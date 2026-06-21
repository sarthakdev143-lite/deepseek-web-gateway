// src/utils.js — Gateway-local utilities inlined from seekcode/src/utils.
//
// Previously the gateway reached across into the sibling `seekcode` package
// (../../seekcode/src/utils/redact, /platformCommands) for these. That
// filesystem coupling broke if you ever published the gateway standalone, and
// meant a missing-sibling-package silently turned redaction into a no-op.
//
// These copies are the same code, kept here so the gateway is self-contained.
// If the originals in seekcode/src/utils change, update these to match.

'use strict';

const os = require('os');
const IS_WIN = os.platform() === 'win32';

// ─────────────────────────────────────────────────────────────────────────────
//  Redaction (inlined from seekcode/src/utils/redact.js)
// ─────────────────────────────────────────────────────────────────────────────

const REDACT_PATTERNS = [
  // Bearer / Auth headers
  [/(Authorization\s*[:=]\s*Bearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]'],
  [/(Authorization\s*[:=]\s*Basic\s+)[A-Za-z0-9+/=]+/gi,        '$1[REDACTED]'],
  // .env / config assignments (KEY=value or "key": "value")
  [/((?:secret|password|passwd|token|api[_-]?key|private[_-]?key|access[_-]?key|auth[_-]?key|client[_-]?secret)\s*[=:]\s*)["']?[^\s"',;\n]{8,}["']?/gi, '$1[REDACTED]'],
  // AWS-style access key IDs (AKIA...)
  [/\bAKIA[0-9A-Z]{16}\b/g, '[AWS_KEY_REDACTED]'],
  // Private key PEM blocks
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE_KEY_REDACTED]'],
  // Connection strings (strip credentials from URL)
  [/((?:postgres|postgresql|mongodb|mysql|redis|amqp|amqps):\/\/)[^:@\s]+:[^@\s]+@/gi, '$1[REDACTED]@'],
  // GitHub / npm / generic tokens (long alphanumeric strings after "token")
  [/(token\s*[:=]\s*)["']?[A-Za-z0-9_\-]{20,}["']?/gi, '$1[REDACTED]'],
  // OpenAI / Anthropic / Hugging Face style keys
  [/\bsk-[A-Za-z0-9]{20,}/g,  '[API_KEY_REDACTED]'],
  [/\bhf_[A-Za-z0-9]{10,}/g,  '[HF_TOKEN_REDACTED]'],
  [/\bxoxb-[A-Za-z0-9\-]{10,}/g, '[SLACK_TOKEN_REDACTED]'],
];

function redact(text) {
  if (!text || typeof text !== 'string') return text;
  let out = text;
  for (const [pattern, replacement] of REDACT_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function redactObject(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'string') {
      result[k] = redact(v);
    } else if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      result[k] = redactObject(v);
    } else {
      result[k] = v;
    }
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Platform commands (inlined from seekcode/src/utils/platformCommands.js —
//  only the 3 functions the gateway actually uses)
// ─────────────────────────────────────────────────────────────────────────────

function sleep(seconds) {
  if (IS_WIN) {
    // ping -n counts one extra (ping once = ~0s, so we add 1).
    // Works with redirected stdin, unlike `timeout`.
    return `ping -n ${seconds + 1} 127.0.0.1 >nul 2>&1`;
  }
  return `sleep ${seconds}`;
}

function httpGet(url, { timeout = 5 } = {}) {
  if (IS_WIN) {
    return `powershell -NoProfile -Command "(Invoke-WebRequest -Uri '${url}' -TimeoutSec ${timeout} -UseBasicParsing).StatusCode"`;
  }
  return `curl -s -o /dev/null -w "%{http_code}" --max-time ${timeout} "${url}"`;
}

function sanitizeCommand(cmd) {
  if (!IS_WIN) return cmd;
  let out = cmd;
  // timeout /t N /nobreak >nul  →  ping equivalent
  out = out.replace(/timeout\s+\/t\s+(\d+)\s*(?:\/nobreak)?\s*(?:>nul)?/gi, (_, n) => {
    return sleep(parseInt(n, 10));
  });
  // sleep N  →  ping equivalent
  out = out.replace(/\bsleep\s+(\d+)\b/gi, (_, n) => {
    return sleep(parseInt(n, 10));
  });
  // curl -s -o /dev/null -w "..." URL  →  PowerShell equivalent (simple checks only)
  out = out.replace(/\bcurl\s+-s\s+-o\s+\/dev\/null\s+-w\s+"[^"]*"\s+([^\s|&]+)/gi, (_, url) => {
    return httpGet(url);
  });
  return out;
}

module.exports = {
  // Platform
  IS_WIN,
  sleep,
  httpGet,
  sanitizeCommand,
  // Redaction
  redact,
  redactObject,
  REDACT_PATTERNS,
};
