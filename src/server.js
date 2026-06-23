// src/server.js — HTTP wrapper around DeepSeekAgent with self-healing
'use strict';

const express = require('express');
const DeepSeekAgent = require('./agent');
const { SessionManager } = require('./session-manager');
const { HealthMonitor } = require('./health');
const logger = require('./logger');
const { createSessionLogger } = require('./session-logger');
const { ConversationPersister } = require('./conversation-persister');

const app = express();
app.use(express.json());

// ─────────────────────────────────────────────────────────────────────────────
//  Security configuration (Phase 6c)
//
//  AUTH_TOKEN: if set (SEEKCODE_AUTH_TOKEN env var), every non-/health request
//  must carry it as `Authorization: Bearer <token>` or `?token=<token>`. Empty
//  by default — set it in production so a random port scan can't drive the
//  browser. When unset, auth is skipped (local dev convenience).
//
//  REQUEST_TIMEOUT_MS: hard cap on NON-STREAM endpoints (default 5min). SSE
//  stream routes are exempt because legitimate streams run for minutes while
//  tokens arrive — the agent.run() wall-clock budget (Phase 6a) bounds those.
//  Override with SEEKCODE_REQUEST_TIMEOUT_MS.
// ─────────────────────────────────────────────────────────────────────────────
const AUTH_TOKEN = process.env.SEEKCODE_AUTH_TOKEN || '';
const REQUEST_TIMEOUT_MS = Number(process.env.SEEKCODE_REQUEST_TIMEOUT_MS) || (5 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
//  Project-root allowlist (GUI "Open Project" picker security gate)
//
//  PROJECT_ROOTS comes from SEEKCODE_PROJECT_ROOTS (semicolon on Windows,
//  colon on Unix). Empty array = OPEN MODE (dev): any path is allowed.
//  In production, set the env var so the agent — which has write_file +
//  run_command — can only be pointed at approved project directories.
// ─────────────────────────────────────────────────────────────────────────────
const pathLib = require('path');
const PROJECT_ROOTS = require('./config').PROJECT_ROOTS || [];

/** Resolve `target` absolute; return true if it equals or is a child of any
 *  configured root. Empty roots array = open mode (allow all). */
function isWithinRoots(target) {
  if (!PROJECT_ROOTS.length) return true; // dev/open mode
  if (!target) return false;
  try {
    const abs = pathLib.resolve(target);
    return PROJECT_ROOTS.some((root) => {
      const rootAbs = pathLib.resolve(root);
      return abs === rootAbs || abs.startsWith(rootAbs + pathLib.sep);
    });
  } catch {
    return false;
  }
}

// Token-auth middleware. Exempts /health (liveness probes must work unauth'd).
function requireAuth(req, res, next) {
  if (!AUTH_TOKEN) return next(); // no token configured → open mode (local dev)
  if (req.path === '/health') return next();

  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const queryToken = req.query && req.query.token ? String(req.query.token) : '';
  if (bearer === AUTH_TOKEN || queryToken === AUTH_TOKEN) return next();

  logger.warn(`Auth rejected: ${req.method} ${req.path} from ${req.ip}`);
  return res.status(401).json({ error: 'Unauthorized — provide Authorization: Bearer <token> or ?token=<token>' });
}
app.use(requireAuth);

// Request timeout for non-stream endpoints. Streams self-terminate via the
// agent's wall-clock budget; capping them here would kill legitimate long chats.
app.use((req, res, next) => {
  if (req.path.endsWith('/chat/stream')) return next(); // SSE — exempt
  req.setTimeout(REQUEST_TIMEOUT_MS, () => {
    if (!res.headersSent) {
      res.status(504).json({ error: `Request timed out after ${REQUEST_TIMEOUT_MS}ms` });
    }
  });
  next();
});

// ─────────────────────────────────────────────
//  Session factory with retry
// ─────────────────────────────────────────────
// Construct an agent and START background init, but return immediately.
// Browser launch (Playwright + DeepSeek navigation + login wait) takes ~5-7s
// on a cold gateway; doing it synchronously made /session/create block the
// HTTP response. Now we kick it off in the background and the first chat
// request awaits agent.ready() before driving the browser. If init fails
// outright (after the agent's internal retry), the ready() promise rejects
// and the next chat request surfaces a 503.
function createAgentBackground() {
  const agent = new DeepSeekAgent({ saveLog: false, silent: true });
  agent.ensureInit(); // fire-and-forget; errors land on the ready() promise
  return agent;
}

// Legacy synchronous constructor — kept for any caller that genuinely needs
// to block until ready (none in the current codebase, but preserved for
// backwards compat with index.js CLI one-shots).
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

  // Wait for background browser init to complete (cold-start latency hides
  // here instead of blocking /session/create). If init already failed, 503.
  if (session.agent && typeof session.agent.ready === 'function') {
    if (session.initError) {
      return res.status(503).json({
        error: `Session failed to initialize: ${session.initError}. Create a new session.`,
      });
    }
    try {
      await session.agent.ready();
    } catch (err) {
      session.initError = err.message;
      return res.status(503).json({
        error: `Session failed to initialize: ${err.message}. Create a new session.`,
      });
    }
  }

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

// POST /session/create — register a session instantly; browser launches in
// the background. Returns immediately with status:'initializing'. The first
// /chat or /chat/stream request awaits the agent's ready() promise before
// driving the browser, so the cold-start latency is hidden behind the user's
// typing/thinking time instead of blocking session creation.
app.post('/session/create', async (req, res) => {
  try {
    const agent = createAgentBackground();
    const workingDir = req.body?.workingDir || null;

    // Security gate: reject workingDir outside the configured allowlist.
    // Open mode (no PROJECT_ROOTS) skips this check for dev convenience.
    if (workingDir && !isWithinRoots(workingDir)) {
      logger.warn(`Rejecting /session/create — workingDir outside roots: ${workingDir}`);
      return res.status(400).json({
        error: 'workingDir outside allowed roots',
        roots: PROJECT_ROOTS,
      });
    }

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

    // Surface init failures on the session so validateSession can 503 early
    // rather than making the user wait for the first chat to discover it.
    agent.ensureInit().catch((err) => {
      logger.error(`Background init failed for session ${sessionId}: ${err.message}`);
      session.initError = err.message;
    });

    // Respond immediately — don't wait for the browser.
    res.json({
      sessionId,
      status        : 'initializing',
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
          () => agent.run(prompt, { tab, model, workingDir, sessionLogger, readOnly, sessionId }),
          () => ({ text: 'Circuit breaker active — please retry in a moment', fallback: true })
        );
      } else {
        result = await agent.run(prompt, { tab, model, workingDir, sessionLogger, readOnly, sessionId });
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
    const sessionId = req.params.id; // thread through so recreateTab can replay
    const result = await req.session.agent.recreateTab(tab, sessionId);
    req.session.sessionLogger?.logOrchestration('TAB_RECREATE', result);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /session/:id/chat/stream — stream response via SSE
//
// Emits TWO parallel event shapes on the same SSE stream for backward compat:
//   (a) Typed events:    { type: 'token'|'tool_call_start'|'tool_call_result'|
//                               'thinking'|'done'|'error', ... }
//       — consumed by the new useStreamingChat hook (Phase 4 GUI).
//   (b) Legacy events:   { chunk: string, done: boolean }
//       — consumed by the existing useChat hook. Emitted on every token AND a
//         final {chunk:'', done:true}. This keeps the current GUI working while
//         the new GUI consumes the richer typed events.
app.post('/session/:id/chat/stream', validateSession, async (req, res) => {
  const { prompt, tab, model, readOnly } = req.body;
  const { agent, healthMonitor, workingDir, sessionLogger } = req.session;
  const sessionId = req.params.id;

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt required' });
  }

  // Set up SSE headers. X-Accel-Buffering disables nginx/proxy buffering.
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no',
  });

  let clientGone = false;
  // Minimal abort-signal object — the agent.run() loop checks .aborted between
  // iterations so a Stop-button disconnect actually halts the run instead of
  // driving DeepSeek through the full conversation to a dead socket.
  const abortSignal = { aborted: false };
  req.on('close', () => { clientGone = true; abortSignal.aborted = true; });

  const sendEvent = (type, data = {}) => {
    if (clientGone) return;
    try {
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    } catch {
      clientGone = true;
    }
  };
  // Legacy {chunk, done} shape for the existing useChat.ts hook.
  const sendLegacyChunk = (chunk, done) => {
    if (clientGone) return;
    try {
      res.write(`data: ${JSON.stringify({ chunk, done })}\n\n`);
    } catch {
      clientGone = true;
    }
  };

  // Queue the task
  const executeStream = () => new Promise(async (resolve, reject) => {
    sessionManager.incrementActiveRequests(sessionId);
    const heartbeatInterval = setInterval(
      () => sessionManager.heartbeat(sessionId),
      60_000
    );

    const runStart = Date.now();

    try {
      sessionLogger?.logOrchestration('CHAT_STREAM_REQUEST', { tab, model, promptLen: (prompt || '').length });
      sendEvent('session_started', { sessionId });

      // Streaming callbacks — surfaced through agent.run via onToken/onToolCall.
      const onToken = (content) => {
        sendEvent('token', { content });
        sendLegacyChunk(content, false);
      };
      const onToolCall = (ev) => {
        // ev is { type: 'tool_call_start'|'tool_call_result', ... } from agent
        sendEvent(ev.type, ev);
      };
      const onThinking = () => {
        sendEvent('thinking', { elapsedMs: Date.now() - runStart });
      };

      let result;
      const runOpts = {
        tab, model, workingDir, sessionLogger, readOnly,
        sessionId,
        abortSignal,
        onToken, onToolCall, onThinking,
      };
      if (healthMonitor) {
        result = await healthMonitor.executeWithProtection(
          () => agent.run(prompt, runOpts),
          () => ({ text: 'Circuit breaker active — please retry in a moment', fallback: true })
        );
      } else {
        result = await agent.run(prompt, runOpts);
      }

      // Ensure the final answer text was streamed (agent emits it as tokens in
      // stream mode, but defensive fallback for buffered-mode results).
      if (typeof result === 'string' && result.length > 0) {
        // The agent already emitted tokens in stream mode; only emit if we're
        // certain nothing was streamed (e.g. circuit-breaker fallback).
        if (result.fallback || /Circuit breaker active/.test(result)) {
          sendEvent('token', { content: result });
        }
      }

      sendEvent('done', { totalDurationMs: Date.now() - runStart, resultLength: typeof result === 'string' ? result.length : 0 });
      sendLegacyChunk('', true);

      sessionLogger?.logOrchestration('CHAT_STREAM_COMPLETE', { tab, model, resultLen: typeof result === 'string' ? result.length : 0 });
      resolve();
    } catch (err) {
      logger.error(`Chat stream failed for session ${sessionId}: ${err.message}`);
      sessionLogger?.logError(`Chat stream failed: ${err.message}`, { tab, model });
      sendEvent('error', { message: err.message });
      try { sendLegacyChunk('', true); } catch {}
      reject(err);
    } finally {
      clearInterval(heartbeatInterval);
      sessionManager.decrementActiveRequests(sessionId);
      try { res.end(); } catch {}
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

// GET /sessions/history — list all PERSISTED conversations (survive restart).
// Distinct from GET /sessions (in-memory only). Used by the GUI's HistorySidebar
// to populate the conversation list across browser/agent restarts.
app.get('/sessions/history', (req, res) => {
  const sessions = ConversationPersister.listSessions();
  res.json({ sessions, count: sessions.length });
});

// GET /sessions/:id/history — full JSONL transcript for one session.
// Returns the raw entries; the GUI renders them as a chat thread on restore.
app.get('/sessions/:id/history', (req, res) => {
  const history = ConversationPersister.load(req.params.id);
  if (history.length === 0) {
    return res.status(404).json({ error: 'No persisted history for session', sessionId: req.params.id });
  }
  res.json({ sessionId: req.params.id, entries: history, count: history.length });
});

// DELETE /sessions/:id/history — remove a persisted conversation file.
app.delete('/sessions/:id/history', (req, res) => {
  const removed = ConversationPersister.delete(req.params.id);
  res.json({ sessionId: req.params.id, removed });
});

// ─────────────────────────────────────────────────────────────────────────────
//  Project / directory picker endpoints
//
//  These power the GUI's "Open Project" modal. /projects/roots exposes the
//  allowlist so the picker knows where browsing is allowed to start.
//  /directories/list returns immediate subdirectories of an allowed path so
//  the picker can render a lazy-expanding folder tree (one level at a time,
//  cheap, no recursion). Both are auth-gated by the global requireAuth mw.
// ─────────────────────────────────────────────────────────────────────────────
const fsLib = require('fs');

// GET /projects/roots — expose the allowlist (empty = open mode)
app.get('/projects/roots', (req, res) => {
  res.json({
    roots: PROJECT_ROOTS,
    openMode: PROJECT_ROOTS.length === 0,
  });
});

// GET /directories/list?path=<dir> — immediate subdirs of an allowed path.
// Skips hidden dirs and common noise (node_modules, .git, dist, build) so the
// picker tree stays clean and readable.
const DIR_SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.cache', 'coverage', '.turbo']);
app.get('/directories/list', (req, res) => {
  const target = req.query.path ? String(req.query.path) : '';
  if (!target) {
    return res.status(400).json({ error: 'Missing required query param: path' });
  }
  if (!isWithinRoots(target)) {
    return res.status(403).json({ error: 'path outside allowed roots', roots: PROJECT_ROOTS });
  }
  let abs;
  try {
    abs = pathLib.resolve(target);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid path', detail: e.message });
  }
  fsLib.readdir(abs, { withFileTypes: true }, (err, entries) => {
    if (err) {
      return res.status(404).json({ error: 'Cannot read directory', detail: err.message });
    }
    const directories = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !DIR_SKIP.has(e.name))
      .map((e) => ({ name: e.name, path: pathLib.join(abs, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ path: abs, directories });
  });
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
const config = require('./config');
app.listen(PORT, () => {
  console.log('═'.repeat(55));
  console.log('  DeepSeek Web Gateway — HTTP API');
  console.log(`  Listening on http://localhost:${PORT}`);
  console.log('  Endpoints:');
  console.log('    GET  /health               — health check');
  console.log('    GET  /sessions             — list active sessions');
  console.log('    GET  /sessions/history     — list persisted conversations');
  console.log('    GET  /sessions/:id/history — load one conversation');
  console.log('    POST /session/create       — create agent session');
  console.log('    POST /session/:id/chat     — send task prompt (non-stream)');
  console.log('    POST /session/:id/chat/stream — SSE streaming chat');
  console.log('    POST /session/:id/close    — close session');
  console.log('    GET  /projects/roots       — project allowlist (GUI picker)');
  console.log('    GET  /directories/list     — list subdirs (GUI folder tree)');
  console.log('─'.repeat(55));
  console.log('  Security:');
  console.log('    Auth: ' + (AUTH_TOKEN ? 'ENABLED (Bearer token required)' : 'DISABLED — set SEEKCODE_AUTH_TOKEN in production'));
  console.log(`    Non-stream request timeout: ${REQUEST_TIMEOUT_MS}ms`);
  console.log(`    Agent wall-clock budget: ${Math.floor((config.RUN_BUDGET_MS || 0) / 60_000)}min (SEEKCODE_RUN_BUDGET_MS)`);
  console.log('═'.repeat(55));
  if (!AUTH_TOKEN) {
    console.log('  ⚠️  WARNING: no auth token set. Anyone who can reach this port can');
    console.log('      drive a browser that executes shell commands. Set SEEKCODE_AUTH_TOKEN.');
    console.log('═'.repeat(55));
  }
});
