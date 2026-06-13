// src/tools.js — All tools available to the AI agent
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const http = require('http');
const https = require('https');
const config = require('./config');

const activeServers = new Map(); // name -> { proc, port, command, workDir, getLogs }

let sanitizeCommand;
try {
  sanitizeCommand = require(path.join(__dirname, '../../seekcode/src/utils/platformCommands')).sanitizeCommand;
} catch (e) {
  sanitizeCommand = cmd => cmd;
}


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
      await atomicWriteFile(abs, content);
      const lineCount = content.split('\n').length;
      await logChange('write', filePath, `wrote ${lineCount} lines`);
      return `✓ Wrote ${formatBytes(Buffer.byteLength(content, 'utf8'))} (${lineCount} lines) → ${filePath}`;
    },
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
      all_occurrences: { type: 'boolean', required: false, description: 'Replace all occurrences (default: true)' },
    },
    async execute({ path: filePath, find, replace, use_regex = false, all_occurrences = true }) {
      const abs = resolve(filePath);
      // FIXED: existsSync
      if (!fs.existsSync(abs)) throw new Error(`File not found: ${filePath}`);

      let content = await fs.promises.readFile(abs, 'utf8');
      const before = content;

      if (use_regex) {
        const re = new RegExp(find, all_occurrences ? 'g' : '');
        content = content.replace(re, replace);
      } else if (all_occurrences) {
        content = content.split(find).join(replace);
      } else {
        content = content.replace(find, replace);
      }

      if (content === before) {
        return `⚠  No matches found for "${find}" in ${filePath}`;
      }

      const escapedFind = use_regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const count = (before.match(new RegExp(escapedFind, 'g')) || []).length;

      await atomicWriteFile(abs, content);
      await logChange('replace', filePath, `replaced ${count} occurrence(s) of "${find}"`);
      return `✓ Replaced ${count} occurrence(s) of "${find}" in ${filePath}`;
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

      const SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'build', 'coverage']);

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
    description: 'Execute a shell command. Runs in the working directory by default.',
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command to run' },
      cwd: { type: 'string', required: false, description: 'Working directory' },
      timeout: { type: 'number', required: false, description: 'Timeout in ms (default: 60000)' },
      env: { type: 'object', required: false, description: 'Extra environment variables' },
    },
    async execute({ command, cwd, timeout = 60000, env = {} }) {
      const workDir = cwd ? resolve(cwd) : config.WORKING_DIR;
      try {
        const output = execSync(command, {
          cwd: workDir, encoding: 'utf8', timeout,
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
      const SKIP = new Set(['node_modules', '.git', 'dist', '.next', 'build', 'coverage']);

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

  // ── Write Multiple Files ────────────────────────────────────────────────────
  write_files: {
    description: 'Write multiple files at once — useful for scaffolding projects.',
    parameters: {
      files: { type: 'array', required: true, description: 'Array of {path, content} objects' },
    },
    async execute({ files }) {
      if (!Array.isArray(files)) throw new Error('"files" must be an array of {path, content}');
      const results = [];
      for (const { path: filePath, content } of files) {
        const abs = resolve(filePath);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await atomicWriteFile(abs, content);
        results.push(`✓ ${filePath}`);
      }
      return `Wrote ${results.length} files:\n${results.join('\n')}`;
    },
  },

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
  return await tool.execute(args);
}

module.exports = { TOOLS, executeTool, getToolDescriptions, stopAllServers };