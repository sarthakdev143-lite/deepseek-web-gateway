// src/tools.js — All tools available to the AI agent

'use strict';

const fs = require('fs');
const path = require('path');

const { execSync } = require('child_process');
const http = require('http');
const https = require('https');
const config = require('./config');

async function atomicWriteFile(filePath, content, createBackup = true) {
  const tempPath = filePath + '.tmp.' + Date.now();
  const backupPath = filePath + '.backup';
  
  try {
    // Create backup if file exists
    if (createBackup && await fs.promises.access(filePath)) {
      await fs.promises.copyFile(filePath, backupPath);
    }
    
    // Write to temp file
    await fs.promises.writeFile(tempPath, content, 'utf8');
    
    // Atomic rename
    fs.renameSync(tempPath, filePath);
    
    // Cleanup backup on success
    if (await fs.promises.access(backupPath)) {
      await fs.promises.unlink(backupPath);
    }
    
    return { success: true, path: filePath };
  } catch (err) {
    // Restore from backup if available
    if (await fs.promises.access(backupPath)) {
      await fs.promises.copyFile(backupPath, filePath);
      await fs.promises.unlink(backupPath);
    }
    
    // Cleanup temp file
    if (await fs.promises.access(tempPath)) {
      await fs.promises.unlink(tempPath);
    }
    
    throw new Error(`Atomic write failed: ${err.message}`);
  }
}

// ---------- File change logging ----------
const LOG_FILE = path.join(process.cwd(), '.seekcode', 'changes.json');

async function logChange(action, filePath, details = '') {
  try {
    const dir = path.dirname(LOG_FILE);
    if (!await fs.promises.access(dir)) await fs.promises.mkdir(dir, { recursive: true });
    let log = [];
    if (await fs.promises.access(LOG_FILE)) {
      log = JSON.parse(await fs.promises.readFile(LOG_FILE, 'utf8'));
    }
    log.push({
      timestamp: new Date().toISOString(),
      action,
      file: filePath,
      details
    });
    await fs.promises.writeFile(LOG_FILE, JSON.stringify(log, null, 2), 'utf8');
  } catch (e) { /* ignore logging errors */ }
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

/** Truncate long strings so they don't blow up the context window */
function truncate(str, max = config.MAX_OUTPUT_LENGTH) {
  if (!str) return '';
  const s = String(str);
  if (s.length <= max) return s;
  const half = Math.floor(max / 2);
  return (
    s.slice(0, half) +
    `\n\nâš  [OUTPUT TRUNCATED "” ${s.length.toLocaleString()} chars total, showing first & last ${half} chars]\n\n` +
    s.slice(-half)
  );
}

/** Resolve a path relative to the working directory */
function resolve(filePath) {
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(config.WORKING_DIR, filePath);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

// ─────────────────────────────────────────────
//  Tool definitions
// ─────────────────────────────────────────────

const TOOLS = {

  // ── File Reading ────────────────────────────────────────────────────────────
  read_file: {
    description: 'Read the full contents of a file. Optionally read specific line ranges.',
    parameters: {
      path: { type: 'string', required: true, description: 'Path to the file' },
      start_line: { type: 'number', required: false, description: 'First line to read (1-indexed)' },
      end_line: { type: 'number', required: false, description: 'Last line to read (inclusive)' },
    },
    async execute({ path: filePath, start_line, end_line }) {
      const abs = resolve(filePath);
      if (!await fs.promises.access(abs)) throw new Error(`File not found: ${filePath}`);
      if (fs.statSync(abs).isDirectory()) throw new Error(`${filePath} is a directory`);

      let content = await fs.promises.readFile(abs, 'utf8');

      if (start_line != null || end_line != null) {
        const lines = content.split('\n');
        const s = Math.max(0, (start_line || 1) - 1);
        const e = end_line != null ? end_line : lines.length;
        content = lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join('\n');
        return `[${filePath} | lines ${s + 1}""${e}]\n${truncate(content)}`;
      }

      // Add line numbers for large files to help the AI reference lines
      const lineCount = content.split('\n').length;
      if (lineCount <= 300) {
        const numbered = content.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
        return `[${filePath} | ${lineCount} lines]\n${numbered}`;
      }
      return `[${filePath} | ${lineCount} lines "” use start_line/end_line to read sections]\n${truncate(content)}`;
    },
  },

  // ── File Writing ────────────────────────────────────────────────────────────
  write_file: {
    description: 'Write (create or overwrite) a file with given content. Creates parent directories automatically.',
    parameters: {
      path: { type: 'string', required: true, description: 'Destination file path' },
      content: { type: 'string', required: true, description: 'Full file content to write' },
    },
    async execute({ path: filePath, content }) {
      const abs = resolve(filePath);
      await fs.promises.mkdir(path.dirname(abs), { recursive: true });
      await fs.promises.writeFile(abs, content, 'utf8');
      const lineCount = content.split('\n').length;
      logChange('write', filePath, `wrote ${lineCount} lines`);
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
      fs.appendFileSync(abs, content, 'utf8');
      const appendedBytes = Buffer.byteLength(content, 'utf8');
      logChange('append', filePath, `appended ${appendedBytes} bytes`);
      return `✓ Appended ${formatBytes(appendedBytes)} to ${filePath}`;
    },
  },

  // ── Find & Replace in File ──────────────────────────────────────────────────
  replace_in_file: {
    description: 'Find and replace text in a file. Supports regex patterns.',
    parameters: {
      path: { type: 'string', required: true, description: 'File path' },
      find: { type: 'string', required: true, description: 'Text to find' },
      replace: { type: 'string', required: true, description: 'Replacement text' },
      use_regex: { type: 'boolean', required: false, description: 'Treat "find" as a regex pattern (default: false)' },
      all_occurrences: { type: 'boolean', required: false, description: 'Replace all occurrences (default: true)' },
    },
    async execute({ path: filePath, find, replace, use_regex = false, all_occurrences = true }) {
      const abs = resolve(filePath);
      let content = await fs.promises.readFile(abs, 'utf8');
      const original = content;

      if (use_regex) {
        const re = new RegExp(find, all_occurrences ? 'g' : '');
        content = content.replace(re, replace);
      } else if (all_occurrences) {
        content = content.split(find).join(replace);
      } else {
        content = content.replace(find, replace);
      }

      if (content === original) {
        return `âš  No matches found for "${find}" in ${filePath}`;
      }

      const count = (original.match(
        new RegExp(use_regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      ) || []).length;

      await fs.promises.writeFile(abs, content, 'utf8');
      logChange('replace', filePath, `replaced ${count} occurrence(s) of "${find}"`);
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
      if (!await fs.promises.access(abs)) throw new Error(`File not found: ${filePath}`);
      await fs.promises.unlink(abs);
      logChange('delete', filePath, `deleted file`);
      return `✓ Deleted ${filePath}`;
    },
  },

  // ── List Directory ──────────────────────────────────────────────────────────
  list_directory: {
    description: 'List files and folders in a directory, optionally recursive.',
    parameters: {
      path: { type: 'string', required: false, description: 'Directory to list (default: working dir)' },
      recursive: { type: 'boolean', required: false, description: 'Recurse into sub-directories (default: false)' },
      show_hidden: { type: 'boolean', required: false, description: 'Include hidden files starting with . (default: false)' },
    },
    async execute({ path: dirPath = '.', recursive = false, show_hidden = false }) {
      const abs = resolve(dirPath);
      if (!await fs.promises.access(abs)) throw new Error(`Directory not found: ${dirPath}`);
      if (!fs.statSync(abs).isDirectory()) throw new Error(`${dirPath} is not a directory`);

      if (recursive) {
        const walkDir = (dir, depth = 0, maxDepth = 10) => {
          if (depth > maxDepth) return [];
          const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => {
            if (!show_hidden && e.name.startsWith('.')) return false;
            if (['node_modules', '.git', 'dist', '.next'].includes(e.name)) return false;
            return true;
          });
          let results = entries.map(e => path.join(dir, e.name));
          entries.forEach(e => {
            if (e.isDirectory()) {
              results = results.concat(walkDir(path.join(dir, e.name), depth + 1, maxDepth));
            }
          });
          return results;
        };

        const results = walkDir(abs).sort().slice(0, 300);
        return results.length > 0 ? results.join('\n') : '(empty)';
      }

      const entries = fs.readdirSync(abs, { withFileTypes: true });
      const visible = show_hidden ? entries : entries.filter(e => !e.name.startsWith('.'));
      visible.sort((a, b) => {
        // Directories first, then alphabetical
        if (a.isDirectory() && !b.isDirectory()) return -1;
        if (!a.isDirectory() && b.isDirectory()) return 1;
        return a.name.localeCompare(b.name);
      });

      if (visible.length === 0) return `(empty directory: ${dirPath})`;

      const lines = visible.map(e => {
        if (e.isDirectory()) {
          return `ðŸ"  ${e.name}/`;
        }
        try {
          const size = fs.statSync(path.join(abs, e.name)).size;
          return `ðŸ"„  ${e.name}  ${formatBytes(size)}`;
        } catch {
          return `ðŸ"„  ${e.name}`;
        }
      });

      return `[${dirPath}] "” ${visible.length} items\n${lines.join('\n')}`;
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
      if (!await fs.promises.access(src)) throw new Error(`Source not found: ${source}`);
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
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
      if (!await fs.promises.access(src)) throw new Error(`Source not found: ${source}`);
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
      if (!await fs.promises.access(abs)) throw new Error(`Not found: ${filePath}`);
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
  run_command: {
    description: 'Execute a shell command and return its output. Runs in the working directory by default.',
    parameters: {
      command: { type: 'string', required: true, description: 'Shell command to run' },
      cwd: { type: 'string', required: false, description: 'Working directory for the command' },
      timeout: { type: 'number', required: false, description: 'Timeout in milliseconds (default: 60000)' },
      env: { type: 'object', required: false, description: 'Extra environment variables as key-value pairs' },
    },
    async execute({ command, cwd, timeout = 60_000, env = {} }) {
      const workDir = cwd ? resolve(cwd) : config.WORKING_DIR;

      try {
        const output = execSync(command, {
          cwd: workDir,
          encoding: 'utf8',
          timeout,
          maxBuffer: 20 * 1024 * 1024,
          env: { ...process.env, ...env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        const result = (output || '').trim();
        return truncate(result || '(command completed with no output)');
      } catch (err) {
        const stdout = (err.stdout || '').trim();
        const stderr = (err.stderr || '').trim();
        const combined = [
          stdout && `STDOUT:\n${stdout}`,
          stderr && `STDERR:\n${stderr}`,
        ].filter(Boolean).join('\n\n');
        throw new Error(`Command failed (exit code ${err.status}):\n${truncate(combined || err.message)}`);
      }
    },
  },

  // ── Find Files ──────────────────────────────────────────────────────────────
  find_files: {
    description: 'Search for files by name pattern (glob-style, e.g. "*.js", "test_*").',
    parameters: {
      pattern: { type: 'string', required: true, description: 'Filename pattern (e.g. "*.ts")' },
      directory: { type: 'string', required: false, description: 'Directory to search (default: working dir)' },
      exclude: { type: 'string', required: false, description: 'Pattern to exclude from results' },
    },
    async execute({ pattern, directory = '.', file_pattern, case_sensitive = false, context_lines = 2 }) {
      const dir = resolve(directory);
      const flags = case_sensitive ? '' : 'i';
      const results = [];

      const walkAndSearch = async (currentDir, depth = 0) => {
        if (depth > 10) return;
        try {
          const entries = fs.readdirSync(currentDir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
              if (['node_modules', '.git', 'dist', '.next'].includes(entry.name)) continue;
              walkAndSearch(fullPath, depth + 1);
            } else if (entry.isFile()) {
              if (file_pattern && !entry.name.endsWith(file_pattern.replace('*', ''))) continue;
              try {
                const content = await fs.promises.readFile(fullPath, 'utf8');
                const lines = content.split('\n');
                const regex = new RegExp(pattern, flags);
                lines.forEach((line, idx) => {
                  if (regex.test(line)) {
                    const ctx = [];
                    for (let c = Math.max(0, idx - context_lines); c <= Math.min(lines.length - 1, idx + context_lines); c++) {
                      ctx.push(`${c + 1}: ${lines[c]}`);
                    }
                    results.push(`\n${fullPath}:${idx + 1}\n${ctx.join('\n')}`);
                  }
                });
              } catch (e) { /* skip unreadable files */ }
            }
          }
        } catch (e) { /* skip inaccessible dirs */ }
      };
      walkAndSearch(dir);
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
            'User-Agent': 'Mozilla/5.0 (compatible; DeepSeekAgent/1.0)',
            'Accept': 'text/html,text/plain,application/json',
          },
        };

        const req = client.get(url, options, (res) => {
          // Follow redirects
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            return TOOLS.read_url.execute({ url: res.headers.location }).then(resolve_p).catch(reject);
          }

          let data = '';
          res.on('data', chunk => { data += chunk; });
          res.on('end', () => {
            // Strip HTML tags for readability
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

  // ── Write Multiple Files (batch) ────────────────────────────────────────────
  write_files: {
    description: 'Write multiple files at once "” useful for scaffolding projects.',
    parameters: {
      files: {
        type: 'array',
        required: true,
        description: 'Array of {path, content} objects',
      },
    },
    async execute({ files }) {
      if (!Array.isArray(files)) throw new Error('"files" must be an array of {path, content}');
      const results = [];
      for (const { path: filePath, content } of files) {
        const abs = resolve(filePath);
        await fs.promises.mkdir(path.dirname(abs), { recursive: true });
        await fs.promises.writeFile(abs, content, 'utf8');
        results.push(`✓ ${filePath}`);
      }
      return `Wrote ${results.length} files:\n${results.join('\n')}`;
    },
  },

  get_change_log: {
    description: 'Returns a list of all file changes made during this session.',
    parameters: {},
    async execute() {
      try {
        if (await fs.promises.access(LOG_FILE)) {
          const log = JSON.parse(await fs.promises.readFile(LOG_FILE, 'utf8'));
          return JSON.stringify(log.slice(-50), null, 2);
        }
        return 'No changes logged yet.';
      } catch (e) {
        return `Error reading change log: ${e.message}`;
      }
    },
  },

};

// ─────────────────────────────────────────────
//  Generate tool docs for the system prompt
// ─────────────────────────────────────────────
function getToolDescriptions() {
  return Object.entries(TOOLS).map(([name, tool]) => {
    const paramLines = Object.entries(tool.parameters || {}).map(([pName, p]) =>
      `    - ${pName} (${p.type}${p.required ? ', REQUIRED' : ''}): ${p.description || ''}`
    ).join('\n');

    return `### ${name}\n  ${tool.description}\n  Parameters:\n${paramLines}`;
  }).join('\n\n');
}

// ─────────────────────────────────────────────
//  Execute a tool by name
// ─────────────────────────────────────────────
async function executeTool(name, args) {
  const tool = TOOLS[name];
  if (!tool) {
    const available = Object.keys(TOOLS).join(', ');
    throw new Error(`Unknown tool: "${name}". Available tools: ${available}`);
  }
  return await tool.execute(args);
}

module.exports = { TOOLS, executeTool, getToolDescriptions };
