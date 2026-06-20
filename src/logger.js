'use strict';

const timestamp = () => new Date().toISOString();

function log(level, message, extra = {}) {
  const entry = { timestamp: timestamp(), level, message, ...extra };
  console.log(JSON.stringify(entry));
}

const logger = {
  banner() {
    const bannerMsg = `
╔══════════════════════════════════════════════════╗
║   🤖  DeepSeek Browser Agent                     ║
║   AI Coding Agent via Browser Automation         ║
║   No API key needed — uses chat.deepseek.com     ║
╚══════════════════════════════════════════════════╝
`;
    log('banner', bannerMsg.trim());
  },

  header(msg) {
    log('header', msg);
  },

  info(msg)    { log('info', msg); },
  success(msg) { log('success', msg); },
  warn(msg)    { log('warn', msg); },
  error(msg)   { log('error', msg); },
  dim(msg)     { log('dim', msg); },

  thinking(msg) {
    // For JSON, output a thinking log line
    log('thinking', msg);
  },

  clearLine() {
    // No-op for JSON mode
  },

  toolCall(name, args) {
    log('toolCall', name, { args });
  },

  toolResult(result, isError = false) {
    log('toolResult', String(result), { error: isError });
  },

  finalOutput(msg) {
    log('finalOutput', msg);
  },

  separator(label = '') {
    log('separator', label || 'separator');
  },

  iteration(n, max) {
    log('iteration', `Step ${n}/${max}`, { n, max });
  },
};

module.exports = logger;
