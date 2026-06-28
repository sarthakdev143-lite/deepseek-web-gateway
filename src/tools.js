// src/tools.js — All tools available to the AI agent
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const http = require('http');
const https = require('https');
const config = require('./config');

// ── Read-only mode guard ───────────────────────────────────────────
let _readOnly = false;
const MUTATION_TOOLS = new Set([
  'write_file', 'write_files', 'replace_in_file', 'append_to_file', 'delete_file',
  'move_file', 'copy_file', 'run_command', 'start_server',
]);

function setReadOnly(val) { _readOnly = Boolean(val); }
function isReadOnly()     { return _readOnly; }


const activeServers = new Map(); // name -> { proc, port, command, workDir, getLogs }

// Windows-safe command sanitizer — inlined in ./utils so the gateway is
// self-contained (previously reached across into the sibling `seekcode`
// package, which silently fell back to a no-op if that package was missing).
const { sanitizeCommand } = require('./utils');


// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

function truncate(str, max = config.MAX_OUTPUT_LENGTH) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return (
    s.slice(0, half) +
    `\n\n⚠  [OUTPUT TRUNCATED — ${s.length.toLocaleString()} chars total, showing first & last ${half}]\n\n` +
    s.slice(-half)
  );
}

function resolve(filePath) {
  let p = filePath;
  if (process.platform === 'win32' && p && p.includes(' ')) {
    p = p.replace(/^["']|["']$/g, '');
  }
  if (path.isAbsolute(p)) return p;
  return path.resolve(config.WORKING_DIR, p);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// ─────────────────────────────────────────────
//  Change log
// ─────────────────────────────────────────────

const LOG_FILE = path.join(process.cwd(), '.seekcode', 'changes.json');

async function logChange(action, filePath, details = '') {
  try {
    const dir = path.dirname(LOG_FILE);
    // FIXED: existsSync instead of fs.promises.access as boolean
    if (!fs.existsSync(dir)) await fs.promises.mkdir(dir, { recursive: true });

    let log = [];
    if (fs.existsSync(LOG_FILE)) {
      log = JSON.parse(await fs.promises.readFile(LOG_FILE, 'utf8'));
    }
    log.push({ timestamp: new Date().toISOString(), action, file: filePath, details });
    await fs.promises.writeFile(LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
  } catch { /* ignore logging errors */ }
}

// ─────────────────────────────────────────────
//  Atomic write (used internally)
// ─────────────────────────────────────────────

async function atomicWriteFile(filePath, content) {
  const tempPath = `${filePath}.tmp.${Date.now()}`;
  const backupPath = `${filePath}.bak`;

  try {
    // FIXED: existsSync is the correct existence check — access() resolves
    // with undefined (falsy), so using it as a boolean always returned false.
    if (fs.existsSync(filePath)) {
      await fs.promises.copyFile(filePath, backupPath);
    }

    await fs.promises.writeFile(tempPath, content, 'utf8');
    await fs.promises.rename(tempPath, filePath);

    if (fs.existsSync(backupPath)) {
      await fs.promises.unlink(backupPath);
    }

    return { success: true, path: filePath };
  } catch (err) {
    // Restore backup on failure
    if (fs.existsSync(backupPath)) {
      await fs.promises.copyFile(backupPath, filePath);
      await fs.promises.unlink(backupPath);
    }
    if (fs.existsSync(tempPath)) {
      await fs.promises.unlink(tempPath);
    }
    throw new Error(`Atomic write failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
//  Tool definitions
// ─────────────────────────────────────────────

// Helper: format symbol entries for get_symbol_signatures
function _formatSymbols(filePath, entry) {
  if (!entry || !entry.symbols || entry.symbols.length === 0) {
    return `[${filePath}]\nNo symbols found in index.`;
  }
  const lines = [`[${filePath}]`, `Imports: ${(entry.imports || []).join(', ') || '(none)'}`, ''];
  const exportedNames = new Set(entry.exports || []);
  for (const sym of entry.symbols) {
    const tag = sym.exported || exportedNames.has(sym.name) ? '(exported)' : '(private)';
    const sig = sym.signature && sym.signature !== sym.name ? sym.signature : sym.name;
    lines.push(`  ${sym.kind || 'symbol'} ${tag}  L${sym.line || '?'}\n    ${sig}`);
  }
  return lines.join('\n');
}

const TOOLS = {

  // ── Read File ───────────────────────────────────────────────────────────────
  read_file: {
    description: 'Read the full contents of a file. Optionally read specific line ranges.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the file' },
      start_line: { type: 'number', required: false, description: 'First line to read (1-indexed)' },
      end_line: { type: 'number', required: false, description: 'Last line to read (inclusive)' },
    },
    async execute({ path: filePath, start_line, end_line }) {
      const abs = resolve(filePath);
      // FIXED: existsSync — previously used fs.promises.access which resolves
      // with undefined (falsy), so !undefined was always true → always threw "not found"
      if (!fs.existsSync(abs)) throw new Error(`File not found: ${filePath}`);
      if (fs.statSync(abs).isDirectory()) throw new Error(`${filePath} is a directory`);

      let content = await fs.promises.readFile(abs, 'utf8');

      if (start_line != null || end_line != null) {
        const lines = content.split('\n');
        const s = Math.max(0, (start_line || 1) - 1);
        const e = end_line != null ? end_line : lines.length;
        content = lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join('\n');
        return `[${filePath} | lines ${s + 1}–${e}]\n${truncate(content)}`;
      }

      const lineCount = content.split('\n').length;
      if (lineCount <= 300) {
        const numbered = content.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
        return `[${filePath} | ${lineCount} lines]\n${numbered}`;
      }
      return `[${filePath} | ${lineCount} lines — use start_line/end_line to read sections]\n${truncate(content)}`;
    },
  },

  // ── Write File ──────────────────────────────────────────────────────────────
  write_file: {
    description: [
      'Write (create or fully overwrite) a file with the given content.',
      'Use replace_in_file for surgical edits to EXISTING files — it is safer.',
      'Use write_file only when creating new files or when a full rewrite is truly needed.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'Destination file path' },
      content: { type: 'string', required: true, description: 'Full file content to write' },
    },
    async execute({ path: filePath, content }) {
      const abs = resolve(filePath);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });

      // ── Idempotency: skip write if file content is already identical ──────────
      if (fs.existsSync(abs)) {
        try {
          const existing = await fs.promises.readFile(abs, 'utf8');
          const hashNew = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
          const hashOld = crypto.createHash('sha256').update(existing, 'utf8').digest('hex');
          if (hashNew === hashOld) {
            return `✓ No-op — file content unchanged (${formatBytes(Buffer.byteLength(content, 'utf8'))}) → ${filePath}`;
          }
        } catch { /* fall through to normal write */ }
      }

      await atomicWriteFile(abs, content);
      const lineCount = content.split('\n').length;
      await logChange('write', filePath, `wrote ${lineCount} lines`);
      return `✓ Wrote ${formatBytes(Buffer.byteLength(content, 'utf8'))} (${lineCount} lines) → ${filePath}`;
    },
  },

  // ── Write Files (Batch) ──────────────────────────────────────────────────────
  write_files: {
    description: 'Write (create or fully overwrite) multiple files to disk simultaneously.',
    parameters: {
      files: { type: 'array', required: true, description: 'An array of objects: [ { path: string, content: string }, ... ]' }
    },
    async execute({ files }) {
      if (!Array.isArray(files)) {
        return 'Error: files parameter must be an array';
      }

      const results = [];
      for (const file of files) {
        const filePath = file.path;
        const content = file.content;
        if (!filePath || content === undefined) {
          results.push(`✗ Error: file object missing path or content`);
          continue;
        }

        try {
          const absPath = resolve(filePath);
          await fs.promises.mkdir(path.dirname(absPath), { recursive: true });

          // Idempotency: skip write if file content is already identical
          let matches = false;
          if (fs.existsSync(absPath)) {
            try {
              const existing = await fs.promises.readFile(absPath, 'utf8');
              const hashNew = crypto.createHash('sha256').update(content, 'utf8').digest('hex');
              const hashOld = crypto.createHash('sha256').update(existing, 'utf8').digest('hex');
              matches = hashNew === hashOld;
            } catch {}
          }

          if (matches) {
            results.push(`✓ ${filePath}: No-op — file content unchanged (${formatBytes(Buffer.byteLength(content, 'utf8'))})`);
            continue;
          }

          await atomicWriteFile(absPath, content);
          const lineCount = content.split('\n').length;
          await logChange('write_file', filePath, `Batch wrote ${lineCount} lines`);
          results.push(`✓ ${filePath}: Written successfully (${formatBytes(Buffer.byteLength(content, 'utf8'))}, ${lineCount} lines)`);
        } catch (err) {
          results.push(`✗ ${filePath}: Error writing file: ${err.message}`);
        }
      }
      return results.join('\n');
    }
  },

  // ── Append to File ──────────────────────────────────────────────────────────
  append_to_file: {
    description: 'Append text to the end of an existing file (or create it if missing).',
    parameters: {
      path: { type: 'string', required: true, description: 'File path' },
      content: { type: 'string', required: true, description: 'Text to append' },
    },
    async execute({ path: filePath, content }) {
      const abs = resolve(filePath);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.appendFile(abs, content, 'utf8');
      await logChange('append', filePath, `appended ${Buffer.byteLength(content, 'utf8')} bytes`);
      return `✓ Appended ${formatBytes(Buffer.byteLength(content, 'utf8'))} to ${filePath}`;
    },
  },

  // ── Replace in File ─────────────────────────────────────────────────────────
  //
  // Hardening: the previous implementation defaulted `all_occurrences` to TRUE.
  // That meant a non-unique `find` string silently overwrote EVERY match — the
  // single most dangerous failure mode for a surgical-edit tool (an AI fixing
  // one `foo` could rewrite hundreds). It also had no uniqueness guard and a
  // fragile count path.
  //
  // New contract (safer-by-default, fully backward compatible when explicit):
  //   - all_occurrences defaults to FALSE (opt-in, like every frontier editor).
  //   - When FALSE and the match is NOT unique, the tool REFUSES with a clear
  //     error telling the model how many matches exist and to include more
  //     surrounding context. This turns a silent correctness bug into a loud,
  //     self-correcting signal — the model re-issues with a wider anchor.
  //   - all_occurrences: TRUE still works exactly as before (explicit bulk).
  //   - Regex mode unchanged; uniqueness check runs on the compiled pattern.
  replace_in_file: {
    description: [
      'Find and replace text in a file. This is the PREFERRED tool for editing existing files.',
      'Supports literal strings or regex patterns. Safer than write_file for partial edits.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'File path' },
      find: { type: 'string', required: true, description: 'Text to find' },
      replace: { type: 'string', required: true, description: 'Replacement text' },
      use_regex: { type: 'boolean', required: false, description: 'Treat "find" as a regex pattern (default: false)' },
      all_occurrences: { type: 'boolean', required: false, description: 'Replace ALL occurrences. Default FALSE. Only set TRUE for intentional bulk edits — otherwise include enough context in `find` to make it unique.' },
    },
    async execute({ path: filePath, find, replace, use_regex = false, all_occurrences = false }) {
      const abs = resolve(filePath);
      // FIXED: existsSync
      if (!fs.existsSync(abs)) throw new Error(`File not found: ${filePath}`);

      const before = await fs.promises.readFile(abs, 'utf8');

      // Build a single source of truth for the pattern. Non-regex find is escaped
      // so its special characters are treated literally — previously the count
      // path and the apply path escaped inconsistently (split/join vs RegExp),
      // so a find like "v1.2" could match different things in each path.
      const escapedFind = use_regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const globalMatcher  = new RegExp(escapedFind, 'g');   // /g  — counts & replaces all
      const firstMatcher   = new RegExp(escapedFind);        // no flag — first match only

      const count = (before.match(globalMatcher) || []).length;
      if (count === 0) {
        return `⚠  No matches found for "${find}" in ${filePath}`;
      }

      // Uniqueness guard: when NOT doing an intentional bulk replace, refuse an
      // ambiguous edit instead of silently editing the wrong location.
      if (!all_occurrences && count > 1) {
        throw new Error(
          `replace_in_file: "${find}" matched ${count} locations in ${filePath}, but ` +
          `all_occurrences is false (the safe default). To target ONE location, include ` +
          `more surrounding lines in \`find\` so it is unique. To replace all ${count} ` +
          `matches intentionally, set all_occurrences: true.`
        );
      }

      // Apply: bulk replaces all; otherwise exactly the first match.
      const finalContent = all_occurrences
        ? before.replace(globalMatcher, replace)
        : before.replace(firstMatcher, replace);

      if (finalContent === before) {
        // Defensive: should be unreachable given count>0, but never no-op silently.
        return `⚠  Match found but replacement produced no change in ${filePath}`;
      }

      const occurrencesReplaced = all_occurrences ? count : 1;
      await atomicWriteFile(abs, finalContent);
      await logChange('replace', filePath, `replaced ${occurrencesReplaced} of ${count} occurrence(s) of "${find}"`);
      return `✓ Replaced ${occurrencesReplaced} of ${count} occurrence(s) of "${find}" in ${filePath}`;
    },
  },

  // ── Delete File ─────────────────────────────────────────────────────────────
  delete_file: {
    description: 'Permanently delete a file.',
    parameters: {
      path: { type: 'string', required: true, description: 'File to delete' },
    },
    async execute({ path: filePath }) {
      const abs = resolve(filePath);
      // FIXED: existsSync
      if (!fs.existsSync(abs)) throw new Error(`File not found: ${filePath}`);
      await fs.promises.unlink(abs);
      await logChange('delete', filePath, 'deleted file');
      return `✓ Deleted ${filePath}`;
    },
  },

  // ── List Directory ──────────────────────────────────────────────────────────
  list_directory: {
    description: 'List files and folders in a directory, optionally recursive.',
    parameters: {
      path: { type: 'string', required: false, description: 'Directory to list (default: working dir)' },
      recursive: { type: 'boolean', required: false, description: 'Recurse into sub-directories (default: false)' },
      show_hidden: { type: 'boolean', required: false, description: 'Include hidden files (default: false)' },
    },
    async execute({ path: dirPath = '.', recursive = false, show_hidden = false }) {
      const abs = resolve(dirPath);
      // FIXED: existsSync
      if (!fs.existsSync(abs)) throw new Error(`Directory not found: ${dirPath}`);
      if (!fs.statSync(abs).isDirectory()) throw new Error(`${dirPath} is not a directory`);

      const SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'build', 'coverage', 'venv', '.venv', '__pycache__']);

      if (recursive) {
        const results = [];
        const walk = (dir, depth = 0) => {
          if (depth > 10 || results.length >= 300) return;
          const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => {
            if (!show_hidden && e.name.startsWith('.')) return false;
            if (SKIP.has(e.name)) return false;
            return true;
          });
          for (const e of entries) {
            results.push(path.join(dir, e.name));
            if (e.isDirectory()) walk(path.join(dir, e.name), depth + 1);
          }
        };
        walk(abs);
        return results.length > 0 ? results.join('\n') : '(empty)';
      }

      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter(e => show_hidden || !e.name.startsWith('.'))
        .sort((a, b) => {
          if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
          return a.name.localeCompare(b.name);
        });

      if (entries.length === 0) return `(empty directory: ${dirPath})`;

      const lines = entries.map(e => {
        if (e.isDirectory()) return `📁  ${e.name}/`;
        try {
          const { size } = fs.statSync(path.join(abs, e.name));
          return `📄  ${e.name}  ${formatBytes(size)}`;
        } catch { return `📄  ${e.name}`; }
      });

      return `[${dirPath}] — ${entries.length} items\n${lines.join('\n')}`;
    },
  },

  // ── Create Directory ────────────────────────────────────────────────────────
  create_directory: {
    description: 'Create a directory (and all necessary parent directories).',
    parameters: {
      path: { type: 'string', required: true, description: 'Directory path to create' },
    },
    async execute({ path: dirPath }) {
      const abs = resolve(dirPath);
      await fs.promises.mkdir(abs, { recursive: true });
      return `✓ Created directory: ${dirPath}`;
    },
  },

  // ── Move / Rename ───────────────────────────────────────────────────────────
  move_file: {
    description: 'Move or rename a file or directory.',
    parameters: {
      source: { type: 'string', required: true, description: 'Source path' },
      destination: { type: 'string', required: true, description: 'Destination path' },
    },
    async execute({ source, destination }) {
      const src = resolve(source);
      const dest = resolve(destination);
      // FIXED: existsSync
      if (!fs.existsSync(src)) throw new Error(`Source not found: ${source}`);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.rename(src, dest);
      return `✓ Moved: ${source} → ${destination}`;
    },
  },

  // ── Copy File ───────────────────────────────────────────────────────────────
  copy_file: {
    description: 'Copy a file to a new location.',
    parameters: {
      source: { type: 'string', required: true, description: 'Source file path' },
      destination: { type: 'string', required: true, description: 'Destination file path' },
    },
    async execute({ source, destination }) {
      const src = resolve(source);
      const dest = resolve(destination);
      // FIXED: existsSync
      if (!fs.existsSync(src)) throw new Error(`Source not found: ${source}`);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.copyFile(src, dest);
      return `✓ Copied: ${source} → ${destination}`;
    },
  },

  // ── File Info ───────────────────────────────────────────────────────────────
  get_file_info: {
    description: 'Get metadata about a file or directory (size, modified date, line count, etc.).',
    parameters: {
      path: { type: 'string', required: true, description: 'File or directory path' },
    },
    async execute({ path: filePath }) {
      const abs = resolve(filePath);
      // FIXED: existsSync
      if (!fs.existsSync(abs)) throw new Error(`Not found: ${filePath}`);
      const stat = fs.statSync(abs);
      const info = {
        path: abs,
        type: stat.isDirectory() ? 'directory' : 'file',
        size: stat.size,
        size_human: formatBytes(stat.size),
        modified: stat.mtime.toISOString(),
        created: stat.birthtime.toISOString(),
        permissions: `0${(stat.mode & 0o777).toString(8)}`,
      };
      if (stat.isFile()) {
        const content = await fs.promises.readFile(abs, 'utf8');
        info.lines = content.split('\n').length;
        info.encoding = 'utf-8';
      }
      return JSON.stringify(info, null, 2);
    },
  },

  // ── Run Command ─────────────────────────────────────────────────────────────
  // run_command: {
  //   description: 'Execute a shell command and return its output. Runs in the working directory by default.',
  //   parameters: {
  //     command : { type: 'string', required: true,  description: 'Shell command to run' },
  //     cwd     : { type: 'string', required: false, description: 'Working directory for the command' },
  //     timeout : { type: 'number', required: false, description: 'Timeout in milliseconds (default: 60000)' },
  //     env     : { type: 'object', required: false, description: 'Extra environment variables' },
  //   },
  //   async execute({ command, cwd, timeout = 60_000, env = {} }) {
  //     const workDir = cwd ? resolve(cwd) : config.WORKING_DIR;
  //     try {
  //       const output = execSync(command, {
  //         cwd: workDir, encoding: 'utf8', timeout,
  //         maxBuffer: 20 * 1024 * 1024,
  //         env: { ...process.env, ...env },
  //         stdio: ['pipe', 'pipe', 'pipe'],
  //       });
  //       return truncate((output || '').trim() || '(command completed with no output)');
  //     } catch (err) {
  //       const stdout = (err.stdout || '').trim();
  //       const stderr = (err.stderr || '').trim();
  //       const combined = [stdout && `STDOUT:\n${stdout}`, stderr && `STDERR:\n${stderr}`]
  //         .filter(Boolean).join('\n\n');
  //       throw new Error(`Command failed (exit ${err.status}):\n${truncate(combined || err.message)}`);
  //     }
  //   },
  // },

  run_command: {
    description: [
      'Execute a shell command and return its output. BLOCKING — waits for the command to finish.',
      'Use for builds, tests, migrations, installs. NOT for long-running servers.',
      'For servers (npm run dev, etc.) use start_server instead, or pass background:true.',
    ].join(' '),
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command to run' },
      cwd: { type: 'string', required: false, description: 'Working directory' },
      timeout: { type: 'number', required: false, description: 'Timeout in ms (default: 60000)' },
      // The model often emits `timeout_ms` (see the tool description in
      // prompt.js). Accept it as an alias so the requested deadline is
      // honoured instead of silently falling back to the 60s default —
      // which previously killed long installs mid-flight and destabilised
      // the browser-driven chat loop.
      timeout_ms: { type: 'number', required: false, description: 'Alias for timeout (ms)' },
      // When true, the command runs detached (spawned, not awaited) and the
      // call returns immediately. Honors the model's `background:true` intent
      // for long-running processes (dev servers, watchers) instead of silently
      // dropping it and blocking until the timeout kills the process — which
      // previously destabilised the gateway and crashed the chat tab.
      background: { type: 'boolean', required: false, description: 'Run detached (non-blocking). Use for long-running processes like dev servers. Returns immediately with a handle name. Prefer start_server when you know the port.' },
      env: { type: 'object', required: false, description: 'Extra environment variables' },
    },
    async execute({ command, cwd, timeout, timeout_ms, background = false, env = {} }) {
      // ── Background path: spawn detached, return immediately ──────────────
      // Honors the `background:true` flag the model emits. Without this, a
      // `run_command npm run dev` blocked until the timeout then killed the
      // server — a silent contract violation that destabilised the gateway.
      if (background) {
        const handle = TOOLS.start_server.execute({
          name: `bg_${Date.now().toString(36)}`,
          command,
          cwd,
          // No port → start_server just spawns and confirms the process is alive,
          // matching the "fire and forget" intent of background:true.
        });
        // start_server.execute is async but may reject; surface a clean message.
        return handle.catch((err) => {
          throw new Error(`Background command failed to start: ${err.message}`);
        }).then((r) => typeof r === 'string' ? `${r}\n(running detached — output not captured)` : r);
      }

      // Resolve the effective deadline: prefer an explicit value, fall back
      // to the model-friendly alias, then the default. Clamp to a safe band
      // so a malformed request can't pin a core (too low) or hang forever.
      const RUN_TIMEOUT_MIN_MS = 5_000;
      const RUN_TIMEOUT_MAX_MS = 5 * 60_000; // 5 minutes
      const requested = timeout_ms ?? timeout ?? 60_000;
      const effectiveTimeout = Math.min(
        RUN_TIMEOUT_MAX_MS,
        Math.max(RUN_TIMEOUT_MIN_MS, Number(requested) || 60_000)
      );

      // Prevent agent suicide commands
      const suicidePatterns = [
        /taskkill.*\bnode(\.exe)?\b/i,
        /\b(killall|pkill|pkill\.exe|kill)\b.*\bnode(\.exe)?\b/i,
      ];
      if (suicidePatterns.some(regex => regex.test(command))) {
        throw new Error(`Security Error: Command rejected. Attempting to kill Node.js processes globally (${command}) would terminate the SeekCode agent and gateway processes. Please kill the target application by its specific port or PID instead, or use the start_server/stop_server tools.`);
      }

      const workDir = cwd ? resolve(cwd) : config.WORKING_DIR;
      try {
        const output = execSync(command, {
          cwd: workDir, encoding: 'utf8', timeout: effectiveTimeout,
          maxBuffer: 20 * 1024 * 1024,
          env: { ...process.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        return truncate((output || '').trim() || '(command completed with no output)');
      } catch (err) {
        const stdout = (err.stdout || '').trim();
        const stderr = (err.stderr || '').trim();
        const combined = [stdout && `STDOUT:\n${stdout}`, stderr && `STDERR:\n${stderr}`]
          .filter(Boolean).join('\n\n');
        throw new Error(`Command failed (exit ${err.status}):\n${truncate(combined || err.message)}`);
      }
    },
  },

  // ── Find Files ──────────────────────────────────────────────────────────────
  find_files: {
    description: 'Search for files by content pattern (grep-style). Optionally filter by file extension.',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Search pattern (regex or text)' },
      directory: { type: 'string', required: false, description: 'Directory to search (default: working dir)' },
      file_pattern: { type: 'string', required: false, description: 'File extension filter e.g. ".js"' },
      case_sensitive: { type: 'boolean', required: false, description: 'Case-sensitive search (default: false)' },
      context_lines: { type: 'number', required: false, description: 'Lines of context around match (default: 2)' },
    },
    async execute({ pattern, directory = '.', file_pattern, case_sensitive = false, context_lines = 2 }) {
      const dir = resolve(directory);
      const flags = case_sensitive ? '' : 'i';
      const results = [];
      const SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'build', 'coverage', 'venv', '.venv', '__pycache__']);

      const walk = (currentDir, depth = 0) => {
        if (depth > 10) return;
        try {
          const entries = fs.readdirSync(currentDir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
              if (!SKIP.has(entry.name)) walk(fullPath, depth + 1);
            } else if (entry.isFile()) {
              if (file_pattern && !entry.name.endsWith(file_pattern.replace('*', ''))) continue;
              try {
                const content = fs.readFileSync(fullPath, 'utf8');
                const lines = content.split('\n');
                const regex = new RegExp(pattern, flags);
                lines.forEach((line, idx) => {
                  if (regex.test(line)) {
                    const start = Math.max(0, idx - context_lines);
                    const end = Math.min(lines.length - 1, idx + context_lines);
                    const ctx = lines.slice(start, end + 1)
                      .map((l, ci) => `${start + ci + 1}: ${l}`)
                      .join('\n');
                    results.push(`\n${fullPath}:${idx + 1}\n${ctx}`);
                  }
                });
              } catch { /* skip unreadable */ }
            }
          }
        } catch { /* skip inaccessible */ }
      };

      walk(dir);
      const output = results.join('\n').substring(0, 8000);
      return output || `No matches found for: ${pattern}`;
    },
  },

  // ── Fetch URL ───────────────────────────────────────────────────────────────
  read_url: {
    description: 'Fetch the text content of a URL (useful for reading documentation, APIs, etc.).',
    parameters: {
      url: { type: 'string', required: true, description: 'Full URL to fetch (http or https)' },
    },
    async execute({ url }) {
      return new Promise((resolve_p, reject) => {
        const client = url.startsWith('https') ? https : http;
        const options = {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SeekCode/1.0)',
            'Accept': 'text/html,text/plain,application/json',
          },
        };

        const req = client.get(url, options, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return TOOLS.read_url.execute({ url: res.headers.location }).then(resolve_p).catch(reject);
          }
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            const text = data
              .replace(/<script[\s\S]*?<\/script>/gi, '')
              .replace(/<style[\s\S]*?<\/style>/gi, '')
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s{3,}/g, '\n\n')
              .trim();
            resolve_p(truncate(text));
          });
        });

        req.on('error', reject);
        req.setTimeout(15_000, () => { req.destroy(); reject(new Error('URL fetch timed out')); });
      });
    },
  },

  // ── (write_files is defined above with idempotency + per-file error
  //    isolation. An earlier duplicate definition here shadowed it — removed
  //    so the robust implementation is the one that actually runs.)

  // ── HTTP GET ────────────────────────────────────────────────────────────────
  http_get: {
    description: 'Perform a HTTP GET request. Useful for health checking local servers or calling local APIs.',
    parameters: {
      url: { type: 'string', required: true, description: 'The URL to request (e.g. http://localhost:3000/api/health)' },
      timeout: { type: 'number', required: false, description: 'Timeout in ms (default: 5000)' }
    },
    async execute({ url, timeout = 5000 }) {
      return new Promise((resolve_p, reject) => {
        const client = url.startsWith('https') ? https : http;
        const req = client.get(url, { timeout }, res => {
          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            resolve_p(`HTTP ${res.statusCode}\n\n${data.slice(0, 1000)}`);
          });
        });
        req.on('error', err => reject(new Error(`HTTP GET failed: ${err.message}`)));
        req.on('timeout', () => {
          req.destroy();
          reject(new Error(`HTTP GET timed out after ${timeout}ms`));
        });
      });
    }
  },

  // ── Start Server ───────────────────────────────────────────────────────────
  start_server: {
    description: 'Start a local server in the background (e.g. npm run dev, nest start). Returns immediately after checking port or spawn.',
    parameters: {
      name: { type: 'string', required: true, description: 'A unique name for this server process' },
      command: { type: 'string', required: true, description: 'The command to run to start the server' },
      cwd: { type: 'string', required: false, description: 'Working directory' },
      port: { type: 'number', required: false, description: 'The port the server is expected to listen on (optional)' },
      ready_timeout: { type: 'number', required: false, description: 'Max time in ms to wait for the port to open (default: 15000)' }
    },
    async execute({ name, command, cwd, port, ready_timeout = 15000 }) {
      const { spawn } = require('child_process');
      const workDir = cwd ? resolve(cwd) : config.WORKING_DIR;

      if (activeServers.has(name)) {
        const old = activeServers.get(name);
        try { old.proc.kill('SIGKILL'); } catch {}
        activeServers.delete(name);
      }

      const safeCommand = sanitizeCommand(command);

      const proc = spawn(safeCommand, {
        cwd: workDir,
        shell: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env }
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', data => {
        stdout += data.toString();
        if (stdout.length > 10000) stdout = stdout.slice(-10000);
      });

      proc.stderr.on('data', data => {
        stderr += data.toString();
        if (stderr.length > 10000) stderr = stderr.slice(-10000);
      });

      activeServers.set(name, { proc, port, command, workDir, getLogs: () => ({ stdout, stderr }) });

      if (port) {
        const checkPortOpen = async (p, t) => {
          const start = Date.now();
          while (Date.now() - start < t) {
            if (proc.exitCode !== null) {
              throw new Error(`Process exited with code ${proc.exitCode}. Stderr: ${stderr}`);
            }
            try {
              await new Promise((resolve_c, reject_c) => {
                const socket = require('net').createConnection(p, 'localhost', () => {
                  socket.end();
                  resolve_c();
                });
                socket.on('error', reject_c);
                socket.setTimeout(1000, () => { socket.destroy(); reject_c(new Error('timeout')); });
              });
              return true;
            } catch (err) {
              await new Promise(r => setTimeout(r, 500));
            }
          }
          return false;
        };

        try {
          const ok = await checkPortOpen(port, ready_timeout);
          if (!ok) {
            throw new Error(`Port ${port} did not open within ${ready_timeout}ms`);
          }
          return `Server "${name}" started and listening on port ${port}.`;
        } catch (err) {
          try { proc.kill('SIGKILL'); } catch {}
          activeServers.delete(name);
          throw new Error(`Failed to start server "${name}": ${err.message}. Logs:\n${stderr}`);
        }
      }

      await new Promise(r => setTimeout(r, 2000));
      if (proc.exitCode !== null) {
        activeServers.delete(name);
        throw new Error(`Process exited immediately with code ${proc.exitCode}. Logs:\n${stderr}`);
      }

      return `Server "${name}" started in background.`;
    }
  },

  // ── Stop Server ────────────────────────────────────────────────────────────
  stop_server: {
    description: 'Stop a running background server process.',
    parameters: {
      name: { type: 'string', required: true, description: 'The unique name of the server to stop' }
    },
    async execute({ name }) {
      if (!activeServers.has(name)) {
        return `No server named "${name}" is currently running.`;
      }
      const { proc } = activeServers.get(name);
      try {
        proc.kill('SIGTERM');
        await new Promise(r => setTimeout(r, 1000));
        if (proc.exitCode === null) {
          proc.kill('SIGKILL');
        }
      } catch {}
      activeServers.delete(name);
      return `Server "${name}" stopped.`;
    }
  },

  // ── Change Log ──────────────────────────────────────────────────────────────
  get_change_log: {
    description: 'Returns a list of all file changes made during this session.',
    parameters: {},
    async execute() {
      try {
        // FIXED: existsSync
        if (!fs.existsSync(LOG_FILE)) return 'No changes logged yet.';
        const log = JSON.parse(await fs.promises.readFile(LOG_FILE, 'utf8'));
        return JSON.stringify(log.slice(-50), null, 2);
      } catch (e) {
        return `Error reading change log: ${e.message}`;
      }
    },
  },

  // ── Symbol Signatures ────────────────────────────────────────────────────────
  get_symbol_signatures: {
    description: [
      'Returns the list of exported and declared symbols (functions, classes, methods) for a given file,',
      'including their signatures (parameters). Use this INSTEAD of reading the full file when you only',
      'need to understand the API surface — it avoids bloating the context with implementation details.',
    ].join(' '),
    parameters: {
      path: { type: 'string', required: true, description: 'Relative or absolute path to the source file' },
    },
    async execute({ path: filePath }) {
      try {
        // The index is written relative to the working directory
        const indexFile = path.join(config.WORKING_DIR, '.seekcode', 'index.json');
        if (!fs.existsSync(indexFile)) {
          return `⚠ Symbol index not found at ${indexFile}. The project may not have been analyzed yet.`;
        }
        const index = JSON.parse(await fs.promises.readFile(indexFile, 'utf8'));

        // Normalise the requested path to a project-relative key
        const abs = path.isAbsolute(filePath) ? filePath : path.resolve(config.WORKING_DIR, filePath);
        const rel = path.relative(config.WORKING_DIR, abs).replace(/\\/g, '/');

        const entry = index.files?.[rel];
        if (!entry) {
          // Try fuzzy match — useful when the user passes a basename
          const candidates = Object.keys(index.files || {}).filter(k => k.endsWith(rel) || k.includes(rel));
          if (candidates.length === 1) {
            const candidate = index.files[candidates[0]];
            return _formatSymbols(candidates[0], candidate);
          }
          if (candidates.length > 1) {
            return `Multiple files match "${rel}":\n${candidates.join('\n')}\nPlease provide a more specific path.`;
          }
          return `⚠ File "${rel}" not found in symbol index. Available files: ${Object.keys(index.files || {}).slice(0, 20).join(', ')}`;
        }

        return _formatSymbols(rel, entry);
      } catch (e) {
        return `Error reading symbol index: ${e.message}`;
      }
    },
  },

  // ── Upload File ─────────────────────────────────────────────────────────────
  upload_file: {
    description: 'Upload a file directly to the DeepSeek chat context so the model can read it directly. read_file already does this automatically when possible.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the file to upload' },
    },
    async execute({ path: filePath }) {
      return `File upload requested for ${filePath}`;
    }
  },

};

// ─────────────────────────────────────────────
//  Tool registry helpers
// ─────────────────────────────────────────────

async function stopAllServers() {
  for (const [name, server] of activeServers.entries()) {
    try {
      server.proc.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 500));
      if (server.proc.exitCode === null) server.proc.kill('SIGKILL');
    } catch {}
  }
  activeServers.clear();
}

function getToolDescriptions() {
  return Object.entries(TOOLS).map(([name, tool]) => {
    const params = Object.entries(tool.parameters || {})
      .map(([pName, p]) =>
        `    - ${pName} (${p.type}${p.required ? ', REQUIRED' : ''}): ${p.description || ''}`
      ).join('\n');
    return `### ${name}\n  ${tool.description}\n  Parameters:\n${params}`;
  }).join('\n\n');
}

async function executeTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) {
    const available = Object.keys(TOOLS).join(', ');
    throw new Error(`Unknown tool: "${name}". Available: ${available}`);
  }
  // ── Read-only guard: block mutation tools when --read-only is active ─────
  if (_readOnly && MUTATION_TOOLS.has(name)) {
    throw new Error(
      `⛔ Read-only mode is active. Tool "${name}" is not permitted.\n` +
      `Remove --read-only to allow filesystem and command mutations.`
    );
  }
  return await tool.execute(args);
}

module.exports = { TOOLS, executeTool, getToolDescriptions, stopAllServers, setReadOnly, isReadOnly };
