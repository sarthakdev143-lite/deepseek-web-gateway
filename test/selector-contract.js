// test/selector-contract.js — Selector contract test
//
// Purpose: catch DeepSeek DOM breakages BEFORE a live session. The gateway's
// selector banks (browser.js SEL.*) are the single most fragile part of the
// system — when chat.deepseek.com ships a redesign, the agent stops being able
// to find the input box, send button, etc. This test loads a static HTML
// fixture mirroring the *current* DeepSeek DOM shape and asserts that every
// selector bank still resolves to at least one element.
//
// When DeepSeek changes their UI:
//   1. Run a live session with --debug to capture the new DOM (agent.js diagnose())
//   2. Update this fixture to match
//   3. Update browser.js SEL banks if needed
//   4. Re-run this test — it should pass
//
// Run: node test/selector-contract.js
'use strict';

// ─────────────────────────────────────────────────────────────────────────────
//  Minimal CSS-selector engine — supports exactly the syntax the gateway's
//  SEL banks use: `tag`, `#id`, `.class`, `[attr]`, `[attr="v"]`, `[attr*="v"]`
//  (case-insensitive variant `[attr*="v" i]`). Comma = OR. No combinators.
//  This is NOT a general CSS engine — it's a contract-test shim.
// ─────────────────────────────────────────────────────────────────────────────

function parseSelector(sel) {
  // Split top-level by comma (we don't support commas inside brackets here).
  return sel.split(',').map((s) => s.trim()).map(parseSingleSelector);
}

function parseSingleSelector(sel) {
  const conditions = [];
  // Match: #id, .class, [attr], [attr="v"], [attr*="v"], [attr*="v" i], tag
  const tokenRe = /(#\w+)|(\.\w+)|(\[[^\]]+\])|(\w+)/g;
  let m;
  while ((m = tokenRe.exec(sel)) !== null) {
    if (m[1]) conditions.push({ type: 'id', value: m[1].slice(1) });
    else if (m[2]) conditions.push({ type: 'class', value: m[2].slice(1) });
    else if (m[3]) {
      const inside = m[3].slice(1, -1).trim();
      const attrMatch = inside.match(/^([\w-]+)\s*(?:([*^$|~]?=)\s*"([^"]*)"\s*(i)?)?$/);
      if (!attrMatch) continue;
      const [, name, op, val, ci] = attrMatch;
      conditions.push({ type: 'attr', name, op: op || 'exists', value: val, ci: !!ci });
    } else if (m[4]) conditions.push({ type: 'tag', value: m[4].toLowerCase() });
  }
  return conditions;
}

function elementMatches(el, conditions) {
  return conditions.every((cond) => {
    if (cond.type === 'tag') return el.tag === cond.value;
    if (cond.type === 'id') return el.attrs.id === cond.value;
    if (cond.type === 'class') {
      const cls = (el.attrs.class || '').split(/\s+/);
      return cls.includes(cond.value);
    }
    if (cond.type === 'attr') {
      const actual = el.attrs[cond.name];
      if (cond.op === 'exists') return actual !== undefined;
      if (actual === undefined) return false;
      const a = cond.ci ? String(actual).toLowerCase() : String(actual);
      const v = cond.ci ? cond.value.toLowerCase() : cond.value;
      if (cond.op === '=') return a === v;
      if (cond.op === '*=') return a.includes(v);
      if (cond.op === '^=') return a.startsWith(v);
      if (cond.op === '$=') return a.endsWith(v);
      return false;
    }
    return false;
  });
}

function querySelectorAll(elements, selector) {
  const groups = parseSelector(selector);
  return elements.filter((el) => groups.some((conds) => elementMatches(el, conds)));
}

// ─────────────────────────────────────────────────────────────────────────────
//  Minimal HTML fixture parser (handles only the tags/attrs the fixture uses)
// ─────────────────────────────────────────────────────────────────────────────

function parseHtml(html) {
  const elements = [];
  const tagRe = /<(\w+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*(?:\/?>)/g;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrsStr = m[2] || '';
    const attrs = {};
    const attrRe = /([\w-]+)="([^"]*)"/g;
    let am;
    while ((am = attrRe.exec(attrsStr)) !== null) {
      attrs[am[1]] = am[2];
    }
    elements.push({ tag, attrs });
  }
  return elements;
}

// ─────────────────────────────────────────────────────────────────────────────
//  The fixture — a faithful static mirror of chat.deepseek.com's current DOM
//  (capture date: 2026-06). When DeepSeek redesigns, refresh this from a live
//  --debug capture. The class names are obfuscated hashes in production; we use
//  representative values that exercise the gateway's wildcard selectors.
// ─────────────────────────────────────────────────────────────────────────────

const DEEPSEEK_FIXTURE = `
<div class="ds-layout">
  <header class="d8f3a1 header">
    <button aria-label="New chat" class="b2c4d6 new-chat-btn">+ New Chat</button>
    <a href="/" aria-label="Home">DeepSeek</a>
  </header>
  <main class="f7e2b9 chat-content">
    <div class="a1b2c3 message-list">
      <div class="e5f6g7 chat-message user-message">
        <div class="msg-content">What does server.js do?</div>
      </div>
      <div class="h8i9j0 chat-message assistant-message">
        <div class="k1l2m3 markdown-content ds-markdown">
          <p>It implements an HTTP API.</p>
        </div>
      </div>
    </div>
  </main>
  <footer class="c4d5e6 input-area">
    <textarea id="chat-input" class="_27c9245" placeholder="Ask anything..."></textarea>
    <button aria-label="Send message" data-testid="send-button" class="send-btn">Send</button>
    <button aria-label="Stop generating" data-testid="stop-button" class="stop-btn" style="display:none">Stop</button>
    <button class="continue-btn" style="display:none">Continue</button>
  </footer>
</div>
`;

// ─────────────────────────────────────────────────────────────────────────────
//  Mirror of the gateway's SEL banks — copy from browser.js. If these drift
//  from the source, the test is invalid. (A future improvement would be to
//  import SEL directly from browser.js, but that file has top-level side
//  effects we don't want in a test.)
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
    'button',
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
//  Run the contract test
// ─────────────────────────────────────────────────────────────────────────────

function run() {
  const elements = parseHtml(DEEPSEEK_FIXTURE);
  let totalBanks = 0;
  let passingBanks = 0;
  const failures = [];

  for (const [bankName, selectors] of Object.entries(SEL)) {
    totalBanks++;
    // A bank passes if AT LEAST ONE of its selectors matches an element.
    const matchedSelector = selectors.find((sel) => querySelectorAll(elements, sel).length > 0);
    if (matchedSelector) {
      passingBanks++;
      console.log(`  ✓ ${bankName.padEnd(18)} matched by: ${matchedSelector}`);
    } else {
      failures.push(bankName);
      console.log(`  ✗ ${bankName.padEnd(18)} NO SELECTOR MATCHED`);
      console.log(`      tried: ${selectors.join(', ')}`);
    }
  }

  console.log('');
  console.log(`${passingBanks}/${totalBanks} selector banks resolve against the fixture.`);
  if (failures.length > 0) {
    console.log('');
    console.log('FAIL — DeepSeek may have changed their DOM. To fix:');
    console.log('  1. Run: node src/index.js --debug "<task>"  (captures the live DOM)');
    console.log('  2. Update the DEEPSEEK_FIXTURE in test/selector-contract.js');
    console.log('  3. Update the SEL banks in src/browser.js if needed');
    console.log('  4. Re-run: node test/selector-contract.js');
    process.exit(1);
  } else {
    console.log('PASS — all selector banks resolve.');
    process.exit(0);
  }
}

run();
