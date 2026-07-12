// src/agent.js — The core agent loop that ties everything together
'use strict';

const fs                           = require('fs');
const path                         = require('path');
const os                           = require('os');
const config                       = require('./config');
const logger                       = require('./logger');
const DeepSeekBrowser              = require('./browser');
const { executeTool,
        setReadOnly }              = require('./tools');
const { parseResponse,
        formatToolResult,
        READ_ONLY_TOOLS }    = require('./parser');
const { ConversationManager }      = require('./prompt');
const { getSessionLogger }         = require('./session-logger');
const { ConversationPersister }    = require('./conversation-persister');
const {
  REPEAT_UPLOAD_STUB_THRESHOLD,
  shouldNeverUpload,
  shouldUseBrowserUpload,
  isUploadStubResult,
  toolFingerprint,
  readFileInline,
  uploadSuccessMessage,
}                                   = require('./read-file-delivery');

// Global error boundary for agent.js
process.on('unhandledRejection', (reason, promise) => {
  // Defer handling to main orchestrator or ignore non-fatal resets
  if (reason.message?.includes('browser') || reason.message?.includes('context')) {
    logger.warn('🔄 Agent rejection caught in global boundary: ' + reason.message);
  }
});

// ─────────────────────────────────────────────
//  Agent class
// ─────────────────────────────────────────────

class DeepSeekAgent {

  async runWithTimeout(prompt, timeoutMs = 1800000, options = {}) {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
      );
    
      try {
        return await Promise.race([this.run(prompt, options), timeoutPromise]);
      } catch (err) {
        if (err.message.includes('timed out')) {
          // Attempt to recover browser state
          console.warn('Operation timeout - attempting recovery');
          await this.shutdown().catch(() => {});
          await this.init();
        }
        throw err;
      }
    }

  constructor(options = {}) {
    this.silent        = options.silent || false;
    this.browser       = new DeepSeekBrowser();
    this.conversations = new Map(); // tabName -> ConversationManager
    this.options       = options;
    this._running      = false;
    this.sandbox           = null; // Will be initialized on first command execution
    this.sessionLogger     = null; // Set per-run from options or module singleton
    this._toolCallTracker  = new Map(); // fingerprint -> { count, uploadStubCount }
  }

  get conversation() {
    const tabName = this.browser.activeTab || 'default';
    if (!this.conversations.has(tabName)) {
      this.conversations.set(tabName, new ConversationManager());
    }
    return this.conversations.get(tabName);
  }

  set conversation(val) {
    const tabName = this.browser.activeTab || 'default';
    if (val) {
      this.conversations.set(tabName, val);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Boot the browser and load DeepSeek */
  async init() {
    await this.browser.launch();
    await this.browser.newChat();
  }

  /**
     * Background-init: kicks off init() without awaiting it. Callers that need
     * a ready browser (chat, diagnose, recreateTab) should `await agent.ready()`
     * first. The ready promise resolves on success or rejects on failure (with
     * a retry baked in). Used by server.js so /session/create can return
     * instantly instead of blocking ~7s on Playwright launch.
     */
    ensureInit() {
      if (!this._initPromise) {
        this._initPromise = (async () => {
          // Two retries with exponential backoff — browser launch is occasionally flaky on cold start.
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              await this.init();
              return;
            } catch (err) {
              if (attempt === 3) throw err;
              logger.warn(`Background init attempt ${attempt}/3 failed, retrying in ${attempt * 2}s: ${err.message}`);
              await new Promise(r => setTimeout(r, attempt * 2000));
            }
          }
        })();
      }
      return this._initPromise;
    }

  /** Await background init if one is in progress; no-op if already ready. */
  ready() {
    return this._initPromise ? this._initPromise : Promise.resolve();
  }

  /** Shut down cleanly */
  async shutdown() {
    // Clean up sandbox if it exists
    if (this.sandbox) {
      try {
        await this.sandbox.cleanup();
      } catch (err) {
        logger.warn(`Sandbox cleanup failed: ${err.message}`);
      }
    }
    // Clean up background servers started by the agent
    try {
      const { stopAllServers } = require('./tools');
      await stopAllServers();
    } catch (err) {
      logger.warn(`Failed to stop background servers: ${err.message}`);
    }
    await this.browser.close();
  }

  async diagnose(tab = 'default') {
    await this.browser.switchTab(tab);
    const artifactDir = path.join(config.WORKING_DIR || process.cwd(), '.seekcode', 'diagnostics');
    fs.mkdirSync(artifactDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const screenshotPath = path.join(artifactDir, `${stamp}-${tab}-screenshot.png`);
    await this.browser.screenshot(screenshotPath, tab).catch(() => {});
    const { page } = this.browser._resolveTab(tab);
    const domPath = path.join(artifactDir, `${stamp}-${tab}-dom.txt`);
    const dom = await page.evaluate(() => ({
      url: window.location.href,
      title: document.title,
      text: (document.body?.innerText || '').slice(0, 12000),
      html: (document.body?.outerHTML || '').slice(0, 12000),
      openRequestsHint: performance.getEntriesByType('resource').slice(-25).map(r => ({
        name: r.name,
        initiatorType: r.initiatorType,
        duration: r.duration,
      })),
    }));
    fs.writeFileSync(domPath, JSON.stringify(dom, null, 2), 'utf8');
    return { screenshotPath, domPath, url: dom.url, title: dom.title };
  }

  /**
     * Recreate a crashed/closed tab and (optionally) replay the persisted
     * conversation back into the fresh ConversationManager so the agent retains
     * context across the crash. `sessionId` should match the one server.js used
     * for the original run; if omitted, no replay happens (legacy behaviour).
     */
    async recreateTab(tab = 'default', sessionId = null) {
      // Close existing page if any
      const page = this.browser.pages.get(tab);
      if (page && !page.isClosed()) {
        try { await page.close(); } catch {}
      }
      this.browser.pages.delete(tab);
      this.browser.adaptiveSelectors.delete(tab);
    
      // Recreate tab with retry logic
      let lastErr;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await this.browser.switchTab(tab);
          await this.browser.newChat(tab);
          break; // Success
        } catch (err) {
          lastErr = err;
          logger.warn(`Tab recreate attempt ${attempt}/3 failed: ${err.message}`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000 * attempt));
        }
      }
      if (lastErr) throw lastErr;

      // Reset this tab's conversation and replay persisted turns (if any).
      // Re-inject as conversation context — do NOT re-send to the model (the
      // model has no memory of the prior tab; the next user message will carry
      // this context forward via buildPrompt's "RECENT CONVERSATION" section).
      this.conversations.delete(tab);
      let replayed = 0;
      if (sessionId) {
        const history = ConversationPersister.load(sessionId);
        if (history.length > 0) {
          logger.info(`Replaying ${history.length} persisted entries into tab "${tab}"...`);
          const conv = this.conversation; // lazily creates a fresh ConversationManager
          for (const entry of history) {
            if (entry.type === 'turn' && (entry.role === 'user' || entry.role === 'assistant')) {
              conv.addMessage(entry.role, entry.content);
              replayed++;
            }
            // tool_result / final entries are skipped — they're summaries, not
            // things the model needs to see verbatim in its context window.
          }
        }
      }

      return { tab, recreated: true, replayed };
    }

  /**
   * Detect whether an error thrown from a Playwright round-trip means the
   * page/context/browser was torn down mid-call. Mirrors the classifier used
   * by DeepSeekBrowser._isNavError but lives here so the agent loop doesn't
   * reach across module boundaries. When this returns true, the caller can
   * recreate the tab and retry the iteration instead of crashing the chat.
   */
  _isBrowserTeardownError(err) {
    const msg = String((err && err.message) || err);
    return /Target page.*closed|Target closed|context or browser has been closed|Browser has been closed|Execution context was destroyed|frame was detached/i.test(msg);
  }

  /**
   * Run a browser round-trip (waitForResponse / streamListen / sendMessage)
   * with one-shot crash recovery. If the call throws a teardown error AND we
   * haven't already used this run's single recovery, recreate the tab —
   * replaying the persisted conversation — and retry the call once. Any other
   * error, or a second teardown, propagates to the caller unchanged.
   *
   * This is the safety net that turns a fatal "Target page, context or
   * browser has been closed" (which previously killed the whole session at
   * seq 176) into a recoverable blip.
   */
  async _browserCallWithCrashRecovery(fn, { tab, sessionId, slog } = {}) {
    try {
      return await fn();
    } catch (err) {
      if (!this._isBrowserTeardownError(err) || this._crashRetried) throw err;
      this._crashRetried = true;
      logger.warn(`🔄 Browser round-trip failed ("${err.message}") — recreating tab "${tab}" and retrying once...`);
      slog?.logWarn('Browser teardown mid-iteration — recreating tab', { tab, error: err.message });
      try {
        await this.recreateTab(tab, sessionId);
      } catch (recErr) {
        logger.error(`Tab recreate failed: ${recErr.message}`);
        throw err; // surface the original teardown error
      }
      // The recreated tab is fresh; re-issue the original call on it.
      return await fn();
    }
  }

  /**
   * Run a task to completion.
   * Returns the final response string.
   */
  async run(task, options = {}) {
    this._running          = true;
    this._toolCallTracker  = new Map();
    this._crashRetried     = false; // one-shot browser-teardown recovery per run
    const maxIter          = config.MAX_ITERATIONS;
    const runStart         = Date.now();

    // ── 0. Attach session logger ────────────────────────────────────────────
    // Prefer a logger passed via options (created by server.js per session),
    // fall back to the module-level singleton, or null (no structured logging).
    const slog = options.sessionLogger || getSessionLogger() || null;
    const tab  = options.tab   || this.browser.activeTab || 'default';
    const model = options.model || 'default';

    // ── 0b. Streaming callbacks (optional) ──────────────────────────────────
    // When provided, the response loop uses browser.streamListen() to emit
    // {type:'token'|'thinking'|'done'} events as tokens arrive, instead of the
    // buffered browser.waitForResponse(). Tool calls are also surfaced via
    // onToolCall. If absent, behaviour is unchanged (buffered, silent).
    const { onToken, onToolCall, onThinking } = options;
    const streamMode = typeof onToken === 'function';
    const streamEvents = (ev) => {
      if (ev.type === 'token' && onToken) onToken(ev.content);
      else if (ev.type === 'thinking' && onThinking) onThinking(ev);
      // 'done' is internal — agent.run() resolves when iteration completes.
    };

    // ── 0c. Conversation persistence (optional) ─────────────────────────────
    // If a sessionId is threaded through (server.js passes it for every chat
    // request), append each user/assistant turn to a JSONL file so the
    // conversation survives gateway restarts and tab crashes. Best-effort —
    // persister never throws.
    const persistSessionId = options.sessionId || null;
    const persist = (entry) => {
      if (!persistSessionId) return;
      ConversationPersister.append(persistSessionId, entry);
    };

    // ── 0d. Abort signal (optional) ─────────────────────────────────────────
    // server.js flips this when the client disconnects (Stop button). The loop
    // checks it between iterations so we don't keep driving DeepSeek after the
    // user has gone away. The currently-in-flight waitForResponse/streamListen
    // still completes (Playwright has no clean mid-poll cancel), but no further
    // iterations fire and partial output is preserved.
    const abortSignal = options.abortSignal || null;
    const isAborted = () => !!(abortSignal && abortSignal.aborted);
    let abortedRun = false;
    let budgetExhausted = false;

    // ── 1. Apply per-session working directory ──────────────────────────────
    if (options.workingDir) {
      config.WORKING_DIR = options.workingDir;
      slog?.logInfo(`Working directory set to: ${options.workingDir}`);
    }

    // ── 1b. Apply read-only mode ────────────────────────────────────────────
    if (options.readOnly) {
      setReadOnly(true);
      logger.warn('⛔ Read-only mode active — write/command tools are blocked.');
      slog?.logOrchestration('READ_ONLY_MODE', { active: true });
    } else {
      setReadOnly(false); // reset in case last session had it enabled
    }

    // ── 2. Switch tab / model ───────────────────────────────────────────────
    if (options.tab) {
      await this.browser.switchTab(options.tab);
      slog?.logOrchestration('TAB_SWITCH', { tab: options.tab });
    }
    if (options.model) {
      await this.browser.selectModel(this.browser.activeTab, options.model);
      slog?.logOrchestration('MODEL_SELECT', { tab, model });
    }

    // ── 3. Snapshot working directory ──────────────────────────────────────
    const dirListing = this._getWorkingDirListing();

    // ── 4. Build and send first message ────────────────────────────────────
    logger.header(`[Tab: ${tab}] Task: ${task.slice(0, 80)}${task.length > 80 ? '…' : ''}`);

    const conversation = this.conversation;
    let firstMsg;

    if (conversation.turnCount === 0) {
      firstMsg = conversation.buildFirstMessage(task, dirListing);
    } else {
      firstMsg = task;
      conversation.messages.push({ role: 'user', content: firstMsg });
    }

    // Persist the user's original task (not the full system prompt) so the
    // conversation transcript stays human-readable on restore.
    persist({ type: 'turn', role: 'user', content: task });

    // Log the outgoing request
    slog?.logRequest(firstMsg, { tab, model, round: 0 });

    logger.info(`Sending task to DeepSeek (${tab})...`);
    await this._browserCallWithCrashRecovery(
      () => this.browser.sendMessage(firstMsg, tab),
      { tab, sessionId: persistSessionId, slog }
    );

    // ── 5. Agent loop ───────────────────────────────────────────────────────
    for (let iter = 1; iter <= maxIter; iter++) {
      this._lastIter = iter;
      // Honor client abort between iterations. The in-flight browser call
      // can't be cancelled cleanly, so we let the current iteration finish
      // but bail before starting the next model round-trip.
      if (isAborted()) {
        abortedRun = true;
        logger.warn('⛔ Abort signal received — stopping agent loop.');
        slog?.logWarn('Run aborted by client', { iter, totalDurationMs: Date.now() - runStart });
        break;
      }

      // Wall-clock budget — hard cap independent of MAX_ITERATIONS. Prevents
      // the runaway "999 iters × 30-min response" scenario. The currently
      // in-flight browser call still completes (can't cancel mid-poll), but
      // we bail before the next iteration and surface a clear warning.
      const elapsedMs = Date.now() - runStart;
      if (config.RUN_BUDGET_MS && elapsedMs > config.RUN_BUDGET_MS) {
        const mins = Math.floor(elapsedMs / 60_000);
        logger.warn(`⏱️  Wall-clock budget exhausted (${mins}min > ${Math.floor(config.RUN_BUDGET_MS / 60_000)}min) — stopping agent loop.`);
        slog?.logWarn('Run budget exhausted', {
          iter, elapsedMs, budgetMs: config.RUN_BUDGET_MS,
        });
        budgetExhausted = true;
        break;
      }

      logger.iteration(iter, maxIter);
      slog?.logOrchestration('ITERATION_START', { iter, maxIter, tab, model });

      const responseStart = Date.now();
      const rawResponse   = await this._browserCallWithCrashRecovery(
        () => (streamMode
          ? this.browser.streamListen(tab, streamEvents)
          : this.browser.waitForResponse(tab)),
        { tab, sessionId: persistSessionId, slog }
      );
      const responseDurMs = Date.now() - responseStart;

      if (!rawResponse || rawResponse.trim().length === 0) {
        logger.warn('Empty response received — retrying...');
        slog?.logWarn('Empty response — retrying', { iter });
        const retryMsg = 'Please continue. If you are waiting for input, proceed with your best judgement.';
        slog?.logRequest(retryMsg, { tab, model, round: iter });
        await this._browserCallWithCrashRecovery(
          () => this.browser.sendMessage(retryMsg, tab),
          { tab, sessionId: persistSessionId, slog }
        );
        continue;
      }

      // Log the full raw response
      slog?.logResponse(rawResponse, { tab, model, durationMs: responseDurMs });

      // Record in conversation history
      conversation.addAssistantMessage(rawResponse);

      // Parse the response
      const parsed = parseResponse(rawResponse);

      // Persist the assistant message + any tool calls it contained (the tool
      // results are appended below as each tool executes).
      persist({
        type: 'turn',
        role: 'assistant',
        content: rawResponse,
        toolCalls: parsed.type === 'tool_calls'
          ? parsed.calls
          : (parsed.type === 'tool_call' ? [{ name: parsed.name, args: parsed.args }] : []),
        iteration: iter,
      });

      // Honor abort after the response arrives — skip tool execution if the
      // user has already stopped. The assistant message is preserved above.
      if (isAborted()) {
        abortedRun = true;
        logger.warn('⛔ Abort signal received after response — skipping tool execution.');
        break;
      }

      // ── Case 0: Multiple tool calls — parallel where safe ──────────────────
      if (parsed.type === 'tool_calls') {
        const calls = parsed.calls;
        logger.info(`⚡ Parallel batch: ${calls.length} tool call(s) — executing...`);
        slog?.logOrchestration('PARALLEL_TOOL_BATCH', { count: calls.length, tools: calls.map(c => c.name), iter });

        const readCalls   = calls.filter(c =>  READ_ONLY_TOOLS.has(c.name));
        const mutateCalls = calls.filter(c => !READ_ONLY_TOOLS.has(c.name));
        // read_file may upload via the browser — run those sequentially to avoid races
        const parallelReadCalls  = readCalls.filter(c => c.name !== 'read_file');
        const sequentialReadCalls = readCalls.filter(c => c.name === 'read_file');

        // Results array aligned with original call order
        const results = new Array(calls.length);

        const runReadOnlyCall = async (call, mode) => {
          const idx = calls.indexOf(call);
          const tStart = Date.now();
          logger.toolCall(`[${mode}] ${call.name}`, call.args);
          slog?.logToolCall(call.name, call.args, {
            tab,
            iteration: iter,
            parallel: mode === 'parallel',
          });
          try {
            const result = await this._executeToolWithEvents(call.name, call.args, onToolCall);
            slog?.logToolResult(call.name, result, { isError: false, durationMs: Date.now() - tStart, iteration: iter });
            results[idx] = { call, result, isError: false };
          } catch (err) {
            slog?.logToolResult(call.name, err.message, { isError: true, durationMs: Date.now() - tStart, iteration: iter });
            results[idx] = { call, result: `Error: ${err.message}`, isError: true };
          }
        };

        // 1. Execute safe read-only tools in parallel
        await Promise.all(parallelReadCalls.map(call => runReadOnlyCall(call, 'parallel')));

        // 2. Execute read_file sequentially (browser upload is not re-entrant)
        for (const call of sequentialReadCalls) {
          await runReadOnlyCall(call, 'sequential');
        }

        // 3. Execute mutation tools sequentially (order matters)
        for (const call of mutateCalls) {
          const idx = calls.indexOf(call);
          const tStart = Date.now();
          logger.toolCall(`[sequential] ${call.name}`, call.args);
          slog?.logToolCall(call.name, call.args, { tab, iteration: iter, parallel: false });
          try {
            const result = await this._executeToolWithEvents(call.name, call.args, onToolCall);
            slog?.logToolResult(call.name, result, { isError: false, durationMs: Date.now() - tStart, iteration: iter });
            results[idx] = { call, result, isError: false };
          } catch (err) {
            slog?.logToolResult(call.name, err.message, { isError: true, durationMs: Date.now() - tStart, iteration: iter });
            results[idx] = { call, result: `Error: ${err.message}`, isError: true };
          }
        }

        // 4. Send all results back in one message
        const combined = results
          .filter(Boolean)
          .map(({ call, result, isError }) => formatToolResult(call.name, result, isError))
          .join('\n\n');

        // Persist each tool result for replay-on-restore.
        for (const r of results.filter(Boolean)) {
          persist({ type: 'tool_result', name: r.call.name, result: r.result, isError: r.isError });
        }

        const feedbackMsg = conversation.addBatchToolResults(combined);
        slog?.logRequest(feedbackMsg, { tab, model, round: iter, type: 'parallel_batch_result' });
        await this._browserCallWithCrashRecovery(
          () => this.browser.sendMessage(feedbackMsg, tab),
          { tab, sessionId: persistSessionId, slog }
        );
        continue;
      }

      // ── Case 1: Tool call ────────────────────────────────────────────────
      if (parsed.type === 'tool_call') {
        logger.toolCall(parsed.name, parsed.args);
        slog?.logToolCall(parsed.name, parsed.args, { tab, iteration: iter });

        let result;
        let isError = false;
        const toolStart = Date.now();

        const isMutationTool = ['write_file', 'replace_in_file', 'append_to_file', 'delete_file', 'move_file', 'copy_file'].includes(parsed.name);
        const sigBefore = isMutationTool ? this._workspaceSignature() : null;

        try {
          result = await this._executeToolWithEvents(parsed.name, parsed.args, onToolCall);
          const toolDurMs = Date.now() - toolStart;
          logger.toolResult(result);
          slog?.logToolResult(parsed.name, result, { isError: false, durationMs: toolDurMs, iteration: iter });

          if (isMutationTool) {
            const sigAfter = this._workspaceSignature();
            if (sigBefore === sigAfter) {
              const noChangeWarn = '⚠️ WARNING: Tool ran but no filesystem changes detected. Check path and content.';
              logger.warn(`Mutation tool ${parsed.name} executed but no filesystem changes detected.`);
              slog?.logWarn(`No-op mutation: ${parsed.name}`, { args: parsed.args });
              result += '\n\n' + noChangeWarn;
            }
          }
        } catch (err) {
          result = `Error: ${err.message}`;
          isError = true;
          const toolDurMs = Date.now() - toolStart;
          logger.toolResult(result, true);
          slog?.logToolResult(parsed.name, result, { isError: true, durationMs: toolDurMs, iteration: iter });
          slog?.logError(`Tool error: ${parsed.name}`, { error: err.message, args: parsed.args, iter });
        }

        const feedbackMsg = conversation.addToolResult(parsed.name, result, isError);
        slog?.logRequest(feedbackMsg, { tab, model, round: iter, type: 'tool_feedback' });
        persist({ type: 'tool_result', name: parsed.name, result, isError });
        await this._browserCallWithCrashRecovery(
          () => this.browser.sendMessage(feedbackMsg, tab),
          { tab, sessionId: persistSessionId, slog }
        );
        continue;
      }

      // ── Case 2: Parse error ──────────────────────────────────────────────
      if (parsed.type === 'error') {
        logger.warn(`Parse error: ${parsed.message}`);
        slog?.logWarn(`Parse error at iter ${iter}`, { message: parsed.message, rawPreview: rawResponse.slice(0, 300) });
        const recovery = conversation.addToolResult(
          'SYSTEM',
          `Parse error: ${parsed.message}\n\nPlease try again with valid JSON in your tool call.`,
          true
        );
        slog?.logRequest(recovery, { tab, model, round: iter, type: 'parse_error_recovery' });
        await this._browserCallWithCrashRecovery(
          () => this.browser.sendMessage(recovery, tab),
          { tab, sessionId: persistSessionId, slog }
        );
        continue;
      }

      // ── Case 3: Final response ───────────────────────────────────────────
      if (parsed.type === 'final') {
        const looksLikeToolCall = (
          /tool_call/i.test(parsed.content) ||
          /"name"\s*:\s*"[\w_]+"/.test(parsed.content) ||
          /write_file|read_file|run_command|list_directory/i.test(parsed.content.slice(0, 200))
        );

        if (looksLikeToolCall && conversation.turnCount <= maxIter - 2) {
          logger.warn('Response looks like a tool call but was not parsed — asking AI to retry format...');
          slog?.logWarn('Malformed tool call — asking retry', { preview: parsed.content.slice(0, 200) });
          const retry = conversation.addToolResult(
            'SYSTEM',
            'Your response appeared to contain a tool call but it could not be parsed. ' +
            'Please respond with ONLY a ```tool_call code block and nothing else — no prose before or after it.',
            true
          );
          slog?.logRequest(retry, { tab, model, round: iter, type: 'malformed_tool_retry' });
          await this._browserCallWithCrashRecovery(
            () => this.browser.sendMessage(retry, tab),
            { tab, sessionId: persistSessionId, slog }
          );
          continue;
        }

        if (!this.silent) logger.finalOutput(parsed.content);
        slog?.logOrchestration('FINAL_RESPONSE', {
          tab, model,
          totalIterations : iter,
          totalDurationMs : Date.now() - runStart,
          responseLen     : parsed.content.length,
        });

        if (this.options.saveLog) {
          await this._saveConversationLog(task, parsed.content);
        }

        // Mark the conversation as completed (terminal marker for restore UI).
        persist({ type: 'final', content: parsed.content, iterations: iter, durationMs: Date.now() - runStart });

        this._running = false;
        return parsed.content;
      }
    }

    // ── Loop exited without a final response ─────────────────────────────────
    // `iterationsCompleted` is tracked outside the for-scope so the post-loop
    // block can reference it even when the loop bailed on iteration 1.
    this._running = false;
    const totalMs = Date.now() - runStart;
    const totalMin = Math.floor(totalMs / 60_000);
    const iterationsCompleted = Math.max(0, (this._lastIter || 1) - 1);

    if (abortedRun) {
      const msg = `⛔ Run aborted by client after ${totalMin}min (${iterationsCompleted} iteration(s) completed). Partial output preserved in the conversation.`;
      logger.warn(msg);
      persist({ type: 'aborted', iterations: iterationsCompleted, durationMs: totalMs });
      return msg;
    }

    if (budgetExhausted) {
      const budgetMin = Math.floor((config.RUN_BUDGET_MS || 0) / 60_000);
      const msg = `⏱️ Wall-clock budget exhausted after ${totalMin}min (cap: ${budgetMin}min, ${iterationsCompleted} iteration(s) completed). The task may be incomplete. Override with SEEKCODE_RUN_BUDGET_MS.`;
      logger.warn(msg);
      slog?.logWarn('Run budget exhausted (terminal)', { iterations: iterationsCompleted, totalMs, budgetMs: config.RUN_BUDGET_MS });
      persist({ type: 'budget_exhausted', iterations: iterationsCompleted, durationMs: totalMs });
      return msg;
    }

    // Default: hit MAX_ITERATIONS without a final answer.
    const warn = `⚠ Reached maximum iterations (${maxIter}). The task may be incomplete.`;
    logger.warn(warn);
    slog?.logWarn('Max iterations reached', { maxIter, totalDurationMs: totalMs });
    return warn;
  }

  // ── Interactive (REPL) Mode ────────────────────────────────────────────────

  async runInteractive() {
    const readline = require('readline');

    logger.header('Interactive Mode — Type your task and press Enter');
    logger.info('Commands: "exit" or "quit" to stop, "new" to start a new chat\n');

    const rl = readline.createInterface({
      input    : process.stdin,
      output   : process.stdout,
      terminal : true,
    });

    const ask = () => new Promise(resolve => rl.question('\n\x1b[96m❯ Task:\x1b[0m ', resolve));

    while (true) {
      let task;
      try {
        task = (await ask()).trim();
      } catch {
        break; // stdin closed
      }

      if (!task) continue;

      if (['exit', 'quit', 'q'].includes(task.toLowerCase())) {
        logger.info('Exiting...');
        break;
      }

      if (task.toLowerCase() === 'new') {
        logger.info('Starting new chat...');
        await this.browser.newChat();
        this.conversations.clear();
        continue;
      }

      // Reset conversations map for each new task
      this.conversations.clear();

      try {
        await this.browser.newChat();
        await this.run(task);
      } catch (err) {
        logger.error(`Task failed: ${err.message}`);
        if (config.DEBUG) console.error(err);
      }
    }

    rl.close();
  }

  // ── Secure Tool Execution with Sandbox ─────────────────────────────────────

  _trackToolResult(toolName, args, result) {
    const fp = toolFingerprint(toolName, args);
    const entry = this._toolCallTracker.get(fp) || { count: 0, uploadStubCount: 0 };
    entry.count += 1;
    if (isUploadStubResult(result)) {
      entry.uploadStubCount += 1;
    } else {
      entry.uploadStubCount = 0;
    }
    this._toolCallTracker.set(fp, entry);
    return entry;
  }

  _shouldForceInlineReadFile(args) {
    const fp = toolFingerprint('read_file', args);
    const entry = this._toolCallTracker.get(fp);
    return (entry?.uploadStubCount || 0) >= REPEAT_UPLOAD_STUB_THRESHOLD;
  }

  /**
   * Tool-execution wrapper that surfaces start/result as streaming events when
   * an onToolCall callback is registered for this run. Falls through to the
   * plain _executeToolSafely path otherwise (zero overhead in non-stream mode).
   */
  async _executeToolWithEvents(name, args, onToolCall) {
    if (typeof onToolCall !== 'function') {
      return this._executeToolSafely(name, args);
    }
    const id = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    onToolCall({ type: 'tool_call_start', toolCallId: id, name, args });
    const startMs = Date.now();
    try {
      const result = await this._executeToolSafely(name, args);
      onToolCall({
        type: 'tool_call_result',
        toolCallId: id,
        result: typeof result === 'string' ? result : JSON.stringify(result),
        durationMs: Date.now() - startMs,
        isError: false,
      });
      return result;
    } catch (err) {
      onToolCall({
        type: 'tool_call_result',
        toolCallId: id,
        result: err.message,
        durationMs: Date.now() - startMs,
        isError: true,
      });
      throw err;
    }
  }

  async _executeToolSafely(toolName, args) {
    const tab = this.browser.activeTab || 'default';

    if (toolName === 'upload_file') {
      const { path: filePath } = args;
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(config.WORKING_DIR, filePath);
      if (!fs.existsSync(absPath)) {
        throw new Error(`File not found: ${filePath}`);
      }
      if (shouldNeverUpload(filePath)) {
        throw new Error(
          `Cannot upload "${path.basename(filePath)}" as a DeepSeek attachment — this file type is not exposed to the model. ` +
          `Use read_file instead; content is returned inline with secrets redacted.`
        );
      }

      logger.info(`Uploading file ${filePath} directly via browser...`);
      const res = await this.browser.uploadFile(absPath, tab);
      if (res.uploaded) {
        const lineCount = fs.readFileSync(absPath, 'utf8').split('\n').length;
        const result = uploadSuccessMessage(res.fileName, lineCount);
        this._trackToolResult(toolName, args, result);
        return result;
      }
      throw new Error(`Browser failed to upload the file. Use read_file for inline content.`);
    }
    
    if (toolName === 'read_file') {
      const { path: filePath, start_line, end_line } = args;
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(config.WORKING_DIR, filePath);

      if (shouldNeverUpload(filePath)) {
        logger.info(`Returning inline (redacted) read for sensitive file: ${filePath}`);
        const result = readFileInline(filePath, { start_line, end_line });
        this._trackToolResult(toolName, args, result);
        return result;
      }

      if (this._shouldForceInlineReadFile(args)) {
        logger.warn(`Forcing inline read for ${filePath} after repeated upload-stub results`);
        const result = readFileInline(filePath, {
          start_line,
          end_line,
          note: '⚠ Previous read_file calls returned an attachment stub but content was not visible. Inline copy:',
        });
        this._trackToolResult(toolName, args, result);
        return result;
      }

      if (fs.existsSync(absPath) && !fs.statSync(absPath).isDirectory()) {
        const content   = fs.readFileSync(absPath, 'utf8');
        const lineCount = content.split('\n').length;

        if (shouldUseBrowserUpload(filePath, lineCount, start_line, end_line)) {
          logger.info(`File ${filePath} has ${lineCount} lines. Attempting direct upload...`);
          try {
            const res = await this.browser.uploadFile(absPath, tab);
            if (res.uploaded) {
              const result = uploadSuccessMessage(res.fileName, lineCount);
              this._trackToolResult(toolName, args, result);
              return result;
            }
          } catch (err) {
            logger.warn(`Failed to upload ${filePath}: ${err.message}. Falling back to inline text.`);
          }
        }
      }

      const inlineResult = await executeTool(toolName, args);
      this._trackToolResult(toolName, args, inlineResult);
      return inlineResult;
    }

    if (toolName !== 'run_command') {
      return await executeTool(toolName, args);
    }

    const { command, cwd, timeout, env } = args;
    
    let SecuritySandbox;
    try {
      SecuritySandbox = require('./security/SecuritySandbox').SecuritySandbox;
    } catch (err) {
      logger.warn('⚠️ Security sandbox not available. Commands run directly on host (unsafe).');
      return await executeTool(toolName, args);
    }

    if (!this.sandbox) {
      logger.info('Initializing security sandbox...');
      this.sandbox = new SecuritySandbox({
        policy: config.SECURITY_POLICY || {
          approvalRequired: { delete: true, writeOutsideProject: true, network: true, shell: true, install: true },
          allowNetwork: false,
        },
        docker: {
          image: config.DOCKER_IMAGE || 'node:20-alpine',
          memory: config.DOCKER_MEMORY || '512m',
          network: config.ALLOW_NETWORK ? 'bridge' : 'none',
          timeout: config.COMMAND_TIMEOUT || 60000,
        },
      });
    }

    try {
      logger.dim(`[Sandbox] Executing: ${command.slice(0, 100)}`);
      const result = await this.sandbox.execute(command, { cwd, env, timeout });
      
      let output = result.stdout;
      if (result.stderr) output += '\n\nSTDERR:\n' + result.stderr;
      if (!result.sandboxed) {
        output += '\n\n⚠️ WARNING: Command ran on host (Docker unavailable). Install Docker for sandboxing.';
      }
      return output || '(command completed with no output)';
    } catch (err) {
      throw new Error(`Sandbox execution failed: ${err.message}`);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _workspaceSignature() {
    // Hash file CONTENT, not mtime+size. See EnhancedOrchestrator._snapshotWorkspace
    // for rationale: mtime is unreliable (flips on touch, blind to same-mtime
    // rewrites), which produced false "no filesystem changes detected" warnings.
    try {
      const crypto = require('crypto');
      const files = [];
      const skip = new Set(['.git', 'node_modules', '.seekcode']);

      const walk = dir => {
        if (!fs.existsSync(dir)) return;
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (skip.has(item.name)) continue;
          const abs = path.join(dir, item.name);
          if (item.isDirectory()) {
            walk(abs);
          } else {
            const stat = fs.statSync(abs);
            // Skip huge files (generated artifacts, binaries) to keep this fast;
            // use size as a stable proxy for those. Source edits are small.
            const sig = stat.size > 5 * 1024 * 1024
              ? `size:${stat.size}`
              : crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
            files.push(`${item.name}:${sig}`);
          }
        }
      };

      walk(config.WORKING_DIR);
      return crypto.createHash('sha1').update(files.join(',')).digest('hex');
    } catch {
      return '';
    }
  }

  _getWorkingDirListing() {
    try {
      const excluded = new Set(["node_modules", ".git", "dist", ".next", "build"]);
      const maxEntries = 80;
      const entries = [];

      function walk(dir, depth) {
        if (depth > 3 || entries.length >= maxEntries) return;
        let items;
        try {
          items = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        items.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });
        for (const item of items) {
          if (entries.length >= maxEntries) return;
          if (item.name.startsWith(".") || excluded.has(item.name)) continue;
          if (item.name.endsWith(".lock")) continue;
          const relPath = path.relative(config.WORKING_DIR, path.join(dir, item.name));
          entries.push((item.isDirectory() ? relPath + "/" : relPath));
          if (item.isDirectory()) {
            walk(path.join(dir, item.name), depth + 1);
          }
        }
      }

      walk(config.WORKING_DIR, 1);
      return entries.length > 0 ? entries.join("\n") : "(empty directory)";
    } catch {
      return "(could not read directory)";
    }
  }

  async _saveConversationLog(task, finalResponse) {
    try {
      const logsDir = path.join(os.homedir(), '.deepseek-agent', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const logFile  = path.join(logsDir, `session-${ts}.txt`);
      const content  = [
        `DeepSeek Agent — Session Log`,
        `Date: ${new Date().toISOString()}`,
        `Task: ${task}`,
        `Working Dir: ${config.WORKING_DIR}`,
        '═'.repeat(60),
        this.conversation.exportLog(),
        '',
        '═'.repeat(60),
        'FINAL RESPONSE:',
        finalResponse,
      ].join('\n');

      fs.writeFileSync(logFile, content, 'utf8');
      logger.dim(`Conversation saved: ${logFile}`);
    } catch (err) {
      logger.warn(`Could not save log: ${err.message}`);
    }
  }
}

module.exports = DeepSeekAgent;
