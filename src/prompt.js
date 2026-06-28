// =============================================================================
// code/prompt.js  →  deepseek-web-gateway/src/prompt.js  (REPLACE)
// =============================================================================
// Rewritten system prompt for the DeepSeek agent.
//
// Goals (vs. current prompt):
//   1. Kill verbose preamble ("I'll perform a systematic analysis...")
//   2. Force structured output (TL;DR → sections → bullets → tables)
//   3. Make the agent ask 3–6 clarifying questions on ambiguous tasks
//   4. Make tool use silent — no narration between calls
//   5. Encourage honesty ("I don't know" > confident wrong answer)
//   6. End every long response with a question offering next steps
//
// Prompt size: ~4,000 chars (down from ~24,000 — 5× reduction)
// =============================================================================

'use strict';

const os = require('os');
const path = require('path');
const config = require('./config');

// ─────────────────────────────────────────────────────────────────────────────
//  Section builders
// ─────────────────────────────────────────────────────────────────────────────

function buildIdentity() {
  return [
    'You are a coding assistant. Be concise, structured, and honest.',
    '',
  ].join('\n');
}

function buildRules() {
  return [
    'RULES',
    '1. Match the tone. If the user says something casual ("hi", "hey", "how are you",',
    '   "thanks", "what can you do"), reply naturally in 1–2 sentences as a friendly',
    '   coding assistant. Do NOT list tools, do NOT ask clarifying questions, do NOT',
    '   structure it like a task. Chat like a human collaborator.',
    '2. Lead with the answer for real tasks. No preamble. No "I\'ll now..." or "Let me...".',
    '   Your first token is either a tool_call block or the answer\'s first word.',
    '3. Only ask clarifying questions when a user gives a CODING TASK that is genuinely',
    '   ambiguous (missing file path, unclear goal, contradictory requirements).',
    '   In that case ask 2–4 short questions in plain text, then wait.',
    '   NEVER ask clarifying questions for greetings, small talk, or status checks.',
    '4. Use tool calls silently. Do not narrate "Reading file X..." or "I\'ll now examine...".',
    '   The user sees tool calls in the UI — they don\'t need prose narration.',
    '5. Structure long answers: TL;DR (≤3 lines) → ## sections → - bullets → tables.',
    '   Bold **key terms**. Use `code spans` for paths, identifiers, commands.',
    '   But do NOT force this structure onto short answers — a 1-line reply stays 1 line.',
    '6. If you\'re unsure, say so. "I don\'t know" > confident wrong answer.',
    '   "This might break" > "this will work". Hedge when appropriate.',
    '7. After completing real work, list:',
    '   (a) concrete file paths changed (full paths, not "the file")',
    '   (b) build/test status (✓ passed / ✗ failed with error)',
    '   (c) a 3-item test checklist of what the user should verify',
    '   Skip this for casual conversation.',
    '8. End long work responses with a question offering 2–3 next-step options.',
    '   Do NOT append questions to greetings or small talk.',
    '9. Reasoning goes in <think>...</think> blocks (DeepSeek R1 native).',
    '   User-visible output is the final answer only. Do not emit reasoning as prose.',
    '',
  ].join('\n');
}

function buildOutputFormat() {
  return [
    'OUTPUT FORMAT',
    '-------------',
    'To call a tool, emit a fenced block:',
    '',
    '```tool_call',
    '{"name": "read_file", "args": {"path": "src/server.js"}}',
    '```',
    '',
    'You may emit multiple tool_call blocks in one response — they run in parallel.',
    'Do NOT write prose between tool_call blocks. Either call tools OR write prose, not both.',
    '',
    'When you have the final answer, write it as Markdown (no tool_call block).',
    '',
  ].join('\n');
}

function buildTools() {
  return [
    'TOOLS',
    '-----',
    '- read_file(path, [start_line], [end_line]) — read file contents',
    '- write_file(path, content) — create or overwrite file',
    '- replace_in_file(path, find, replace, [all_occurrences]) — surgical edit to existing file. `find` MUST be unique unless all_occurrences=true (default false). If it matches >1 spot, the tool refuses — include more context to make it unique.',
    '- append_to_file(path, content) — append to existing file',
    '- delete_file(path) — remove file',
    '- move_file(src, dst) — rename or move file',
    '- list_directory(path, [recursive]) — list directory contents',
    '- find_files(pattern, directory, [case_sensitive], [context_lines]) — regex search files',
    '- search_file(path, query) — search within a single file',
    '- run_command(command, [timeout_ms], [background]) — BLOCKING shell command (builds, tests, migrations). Do NOT use for servers. Pass background:true for long-running processes (dev servers, watchers) or use start_server when you know the port.',
    '- start_server(name, command, port) — start a server in the background and confirm the port opens. PREFER this over run_command background:true when you know the port.',
    '- stop_server(name) — stop a background server started with start_server or run_command background:true',
    '- http_get(url) — fetch a URL',
    '- get_symbol_signatures(path) — extract AST symbols from a file',
    '- get_diagnostics([path]) — get lint/compiler diagnostics',
    '',
  ].join('\n');
}

function buildEnvironment(workingDir) {
  const cwd = workingDir || config.WORKING_DIR || process.cwd();
  return [
    'ENVIRONMENT',
    '-----------',
    `Platform         : ${process.platform} ${os.release()}`,
    `Node.js          : ${process.version}`,
    `Date/Time        : ${new Date().toISOString()}`,
    `Working Directory: ${cwd}`,
    '',
  ].join('\n');
}

function buildSituationReport(situationReport) {
  if (!situationReport) return '';
  // situationReport is a string from SituationReport.js
  // Strip ASCII-art borders to keep prompt compact
  const compact = situationReport
    .split('\n')
    .filter(line => !line.match(/^[╔╗╚╝║═]/))
    .map(line => line.replace(/\s+$/, ''))
    .join('\n')
    .trim();

  if (!compact) return '';

  return [
    'PRIOR SESSION CONTEXT',
    '---------------------',
    compact,
    '',
  ].join('\n');
}

function buildUserTask(task) {
  return [
    'USER TASK',
    '---------',
    task,
    '',
  ].join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Conversation manager
//
//  Agent.js calls these methods on the conversation object:
//    .turnCount                (getter)
//    .buildFirstMessage(task, dirListing)
//    .addAssistantMessage(rawResponse)
//    .addBatchToolResults(combined)   -> returns the message string
//    .addToolResult(name, result, isError)  -> returns the message string
//    .exportLog()
//    .addMessage(role, content)        (already existed)
//  All of them are implemented here so the prompt rewrite is a true drop-in.
// ─────────────────────────────────────────────────────────────────────────────

/** Inline tool-result formatter (kept local to avoid a parser.js dependency). */
function formatToolResult(name, result, isError = false) {
  const status = isError ? 'ERROR' : 'SUCCESS';
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return `[TOOL ${status}] ${name}\n${resultStr}`;
}

class ConversationManager {
  constructor() {
    this.messages = [];
    this.maxMessages = 20; // keep last 20 turns in prompt; older go to summary
    // Context that buildFirstMessage needs but isn't known at construction.
    // Set by the agent before the first turn (see agent.js run()).
    this.workingDir = null;
    this.situationReport = null;
    this.readOnly = false;
    this.tab = null;
    this.model = null;
  }

  /** Number of assistant turns observed so far (used to gate retry logic). */
  get turnCount() {
    return this.messages.filter(m => m.role === 'assistant').length;
  }

  addMessage(role, content) {
    this.messages.push({ role, content, ts: Date.now() });
    if (this.messages.length > this.maxMessages) {
      // Keep last maxMessages
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }

  getRecentTurns(count = 6) {
    return this.messages.slice(-count);
  }

  getSummary() {
    // Compact summary of turns older than `count`
    const older = this.messages.slice(0, -6);
    if (older.length === 0) return '';
    return older.map(m => `[${m.role}] ${m.content.slice(0, 200)}`).join('\n');
  }

  /**
   * Build the first outgoing message for a new task.
   * This is the FULL system prompt — identity + rules + output format + tools
   * + environment + situation report + working-dir listing + the user task.
   * Returns the composed string ready to send to DeepSeek.
   */
  buildFirstMessage(task, dirListing) {
    // readOnly is enforced at the tools layer; reflect it in the prompt so the
    // model knows not to even attempt write/command tools.
    let readOnly = this.readOnly;
    if (!readOnly) {
      try {
        const { isReadOnly } = require('./tools');
        readOnly = !!isReadOnly();
      } catch { /* tools module not loaded — skip */ }
    }
    return buildPrompt({
      task,
      workingDir: this.workingDir,
      situationReport: this.situationReport,
      conversation: null, // first turn — no recent history to include
      readOnly,
      tab: this.tab,
      model: this.model,
      dirListing,
    });
  }

  /** Record an assistant response verbatim. */
  addAssistantMessage(rawResponse) {
    this.addMessage('assistant', rawResponse);
  }

  /**
   * Append a batch of tool results as a single user message and return the
   * exact string the agent should send to DeepSeek next.
   */
  addBatchToolResults(combined) {
    const content = typeof combined === 'string' ? combined : String(combined);
    this.addMessage('user', content);
    return content;
  }

  /** Format a single tool result, append it, and return the message string. */
  addToolResult(name, result, isError = false) {
    return this.addBatchToolResults(formatToolResult(name, result, isError));
  }

  /** Human-readable transcript of the whole conversation (used for log dumps). */
  exportLog() {
    return this.messages
      .map(m => `[${(m.role || 'unknown').toUpperCase()}]\n${m.content}`)
      .join('\n\n');
  }

  clear() {
    this.messages = [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main prompt builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the full system prompt sent to DeepSeek.
 *
 * @param {Object} opts
 * @param {string} opts.task — the user's task description
 * @param {string} [opts.workingDir] — override working directory
 * @param {string} [opts.situationReport] — prior session context (from SituationReport.js)
 * @param {Object} [opts.conversation] — ConversationManager instance for recent turns
 * @param {boolean} [opts.readOnly] — read-only mode active
 * @param {string} [opts.tab] — current tab name
 * @param {string} [opts.model] — current model name
 * @param {string} [opts.dirListing] — working-directory file listing (first turn only)
 * @returns {string} the full system prompt
 */
function buildPrompt(opts = {}) {
  const {
    task,
    workingDir,
    situationReport,
    conversation,
    readOnly,
    tab,
    model,
    dirListing,
  } = opts;

  const parts = [];

  // 1. Identity
  parts.push(buildIdentity());

  // 2. Rules
  parts.push(buildRules());

  // 3. Output format
  parts.push(buildOutputFormat());

  // 4. Tools (compact one-liners)
  parts.push(buildTools());

  // 5. Environment
  parts.push(buildEnvironment(workingDir));

  // 5b. Working directory listing (first turn only — model can list_directory later)
  if (dirListing && dirListing.trim().length > 0) {
    parts.push([
      'WORKING DIRECTORY CONTENTS',
      '--------------------------',
      dirListing,
      '',
    ].join('\n'));
  }

  // 6. Read-only warning (if active)
  if (readOnly) {
    parts.push([
      '⚠️  READ-ONLY MODE ACTIVE',
      '-------------------------',
      'Write/command tools are BLOCKED. Use only read_file, list_directory,',
      'find_files, search_file, http_get, get_symbol_signatures, get_diagnostics.',
      'Do NOT attempt write_file, replace_in_file, delete_file, run_command, etc.',
      '',
    ].join('\n'));
  }

  // 7. Prior session context (situation report)
  const situation = buildSituationReport(situationReport);
  if (situation) parts.push(situation);

  // 8. Recent conversation (if any)
  if (conversation && conversation.messages.length > 0) {
    const recent = conversation.getRecentTurns(6);
    const summary = conversation.getSummary();
    parts.push('RECENT CONVERSATION');
    parts.push('-------------------');
    if (summary) {
      parts.push('[Earlier turns — compacted]');
      parts.push(summary);
      parts.push('');
    }
    for (const m of recent) {
      parts.push(`[${m.role.toUpperCase()}]`);
      parts.push(m.content);
      parts.push('');
    }
  }

  // 9. User task (always last — model pays most attention to the end)
  parts.push(buildUserTask(task));

  return parts.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  buildPrompt,
  ConversationManager,
  // Exported for testing
  buildIdentity,
  buildRules,
  buildOutputFormat,
  buildTools,
  buildEnvironment,
  buildSituationReport,
  buildUserTask,
};
