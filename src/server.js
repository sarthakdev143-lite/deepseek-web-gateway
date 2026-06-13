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

  // Auto-heal unhealthy sessions
  if (session.healthMonitor) {
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

    res.json({ sessionId, status: 'ready', ttl: sessionManager.sessionTTL });
  } catch (err) {
    logger.error(`Session creation failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// POST /session/:id/chat — run a task prompt
app.post('/session/:id/chat', validateSession, async (req, res) => {
  const { prompt, tab, model, readOnly } = req.body;
  const { agent, healthMonitor, workingDir, sessionLogger } = req.session;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt required' });
  }

  if (!req.session.chatQueue) {
    req.session.chatQueue = Promise.resolve();
  }

  // Queue tasks sequentially per session to prevent bot-detection bans
  const executeChat = () => new Promise(async (resolve, reject) => {
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
      res.json({ text: result, toolCalls: [] });
      resolve();
    } catch (err) {
      logger.error(`Chat failed for session ${req.params.id}: ${err.message}`);
      sessionLogger?.logError(`Chat failed: ${err.message}`, { tab, model });
      res.status(500).json({ error: err.message });
      reject(err);
    }
  });

  // Chain to the queue and ignore failures of previous runs
  req.session.chatQueue = req.session.chatQueue
    .then(executeChat)
    .catch(() => executeChat());
});

// POST /session/:id/close — shut down and remove session
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