// src/prompt.js — Enhanced System Prompt with Planning, Reflection, and Memory Instructions
'use strict';

const os = require('os');
const path = require('path');
const config = require('./config');

// ─────────────────────────────────────────────────────────────────────────────
// Section builders
// ─────────────────────────────────────────────────────────────────────────────

function buildIdentity() {
  return [
    'You are an enhanced coding assistant with planning, memory, reflection, and self-correction capabilities.',
    'You excel at long-horizon complex tasks by decomposing them, tracking progress, and adapting your approach.',
    '',
  ].join('\n');
}

function buildRules() {
  return [
    'CORE RULES',
    '----------',
    '1. Match the tone. If the user says something casual ("hi", "hey", "thanks"), reply naturally in 1–2 sentences. Do NOT list tools, ask clarifying questions, or structure it like a task.',
    '2. Lead with the answer for real tasks. No preamble. No "I\'ll now..." or "Let me...". Your first token is either a tool_call block or the answer\'s first word.',
    '3. Only ask clarifying questions when a CODING TASK is genuinely ambiguous (missing file path, unclear goal, contradictory requirements). Ask 2–4 short questions in plain text, then wait. NEVER ask clarifying questions for greetings or status checks.',
    '4. Use tool calls silently. Do not narrate "Reading file X..." or "I\'ll now examine...". The user sees tool calls in the UI — they don\'t need prose narration.',
    '5. Structure long answers: TL;DR (≤3 lines) → ## sections → - bullets → tables. Bold **key terms**. Use `code spans` for paths, identifiers, commands. But do NOT force this on short answers — a 1-line reply stays 1 line.',
    '6. If you\'re unsure, say so. "I don\'t know" > confident wrong answer. "This might break" > "this will work". Hedge when appropriate.',
    '7. After completing real work, list:',
    '   (a) concrete file paths changed (full paths, not "the file")',
    '   (b) build/test status (✓ passed / ✗ failed with error)',
    '   (c) a 3-item test checklist of what the user should verify',
    '   Skip this for casual conversation.',
    '8. End long work responses with a question offering 2–3 next-step options. Do NOT append questions to greetings or small talk.',
    '9. Reasoning goes in  blocks (DeepSeek R1 native). User-visible output is the final answer only. Do not emit reasoning as prose.',
    '10. PLANNING: For complex tasks, FIRST create a plan using the task_planner tool. Break work into subtasks with dependencies. Track progress. Update the plan as you learn.',
    '11. MEMORY: Use working_memory to store key facts, decisions, and context. Use long_term_memory to recall relevant past episodes, skills, and patterns. Reference them in your reasoning.',
    '12. REFLECTION: Periodically reflect on progress using self_reflection. Are you stuck? Is the approach working? Should you pivot? Be honest — if progress stalls, change strategy.',
    '13. ADAPTATION: If a tool fails repeatedly, try a different approach. If a subtask takes too long, decompose it further. If you\'re repeating yourself, stop and reassess.',
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
    'SPECIAL TOOLS FOR ENHANCED CAPABILITIES:',
    '- task_planner: Create, update, and query execution plans',
    '- working_memory: Store/retrieve key facts and context',
    '- long_term_memory: Recall past episodes, skills, and patterns',
    '- self_reflection: Analyze progress, detect stuck states, suggest pivots',
    '- progress_tracker: Create checkpoints, track completion, enable resume',
    '- skill_learning: Extract reusable patterns from successful executions',
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
    '- start_server(name, command, port) — start a server in background and confirm port opens. PREFER this over run_command background:true when you know the port.',
    '- stop_server(name) — stop a background server started with start_server or run_command background:true',
    '- http_get(url) — fetch a URL',
    '- get_symbol_signatures(path) — extract AST symbols from a file',
    '- get_diagnostics([path]) — get lint/compiler diagnostics',
    '',
    'ENHANCED TOOLS (for complex tasks):',
    '- task_planner(action, [plan_data]) — action: "create"|"update"|"get_progress"|"get_ready"|"start_subtask"|"complete_subtask"|"fail_subtask"',
    '- working_memory(action, [data]) — action: "add"|"get_context"|"set_focus"|"extract_facts"',
    '- long_term_memory(action, [data]) — action: "recall_facts"|"recall_episodes"|"recall_skills"|"remember_fact"|"start_episode"|"end_episode"|"learn_skill"',
    '- self_reflection(action, [data]) — action: "reflect"|"analyze_progress"|"check_stuck"|"suggest_pivot"',
    '- progress_tracker(action, [data]) — action: "checkpoint"|"get_resume_data"|"verify_workspace"|"export_report"',
    '- skill_learning(action, [data]) — action: "extract_from_episode"|"find_applicable"|"apply_skill"|"record_outcome"',
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
// Conversation manager
// ─────────────────────────────────────────────────────────────────────────────

function formatToolResult(name, result, isError = false) {
  const status = isError ? 'ERROR' : 'SUCCESS';
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return `[TOOL ${status}] ${name}\n${resultStr}`;
}

class ConversationManager {
  constructor() {
    this.messages = [];
    this.maxMessages = 20;
    this.workingDir = null;
    this.situationReport = null;
    this.readOnly = false;
    this.tab = null;
    this.model = null;
  }

  get turnCount() {
    return this.messages.filter(m => m.role === 'assistant').length;
  }

  addMessage(role, content) {
    this.messages.push({ role, content, ts: Date.now() });
    if (this.messages.length > this.maxMessages) {
      this.messages = this.messages.slice(-this.maxMessages);
    }
  }

  getRecentTurns(count = 6) {
    return this.messages.slice(-count);
  }

  getSummary() {
    const older = this.messages.slice(0, -6);
    if (older.length === 0) return '';
    return older.map(m => `[${m.role}] ${m.content.slice(0, 200)}`).join('\n');
  }

  buildFirstMessage(task, dirListing) {
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
      conversation: null,
      readOnly,
      tab: this.tab,
      model: this.model,
      dirListing,
    });
  }

  addAssistantMessage(rawResponse) {
    this.addMessage('assistant', rawResponse);
  }

  addBatchToolResults(combined) {
    const content = typeof combined === 'string' ? combined : String(combined);
    this.addMessage('user', content);
    return content;
  }

  addToolResult(name, result, isError = false) {
    return this.addBatchToolResults(formatToolResult(name, result, isError));
  }

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
// Main prompt builder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the full system prompt sent to DeepSeek.
 * @param {Object} opts
 * @param {string} opts.task — the user's task description
 * @param {string} [opts.workingDir] — override working directory
 * @param {string} [opts.situationReport] — prior session context
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

  // 5b. Working directory listing (first turn only)
  if (dirListing && dirListing.trim().length > 0) {
    parts.push([
      'WORKING DIRECTORY CONTENTS',
      '--------------------------',
      dirListing,
      '',
    ].join('\n'));
  }

  // 6. Read-only warning
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

  // 7. Prior session context
  const situation = buildSituationReport(situationReport);
  if (situation) parts.push(situation);

  // 8. Recent conversation
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
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  buildPrompt,
  ConversationManager,
  buildIdentity,
  buildRules,
  buildOutputFormat,
  buildTools,
  buildEnvironment,
  buildSituationReport,
  buildUserTask,
};