// =============================================================================
// code/sse-server.js  →  patch into deepseek-web-gateway/src/server.js
// =============================================================================
// Replaces the existing /chat/stream route with a real SSE streaming
// implementation that uses browser.streamResponse() to capture tokens
// from DeepSeek's XHR responses in real time.
//
// HOW TO APPLY:
//   1. Open deepseek-web-gateway/src/server.js
//   2. Find the route: app.post('/session/:id/chat/stream', ...)
//   3. Replace its entire body with the content of this file's route handler
//   4. Make sure agent.run() accepts onToken/onToolCall callbacks
//      (see 04-GATEWAY-FIXES.md for the agent.js changes)
// =============================================================================

'use strict';

// This file is meant to be copy-pasted INTO server.js — it uses the
// already-declared `app`, `sessionManager`, `validateSession`, etc.

// ─────────────────────────────────────────────────────────────────────────────
//  The new /chat/stream route — replaces the fake-streaming one
// ─────────────────────────────────────────────────────────────────────────────

app.post('/session/:id/chat/stream', validateSession, async (req, res) => {
  const { prompt, tab, model, readOnly } = req.body;
  const { agent, healthMonitor, workingDir, sessionLogger } = req.session;
  const sessionId = req.params.id;
  const startTime = Date.now();

  if (!prompt) {
    return res.status(400).json({ error: 'Prompt required' });
  }

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
    'X-Accel-Buffering': 'no', // disable nginx buffering
  });

  // Helper: write an SSE event
  const sendEvent = (type, data = {}) => {
    try {
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    } catch (err) {
      // res might be closed — ignore
    }
  };

  sendEvent('session_started', { sessionId, model: model || 'default' });

  // Queue the task (preserves per-session sequential execution)
  const executeStream = () => new Promise(async (resolve, reject) => {
    sessionManager.incrementActiveRequests(sessionId);
    const heartbeatInterval = setInterval(
      () => sessionManager.heartbeat(sessionId), 60_000
    );

    // ── Tool-call interception ─────────────────────────────────────────────
    // Wrap agent.toolExecutor (or equivalent) so every tool call emits an
    // SSE event before and after execution. This lets the GUI show tool-call
    // cards in real time.
    let toolCallCounter = 0;
    const originalExecuteTool = agent.executeTool?.bind(agent);

    if (originalExecuteTool) {
      agent.executeTool = async (name, args, opts) => {
        const toolCallId = `tc_${Date.now()}_${++toolCallCounter}`;
        sendEvent('tool_call_start', { toolCallId, name, args });
        const startMs = Date.now();
        try {
          const result = await originalExecuteTool(name, args, opts);
          const durationMs = Date.now() - startMs;
          const isError = result instanceof Error ||
                          (result && result.isError === true);
          const resultStr = typeof result === 'string'
            ? result
            : JSON.stringify(result, null, 2);
          // Cap result preview to 10KB to avoid huge SSE events
          const trimmed = resultStr.slice(0, 10000);
          sendEvent('tool_call_result', {
            toolCallId,
            result: trimmed,
            durationMs,
            isError,
            truncated: resultStr.length > 10000,
          });
          return result;
        } catch (err) {
          sendEvent('tool_call_result', {
            toolCallId,
            result: err.message,
            durationMs: Date.now() - startMs,
            isError: true,
          });
          throw err;
        }
      };
    }

    try {
      sessionLogger?.logOrchestration('CHAT_STREAM_REQUEST', {
        tab, model, promptLen: prompt.length,
      });

      // ── Run the agent with streaming callbacks ──────────────────────────
      const streamTab = tab || 'default';

      // The agent.run() method now accepts onToken/onToolCall/onThinking
      // callbacks. When provided, it uses browser.streamResponse() instead
      // of browser.getResponse() for real-time streaming.
      let finalResult = '';

      if (healthMonitor) {
        finalResult = await healthMonitor.executeWithProtection(
          () => agent.run(prompt, {
            tab: streamTab,
            model,
            workingDir,
            sessionLogger,
            readOnly,
            onToken: (content) => sendEvent('token', { content }),
            onToolCall: (call) => sendEvent('tool_call', call),
            onThinking: (elapsedMs) => sendEvent('thinking', { elapsedMs }),
          }),
          () => ({ text: 'Circuit breaker active — please retry in a moment', fallback: true })
        );
      } else {
        finalResult = await agent.run(prompt, {
          tab: streamTab,
          model,
          workingDir,
          sessionLogger,
          readOnly,
          onToken: (content) => sendEvent('token', { content }),
          onToolCall: (call) => sendEvent('tool_call', call),
          onThinking: (elapsedMs) => sendEvent('thinking', { elapsedMs }),
        });
      }

      // Stream complete
      sendEvent('done', {
        totalDurationMs: Date.now() - startTime,
        resultLength: finalResult?.length || 0,
      });

      sessionLogger?.logOrchestration('CHAT_STREAM_COMPLETE', {
        tab, model,
        resultLen: finalResult?.length || 0,
        durationMs: Date.now() - startTime,
      });

      resolve();
    } catch (err) {
      logger.error(`Chat stream failed for session ${sessionId}: ${err.message}`);
      sessionLogger?.logError(`Chat stream failed: ${err.message}`, { tab, model });
      sendEvent('error', {
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
      });
      reject(err);
    } finally {
      clearInterval(heartbeatInterval);
      sessionManager.decrementActiveRequests(sessionId);
      // Restore original executeTool
      if (originalExecuteTool) agent.executeTool = originalExecuteTool;
      try { res.end(); } catch {}
    }
  });

  // Chain onto the session's existing chat queue (sequential execution)
  if (!req.session.chatQueue) {
    req.session.chatQueue = Promise.resolve();
  }
  const queued = req.session.chatQueue.catch(() => {}).then(executeStream);
  req.session.chatQueue = queued.catch(() => {});

  try {
    await queued;
  } catch {
    // executeStream has already sent the SSE error event.
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Also add: history endpoints (for Phase 3c — conversation persistence)
// ─────────────────────────────────────────────────────────────────────────────

// GET /sessions/history — list all restorable sessions from disk
app.get('/sessions/history', (req, res) => {
  try {
    const { ConversationPersister } = require('./conversation-persister');
    const sessions = ConversationPersister.listSessions();
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /sessions/:id/history — load full conversation for a session
app.get('/sessions/:id/history', (req, res) => {
  try {
    const { ConversationPersister } = require('./conversation-persister');
    const history = ConversationPersister.load(req.params.id);
    res.json({ sessionId: req.params.id, history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
