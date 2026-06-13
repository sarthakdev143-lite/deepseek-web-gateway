// src/session-logger.js — Structured per-session event logger
// Writes a JSONL file capturing every request, response, tool call, result,
// and orchestration event so you can replay or debug exactly what happened.
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// Redact secrets from log output
let _redact, _redactObj;
try {
  const r = require(path.join(__dirname, '../../seekcode/src/utils/redact'));
  _redact    = r.redact;
  _redactObj = r.redactObject;
} catch {
  _redact    = s => s;
  _redactObj = o => o;
}

// ─────────────────────────────────────────────
//  Log directory
// ─────────────────────────────────────────────
const LOG_ROOT = path.join(os.homedir(), '.deepseek-agent', 'session-logs');
fs.mkdirSync(LOG_ROOT, { recursive: true });

// ─────────────────────────────────────────────
//  ANSI helpers (no deps)
// ─────────────────────────────────────────────
const A = {
  reset   : '\x1b[0m',  bold    : '\x1b[1m',   dim     : '\x1b[2m',
  red     : '\x1b[31m', green   : '\x1b[32m',  yellow  : '\x1b[33m',
  blue    : '\x1b[34m', magenta : '\x1b[35m',  cyan    : '\x1b[36m',
  gray    : '\x1b[90m', lred    : '\x1b[91m',  lgreen  : '\x1b[92m',
  lyellow : '\x1b[93m', lblue   : '\x1b[94m',  lcyan   : '\x1b[96m',
};
const c  = (code, text) => `${A[code] || ''}${text}${A.reset}`;
const cb = (code, text) => `${A.bold}${A[code] || ''}${text}${A.reset}`;

function ts() { return new Date().toISOString(); }
function elapsed(startMs) {
  const ms = Date.now() - startMs;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}
function trunc(str, max = 600) {
  const s = String(str || '');
  if (s.length <= max) return s;
  return s.slice(0, max) + `… [+${s.length - max} chars]`;
}

// ─────────────────────────────────────────────
//  SessionLogger class
// ─────────────────────────────────────────────
class SessionLogger {
  /**
   * @param {string} sessionId  — gateway session ID
   * @param {string} workingDir — project path for context
   */
  constructor(sessionId, workingDir) {
    this.sessionId  = sessionId;
    this.workingDir = workingDir || process.cwd();
    this.startMs    = Date.now();
    this._seq       = 0;

    const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const safeName = sessionId.slice(0, 12);
    this.logFile = path.join(LOG_ROOT, `${dateStr}_${safeName}.jsonl`);

    // Write session header
    this._write('SESSION_START', {
      sessionId,
      workingDir: this.workingDir,
      pid: process.pid,
      node: process.version,
    });

    this._printHeader(sessionId);
  }

  // ── Core write ──────────────────────────────────────────────────────────────

  _write(event, payload = {}) {
    const entry = {
      seq       : ++this._seq,
      ts        : ts(),
      elapsedMs : Date.now() - this.startMs,
      event,
      sessionId : this.sessionId,
      ...payload,
    };
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* non-fatal */ }
    return entry;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Called when the orchestrator sends a prompt to the model */
  logRequest(prompt, { tab, model, round = 0 } = {}) {
    const safePrompt = _redact(prompt);
    this._write('REQUEST', { tab, model, round, promptLen: prompt.length, promptPreview: trunc(safePrompt, 800) });
    console.log(
      `\n${c('cyan','┌─')}${cb('cyan','── REQUEST ')}${c('gray',`[${tab || 'default'}/${model || 'default'}]`)}` +
      c('gray', ` round=${round} seq=${this._seq}`) + '\n' +
      c('gray', `  prompt length : ${prompt.length} chars`) + '\n' +
      c('gray', `  preview       : ${trunc(safePrompt, 200)}`) + '\n' +
      c('cyan', '└─────────────────────────────────────────────────────────')
    );
  }

  /** Called when the model returns a full response */
  logResponse(text, { tab, model, continueRounds = 0, durationMs } = {}) {
    const safeText = _redact(text);
    this._write('RESPONSE', { tab, model, continueRounds, durationMs, responseLen: text.length, responsePreview: trunc(safeText, 800) });
    const dur = durationMs != null ? ` in ${(durationMs / 1000).toFixed(1)}s` : '';
    console.log(
      `\n${c('lgreen','┌─')}${cb('lgreen','── RESPONSE ')}${c('gray',`[${tab || 'default'}/${model || 'default'}]`)}` +
      c('gray', dur) + (continueRounds ? c('lyellow', ` (${continueRounds} continuations)`) : '') + '\n' +
      c('gray', `  length  : ${text.length} chars`) + '\n' +
      c('gray', `  preview : ${trunc(safeText, 300)}`) + '\n' +
      c('lgreen', '└─────────────────────────────────────────────────────────')
    );
  }

  /** Called when the model emits a tool call */
  logToolCall(name, args, { tab, iteration, parallel } = {}) {
    const safeArgs = _redactObj(args);
    this._write('TOOL_CALL', { tab, iteration, toolName: name, args: safeArgs, parallel: !!parallel });
    console.log(
      `\n  ${cb('magenta','⚡ TOOL CALL')} ${c('cyan', `→ ${name}`)}` +
      c('gray', ` [iter=${iteration ?? '?'} tab=${tab || 'default'}${parallel ? ' PARALLEL' : ''}]`)
    );
    const preview = JSON.stringify(safeArgs, null, 2);
    preview.split('\n').forEach(l => console.log(`    ${c('gray', l)}`));
  }

  /** Called after a tool executes with its result */
  logToolResult(name, result, { isError = false, durationMs, iteration } = {}) {
    const resultStr = _redact(String(result));
    this._write('TOOL_RESULT', { toolName: name, isError, durationMs, iteration, resultLen: String(result).length, resultPreview: trunc(resultStr, 500) });
    const icon  = isError ? c('lred', '  ✗ Result') : c('lgreen', '  ✓ Result');
    const dur   = durationMs != null ? c('gray', ` (${durationMs}ms)`) : '';
    console.log(`${icon} ${c('gray', `[${name}]`)}${dur}:`);
    trunc(resultStr, 400).split('\n').slice(0, 15).forEach(l =>
      console.log(`    ${c(isError ? 'lred' : 'gray', l)}`)
    );
    if (resultStr.split('\n').length > 15) {
      console.log(`    ${c('gray', '… (truncated — full output in log file)')}`);
    }
    console.log('');
  }

  /** Called when the Continue button is clicked */
  logContinueClick(round) {
    this._write('CONTINUE_CLICK', { round });
    console.log(`\n  ${cb('lyellow','↻ CONTINUE CLICKED')} ${c('gray', `round ${round} — accumulating next chunk...`)}`);
  }

  /** Called for orchestration-level events (plan, step, repair, review, etc.) */
  logOrchestration(phase, detail = {}) {
    this._write('ORCHESTRATION', { phase, ...detail });
    const detailStr = Object.entries(detail)
      .map(([k, v]) => `${k}=${JSON.stringify(v)?.slice(0, 80)}`)
      .join('  ');
    console.log(`\n  ${cb('lblue','◈ ORCH')} ${c('cyan', phase)} ${c('gray', detailStr)}`);
  }

  /** General error event */
  logError(message, context = {}) {
    this._write('ERROR', { message, ...context });
    console.log(`\n  ${cb('lred','✖ ERROR')} ${c('lred', message)}`);
    if (Object.keys(context).length) {
      console.log(`    ${c('gray', JSON.stringify(context).slice(0, 200))}`);
    }
  }

  /** General warning */
  logWarn(message, context = {}) {
    this._write('WARN', { message, ...context });
    console.log(`  ${c('lyellow','⚠')} ${c('lyellow', message)}`);
  }

  /** General info */
  logInfo(message, context = {}) {
    this._write('INFO', { message, ...context });
    console.log(`  ${c('lblue','ℹ')} ${message}`);
  }

  /** Mark session end */
  close() {
    const totalMs = Date.now() - this.startMs;
    this._write('SESSION_END', { totalMs, totalEvents: this._seq });
    console.log(
      `\n${c('gray','  Session log written → ')}${c('cyan', this.logFile)}` +
      `\n  ${c('gray', `Total events: ${this._seq}  Duration: ${elapsed(this.startMs)}`)}\n`
    );
  }

  // ── Console header ──────────────────────────────────────────────────────────

  _printHeader(sessionId) {
    console.log(
      `\n${c('cyan','╔══════════════════════════════════════════════════════╗')}` +
      `\n${c('cyan','║')}  ${cb('lcyan', '📝 Session Logger Active')}                           ${c('cyan','║')}` +
      `\n${c('cyan','║')}  ${c('gray', `ID  : ${sessionId.slice(0, 40)}`)}${' '.repeat(Math.max(0, 14 - sessionId.slice(0, 40).length))}${c('cyan','  ║')}` +
      `\n${c('cyan','║')}  ${c('gray', `Log : ${path.basename(this.logFile)}`)}` +
        `${' '.repeat(Math.max(0, 50 - path.basename(this.logFile).length))}${c('cyan','║')}` +
      `\n${c('cyan','╚══════════════════════════════════════════════════════╝')}\n`
    );
  }

  /** Convenience: return path to the log file for display */
  get path() { return this.logFile; }
}

// ─────────────────────────────────────────────
//  Module-level singleton (one per process run)
// ─────────────────────────────────────────────
let _active = null;

function createSessionLogger(sessionId, workingDir) {
  _active = new SessionLogger(sessionId, workingDir);
  return _active;
}

function getSessionLogger() { return _active; }

module.exports = { SessionLogger, createSessionLogger, getSessionLogger, LOG_ROOT };
