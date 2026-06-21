// src/server.js — HTTP wrapper around DeepSeekAgent with self-healing
'use strict';

const express = require('express');
const DeepSeekAgent = require('./agent');
const { SessionManager } = require('./session-manager');
const { HealthMonitor } = require('./health');
const logger = require('./logger');
const { createSessionLogger } = require('./session-logger');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────
//  Session factory with retry
// ─────────────────────────────────────────────
async function createAgentWithRetry(maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const agent = new DeepSeekAgent({ saveLog: false, silent: true });
      await agent.init();
      return agent;
    } catch (err) {
      logger.warn(`Session creation attempt ${attempt + 1}/${maxRetries} failed: ${err.message}`);
      if (attempt === maxRetries - 1) throw err;
      // Exponential backoff: 1s, 2s, 4s
      await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
    }
  }
}

const sessionManager = new SessionManager();
sessionManager.startAutoCleanup(); // Enable background session cleanup

// ─────────────────────────────────────────────
//  Middleware
// ─────────────────────────────────────────────
async function validateSession(req, res, next) {
  const sessionId = req.params.id;
  if (!sessionId) {
    return res.status(400).json({ error: 'Session ID required' });
  }

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found or expired' });
  }

  req.session = session;

  // Auto-heal unhealthy sessions. Do not probe the browser while another
  // request is actively driving it; Playwright checks can disturb generation.
  if (session.healthMonitor && (session.activeRequests || 0) === 0) {
    const isHealthy = await session.healthMonitor.checkHealth();
    if (!isHealthy) {
      logger.warn(`Session ${sessionId} unhealthy — attempting auto-heal`);
      const healed = await session.healthMonitor.autoHeal();
      if (!healed) {
        await sessionManager.destroySession(sessionId);
        return res.status(503).json({
          error: 'Session unhealthy and could not be recovered. Create a new session.'
        });
      }
    }
  }

  next();
}

// ─────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────

// POST /session/create — boot a browser agent
app.post('/session/create', async (req, res) => {
  try {
    const agent = await createAgentWithRetry(3);
    const workingDir = req.body?.workingDir || null;

    const sessionId = sessionManager.createSession(agent);
    const healthMonitor = new HealthMonitor(agent);

    // Create a structured per-session logger
    const sessionLogger = createSessionLogger(sessionId, workingDir);

    // Attach everything on the session object
    const session = sessionManager.getSession(sessionId);
    session.healthMonitor = healthMonitor;
    session.chatQueue    = Promise.resolve();
    session.workingDir   = workingDir;
    session.sessionLogger = sessionLogger;
    sessionManager.updateMetadata(sessionId, { createdAt: new Date().toISOString(), workingDir });

    // Return the log file path so clients can record it in their own traces
    res.json({
      sessionId,
      status        : 'ready',
      ttl           : sessionManager.sessionTTL,
      sessionLogPath: sessionLogger.path,
    });
  } catch (err) {
    logger.error(`Session creation failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /session/:id/chat — run a task prompt (legacy, non-streaming)
app.post('/session/:id/chat', validateSession, async (req, res) => {
  const { prompt, tab, model, readOnly } = req.body;
  const { agent, healthMonitor, workingDir, sessionLogger } = req.session;
  const sessionId = req.params.id;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt required' });
  }

  const tabName = tab || 'default';

  // Queue tasks sequentially for the whole browser session. The browser
  // controller owns shared state such as activeTab and WORKING_DIR, so
  // per-tab parallel runs can race even when they use different pages.
  const executeChat = () => new Promise(async (resolve, reject) => {
    // ── CRITICAL: mark this session as having an active in-flight request.
    // Auto-cleanup will skip sessions where activeRequests > 0, preventing
    // the TTL from killing a browser that is actively doing work.
    sessionManager.incrementActiveRequests(sessionId);

    // ── Heartbeat: refresh lastAccessed every 60s during long-running runs
    // so the session TTL clock never considers this session stale.
    const heartbeatInterval = setInterval(
      () => sessionManager.heartbeat(sessionId),
      60_000
    );

    try {
      sessionLogger?.logOrchestration('CHAT_REQUEST', { tab, model, promptLen: (prompt || '').length });
      let result;

      if (healthMonitor) {
        result = await healthMonitor.executeWithProtection(
          () => agent.run(prompt, { tab, model, workingDir, sessionLogger, readOnly }),
          () => ({ text: 'Circuit breaker active — please retry in a moment', fallback: true })
        );
      } else {
        result = await agent.run(prompt, { tab, model, workingDir, sessionLogger, readOnly });
      }

      sessionLogger?.logOrchestration('CHAT_COMPLETE', { tab, model, resultLen: (result || '').length });
      if (!res.headersSent) res.json({ text: result, toolCalls: [] });
      resolve();
    } catch (err) {
      logger.error(`Chat failed for session ${sessionId} (tab: ${tabName}): ${err.message}`);
      sessionLogger?.logError(`Chat failed: ${err.message}`, { tab, model });
      if (!res.headersSent) res.status(500).json({ error: err.message });
      reject(err);
    } finally {
      // Always clear heartbeat and decrement active request counter
      clearInterval(heartbeatInterval);
      sessionManager.decrementActiveRequests(sessionId);
    }
  });

  if (!req.session.chatQueue) {
    req.session.chatQueue = Promise.resolve();
  }

  const queued = req.session.chatQueue.catch(() => {}).then(executeChat);
  req.session.chatQueue = queued.catch(() => {});

  try {
    await queued;
  } catch {
    // executeChat has already sent the HTTP error response.
  }
});

// POST /session/:id/close — shut down and remove session
app.post('/session/:id/diagnose', validateSession, async (req, res) => {
  try {
    const tab = req.body?.tab || 'default';
    const result = await req.session.agent.diagnose(tab);
    req.session.sessionLogger?.logOrchestration('DIAGNOSE', result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/session/:id/tab/recreate', validateSession, async (req, res) => {
  try {
    const tab = req.body?.tab || 'default';
    const result = await req.session.agent.recreateTab(tab);
    req.session.sessionLogger?.logOrchestration('TAB_RECREATE', result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /session/:id/chat/stream — stream response via SSE
app.post('/session/:id/chat/stream', validateSession, async (req, res) => {
  const { prompt, tab, model, readOnly } = req.body;
  const { agent, healthMonitor, workingDir, sessionLogger } = req.session;
  const sessionId = req.params.id;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt required' });
  }

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Queue the task
  const executeStream = () => new Promise(async (resolve, reject) => {
    sessionManager.incrementActiveRequests(sessionId);
    const heartbeatInterval = setInterval(
      () => sessionManager.heartbeat(sessionId),
      60_000
    );

    try {
      sessionLogger?.logOrchestration('CHAT_STREAM_REQUEST', { tab, model, promptLen: (prompt || '').length });
      
      let result;
      if (healthMonitor) {
        result = await healthMonitor.executeWithProtection(
          () => agent.run(prompt, { tab, model, workingDir, sessionLogger, readOnly }),
          () => ({ text: 'Circuit breaker active — please retry in a moment', fallback: true })
        );
      } else {
        result = await agent.run(prompt, { tab, model, workingDir, sessionLogger, readOnly });
      }

      // Stream the result in chunks (simulated streaming)
      const chunks = result.match(/.{1,20}/g) || [result];
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        res.write(`data: ${JSON.stringify({ chunk, done: i === chunks.length - 1 })}\n\n`);
        await new Promise(r => setTimeout(r, 30));
      }

      sessionLogger?.logOrchestration('CHAT_STREAM_COMPLETE', { tab, model, resultLen: result.length });
      resolve();
    } catch (err) {
      logger.error(`Chat stream failed for session ${sessionId}: ${err.message}`);
      sessionLogger?.logError(`Chat stream failed: ${err.message}`, { tab, model });
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
      reject(err);
    } finally {
      clearInterval(heartbeatInterval);
      sessionManager.decrementActiveRequests(sessionId);
      res.end();
    }
  });

  if (!req.session.chatQueue) {
    req.session.chatQueue = Promise.resolve();
  }
  const queued = req.session.chatQueue.catch(() => {}).then(executeStream);
  req.session.chatQueue = queued.catch(() => {});

  try {
    await queued;
  } catch {
    // error already sent
  }
});

app.post('/session/:id/close', async (req, res) => {
  const sessionId = req.params.id;
  // Close the logger before destroying session
  const session = sessionManager.getSession(sessionId);
  session?.sessionLogger?.close();
  await sessionManager.destroySession(sessionId);
  res.json({ status: 'closed', sessionId });
});

// GET /sessions — list all active sessions (admin)
app.get('/sessions', (req, res) => {
  const stats = sessionManager.getStats();
  const sessions = Array.from(sessionManager.sessions.keys()).map(id => ({
    id,
    metadata: sessionManager.sessions.get(id)?.metadata || {},
  }));
  res.json({ stats, sessions });
});

// GET /health — liveness probe
app.get('/health', (req, res) => {
  const stats = sessionManager.getStats();
  res.json({
    status: 'ok',
    version: '2.0.0',
    sessions: stats,
    timestamp: new Date().toISOString(),
  });
});

// ─────────────────────────────────────────────
//  Graceful shutdown
// ─────────────────────────────────────────────
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received — shutting down gracefully');
  await sessionManager.destroyAllSessions();
  process.exit(0);
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received — shutting down gracefully');
  await sessionManager.destroyAllSessions();
  process.exit(0);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log('═'.repeat(55));
  console.log('  DeepSeek Web Gateway — HTTP API');
  console.log(`  Listening on http://localhost:${PORT}`);
  console.log('  Endpoints:');
  console.log('    GET  /health               — health check');
  console.log('    GET  /sessions             — list active sessions');
  console.log('    POST /session/create       — create agent session');
  console.log('    POST /session/:id/chat     — send task prompt');
  console.log('    POST /session/:id/close    — close session');
  console.log('═'.repeat(55));
});
