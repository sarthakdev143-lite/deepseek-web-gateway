#!/usr/bin/env node
// src/view-logs.js — Pretty-print SeekCode session JSONL logs
// Usage:
//   node src/view-logs.js               → list all sessions
//   node src/view-logs.js <id-prefix>   → show full log for matching session
//   node src/view-logs.js <id-prefix> --filter tool_call,response
//   node src/view-logs.js <id-prefix> --summary
//   node src/view-logs.js --last        → show the most recent session
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const LOG_ROOT = path.join(os.homedir(), '.deepseek-agent', 'session-logs');

// ─────────────────────────────────────────────
//  ANSI colours
// ─────────────────────────────────────────────
const A = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  blue: '\x1b[34m', magenta: '\x1b[35m', cyan: '\x1b[36m',
  gray: '\x1b[90m', lred: '\x1b[91m', lgreen: '\x1b[92m',
  lyellow: '\x1b[93m', lblue: '\x1b[94m', lcyan: '\x1b[96m',
};
const c  = (code, t) => `${A[code] || ''}${t}${A.reset}`;
const cb = (code, t) => `${A.bold}${A[code] || ''}${t}${A.reset}`;

function trunc(s, max = 500) {
  const str = String(s || '');
  return str.length <= max ? str : str.slice(0, max) + c('gray', ` …(+${str.length - max})`);
}

function fmtMs(ms) {
  if (ms == null) return '?';
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

// ─────────────────────────────────────────────
//  Load log files
// ─────────────────────────────────────────────
function listLogFiles() {
  if (!fs.existsSync(LOG_ROOT)) return [];
  return fs.readdirSync(LOG_ROOT)
    .filter(f => f.endsWith('.jsonl'))
    .sort()
    .reverse(); // newest first
}

function readLog(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ─────────────────────────────────────────────
//  Display helpers
// ─────────────────────────────────────────────
const EVENT_COLORS = {
  SESSION_START    : 'lcyan',
  SESSION_END      : 'lcyan',
  REQUEST          : 'blue',
  RESPONSE         : 'lgreen',
  TOOL_CALL        : 'magenta',
  TOOL_RESULT      : 'lgreen',
  ORCHESTRATION    : 'lblue',
  CONTINUE_CLICK   : 'lyellow',
  ERROR            : 'lred',
  WARN             : 'lyellow',
  INFO             : 'gray',
};

const EVENT_ICONS = {
  SESSION_START  : '╔ START',
  SESSION_END    : '╚ END  ',
  REQUEST        : '→ REQ  ',
  RESPONSE       : '← RESP ',
  TOOL_CALL      : '⚡ TOOL ',
  TOOL_RESULT    : '✓ RES  ',
  ORCHESTRATION  : '◈ ORCH ',
  CONTINUE_CLICK : '↻ CONT ',
  ERROR          : '✖ ERR  ',
  WARN           : '⚠ WARN ',
  INFO           : 'ℹ INFO ',
};

function printEvent(entry, opts = {}) {
  const color = EVENT_COLORS[entry.event] || 'gray';
  const icon  = EVENT_ICONS[entry.event]  || '· EVT  ';
  const ts    = entry.ts ? entry.ts.slice(11, 23) : '??:??:??';
  const elapsed = fmtMs(entry.elapsedMs);

  const header = [
    c('gray', `[${ts}]`),
    c('gray', `+${elapsed.padStart(8)}`),
    c('gray', `#${String(entry.seq).padStart(4)}`),
    cb(color, icon),
  ].join('  ');

  console.log(header);

  switch (entry.event) {
    case 'SESSION_START':
      console.log(c('gray', `    session : ${entry.sessionId}`));
      console.log(c('gray', `    workDir : ${entry.workingDir || '(none)'}`));
      break;

    case 'SESSION_END':
      console.log(c('gray', `    total events : ${entry.totalEvents}`));
      console.log(c('gray', `    duration     : ${fmtMs(entry.totalMs)}`));
      break;

    case 'REQUEST':
      console.log(c('gray', `    tab   : ${entry.tab || '-'}  model : ${entry.model || '-'}  round : ${entry.round ?? '-'}`));
      if (entry.type) console.log(c('gray', `    type  : ${entry.type}`));
      console.log(c('gray', `    len   : ${entry.promptLen} chars`));
      if (!opts.summaryOnly && entry.promptPreview) {
        console.log(c('blue', `    ┌─ prompt ─────────────────────────────────────`));
        trunc(entry.promptPreview, 400).split('\n').slice(0, 10).forEach(l =>
          console.log(c('blue', `    │ `) + c('dim', l))
        );
        console.log(c('blue', `    └──────────────────────────────────────────────`));
      }
      break;

    case 'RESPONSE':
      console.log(c('gray', `    tab   : ${entry.tab || '-'}  model : ${entry.model || '-'}  dur : ${fmtMs(entry.durationMs)}`));
      if (entry.continueRounds) console.log(c('lyellow', `    continuations : ${entry.continueRounds}`));
      console.log(c('gray', `    len   : ${entry.responseLen} chars`));
      if (!opts.summaryOnly && entry.responsePreview) {
        console.log(c('lgreen', `    ┌─ response ───────────────────────────────────`));
        trunc(entry.responsePreview, 400).split('\n').slice(0, 12).forEach(l =>
          console.log(c('lgreen', `    │ `) + c('dim', l))
        );
        console.log(c('lgreen', `    └──────────────────────────────────────────────`));
      }
      break;

    case 'TOOL_CALL':
      console.log(c('magenta', `    tool  : ${entry.toolName}`));
      console.log(c('gray',    `    iter  : ${entry.iteration ?? '-'}  tab : ${entry.tab || '-'}`));
      if (!opts.summaryOnly && entry.args) {
        const argsStr = JSON.stringify(entry.args, null, 2);
        trunc(argsStr, 300).split('\n').slice(0, 10).forEach(l =>
          console.log(c('gray', `    │ ${l}`))
        );
      }
      break;

    case 'TOOL_RESULT':
      const errLabel = entry.isError ? c('lred', 'ERROR') : c('lgreen', 'OK');
      console.log(`    tool  : ${c('magenta', entry.toolName)}  status : ${errLabel}  dur : ${c('gray', fmtMs(entry.durationMs))}`);
      console.log(c('gray', `    len   : ${entry.resultLen} chars`));
      if (!opts.summaryOnly && entry.resultPreview && !entry.isError) {
        trunc(entry.resultPreview, 200).split('\n').slice(0, 6).forEach(l =>
          console.log(c('gray', `    │ ${l}`))
        );
      }
      if (entry.isError && entry.resultPreview) {
        console.log(c('lred', `    ✖ ${trunc(entry.resultPreview, 200)}`));
      }
      break;

    case 'ORCHESTRATION':
      console.log(c('lblue', `    phase : ${entry.phase}`));
      const detail = { ...entry };
      ['seq','ts','elapsedMs','event','sessionId','phase'].forEach(k => delete detail[k]);
      if (Object.keys(detail).length) {
        Object.entries(detail).forEach(([k, v]) =>
          console.log(c('gray', `    ${k.padEnd(16)}: ${JSON.stringify(v)?.slice(0, 120)}`))
        );
      }
      break;

    case 'CONTINUE_CLICK':
      console.log(c('lyellow', `    round : ${entry.round}`));
      break;

    case 'ERROR':
      console.log(c('lred', `    ${entry.message}`));
      const errCtx = { ...entry };
      ['seq','ts','elapsedMs','event','sessionId','message'].forEach(k => delete errCtx[k]);
      if (Object.keys(errCtx).length) {
        console.log(c('gray', `    ${JSON.stringify(errCtx).slice(0, 200)}`));
      }
      break;

    case 'WARN':
      console.log(c('lyellow', `    ${entry.message}`));
      break;

    case 'INFO':
      console.log(c('gray', `    ${entry.message}`));
      break;

    default:
      console.log(c('gray', `    ${JSON.stringify(entry).slice(0, 200)}`));
  }

  console.log('');
}

// ─────────────────────────────────────────────
//  Summary view
// ─────────────────────────────────────────────
function printSummary(entries) {
  const byType = {};
  let toolCalls = [], errors = [], warns = [], totalDurationMs = 0;

  for (const e of entries) {
    byType[e.event] = (byType[e.event] || 0) + 1;
    if (e.event === 'TOOL_CALL') toolCalls.push(e.toolName);
    if (e.event === 'ERROR')     errors.push(e.message);
    if (e.event === 'WARN')      warns.push(e.message);
    if (e.event === 'SESSION_END') totalDurationMs = e.totalMs;
  }

  const start  = entries.find(e => e.event === 'SESSION_START');
  const end    = entries.find(e => e.event === 'SESSION_END');

  console.log(cb('lcyan', '\n══ SESSION SUMMARY ══════════════════════════════════════\n'));
  console.log(`  ${c('gray','Session')}  : ${start?.sessionId || '?'}`);
  console.log(`  ${c('gray','WorkDir')}  : ${start?.workingDir || '(unknown)'}`);
  console.log(`  ${c('gray','Duration')} : ${fmtMs(totalDurationMs)}`);
  console.log(`  ${c('gray','Events')}   : ${entries.length}`);
  console.log('');

  console.log(cb('white', '  Event Counts:'));
  Object.entries(byType).sort((a,b) => b[1]-a[1]).forEach(([k,v]) => {
    const color = EVENT_COLORS[k] || 'gray';
    console.log(`    ${c(color, (EVENT_ICONS[k] || k).trim().padEnd(12))} ${c('white', String(v).padStart(4))}`);
  });
  console.log('');

  if (toolCalls.length) {
    const freq = {};
    toolCalls.forEach(t => freq[t] = (freq[t]||0)+1);
    console.log(cb('white', '  Tool Usage:'));
    Object.entries(freq).sort((a,b)=>b[1]-a[1]).forEach(([t,n]) =>
      console.log(`    ${c('magenta', t.padEnd(25))} ${c('gray', `×${n}`)}`));
    console.log('');
  }

  if (errors.length) {
    console.log(cb('lred', `  Errors (${errors.length}):`));
    errors.slice(0, 10).forEach(e => console.log(`    ${c('lred','✖')} ${trunc(e, 120)}`));
    console.log('');
  }

  if (warns.length) {
    console.log(cb('lyellow', `  Warnings (${warns.length}):`));
    warns.slice(0, 10).forEach(w => console.log(`    ${c('lyellow','⚠')} ${trunc(w, 120)}`));
    console.log('');
  }

  console.log(c('gray', '═'.repeat(60)) + '\n');
}

// ─────────────────────────────────────────────
//  List view
// ─────────────────────────────────────────────
function printList(files) {
  console.log(cb('lcyan', '\n══ SESSION LOGS ══════════════════════════════════════════\n'));
  console.log(c('gray', `  Log directory: ${LOG_ROOT}\n`));

  if (!files.length) {
    console.log(c('yellow', '  No session logs found yet. Run a task first.\n'));
    return;
  }

  files.forEach((f, i) => {
    const fp  = path.join(LOG_ROOT, f);
    const raw = fs.readFileSync(fp, 'utf8').split('\n').filter(Boolean);
    let events = 0, tools = 0, errors = 0, dur = '?';
    for (const line of raw) {
      try {
        const e = JSON.parse(line);
        events++;
        if (e.event === 'TOOL_CALL') tools++;
        if (e.event === 'ERROR') errors++;
        if (e.event === 'SESSION_END') dur = fmtMs(e.totalMs);
      } catch {}
    }

    const prefix = f.slice(0, 19).replace(/T/, ' ').replace(/-/g, ':').slice(0, 19);
    const idPart = f.slice(20).replace('.jsonl', '');
    const errTag = errors ? c('lred', ` ✖${errors}err`) : '';
    console.log(
      `  ${c('gray',String(i+1).padStart(2)+'.')} ` +
      `${c('cyan', prefix)}  ` +
      `${c('gray', idPart.padEnd(15))}  ` +
      `${c('white', String(events).padStart(4))} evts  ` +
      `${c('magenta', String(tools).padStart(3))} tools  ` +
      `${c('gray', dur.padStart(7))}` +
      errTag
    );
  });

  console.log('');
  console.log(c('gray', `  Usage: node src/view-logs.js <id-prefix>      → full log`));
  console.log(c('gray', `         node src/view-logs.js <id-prefix> --summary → summary`));
  console.log(c('gray', `         node src/view-logs.js --last           → latest session`));
  console.log('');
}

// ─────────────────────────────────────────────
//  Main
// ─────────────────────────────────────────────
const args   = process.argv.slice(2);
const flags  = new Set(args.filter(a => a.startsWith('--')));
const posArgs = args.filter(a => !a.startsWith('--'));

const isSummary = flags.has('--summary');
const isLast    = flags.has('--last');
const filterRaw = [...flags].find(f => f.startsWith('--filter='));
const filterEvents = filterRaw
  ? new Set(filterRaw.slice('--filter='.length).toUpperCase().split(','))
  : null;

const files = listLogFiles();

if (!posArgs.length && !isLast) {
  printList(files);
  process.exit(0);
}

// Find the target file
let targetFile = null;
if (isLast) {
  targetFile = files[0] ? path.join(LOG_ROOT, files[0]) : null;
} else {
  const prefix = posArgs[0];
  const match  = files.find(f => f.includes(prefix));
  if (match) targetFile = path.join(LOG_ROOT, match);
}

if (!targetFile || !fs.existsSync(targetFile)) {
  console.error(c('lred', `\n  No log found matching: ${posArgs[0] || '(last)'}\n`));
  printList(files);
  process.exit(1);
}

console.log(cb('lcyan', `\n══ LOG: ${path.basename(targetFile)} ══\n`));

const entries = readLog(targetFile);

if (isSummary) {
  printSummary(entries);
} else {
  const filtered = filterEvents
    ? entries.filter(e => filterEvents.has(e.event))
    : entries;

  filtered.forEach(e => printEvent(e, { summaryOnly: false }));

  // Always print summary at the end
  console.log('');
  printSummary(entries);
}
