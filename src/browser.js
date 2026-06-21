// src/browser.js — Playwright controller for chat.deepseek.com
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');
const browserPool = require('./shared-browser-pool');

// Global error boundary for browser.js
process.on('unhandledRejection', (reason, promise) => {
  // Defer handling to main orchestrator or ignore non-fatal resets
  if (reason.message?.includes('browser') || reason.message?.includes('context')) {
    logger.warn('🔄 Browser rejection caught in global boundary: ' + reason.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
//  Selector banks — ordered by likelihood, with fallbacks
//  We never depend on a single selector; DeepSeek's UI can change.
// ─────────────────────────────────────────────────────────────────────────────

const SEL = {
  chatInput: [
    '#chat-input',
    'textarea[placeholder]',
    'textarea',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
  ],
  sendButton: [
    'button[aria-label*="Send" i]',
    'button[aria-label*="send" i]',
    '[data-testid="send-button"]',
    'button[type="submit"]',
    '[class*="send-btn"]',
    '[class*="sendBtn"]',
    '[class*="send-button"]',
  ],
  continueButton: [
    'button[id*="continue" i]',
    'button[class*="continue" i]',
    '[data-testid*="continue" i]',
    // DeepSeek renders a plain button with exactly this text
    'button',  // fallback: scanned by text content below
  ],
  stopButton: [
    'button[aria-label*="Stop" i]',
    '[aria-label*="stop generating" i]',
    '[data-testid="stop-button"]',
    '[class*="stop-btn"]',
    '[class*="stopBtn"]',
  ],
  newChat: [
    'button[aria-label*="New chat" i]',
    'button[aria-label*="New conversation" i]',
    'a[href="/"][aria-label]',
    '[data-testid="new-chat"]',
    '[class*="new-chat"]',
    '[class*="newChat"]',
  ],
  messageContainer: [
    '[class*="chat-content"]',
    '[class*="message-list"]',
    '[class*="conversation"]',
    'main',
  ],
};

// ─────────────────────────────────────────────────────────────────────────────
//  DeepSeekBrowser class
// ─────────────────────────────────────────────────────────────────────────────

class DeepSeekBrowser {
  constructor() {
    this.context = null;
    this.pages = new Map(); // tabName -> Playwright Page object
    this.adaptiveSelectors = new Map(); // tabName -> AdaptiveSelector object
    this.activeTab = 'default';
    this._closed = false;
    this._crashRecovering = new Set(); // tabs currently in crash recovery
  }

  get page() {
    return this.pages.get(this.activeTab) || null;
  }

  set page(val) {
    if (val) {
      this.pages.set(this.activeTab, val);
    }
  }

  get adaptiveSelector() {
    if (!this.page) return null;
    if (!this.adaptiveSelectors.has(this.activeTab)) {
      const { AdaptiveSelector } = require('./adaptive-selectors');
      this.adaptiveSelectors.set(this.activeTab, new AdaptiveSelector(this.page));
    }
    return this.adaptiveSelectors.get(this.activeTab);
  }

  _resolveTab(tabName) {
    const tab = tabName || this.activeTab;
    const page = this.pages.get(tab);
    if (!page) {
      throw new Error(`Tab "${tab}" not found/initialized.`);
    }
    let selector = this.adaptiveSelectors.get(tab);
    if (!selector) {
      const { AdaptiveSelector } = require('./adaptive-selectors');
      selector = new AdaptiveSelector(page);
      this.adaptiveSelectors.set(tab, selector);
    }
    return { page, adaptiveSelector: selector };
  }

  // ── Safe evaluate wrappers ────────────────────────────────────────────────
  // DeepSeek re-renders chunks mid-stream (auto-clicked "Continue", R1 chunk
  // boundaries, model switches). That destroys page.evaluate's execution
  // context mid-call → "Execution context was destroyed" / "Target closed".
  // These wrappers retry-with-backoff so a transient reflow doesn't crash a
  // 30-minute run. Strategy: wait for DOM readiness, evaluate, retry on nav
  // errors up to MAX_ATTEMPTS times.

  static _isNavError(err) {
    const msg = String(err && err.message || err);
    return /Execution context was destroyed|Target closed|Navigation|frame was detached/i.test(msg);
  }

  async safeEvaluate(page, fn, ...args) {
    const MAX_ATTEMPTS = 3;
    const BASE_DELAY_MS = 500;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // Wait for the page to settle before evaluating. Non-fatal — if the
        // page is gone entirely, the evaluate below will throw a catchable err.
        if (page && typeof page.waitForLoadState === 'function') {
          await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        }
        return await page.evaluate(fn, ...args);
      } catch (err) {
        lastErr = err;
        if (!DeepSeekBrowser._isNavError(err) || attempt === MAX_ATTEMPTS) throw err;
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn(`page.evaluate failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${delay}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  /** ElementHandle-scoped variant — same retry semantics for `el.evaluate(...)`. */
  async safeElementEvaluate(el, fn, ...args) {
    const MAX_ATTEMPTS = 3;
    const BASE_DELAY_MS = 500;
    let lastErr;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await el.evaluate(fn, ...args);
      } catch (err) {
        lastErr = err;
        // If the element is detached/gone, retrying won't help — bail now.
        if (!DeepSeekBrowser._isNavError(err) || attempt === MAX_ATTEMPTS) throw err;
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        logger.warn(`element.evaluate failed (attempt ${attempt}/${MAX_ATTEMPTS}), retrying in ${delay}ms: ${err.message}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw lastErr;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async launch() {
    if (this.context && !this._closed) {
      if (!this.pages.has('default')) {
        const defaultPage = await this.context.newPage();
        this.pages.set('default', defaultPage);
        this.activeTab = 'default';
        await defaultPage.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        this._attachCrashRecovery('default', defaultPage);
        await this._navigate(config.DEEPSEEK_URL);
        await this._ensureLoggedIn();
      }
      return;
    }

    this.context = await browserPool.acquire();
    this._usesSharedContext = true;

    // Each agent gets its own tab — never reuse another session's page.
    const defaultPage = await this.context.newPage();
    this.pages.set('default', defaultPage);
    this.activeTab = 'default';

    // Mask automation signals
    await defaultPage.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Attach crash / close recovery
    this._attachCrashRecovery('default', defaultPage);

    await this._navigate(config.DEEPSEEK_URL);
    const needsLogin = await this._ensureLoggedIn();

    // Save cookies after login
    if (needsLogin) {
      const sessionDir = path.resolve(config.SESSION_DIR);
      const cookiesFile = path.join(sessionDir, 'cookies.json');
      const newCookies = await this.context.cookies();
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(cookiesFile, JSON.stringify(newCookies, null, 2), 'utf8');
      logger.success('Cookies saved for next run');
    }

    logger.success('Browser ready!');
  }

  // ── Crash / Close Recovery ─────────────────────────────────────────────────

  /**
   * Attach crash and unexpected-close listeners to a Playwright page.
   * On crash: silently recreate the tab and navigate back to DeepSeek.
   */
  _attachCrashRecovery(tabName, page) {
    const recover = async (reason) => {
      if (this._closed) return;
      if (this._crashRecovering.has(tabName)) return; // already recovering
      this._crashRecovering.add(tabName);

      logger.warn(`⚠️  Page crash/close detected on tab "${tabName}" (${reason}) — auto-recovering...`);

      try {
        // Discard the dead page
        this.pages.delete(tabName);
        this.adaptiveSelectors.delete(tabName);

        // Open a fresh page in the same persistent context
        const newPage = await this.context.newPage();
        await newPage.addInitScript(() => {
          Object.defineProperty(navigator, 'webdriver', { get: () => false });
        });
        this.pages.set(tabName, newPage);

        // Re-attach listeners on the new page
        this._attachCrashRecovery(tabName, newPage);

        // Navigate back and verify login (cookies persist in the context)
        await this._navigate(config.DEEPSEEK_URL);
        await newPage.waitForTimeout(2_000);
        const stillLoggedIn = !(await this._ensureLoggedIn());

        if (stillLoggedIn) {
          logger.success(`✅  Tab "${tabName}" recovered successfully.`);
        } else {
          logger.warn(`Tab "${tabName}" recovered but login was required again.`);
        }
      } catch (err) {
        logger.error(`❌  Recovery failed for tab "${tabName}": ${err.message}`);
      } finally {
        this._crashRecovering.delete(tabName);
      }
    };

    page.on('crash', () => recover('crash'));
    // 'close' fires on unexpected closes (not on intentional context.close())
    page.on('close', () => { if (!this._closed) recover('unexpected close'); });
  }

  async close() {
    if (this._closed) return;
    this._closed = true;

    for (const [, page] of this.pages.entries()) {
      try {
        if (!page.isClosed()) await page.close();
      } catch { /* page may already be gone */ }
    }
    this.pages.clear();
    this.adaptiveSelectors.clear();

    if (this._usesSharedContext) {
      this.context = null;
      await browserPool.release();
      return;
    }

    try { await this.context?.close(); } catch { }
    this.context = null;
  }

  async switchTab(tabName) {
    if (!tabName) return;
    logger.info(`Switching browser tab to: ${tabName}`);
    if (!this.pages.has(tabName)) {
      logger.info(`Creating new tab/thread for: ${tabName}`);
      const newPage = await this.context.newPage();
      // Mask automation signals
      await newPage.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
      this.pages.set(tabName, newPage);
      this.activeTab = tabName;
      // Attach crash recovery on new tab too
      this._attachCrashRecovery(tabName, newPage);
      // Navigate and start new chat
      await this._navigate(config.DEEPSEEK_URL, tabName);
      await this.newChat(tabName);
    } else {
      this.activeTab = tabName;
      const page = this.pages.get(tabName);
      await page.bringToFront();
    }
  }

  async selectModel(tabName, modelName) {
    if (!modelName) return;
    logger.info(`Configuring model for tab ${tabName}: ${modelName}`);
    await this.switchTab(tabName);
    const { page } = this._resolveTab(tabName);
    try {
      const isR1 = modelName.toUpperCase().includes('R1');
      const targetLabel = isR1 ? 'DeepSeek-R1' : 'DeepSeek-V3';
      
      // ── New Tab/Toggle UI check (Instant/Expert & DeepThink) ────────────────
      const hasTabs = await this.safeEvaluate(page, () => {
        return !!Array.from(document.querySelectorAll('button, div, span')).find(e => 
          e.textContent?.trim() === 'Expert' || e.textContent?.trim() === 'Instant'
        );
      });
      
      if (hasTabs) {
        logger.dim(`Detected Tab/Toggle model selection UI on tab ${tabName}`);
        
        // 1. Resolve current active mode (Instant vs Expert)
        const currentMode = await this.safeEvaluate(page, () => {
          const text = document.body.innerText || '';
          if (text.includes('Start chatting with Expert')) return 'Expert';
          if (text.includes('Start chatting with Instant')) return 'Instant';
          if (text.includes('Start chatting with Vision')) return 'Vision';
          
          // Fallback: search classes
          const buttons = Array.from(document.querySelectorAll('button, div, span'));
          for (const name of ['Instant', 'Expert', 'Vision']) {
            const btn = buttons.find(e => e.textContent?.trim() === name || e.innerText?.trim() === name);
            if (btn) {
              const pill = btn.closest('button') || btn.closest('[role="button"]') || btn;
              if (pill.getAttribute('aria-checked') === 'true' || 
                  pill.getAttribute('aria-selected') === 'true' ||
                  pill.classList.contains('active') ||
                  pill.classList.contains('selected')) {
                return name;
              }
            }
          }
          return null;
        });
        
        // Always use Instant — Expert mode does not expose file upload controls.
        const targetMode = 'Instant';
        if (currentMode !== targetMode) {
          logger.info(`Switching mode from ${currentMode || 'unknown'} to ${targetMode}`);
          const modeBtn = page.locator('button, div, span').filter({ hasText: new RegExp(`^${targetMode}$`, 'i') }).first();
          if (await modeBtn.count() > 0) {
            await modeBtn.click();
            await page.waitForTimeout(1000);
          }
        }

        // 2. Enable thinking in Instant mode (replaces Expert-mode R1 reasoning)
        const THINKING_LABELS = ['DeepThink', 'Thinking'];

        const checkThinkingActive = async () => {
          return await this.safeEvaluate(page, (labels) => {
            const el = Array.from(document.querySelectorAll('button, div, span')).find(e => {
              const text = (e.textContent || e.innerText || '').trim();
              return labels.includes(text);
            });
            if (!el) return null;

            const btn = el.closest('button') || el.closest('[role="button"]') || el;
            const style = window.getComputedStyle(btn);
            const bg = style.backgroundColor || '';
            const isBlue = bg.includes('rgb(') && (() => {
              const match = bg.match(/\d+/g);
              if (match && match.length >= 3) {
                const r = parseInt(match[0]);
                const g = parseInt(match[1]);
                const b = parseInt(match[2]);
                return b > r && b > 100;
              }
              return false;
            })();

            const hasCheckedAttr = btn.getAttribute('aria-checked') === 'true' ||
                                   btn.getAttribute('aria-selected') === 'true' ||
                                   btn.classList.contains('active') ||
                                   btn.classList.contains('checked') ||
                                   btn.classList.contains('selected');

            return isBlue || hasCheckedAttr;
          }, THINKING_LABELS);
        };

        const shouldThinkingBeActive = isR1;
        const thinkingActive = await checkThinkingActive();

        if (thinkingActive === null && shouldThinkingBeActive) {
          logger.warn('Thinking toggle not found on page after switching to Instant mode');
        } else if (thinkingActive !== null && thinkingActive !== shouldThinkingBeActive) {
          logger.info(`Toggling thinking to ${shouldThinkingBeActive ? 'ON' : 'OFF'} in Instant mode`);
          const thinkBtn = page.locator('button, div, span').filter({
            hasText: new RegExp(`^(${THINKING_LABELS.join('|')})$`, 'i'),
          }).first();
          if (await thinkBtn.count() > 0) {
            await thinkBtn.click();
            await page.waitForTimeout(1000);
          }
        }

        logger.success(`Switched model on tab ${tabName} to ${targetLabel} (${targetMode} mode, Thinking: ${shouldThinkingBeActive ? 'ON' : 'OFF'})`);
        return;
      }
      
      // ── Dropdown UI Fallback ────────────────────────────────────────────────
      // Look for the model selection dropdown button
      const dropdown = await page.locator('div, button').filter({ hasText: /DeepSeek-V3|DeepSeek-R1/ }).first();
      if (await dropdown.count() > 0) {
        const text = await dropdown.innerText();
        if (text.includes(targetLabel)) {
          logger.dim(`Model on tab ${tabName} is already set to ${targetLabel}`);
          return;
        }
        
        await dropdown.click();
        await page.waitForTimeout(600);
        
        const option = await page.locator('div, li, span').filter({ hasText: new RegExp(targetLabel, 'i') }).first();
        if (await option.count() > 0) {
          await option.click();
          await page.waitForTimeout(1000);
          logger.success(`Switched model on tab ${tabName} to ${targetLabel} via dropdown`);
        } else {
          logger.warn(`Could not find dropdown option for ${targetLabel}`);
          await page.keyboard.press('Escape');
        }
      } else {
        logger.warn('Could not locate model switcher dropdown or tabs on page');
      }
    } catch (err) {
      logger.warn(`Failed to switch model: ${err.message}`);
    }
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  async _navigate(url, tabName) {
    const { page } = this._resolveTab(tabName);
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await page.waitForTimeout(1_500);
    } catch (err) {
      logger.warn(`Navigation warning on tab ${tabName}: ${err.message}`);
    }
  }

  async newChat(tabName) {
    // Normalise: if caller passed nothing, resolve against the active tab
    tabName = tabName || this.activeTab || 'default';
    const { page, adaptiveSelector } = this._resolveTab(tabName);
    if (adaptiveSelector) {
      const el = await adaptiveSelector.findElement('newChat');
      if (el && await el.isVisible()) {
        await el.click();
        await page.waitForTimeout(1_000);
        logger.dim(`Started new chat session via adaptive selector on tab ${tabName}`);
        return;
      }
    }

    try {
      for (const sel of SEL.newChat) {
        try {
          const el = await page.$(sel);
          if (el && await el.isVisible()) {
            await el.click();
            await page.waitForTimeout(1_000);
            logger.dim(`Started new chat session on tab ${tabName}`);
            return;
          }
        } catch { }
      }
    } catch { }

    await this._navigate(config.DEEPSEEK_URL, tabName);
    logger.dim(`Navigated to DeepSeek home (new chat) on tab ${tabName}`);
  }

  // ── Login handling ─────────────────────────────────────────────────────────

  async _ensureLoggedIn(tabName) {
    const { page } = this._resolveTab(tabName);
    await page.waitForTimeout(2_000);

    const needsLogin = await this.safeEvaluate(page, () => {
      const url = window.location.href;
      const bodyText = document.body?.innerText || '';
      return (
        url.includes('/auth') ||
        url.includes('/login') ||
        url.includes('/sign') ||
        bodyText.includes('Sign in') ||
        bodyText.includes('Log in') ||
        !!document.querySelector('input[type="password"]')
      );
    });

    if (needsLogin) {
      this._printLoginBanner();
      await this._waitForEnter();
      await page.waitForTimeout(2_000);
    }

    return needsLogin;
  }

  _printLoginBanner() {
    console.log('');
    logger.warn('╔══════════════════════════════════════════════╗');
    logger.warn('║  🔐  LOGIN REQUIRED                          ║');
    logger.warn('║                                              ║');
    logger.warn('║  1. Log in to DeepSeek in the browser window ║');
    logger.warn('║  2. Return here and press  ENTER  to continue║');
    logger.warn('╚══════════════════════════════════════════════╝');
    console.log('');
  }

  async _waitForEnter() {
    return new Promise(resolve => {
      const stdin = process.stdin;
      const wasRaw = stdin.isRaw;
      const wasPaused = !stdin.readable;

      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.resume();

      const handler = chunk => {
        const s = chunk.toString();
        if (s.includes('\n') || s.includes('\r')) {
          stdin.removeListener('data', handler);
          if (stdin.isTTY && wasRaw) stdin.setRawMode(true);
          if (wasPaused) stdin.pause();
          resolve();
        }
      };

      stdin.on('data', handler);
    });
  }

  // ── Sending Messages ───────────────────────────────────────────────────────

  async sendMessage(text, tabName) {
    const { page } = this._resolveTab(tabName);
    const { el, isTextarea } = await this._findInput(tabName);

    await el.click({ force: true });
    await page.waitForTimeout(200);

    await page.keyboard.press('Control+a');
    await page.waitForTimeout(100);

    if (isTextarea) {
      await el.fill(text);
    } else {
      await this.safeEvaluate(page, (element, content) => {
        element.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, content);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: content }));
      }, el, text);
    }

    await page.waitForTimeout(config.SEND_DELAY);

    const clicked = await this._clickSendButton(tabName);
    if (!clicked) {
      await page.keyboard.press('Enter');
    }

    await page.waitForTimeout(500);
  }

  async _findInput(tabName) {
    const { page, adaptiveSelector } = this._resolveTab(tabName);
    if (adaptiveSelector) {
      const el = await adaptiveSelector.findElement('chatInput');
      if (el) {
        const tagName = await this.safeElementEvaluate(el, e => e.tagName.toLowerCase());
        const isContentEditable = await this.safeElementEvaluate(el, e => e.isContentEditable);
        return { el, isTextarea: tagName === 'textarea' && !isContentEditable };
      }
    }

    for (const sel of SEL.chatInput) {
      try {
        const el = await page.waitForSelector(sel, { timeout: 4_000, state: 'visible' });
        if (!el) continue;
        const tagName = await this.safeElementEvaluate(el, e => e.tagName.toLowerCase());
        const isContentEditable = await this.safeElementEvaluate(el, e => e.isContentEditable);
        return { el, isTextarea: tagName === 'textarea' && !isContentEditable };
      } catch { }
    }
    throw new Error(
      'Cannot find the DeepSeek chat input box.\n' +
      '  → Make sure the page is fully loaded and you are logged in.\n' +
      '  → Run with --debug to inspect DOM selectors.\n' +
      '  → Run: node src/calibrate.js to auto-detect selectors.'
    );
  }

  async _clickSendButton(tabName) {
    const { page, adaptiveSelector } = this._resolveTab(tabName);
    if (adaptiveSelector) {
      const el = await adaptiveSelector.findElement('sendButton');
      if (el && await el.isVisible() && await el.isEnabled()) {
        await el.click();
        return true;
      }
    }

    for (const sel of SEL.sendButton) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible() && await el.isEnabled()) {
          await el.click();
          return true;
        }
      } catch { }
    }
    return false;
  }

  // ── Waiting for Response ───────────────────────────────────────────────────

  /**
   * Clicks the DeepSeek "Continue" button if it is visible.
   * Returns true if the button was found and clicked.
   */
  async _clickContinueIfPresent(tabName) {
    const { page } = this._resolveTab(tabName);
    try {
      // Strategy 1: scan all visible buttons for exact "Continue" text
      const found = await this.safeEvaluate(page, () => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          const txt = (btn.innerText || btn.textContent || '').trim();
          if (
            (txt === 'Continue' || txt === 'Continue generating') &&
            btn.offsetParent !== null // visible
          ) {
            btn.click();
            return true;
          }
        }
        return false;
      });
      if (found) return true;

      // Strategy 2: aria-label / data-testid variants
      for (const sel of [
        'button[aria-label*="continue" i]',
        '[data-testid*="continue" i]',
        '[class*="continue-btn"]',
        '[class*="continueBtn"]',
      ]) {
        try {
          const el = await page.$(sel);
          if (el && await el.isVisible()) {
            await el.click();
            return true;
          }
        } catch { }
      }
    } catch (err) {
      logger.warn(`_clickContinueIfPresent error: ${err.message}`);
    }
    return false;
  }

  /**
   * Wait for the DeepSeek model to finish responding.
   * Handles mid-response "Continue" buttons transparently by clicking them
   * and accumulating all chunks into a single seamless string.
   */
  async waitForResponse(tabName) {
    const { page } = this._resolveTab(tabName);
    const timeout    = config.RESPONSE_TIMEOUT;
    const stableDelay = config.STABLE_DELAY;
    const start      = Date.now();

    // ── Wait for the first new assistant message to appear ────────────────
    const initialCount = await this._getMessageCount(tabName);
    let appeared = false;
    while (Date.now() - start < 15_000) {
      const count = await this._getMessageCount(tabName);
      if (count > initialCount) { appeared = true; break; }
      await page.waitForTimeout(400);
    }
    if (!appeared) logger.warn('Response may have been delayed — continuing to wait...');

    // ── Main accumulation loop — no hard round cap, bounded by total timeout ─
    let accumulatedText = '';
    let continueRound  = 0;

    while (true) {
      // ── Inner stability loop: wait until this segment stops streaming ────
      let lastText   = '';
      let stableStart = null;
      let dotCount   = 0;

      while (Date.now() - start < timeout) {
        const text = await this._extractLastMessage(tabName);

        if (text !== lastText) {
          lastText    = text;
          stableStart = null;
        } else if (text.length > 0) {
          if (!stableStart) {
            stableStart = Date.now();
          } else if (Date.now() - stableStart >= stableDelay) {
            if (!await this._isGenerating(tabName)) break; // generation truly stopped
            stableStart = null; // still streaming — reset stability timer
          }
        }

        dotCount = (dotCount + 1) % 4;
        const totalKB = (accumulatedText.length / 1024).toFixed(1);
        logger.thinking(
          `Receiving response [Tab: ${tabName || 'default'}]${'.'.repeat(dotCount)}  (${text.length} chars this segment` +
          (continueRound > 0 ? `, ${totalKB} KB total across ${continueRound + 1} parts` : '') + ')'
        );
        await page.waitForTimeout(500);
      }
      logger.clearLine();

      // ── Snapshot the DOM text length BEFORE clicking Continue ────────────
      // This is the anchor we diff against after the next chunk settles,
      // regardless of whether DeepSeek appends in-place or re-renders.
      const domTextAfterSettle = this._cleanText(await this._extractLastMessage(tabName));
      const anchorLength       = accumulatedText.length; // chars accumulated so far

      if (continueRound === 0) {
        // First segment — take everything
        accumulatedText = domTextAfterSettle;
      } else {
        // Subsequent segments — the DOM may return the full message or just the
        // new segment. Either way, take whatever is beyond our anchor.
        const newFromDom = domTextAfterSettle.slice(anchorLength);
        if (newFromDom.trim().length > 0) {
          accumulatedText += newFromDom;
          logger.info(`Appended ${newFromDom.length} chars from continue-round ${continueRound} (total: ${(accumulatedText.length / 1024).toFixed(1)} KB)`);
        }
      }

      // ── Let the UI fully settle, then look for Continue button ──────────
      await page.waitForTimeout(1_000);
      const clicked = await this._clickContinueIfPresent(tabName);
      if (!clicked) break; // no Continue button — response is complete

      continueRound++;
      logger.info(`⏩ Clicked "Continue" (part ${continueRound + 1}) — waiting for next segment...`);

      // Wait for the new segment to start streaming before re-entering the loop
      await page.waitForTimeout(2_000);

      // Safety: bail if we've been running longer than the total timeout
      if (Date.now() - start >= timeout) {
        logger.warn(`Total response timeout (${timeout}ms) reached after ${continueRound} continuation(s).`);
        break;
      }
    }

    if (continueRound > 0) {
      const kb = (accumulatedText.length / 1024).toFixed(1);
      logger.success(`✅ Response fully assembled [Tab: ${tabName || 'default'}]: ${continueRound + 1} segment(s), ${kb} KB total`);
    }

    return accumulatedText;
  }

  // ── Streaming Response (real SSE via XHR interception) ─────────────────────
  //
  // streamResponse(tabName, text, onEvent):
  //   Sends `text` via the DOM, then listens for DeepSeek's chat-completion XHR
  //   and emits {type:'token'|'thinking'|'done', ...} events. Returns the full
  //   accumulated assistant text. Use this for the FIRST turn of a run (it sends
  //   + receives).
  //
  // streamListen(tabName, onEvent):
  //   Listen-only variant for SUBSEQUENT turns — assumes the caller has already
  //   sent the feedback message via sendMessage(). Same events, same fallback.
  //
  // Robustness: if no matching XHR is observed within XHR_GRACE_MS, both fall
  // back to DOM-polling via waitForResponse() and emit the whole thing as a
  // single token — so callers always get *some* streaming, never a silent hang
  // when DeepSeek changes their endpoint.

  async streamResponse(tabName, text, onEvent) {
    const XHR_GRACE_MS = 8000;
    const { page } = this._resolveTab(tabName);

    // Set up listeners BEFORE sending so we don't miss the first chunk.
    const ctx = this._startXhrListener(page, onEvent);

    try {
      this._streamSendStart = Date.now();
      await this.sendMessage(text, tabName);
      if (onEvent) onEvent({ type: 'thinking', reason: 'sent' });
    } catch (err) {
      ctx.cleanup();
      throw err;
    }

    return await this._finishStream(page, tabName, ctx, onEvent, XHR_GRACE_MS);
  }

  /** Listen-only variant — caller has already sent the message via sendMessage(). */
  async streamListen(tabName, onEvent) {
    const XHR_GRACE_MS = 8000;
    const { page } = this._resolveTab(tabName);
    this._streamSendStart = Date.now(); // anchor for the grace-window fallback
    const ctx = this._startXhrListener(page, onEvent);
    return await this._finishStream(page, tabName, ctx, onEvent, XHR_GRACE_MS);
  }

  /** Wire up request/response listeners filtered to the completion endpoint. */
  _startXhrListener(page, onEvent) {
    const COMPLETION_URL_RE = /chat\.deepseek\.com\/api\/v\d+\.\d+\/chat\/completion/;
    const state = { accumulated: '', captured: false, resolved: false, bodyBuffer: '', requestSeen: false };

    const onResponse = async (response) => {
      const url = response.url();
      if (!COMPLETION_URL_RE.test(url)) return;
      state.captured = true;
      try {
        const body = await response.text();
        state.bodyBuffer += body;
        const parsed = this._parseCompletionBody(state.bodyBuffer);
        if (parsed.text && parsed.text.length > state.accumulated.length) {
          const delta = parsed.text.slice(state.accumulated.length);
          state.accumulated = parsed.text;
          if (onEvent && delta.length > 0) onEvent({ type: 'token', content: delta });
        }
        if (parsed.done && !state.resolved) state.resolved = true;
      } catch (err) {
        logger.dim(`XHR body read error (non-fatal): ${err.message}`);
      }
    };
    const onRequest = (request) => {
      if (COMPLETION_URL_RE.test(request.url())) state.requestSeen = true;
    };

    page.on('response', onResponse);
    page.on('request', onRequest);

    const cleanup = () => {
      try { page.off('response', onResponse); } catch {}
      try { page.off('request', onRequest); } catch {}
    };
    return { state, cleanup };
  }

  /** Wait for the stream to finish (or fall back to DOM polling). */
  async _finishStream(page, tabName, ctx, onEvent, graceMs) {
    const { state, cleanup } = ctx;
    const deadline = Date.now() + (config.RESPONSE_TIMEOUT || 5 * 60_000);
    let xhrTimedOut = false;

    while (!state.resolved && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 200));
      const elapsed = Date.now() - (this._streamSendStart || Date.now());
      // Grace-window fallback: no matching XHR observed → bail to DOM polling.
      if (!state.captured && !state.requestSeen && elapsed > graceMs) {
        xhrTimedOut = true; break;
      }
      // Safety: request seen but no body in 30s → give up on XHR path.
      if (state.requestSeen && !state.captured && elapsed > 30_000) {
        xhrTimedOut = true; break;
      }
    }
    cleanup();

    let finalText;

    if (state.captured && !xhrTimedOut) {
      // XHR path succeeded — pick up any DOM tail beyond what XHR carried.
      try {
        const domTail = await this._extractLastMessage(tabName);
        if (domTail && domTail.length > state.accumulated.length) {
          const delta = domTail.slice(state.accumulated.length);
          if (delta.trim().length > 0 && onEvent) onEvent({ type: 'token', content: delta });
          finalText = domTail;
        } else {
          finalText = state.accumulated;
        }
      } catch {
        finalText = state.accumulated;
      }
      if (onEvent) onEvent({ type: 'done', totalChars: finalText.length });
      return finalText;
    }

    // Fallback: DOM polling.
    logger.warn(`XHR stream not observed within ${graceMs}ms — falling back to DOM polling for [Tab: ${tabName || 'default'}]`);
    if (onEvent) onEvent({ type: 'thinking', reason: 'dom_poll_fallback' });
    finalText = await this.waitForResponse(tabName);
    if (onEvent) {
      onEvent({ type: 'token', content: finalText });
      onEvent({ type: 'done', totalChars: finalText.length, fallback: true });
    }
    return finalText;
  }

  /**
   * Parse a DeepSeek completion response body. Handles two shapes:
   *   1. SSE stream: "data: {json}\ndata: {json}\ndata: [DONE]\n\n"
   *   2. Plain JSON: { choices: [{ message: { content } }], ... }
   * Returns { text: string, done: boolean }.
   */
  _parseCompletionBody(body) {
    let text = '';
    let done = false;

    const lines = body.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') { done = true; continue; }
      if (!payload) continue;
      try {
        const obj = JSON.parse(payload);
        // OpenAI-style: choices[0].delta.content (streaming) or .message.content (final)
        const choice = obj.choices && obj.choices[0];
        if (!choice) continue;
        const delta = choice.delta || choice.message || {};
        if (typeof delta.content === 'string' && delta.content.length > 0) {
          text += delta.content;
        }
        if (choice.finish_reason || obj.done) done = true;
      } catch {
        // Not JSON — skip. (Could be a keep-alive comment.)
      }
    }

    // If no SSE lines matched, try parsing the whole body as a single JSON object.
    if (!text && !done) {
      try {
        const obj = JSON.parse(body);
        const choice = obj.choices && obj.choices[0];
        if (choice) {
          const msg = choice.message || choice.delta || {};
          if (typeof msg.content === 'string') text = msg.content;
          if (choice.finish_reason || obj.done) done = true;
        }
      } catch {
        // Not JSON at all — leave text empty.
      }
    }

    return { text, done };
  }

  // ── DOM Extraction ─────────────────────────────────────────────────────────

  async _getMessageCount(tabName) {
    const { page } = this._resolveTab(tabName);
    return await this.safeEvaluate(page, () => {
      const candidates = [
        '[class*="assistant"][class*="message"]',
        '[data-role="assistant"]',
        '[class*="markdown-content"]',
        '.ds-markdown',
        '[class*="chat-message"]',
        '[class*="message-bubble"]',
      ];
      for (const sel of candidates) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) return els.length;
      }
      return document.querySelectorAll('[class*="message"]').length;
    });
  }

  async _extractLastMessage(tabName) {
    const { page } = this._resolveTab(tabName);
    return await this.safeEvaluate(page, () => {
      function getFullText(el) {
        if (!el) return '';
        let result = '';

        function walk(node) {
          if (node.nodeType === Node.TEXT_NODE) {
            result += node.textContent;
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const tag = node.tagName.toLowerCase();

          if (tag === 'pre') {
            const codeEl = node.querySelector('code');
            if (codeEl) {
              const cls = codeEl.className || '';
              const lang = (cls.match(/language-(\S+)/) || [])[1] || '';
              const body = codeEl.textContent || '';
              result += '\n```' + lang + '\n' + body + '\n```\n';
            } else {
              result += '\n```\n' + node.textContent + '\n```\n';
            }
            return;
          }

          if (tag === 'code') {
            const parentTag = node.parentElement && node.parentElement.tagName
              ? node.parentElement.tagName.toLowerCase() : '';
            if (parentTag !== 'pre') {
              result += '`' + node.textContent + '`';
            }
            return;
          }

          for (const child of node.childNodes) walk(child);

          if (['p', 'div', 'li', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
            result += '\n';
          }
        }

        walk(el);
        return result.trim();
      }

      const directSelectors = [
        '.ds-markdown',
        '[class*="assistant"] [class*="markdown"]',
        '[class*="assistant"] [class*="content"]',
        '[data-role="assistant"] [class*="content"]',
        '[class*="ai-message"] [class*="content"]',
        '[class*="bot-message"] [class*="content"]',
        '[class*="response-content"]',
        '[class*="message-content"]:last-child',
      ];

      for (const sel of directSelectors) {
        const els = document.querySelectorAll(sel);
        if (els.length > 0) {
          const t = getFullText(els[els.length - 1]);
          if (t.length > 10) return t;
        }
      }

      const markdownEls = document.querySelectorAll(
        '[class*="markdown"], [class*="prose"], [class*="rendered"]'
      );
      if (markdownEls.length > 0) {
        const t = getFullText(markdownEls[markdownEls.length - 1]);
        if (t.length > 10) return t;
      }

      const allBlocks = Array.from(
        document.querySelectorAll('[class*="message"], [class*="chat-item"], [class*="turn"]')
      );
      const candidates = allBlocks.filter(el => {
        const cls = el.className || '';
        return (
          !cls.toLowerCase().includes('input') &&
          !cls.toLowerCase().includes('user') &&
          !el.querySelector('textarea, input[type="text"]') &&
          (el.innerText || '').length > 20
        );
      });

      if (candidates.length > 0) {
        return getFullText(candidates[candidates.length - 1]);
      }

      return '';
    });
  }

  async _isGenerating(tabName) {
    const { page, adaptiveSelector } = this._resolveTab(tabName);
    if (adaptiveSelector) {
      const el = await adaptiveSelector.trySelector(SEL.stopButton[0]);
      if (el) return true;
    }

    return await this.safeEvaluate(page, () => {
      const stopSelectors = [
        'button[aria-label*="Stop" i]',
        '[class*="stop-gen"]',
        '[class*="stopGen"]',
        '[class*="generating"]',
      ];
      for (const sel of stopSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const s = window.getComputedStyle(el);
          if (s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0') return true;
        }
      }

      const loaderSelectors = [
        '[class*="typing"]',
        '[class*="loading"]',
        '[class*="spinner"]',
        '[class*="blink"]',
        '[class*="cursor"]',
        '[class*="pulsing"]',
        'svg[class*="loading"]',
        'svg[class*="spinner"]',
      ];
      for (const sel of loaderSelectors) {
        const el = document.querySelector(sel);
        if (el) {
          const s = window.getComputedStyle(el);
          if (s.display !== 'none' && s.visibility !== 'hidden') return true;
        }
      }

      return false;
    });
  }

  _cleanText(text) {
    if (!text) return '';

    let out = sanitizeUnicode(text)
      .replace(/<think>[\s\S]*?<\/think>\n?/gi, "")
      .replace(/^Thinking\.{0,3}\n[\s\S]*?\n\n/m, "")
      // DeepSeek R1 web UI renders the reasoning trace with a literal
      // "Thought for N second(s)" header followed by the reasoning prose,
      // then a blank line, then the actual answer. Strip the header + prose,
      // keep only the answer. (Anchor on ^ so mid-text mentions are preserved.)
      .replace(/^Thought for \d+ seconds?\n\n[\s\S]*?\n\n/m, "")
      // Fallback for the no-blank-line variant: strip just the header line.
      .replace(/^Thought for \d+ seconds?\n+/, "")
      .replace(/^\d+(?:Copy|Run|Insert|Edit)\b.*$/gm, "")
      .replace(/^\s*(?:Copy|Download|Run|Insert|Edit)\s*$/gim, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    // Conservative reasoning-trace stripper for the case where R1 emits its
    // reasoning as plain prose WITHOUT the "Thought for" header. Only fires
    // when there are 2+ blank-line-separated paragraphs AND the first paragraph
    // matches a strong reasoning marker (1+) OR multiple weak ones (2+). Keeps
    // the final paragraph as the answer. The strong/weak split avoids
    // over-stripping legit multi-paragraph answers that happen to start with "I".
    const paragraphs = out.split(/\n\n+/);
    if (paragraphs.length >= 2) {
      const first = paragraphs[0];
      const strongMarkers = [
        /\bThe user (asks|wants|needs|is asking)\b/i,
        /\bI will (output|respond|answer|write|provide)\b/i,
        /\bI'll (output|respond|answer|write|provide)\b/i,
        /\bstep[- ]by[- ]step\b/i,
      ];
      const weakMarkers = [
        /\bLet me\b/i,
        /\bI need to\b/i,
        /\bI should\b/i,
        /\bI('m| am) going to\b/i,
        /\bWe need to\b/i,
        /\bThis is a simple\b/i,
      ];
      const strongHits = strongMarkers.filter((m) => m.test(first)).length;
      const weakHits = weakMarkers.filter((m) => m.test(first)).length;
      if (strongHits >= 1 || weakHits >= 2) {
        const lastPara = paragraphs[paragraphs.length - 1].trim();
        if (lastPara) out = lastPara;
      }
    }

    return out;
  }

  async dumpDebugInfo() {
    const info = await this.safeEvaluate(this.page, () => {
      const classFreq = {};
      document.querySelectorAll('*').forEach(el => {
        el.classList.forEach(c => {
          if (c.match(/message|chat|input|send|stop|markdown|content|assistant|user|bot/i)) {
            classFreq[c] = (classFreq[c] || 0) + 1;
          }
        });
      });

      const inputs = Array.from(document.querySelectorAll('textarea, [contenteditable]')).map(e => ({
        tag: e.tagName,
        id: e.id || null,
        class: e.className?.slice(0, 80) || null,
        placeholder: e.placeholder || null,
        editable: e.isContentEditable,
        visible: e.offsetParent !== null,
      }));

      return {
        url: window.location.href,
        title: document.title,
        classes: Object.entries(classFreq).sort((a, b) => b[1] - a[1]).slice(0, 40),
        inputs,
      };
    });

    console.log('\n' + '═'.repeat(60));
    console.log('  DOM DEBUG INFO');
    console.log('═'.repeat(60));
    console.log('URL   :', info.url);
    console.log('Title :', info.title);
    console.log('\nInput elements:');
    info.inputs.forEach(i => console.log(' ', JSON.stringify(i)));
    console.log('\nMatching CSS classes (by frequency):');
    info.classes.forEach(([cls, count]) => console.log(`  ${String(count).padStart(3)}x  .${cls}`));
    console.log('═'.repeat(60) + '\n');
  }

  async screenshot(filePath, tabName) {
    const { page } = this._resolveTab(tabName);
    const defaultPath = path.join(config.SESSION_DIR, 'debug-screenshot.png');
    const finalPath = filePath || defaultPath;
    await page.screenshot({ path: finalPath, fullPage: false });
    logger.info(`Screenshot saved: ${finalPath}`);
  }

  async uploadFile(filePath, tabName) {
    const { page } = this._resolveTab(tabName);
    const path = require('path');
    
    // ── Check if the page supports file uploads first ───────────────────────
    const hasUploadCapability = await this.safeEvaluate(page, () => {
      const hasInput = !!document.querySelector('input[type="file"]');
      const buttons = Array.from(document.querySelectorAll('button, div, span'));
      const hasBtn = buttons.some(btn => {
        const label = (btn.getAttribute('aria-label') || '').toLowerCase();
        const cls = (btn.className || '').toLowerCase();
        const txt = (btn.textContent || btn.innerText || '').toLowerCase();
        return label.includes('attach') || label.includes('upload') || 
               cls.includes('upload') || cls.includes('attach') ||
               txt.includes('attach') || txt.includes('upload');
      });
      return hasInput || hasBtn;
    });
    
    if (!hasUploadCapability) {
      throw new Error(`File upload is not supported in this DeepSeek mode/UI layout. Please read the file content using read_file instead.`);
    }

    const uploadSelectors = [
      'input[type="file"]',
      'button[aria-label*="attach" i]',
      'button[aria-label*="upload" i]',
      '[class*="upload"]',
      '[class*="attach"]',
    ];
    
    logger.info(`[Tab: ${tabName || 'default'}] Attempting file upload: ${filePath}`);
    
    try {
      const fileInput = await page.$('input[type="file"]');
      if (fileInput) {
        await fileInput.setInputFiles(filePath);
        await page.waitForTimeout(2000);
        logger.success(`[Tab: ${tabName || 'default'}] Successfully uploaded ${path.basename(filePath)} via input[type="file"]`);
        return { uploaded: true, fileName: path.basename(filePath) };
      }
    } catch (err) {
      logger.warn(`Direct file input upload failed: ${err.message}. Trying button fallback...`);
    }
    
    for (const sel of uploadSelectors.slice(1)) {
      try {
        const btn = await page.$(sel);
        if (btn && await btn.isVisible()) {
          const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 5000 });
          await btn.click();
          const fileChooser = await fileChooserPromise;
          await fileChooser.setFiles(filePath);
          await page.waitForTimeout(2000);
          logger.success(`[Tab: ${tabName || 'default'}] Successfully uploaded ${path.basename(filePath)} via button ${sel}`);
          return { uploaded: true, fileName: path.basename(filePath) };
        }
      } catch (err) {
        // ignore and try next selector fallback
      }
    }

    // ─── HARD WARNING ───────────────────────────────────────────────────────────
    // Every upload strategy exhausted. Do NOT silently fall back to text-paste.
    // Surface this loudly so the caller can inform the user.
    const hardMsg =
      `[HARD WARNING] File upload FAILED for: ${filePath}\n` +
      `  All ${uploadSelectors.length} upload selectors were tried and none succeeded.\n` +
      `  The file was NOT pasted as text. The agent cannot proceed with this file silently.\n` +
      `  Action required: check DeepSeek UI for changes, or verify the file path.`;
    logger.error(hardMsg);
    // Print directly to stderr so it is never swallowed by a log level filter
    process.stderr.write('\n' + '═'.repeat(70) + '\n');
    process.stderr.write(hardMsg + '\n');
    process.stderr.write('═'.repeat(70) + '\n\n');
    throw new Error(hardMsg);
  }
}

function sanitizeUnicode(text) {
  if (!text) return '';
  const map = {
    "â€œ": "“", "â€ ": "”", "â€˜": "‘", "â€™": "’",
    "â€”": "—", "â€“": "–", "â€¦": "…", "â€¢": "•",
    "â€°": "‰", "â€¹": "‹", "â€º": "›", "â€ž": "„",
    "â€¡": "‡", "â„¢": "™", "Â©": "©", "Â®": "®",
    "Â°": "°", "Â±": "±", "Â²": "²", "Â³": "³",
    "Âµ": "µ", "Â¶": "¶", "Â·": "·", "Â¹": "¹",
    "Â¼": "¼", "Â½": "½", "Â¾": "¾", "Â¿": "¿",
    "Ã€": "À", "Ã ": "Á", "Ã‚": "Â", "Ãƒ": "Ã",
    "Ã„": "Ä", "Ã…": "Å", "Ã†": "Æ", "Ã‡": "Ç",
    "Ãˆ": "È", "Ã‰": "É", "ÃŠ": "Ê", "Ã‹": "Ë",
    "ÃŒ": "Ì", "Ã ": "Í", "ÃŽ": "Î", "Ã ": "Ï",
    "Ã ": "Ð", "Ã‘": "Ñ", "Ã’": "Ò", "Ã“": "Ó",
    "Ã”": "Ô", "Ã•": "Õ", "Ã–": "Ö", "Ã—": "×",
    "Ã˜": "Ø", "Ã™": "Ù", "Ãš": "Ú", "Ã›": "Û",
    "Ãœ": "Ü", "Ã ": "Ý", "Ãž": "Þ", "ÃŸ": "ß",
    "Ã ": "à", "Ã¡": "á", "Ã¢": "â", "Ã£": "ã",
    "Ã¤": "ä", "Ã¥": "å", "Ã¦": "æ", "Ã§": "ç",
    "Ã¨": "è", "Ã©": "é", "Ãª": "ê", "Ã«": "ë",
    "Ã¬": "ì", "Ã­": "í", "Ã®": "î", "Ã¯": "ï",
    "Ã°": "ð", "Ã±": "ñ", "Ã²": "ò", "Ã³": "ó",
    "Ã´": "ô", "Ãµ": "õ", "Ã¶": "ö", "Ã·": "÷",
    "Ã¸": "ø", "Ã¹": "ù", "Ãº": "ú", "Ã»": "û",
    "Ã¼": "ü", "Ã½": "ý", "Ã¾": "þ", "Ã¿": "ÿ",
    "Å“": "œ", "Å”": "Œ", "Å¸": "Ÿ", "Ë†": "ˆ"
  };
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return text.replace(pattern, m => map[m] || m);
}

module.exports = DeepSeekBrowser;
