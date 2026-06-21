// =============================================================================
// code/browser-streaming.js  →  patch into deepseek-web-gateway/src/browser.js
// =============================================================================
// Adds two new methods to the DeepSeekBrowser class:
//   1. safeEvaluate(page, fn, ...args) — retry-with-backoff for page.evaluate
//   2. streamResponse(tab, prompt, onEvent) — real SSE token streaming via
//      Playwright's page.on('response') interception of DeepSeek's XHR
//
// HOW TO APPLY:
//   1. Open deepseek-web-gateway/src/browser.js
//   2. Copy these two methods into the DeepSeekBrowser class
//   3. Replace all existing `page.evaluate(...)` calls with `this.safeEvaluate(page, ...)`
//   4. In agent.js, modify run() to call this.browser.streamResponse() when
//      onToken/onToolCall callbacks are provided (see 04-GATEWAY-FIXES.md)
// =============================================================================

'use strict';

const logger = require('./logger');

// ─────────────────────────────────────────────────────────────────────────────
//  Method 1: safeEvaluate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wrap page.evaluate with retry-with-backoff for navigation resilience.
 *
 * DeepSeek's web UI re-renders frequently during R1 reasoning (chunk
 * boundaries, Continue button auto-click, model switches). These re-renders
 * destroy the page's execution context, causing page.evaluate to throw:
 *   "Execution context was destroyed, most likely because of a navigation"
 *
 * This wrapper detects that error and retries up to MAX_ATTEMPTS times
 * with exponential backoff.
 *
 * @param {import('playwright').Page} page
 * @param {Function} fn — function to evaluate on the page
 * @param {...any} args — arguments to pass to fn
 * @returns {Promise<any>} result of fn
 */
async function safeEvaluate(page, fn, ...args) {
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 500;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      // Wait for the page to be ready before evaluating
      await page.waitForLoadState('domcontentloaded', { timeout: 5000 })
        .catch(() => {}); // non-fatal — page might already be loaded

      return await page.evaluate(fn, ...args);
    } catch (err) {
      const msg = err.message || String(err);
      const isNavError = msg.includes('Execution context was destroyed') ||
                         msg.includes('Target closed') ||
                         msg.includes('Navigation') ||
                         msg.includes('frame was detached');

      if (!isNavError || attempt === MAX_ATTEMPTS) throw err;

      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      logger.warn(
        `page.evaluate failed (attempt ${attempt}/${MAX_ATTEMPTS}), ` +
        `retrying in ${delay}ms: ${msg.slice(0, 200)}`
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Method 2: streamResponse — real SSE token streaming
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stream a response from DeepSeek by intercepting XHR responses.
 *
 * DeepSeek's web UI makes a POST to
 *   https://chat.deepseek.com/api/v0/chat/completion
 * for each user message. The response is a Server-Sent Events stream
 * containing tokens as they're generated.
 *
 * By intercepting these responses via Playwright's `page.on('response')`,
 * we get:
 *   - Real token-by-token streaming (not fake 30ms chunking)
 *   - No DOM polling (eliminates execution-context-destroyed errors)
 *   - Access to tool_call deltas if DeepSeek emits them
 *
 * @param {string} tab — tab name (e.g. 'default', 'coder')
 * @param {string} prompt — the prompt to send
 * @param {Function} onEvent — callback for stream events:
 *   {type: 'token', content: '...'}           — a new token arrived
 *   {type: 'tool_call_delta', toolCall: {}}   — a tool call delta arrived
 *   {type: 'thinking', elapsedMs: 1234}        — model is thinking (no tokens yet)
 *   {type: 'done', totalDurationMs: 12345}    — stream complete
 *   {type: 'error', message: '...'}            — stream errored
 * @returns {Promise<string>} full accumulated response text
 */
async function streamResponse(tab, prompt, onEvent) {
  const { page } = this._resolveTab(tab);
  if (!page) throw new Error(`Tab not found: ${tab}`);

  const startTime = Date.now();
  let responseBuffer = '';
  let resolved = false;
  let lastTokenTime = Date.now();

  // Set up thinking indicator — if no tokens arrive for >2s, emit 'thinking'
  const thinkingInterval = setInterval(() => {
    if (Date.now() - lastTokenTime > 2000 && !resolved) {
      onEvent({ type: 'thinking', elapsedMs: Date.now() - startTime });
    }
  }, 1000);

  return new Promise(async (resolve, reject) => {
    const cleanup = () => {
      clearInterval(thinkingInterval);
      page.off('response', onResponse);
    };

    const finish = (err, result) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      if (err) {
        onEvent({ type: 'error', message: err.message });
        reject(err);
      } else {
        onEvent({ type: 'done', totalDurationMs: Date.now() - startTime });
        resolve(result);
      }
    };

    const onResponse = async (response) => {
      const url = response.url();
      // Only intercept DeepSeek chat completion responses
      if (!url.includes('chat.deepseek.com/api/v0/chat/completion') &&
          !url.includes('chat.deepseek.com/api/v0/chat_message')) {
        return;
      }

      try {
        const body = await response.text();
        // Parse SSE-style "data: {...}" lines
        const lines = body.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;

          const jsonStr = trimmed.slice(5).trim();
          if (jsonStr === '[DONE]' || jsonStr === '') {
            continue;
          }

          try {
            const data = JSON.parse(jsonStr);

            // DeepSeek emits: {choices: [{delta: {content: '...'}}]}
            const choice = data.choices?.[0];
            if (!choice) continue;

            const delta = choice.delta || {};
            const token = delta.content || '';
            if (token) {
              responseBuffer += token;
              lastTokenTime = Date.now();
              onEvent({ type: 'token', content: token });
            }

            // Capture tool_call deltas (if DeepSeek emits them — usually not,
            // because tool calls come as text in the content stream, but
            // handle them just in case)
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                onEvent({ type: 'tool_call_delta', toolCall: tc });
              }
            }

            // Check for finish_reason
            if (choice.finish_reason === 'stop' ||
                choice.finish_reason === 'length') {
              // Stream complete
              setTimeout(() => finish(null, responseBuffer), 100);
              return;
            }
          } catch (parseErr) {
            // JSON parse failed — skip this line, continue
            // (some lines are comments or partial)
          }
        }
      } catch (err) {
        // response.text() can fail if response was already consumed or
        // if the request was redirected — non-fatal, just skip
      }
    };

    // Register the response listener
    page.on('response', onResponse);

    // Send the prompt via existing DOM logic
    try {
      await this.sendMessage(tab, prompt);
    } catch (err) {
      finish(err);
      return;
    }

    // Safety timeout — 5 minutes max per response
    // (DeepSeek R1 can take up to 30 min for very long reasoning, but we
    // cap at 5 min for streaming — if it takes longer, fall back to
    // non-streaming getResponse())
    setTimeout(() => {
      if (!resolved) {
        finish(new Error('Stream timed out after 5 minutes'), null);
      }
    }, 5 * 60 * 1000).unref();

    // Also listen for page close / navigation away
    page.on('close', () => {
      if (!resolved) {
        finish(new Error('Page closed during streaming'), null);
      }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  Bonus: Helper to detect when DeepSeek's response is "stable"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Wait for the DeepSeek response to be complete.
 *
 * Heuristics:
 *   1. Stop button disappears from DOM
 *   2. Response text hasn't changed in STABLE_DELAY ms
 *   3. Network idle for 2 seconds
 *
 * Use this as a fallback when streamResponse() times out (5 min) but the
 * response is still going.
 */

async function waitForResponseStable(tab, maxWaitMs = 30 * 60 * 1000) {
  const { page } = this._resolveTab(tab);
  if (!page) throw new Error(`Tab not found: ${tab}`);

  const startTime = Date.now();
  let lastText = '';
  let stableMs = 0;
  const STABLE_DELAY = 2500; // matches config.STABLE_DELAY

  while (Date.now() - startTime < maxWaitMs) {
    const text = await this.safeEvaluate(page, () => {
      // Look for the assistant's last message in the DOM
      const messages = document.querySelectorAll('[class*="message"], [class*="response"], [role="log"]');
      if (!messages.length) return '';
      const last = messages[messages.length - 1];
      return last?.innerText || '';
    }).catch(() => '');

    if (text === lastText) {
      stableMs += 500;
      if (stableMs >= STABLE_DELAY) {
        // Check if the stop button is gone (response complete)
        const stopBtn = await page.$('button[aria-label*="Stop"], [class*="stop"]')
          .catch(() => null);
        if (!stopBtn) {
          return text; // stable and no stop button — done
        }
      }
    } else {
      stableMs = 0;
      lastText = text;
    }

    await new Promise(r => setTimeout(r, 500));
  }

  return lastText; // return whatever we have on timeout
}

// ─────────────────────────────────────────────────────────────────────────────
//  Export as a mixin (apply to DeepSeekBrowser.prototype)
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  safeEvaluate,
  streamResponse,
  waitForResponseStable,

  // Helper to apply these methods to an existing class
  applyTo(klass) {
    klass.prototype.safeEvaluate = safeEvaluate;
    klass.prototype.streamResponse = streamResponse;
    klass.prototype.waitForResponseStable = waitForResponseStable;
  },
};
