// src/browser.js — Playwright controller for chat.deepseek.com
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');
const logger = require('./logger');

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

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async launch() {
    logger.info('Launching browser with persistent session...');

    const sessionDir = path.resolve(config.SESSION_DIR);
    const cookiesFile = path.join(sessionDir, 'cookies.json');

    let cookies = [];
    if (fs.existsSync(cookiesFile)) {
      try {
        cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'));
        logger.success('Loaded saved cookies — attempting silent login...');
      } catch (e) {
        logger.warn('Could not load cookies: ' + e.message);
      }
    }

    this.context = await chromium.launchPersistentContext(sessionDir, {
      headless: config.HEADLESS,
      viewport: null,
      userAgent: [
        'Mozilla/5.0 (X11; Linux x86_64)',
        'AppleWebKit/537.36 (KHTML, like Gecko)',
        'Chrome/124.0.0.0 Safari/537.36',
      ].join(' '),
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--disable-default-apps',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    // Grab existing page or open a new one
    const pages = this.context.pages();
    const defaultPage = pages.length > 0 ? pages[0] : await this.context.newPage();
    this.pages.set('default', defaultPage);
    this.activeTab = 'default';

    // Mask automation signals
    await defaultPage.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    // Inject saved cookies
    if (cookies.length > 0) {
      await this.context.addCookies(cookies);
      logger.dim(`Injected ${cookies.length} cookies`);
    }

    await this._navigate(config.DEEPSEEK_URL);
    const needsLogin = await this._ensureLoggedIn();

    // Save cookies after login
    if (needsLogin) {
      const newCookies = await this.context.cookies();
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(cookiesFile, JSON.stringify(newCookies, null, 2), 'utf8');
      logger.success('Cookies saved for next run');
    }

    logger.success('Browser ready!');
  }

  async close() {
    if (this._closed) return;
    this._closed = true;
    try { await this.context?.close(); } catch { }
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
      // Navigate and start new chat
      await this._navigate(config.DEEPSEEK_URL);
      await this.newChat();
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
    try {
      const isR1 = modelName.toUpperCase().includes('R1');
      const targetLabel = isR1 ? 'DeepSeek-R1' : 'DeepSeek-V3';
      
      // Look for the model selection dropdown button
      const dropdown = await this.page.locator('div, button').filter({ hasText: /DeepSeek-V3|DeepSeek-R1/ }).first();
      if (await dropdown.count() > 0) {
        const text = await dropdown.innerText();
        if (text.includes(targetLabel)) {
          logger.dim(`Model on tab ${tabName} is already set to ${targetLabel}`);
          return;
        }
        
        await dropdown.click();
        await this.page.waitForTimeout(600);
        
        const option = await this.page.locator('div, li, span').filter({ hasText: new RegExp(targetLabel, 'i') }).first();
        if (await option.count() > 0) {
          await option.click();
          await this.page.waitForTimeout(1000);
          logger.success(`Switched model on tab ${tabName} to ${targetLabel}`);
        } else {
          logger.warn(`Could not find dropdown option for ${targetLabel}`);
          await this.page.keyboard.press('Escape');
        }
      } else {
        logger.warn('Could not locate model switcher dropdown on page');
      }
    } catch (err) {
      logger.warn(`Failed to switch model: ${err.message}`);
    }
  }

  // ── Navigation ─────────────────────────────────────────────────────────────

  async _navigate(url) {
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.page.waitForTimeout(1_500);
    } catch (err) {
      logger.warn(`Navigation warning: ${err.message}`);
    }
  }

  async newChat() {
    if (this.adaptiveSelector) {
      const el = await this.adaptiveSelector.findElement('newChat');
      if (el && await el.isVisible()) {
        await el.click();
        await this.page.waitForTimeout(1_000);
        logger.dim('Started new chat session via adaptive selector');
        return;
      }
    }

    try {
      for (const sel of SEL.newChat) {
        try {
          const el = await this.page.$(sel);
          if (el && await el.isVisible()) {
            await el.click();
            await this.page.waitForTimeout(1_000);
            logger.dim('Started new chat session');
            return;
          }
        } catch { }
      }
    } catch { }

    await this._navigate(config.DEEPSEEK_URL);
    logger.dim('Navigated to DeepSeek home (new chat)');
  }

  // ── Login handling ─────────────────────────────────────────────────────────

  async _ensureLoggedIn() {
    await this.page.waitForTimeout(2_000);

    const needsLogin = await this.page.evaluate(() => {
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
      await this.page.waitForTimeout(2_000);
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

  async sendMessage(text) {
    const { el, isTextarea } = await this._findInput();

    await el.click({ force: true });
    await this.page.waitForTimeout(200);

    await this.page.keyboard.press('Control+a');
    await this.page.waitForTimeout(100);

    if (isTextarea) {
      await el.fill(text);
    } else {
      await this.page.evaluate((element, content) => {
        element.focus();
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        document.execCommand('insertText', false, content);
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: content }));
      }, el, text);
    }

    await this.page.waitForTimeout(config.SEND_DELAY);

    const clicked = await this._clickSendButton();
    if (!clicked) {
      await this.page.keyboard.press('Enter');
    }

    await this.page.waitForTimeout(500);
  }

  async _findInput() {
    if (this.adaptiveSelector) {
      const el = await this.adaptiveSelector.findElement('chatInput');
      if (el) {
        const tagName = await el.evaluate(e => e.tagName.toLowerCase());
        const isContentEditable = await el.evaluate(e => e.isContentEditable);
        return { el, isTextarea: tagName === 'textarea' && !isContentEditable };
      }
    }

    for (const sel of SEL.chatInput) {
      try {
        const el = await this.page.waitForSelector(sel, { timeout: 4_000, state: 'visible' });
        if (!el) continue;
        const tagName = await el.evaluate(e => e.tagName.toLowerCase());
        const isContentEditable = await el.evaluate(e => e.isContentEditable);
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

  async _clickSendButton() {
    if (this.adaptiveSelector) {
      const el = await this.adaptiveSelector.findElement('sendButton');
      if (el && await el.isVisible() && await el.isEnabled()) {
        await el.click();
        return true;
      }
    }

    for (const sel of SEL.sendButton) {
      try {
        const el = await this.page.$(sel);
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
  async _clickContinueIfPresent() {
    try {
      // Strategy 1: scan all visible buttons for exact "Continue" text
      const found = await this.page.evaluate(() => {
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
          const el = await this.page.$(sel);
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
   * and accumulating all chunks into a single returned string.
   */
  async waitForResponse() {
    const timeout = config.RESPONSE_TIMEOUT;
    const stableDelay = config.STABLE_DELAY;
    const start = Date.now();

    // ── Wait for the first new message to appear ──────────────────────────
    const initialCount = await this._getMessageCount();
    let appeared = false;

    while (Date.now() - start < 12_000) {
      const count = await this._getMessageCount();
      if (count > initialCount) { appeared = true; break; }
      await this.page.waitForTimeout(400);
    }

    if (!appeared) logger.warn('Response may have been delayed — continuing to wait...');

    // ── Main accumulation loop (handles "Continue" buttons) ───────────────
    let accumulatedText = '';
    let continueRound = 0;
    const MAX_CONTINUE_ROUNDS = 20; // safety cap

    while (continueRound < MAX_CONTINUE_ROUNDS) {
      // --- Inner stability loop: wait until this chunk stops streaming ---
      let lastText = '';
      let stableStart = null;
      let dotCount = 0;

      while (Date.now() - start < timeout) {
        const text = await this._extractLastMessage();

        if (text !== lastText) {
          lastText = text;
          stableStart = null;
        } else if (text.length > 0) {
          if (!stableStart) stableStart = Date.now();
          else if (Date.now() - stableStart >= stableDelay) {
            if (!await this._isGenerating()) break; // truly stopped
            stableStart = null; // still streaming — reset
          }
        }

        dotCount = (dotCount + 1) % 4;
        logger.thinking(
          `Receiving response${'.'.repeat(dotCount)}  (${text.length} chars` +
          (continueRound > 0 ? `, part ${continueRound + 1}` : '') + ')'
        );
        await this.page.waitForTimeout(500);
      }

      logger.clearLine();

      // Record what was received in this round
      const roundText = this._cleanText(await this._extractLastMessage());

      if (continueRound === 0) {
        accumulatedText = roundText;
      } else {
        // Append only the genuinely new part (avoid re-appending the full DOM text)
        // DeepSeek keeps the whole conversation in the DOM, so we diff by length
        const newChars = roundText.slice(accumulatedText.length);
        if (newChars.trim()) {
          accumulatedText += newChars;
          logger.info(`Appended ${newChars.length} chars from continue-round ${continueRound}`);
        } else {
          // Nothing new was added — continuation is complete
          break;
        }
      }

      // ── Check for Continue button ────────────────────────────────────
      await this.page.waitForTimeout(800); // let UI settle
      const clicked = await this._clickContinueIfPresent();
      if (!clicked) break; // no Continue button — fully done

      logger.info(`Clicked "Continue" (round ${continueRound + 1}) — accumulating next chunk...`);
      continueRound++;

      // Wait for the next chunk to start arriving
      await this.page.waitForTimeout(1_500);
    }

    if (continueRound > 0) {
      logger.success(`Response completed across ${continueRound + 1} continuation(s) (${accumulatedText.length} total chars)`);
    }

    return accumulatedText;
  }

  // ── DOM Extraction ─────────────────────────────────────────────────────────

  async _getMessageCount() {
    return await this.page.evaluate(() => {
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

  async _extractLastMessage() {
    return await this.page.evaluate(() => {
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

  async _isGenerating() {
    if (this.adaptiveSelector) {
      const el = await this.adaptiveSelector.trySelector(SEL.stopButton[0]);
      if (el) return true;
    }

    return await this.page.evaluate(() => {
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

    return sanitizeUnicode(text)
      .replace(/<think>[\s\S]*?<\/think>\n?/gi, "")
      .replace(/^Thinking\.{0,3}\n[\s\S]*?\n\n/m, "")
      .replace(/^\d+(?:Copy|Run|Insert|Edit)\b.*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  async dumpDebugInfo() {
    const info = await this.page.evaluate(() => {
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

  async screenshot(filePath) {
    const defaultPath = path.join(config.SESSION_DIR, 'debug-screenshot.png');
    const finalPath = filePath || defaultPath;
    await this.page.screenshot({ path: finalPath, fullPage: false });
    logger.info(`Screenshot saved: ${finalPath}`);
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