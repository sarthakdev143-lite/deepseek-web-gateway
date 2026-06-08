// src/browser.js â€” Playwright controller for chat.deepseek.com
'use strict';
const fs = require('fs');

const { chromium } = require('playwright');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  Selector banks â€” ordered by likelihood, with fallbacks
//  We never depend on a single selector; DeepSeek's UI can change.
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const SEL = {
  // Text input where the user types
  chatInput: [
    '#chat-input',
    'textarea[placeholder]',
    'textarea',
    '[contenteditable="true"][role="textbox"]',
    '[contenteditable="true"]',
  ],

  // Button that submits the message
  sendButton: [
    'button[aria-label*="Send" i]',
    'button[aria-label*="send" i]',
    '[data-testid="send-button"]',
    'button[type="submit"]',
    '[class*="send-btn"]',
    '[class*="sendBtn"]',
    '[class*="send-button"]',
  ],

  // "Stop generating" button â€” visible while streaming
  stopButton: [
    'button[aria-label*="Stop" i]',
    '[aria-label*="stop generating" i]',
    '[data-testid="stop-button"]',
    '[class*="stop-btn"]',
    '[class*="stopBtn"]',
  ],

  // "New chat" / "New conversation" button in sidebar
  newChat: [
    'button[aria-label*="New chat" i]',
    'button[aria-label*="New conversation" i]',
    'a[href="/"][aria-label]',
    '[data-testid="new-chat"]',
    '[class*="new-chat"]',
    '[class*="newChat"]',
  ],

  // The main chat messages container
  messageContainer: [
    '[class*="chat-content"]',
    '[class*="message-list"]',
    '[class*="conversation"]',
    'main',
  ],
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//  DeepSeekBrowser class
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class DeepSeekBrowser {
  constructor() {
    this.context = null;
    this.page = null;
    this._closed = false;
  }

  // â”€â”€ Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async launch() {
    logger.info('Launching browser with persistent session...');

    const sessionDir = path.resolve(config.SESSION_DIR);
    const cookiesFile = path.join(sessionDir, 'cookies.json');

    let cookies = [];
    if (fs.existsSync(cookiesFile)) {
      try {
        cookies = JSON.parse(fs.readFileSync(cookiesFile, 'utf8'));
        logger.success('Loaded saved cookies â€” attempting silent login...');
      } catch (e) {
        logger.warn('Could not load cookies: ' + e.message);
      }
    }

    this.context = await chromium.launchPersistentContext(sessionDir, {
      headless: config.HEADLESS,
      viewport: { width: 1366, height: 768 },
      userAgent: [
        'Mozilla/5.0 (X11; Linux x86_64)',
        'AppleWebKit/537.36 (KHTML, like Gecko)',
        'Chrome/124.0.0.0 Safari/537.36',
      ].join(' '),
      args: [
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
    this.page = pages.length > 0 ? pages[0] : await this.context.newPage();

    // Mask automation signals
    await this.page.addInitScript(() => {
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

  // â”€â”€ Navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async _navigate(url) {
    try {
      await this.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await this.page.waitForTimeout(1_500);
    } catch (err) {
      logger.warn(`Navigation warning: ${err.message}`);
    }
  }

  async newChat() {
    try {
      // Try clicking the "New Chat" button in the sidebar
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

    // Fallback: navigate to home which usually opens a fresh chat
    await this._navigate(config.DEEPSEEK_URL);
    logger.dim('Navigated to DeepSeek home (new chat)');
  }

  // â”€â”€ Login handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    logger.warn('â•”â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•—');
    logger.warn('â•‘  ðŸ”  LOGIN REQUIRED                          â•‘');
    logger.warn('â•‘                                              â•‘');
    logger.warn('â•‘  1. Log in to DeepSeek in the browser window â•‘');
    logger.warn('â•‘  2. Return here and press  ENTER  to continueâ•‘');
    logger.warn('â•šâ•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•');
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

  // â”€â”€ Sending Messages â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async sendMessage(text) {
    // Find input element
    const { el, isTextarea } = await this._findInput();

    // Click to focus
    await el.click({ force: true });
    await this.page.waitForTimeout(200);

    // Clear existing content
    await this.page.keyboard.press('Control+a');
    await this.page.waitForTimeout(100);

    if (isTextarea) {
      // Standard textarea â€” use fill() which is reliable
      await el.fill(text);
    } else {
      // contenteditable div â€” needs execCommand
      await this.page.evaluate((element, content) => {
        element.focus();
        // Select all and delete
        document.execCommand('selectAll', false, null);
        document.execCommand('delete', false, null);
        // Insert text (fires proper input events)
        document.execCommand('insertText', false, content);
        // Belt-and-suspenders: fire input event manually
        element.dispatchEvent(new InputEvent('input', { bubbles: true, data: content }));
      }, el, text);
    }

    await this.page.waitForTimeout(config.SEND_DELAY);

    // Try send button, fall back to Enter
    const clicked = await this._clickSendButton();
    if (!clicked) {
      // DeepSeek uses plain Enter to submit (Shift+Enter for newlines)
      await this.page.keyboard.press('Enter');
    }

    await this.page.waitForTimeout(500);
  }

  async _findInput() {
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
      '  â†’ Make sure the page is fully loaded and you are logged in.\n' +
      '  â†’ Run with --debug to inspect DOM selectors.\n' +
      '  â†’ Run: node src/calibrate.js to auto-detect selectors.'
    );
  }

  async _clickSendButton() {
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

  // â”€â”€ Waiting for Response â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Wait until DeepSeek finishes generating and return the response text.
   *
   * Algorithm:
   *  1. Record how many assistant messages are on the page right now.
   *  2. Wait until a new message appears (count goes up).
   *  3. Poll the last message text every 500 ms.
   *  4. When the text has not changed for STABLE_DELAY ms AND
   *     no stop/loading indicator is visible â†’ done.
   */
  async waitForResponse() {
    const timeout = config.RESPONSE_TIMEOUT;
    const stableDelay = config.STABLE_DELAY;
    const start = Date.now();

    // â”€â”€ Phase 1: wait for a new message to appear â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const initialCount = await this._getMessageCount();
    let appeared = false;

    while (Date.now() - start < 12_000) {
      const count = await this._getMessageCount();
      if (count > initialCount) { appeared = true; break; }
      await this.page.waitForTimeout(400);
    }

    if (!appeared) logger.warn('Response may have been delayed â€” continuing to wait...');

    // â”€â”€ Phase 2: wait for text to stabilise â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
          if (!await this._isGenerating()) break;  // confirmed done
          stableStart = null;                       // still generating, reset
        }
      }

      // Progress indicator
      dotCount = (dotCount + 1) % 4;
      logger.thinking(`Receiving response${'.'.repeat(dotCount)}  (${text.length} chars)`);

      await this.page.waitForTimeout(500);
    }

    logger.clearLine();

    const final = await this._extractLastMessage();
    return this._cleanText(final);
  }

  // â”€â”€ DOM Extraction â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** Count how many "response" blocks are visible */
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
      // Broad fallback
      return document.querySelectorAll('[class*="message"]').length;
    });
  }

  /** Extract the text of the last assistant message â€” including code blocks */
  async _extractLastMessage() {
    return await this.page.evaluate(() => {

      // â”€â”€ Helper: get all text including code blocks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      // Walks the DOM and reconstructs text, re-adding fence markers for code
      // blocks so the parser can recognise tool_call fences even after the
      // browser markdown renderer has converted them to <pre><code> elements.
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

          // <pre> wraps a fenced code block â€” reconstruct the backtick fence
          // so the parser can match the ```tool_call regex.
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

          // Inline <code> â€” skip if inside a <pre> (already handled)
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

      // â”€â”€ Attempt 1: Specific assistant-message selectors â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

      // â”€â”€ Attempt 2: Any markdown/prose container â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
      const markdownEls = document.querySelectorAll(
        '[class*="markdown"], [class*="prose"], [class*="rendered"]'
      );
      if (markdownEls.length > 0) {
        const t = getFullText(markdownEls[markdownEls.length - 1]);
        if (t.length > 10) return t;
      }

      // â”€â”€ Attempt 3: Heuristic â€” large non-user text blocks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  /** True if DeepSeek is still streaming / generating */
  async _isGenerating() {
    return await this.page.evaluate(() => {
      // Check for stop button
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

      // Check for animated loading/typing indicators
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

  // â”€â”€ Text Cleanup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  _cleanText(text) {
    if (!text) return '';

    return sanitizeUnicode(text)
      .replace(/<think>[\s\S]*?<\/think>\n?/gi, "")
      .replace(/^Thinking\.{0,3}\n[\s\S]*?\n\n/m, "")
      .replace(/^\d+(?:Copy|Run|Insert|Edit)\b.*$/gm, "")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // â”€â”€ Debug / Calibration Utilities â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Dump useful DOM information to stdout.
   * Called by `node src/calibrate.js` or `--debug` flag.
   */
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

    console.log('\n' + 'â•'.repeat(60));
    console.log('  DOM DEBUG INFO');
    console.log('â•'.repeat(60));
    console.log('URL   :', info.url);
    console.log('Title :', info.title);
    console.log('\nInput elements:');
    info.inputs.forEach(i => console.log(' ', JSON.stringify(i)));
    console.log('\nMatching CSS classes (by frequency):');
    info.classes.forEach(([cls, count]) => console.log(`  ${String(count).padStart(3)}x  .${cls}`));
    console.log('â•'.repeat(60) + '\n');
  }

  /** Take a screenshot (for debugging) */
  async screenshot(filePath = '/tmp/deepseek-agent-debug.png') {
    await this.page.screenshot({ path: filePath, fullPage: false });
    logger.info(`Screenshot saved: ${filePath}`);
  }
}


// ── Unicode Mojibake Sanitizer ─────────────────────────────────────────
// Fixes common UTF-8 bytes misinterpreted as Windows-1252 / ISO-8859-1.
function sanitizeUnicode(text) {
  if (!text) return '';
  var map = {};
  map["â€œ"] = "“";
  map["â€"] = "”";
  map["â€˜"] = "‘";
  map["â€™"] = "’";
  map["â€”"] = "—";
  map["â€“"] = "–";
  map["â€¦"] = "…";
  map["â€¢"] = "•";
  map["â€°"] = "‰";
  map["â€¹"] = "‹";
  map["â€º"] = "›";
  map["â€ž"] = "„";
  map["â€¡"] = "‡";
  map["â„¢"] = "™";
  map["Â©"] = "©";
  map["Â®"] = "®";
  map["Â°"] = "°";
  map["Â±"] = "±";
  map["Â²"] = "²";
  map["Â³"] = "³";
  map["Âµ"] = "µ";
  map["Â¶"] = "¶";
  map["Â·"] = "·";
  map["Â¹"] = "¹";
  map["Â¼"] = "¼";
  map["Â½"] = "½";
  map["Â¾"] = "¾";
  map["Â¿"] = "¿";
  map["Ã"] = "À";
  map["Ã"] = "Á";
  map["Ã"] = "Â";
  map["Ã"] = "Ã";
  map["Ã"] = "Ä";
  map["Ã"] = "Å";
  map["Ã"] = "Æ";
  map["Ã"] = "Ç";
  map["Ã"] = "È";
  map["Ã"] = "É";
  map["Ã"] = "Ê";
  map["Ã"] = "Ë";
  map["Ã"] = "Ì";
  map["Ã"] = "Í";
  map["Ã"] = "Î";
  map["Ã"] = "Ï";
  map["Ã"] = "Ð";
  map["Ã"] = "Ñ";
  map["Ã"] = "Ò";
  map["Ã"] = "Ó";
  map["Ã"] = "Ô";
  map["Ã"] = "Õ";
  map["Ã"] = "Ö";
  map["Ã"] = "×";
  map["Ã"] = "Ø";
  map["Ã"] = "Ù";
  map["Ã"] = "Ú";
  map["Ã"] = "Û";
  map["Ã"] = "Ü";
  map["Ã"] = "Ý";
  map["Ã"] = "Þ";
  map["Ã"] = "ß";
  map["Ã "] = "à";
  map["Ã¡"] = "á";
  map["Ã¢"] = "â";
  map["Ã£"] = "ã";
  map["Ã¤"] = "ä";
  map["Ã¥"] = "å";
  map["Ã¦"] = "æ";
  map["Ã§"] = "ç";
  map["Ã¨"] = "è";
  map["Ã©"] = "é";
  map["Ãª"] = "ê";
  map["Ã«"] = "ë";
  map["Ã¬"] = "ì";
  map["Ã­"] = "í";
  map["Ã®"] = "î";
  map["Ã¯"] = "ï";
  map["Ã°"] = "ð";
  map["Ã±"] = "ñ";
  map["Ã²"] = "ò";
  map["Ã³"] = "ó";
  map["Ã´"] = "ô";
  map["Ãµ"] = "õ";
  map["Ã¶"] = "ö";
  map["Ã·"] = "÷";
  map["Ã¸"] = "ø";
  map["Ã¹"] = "ù";
  map["Ãº"] = "ú";
  map["Ã»"] = "û";
  map["Ã¼"] = "ü";
  map["Ã½"] = "ý";
  map["Ã¾"] = "þ";
  map["Ã¿"] = "ÿ";
  map["Å“"] = "œ";
  map["Å”"] = "Œ";
  map["Å¸"] = "Ÿ";
  map["Ë†"] = "ˆ";

  var keys = Object.keys(map);
  keys.sort(function(a, b) { return b.length - a.length; });
  var pattern = new RegExp(keys.map(function(k) { return k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }).join("|"), "g");
  return text.replace(pattern, function(m) { return map[m] || m; });
}
module.exports = DeepSeekBrowser;
