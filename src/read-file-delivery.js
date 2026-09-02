'use strict';

const fs   = require('fs');
const path = require('path');
const config = require('./config');

// Secret redaction — inlined in ./utils so the gateway is self-contained
// (previously reached across into the sibling `seekcode` package).
const { redact } = require('./utils');
const { assertWithinRoots } = require('./path-guard');
const runContext = require('./run-context');

/** Full-file reads above this line count may use DeepSeek attachment upload. */
const UPLOAD_LINE_THRESHOLD = 150;

/** After this many upload-stub results for the same read_file call, force inline. */
const REPEAT_UPLOAD_STUB_THRESHOLD = 2;

const UPLOAD_DENY_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.crt', '.cer']);
const UPLOAD_DENY_BASENAMES  = /^\.env(\..+)?$/i;

function resolveAbs(filePath) {
  const ctx = runContext.current();
  const base = (ctx && ctx.workingDir) || config.WORKING_DIR;
  const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(base, filePath);
  // Inline reads bypass tools.js, so apply the allowlist here too.
  return assertWithinRoots(absolute, config.PROJECT_ROOTS);
}

function shouldNeverUpload(filePath) {
  const base = path.basename(filePath);
  const ext  = path.extname(filePath).toLowerCase();
  if (UPLOAD_DENY_BASENAMES.test(base)) return true;
  if (UPLOAD_DENY_EXTENSIONS.has(ext)) return true;
  if (ext === '.json' && /secret|credential|token/i.test(base)) return true;
  return false;
}

function shouldUseBrowserUpload(filePath, lineCount, startLine, endLine) {
  if (startLine != null || endLine != null) return false;
  if (shouldNeverUpload(filePath)) return false;
  return lineCount > UPLOAD_LINE_THRESHOLD;
}

function isUploadStubResult(result) {
  return (
    typeof result === 'string' &&
    (result.includes('uploaded directly to DeepSeek chat context') ||
      result.includes('uploaded as a DeepSeek attachment'))
  );
}

function toolFingerprint(toolName, args) {
  return `${toolName}:${JSON.stringify(args)}`;
}

function formatInlineContent(filePath, content, { startLine, endLine, note } = {}) {
  const redacted = shouldNeverUpload(filePath) ? redact(content) : content;
  const lines    = redacted.split('\n');

  if (startLine != null || endLine != null) {
    const s = Math.max(0, (startLine || 1) - 1);
    const e = endLine != null ? endLine : lines.length;
    const slice = lines.slice(s, e).map((l, i) => `${s + i + 1}: ${l}`).join('\n');
    const header = `[${filePath} | lines ${s + 1}–${e} | inline]`;
    return note ? `${note}\n${header}\n${slice}` : `${header}\n${slice}`;
  }

  const lineCount = lines.length;
  const sensitive = shouldNeverUpload(filePath);
  const tag       = sensitive ? 'inline, secrets redacted' : 'inline';
  const header    = `[${filePath} | ${lineCount} lines | ${tag}]`;
  const body =
    lineCount <= 300
      ? lines.map((l, i) => `${i + 1}: ${l}`).join('\n')
      : lines.slice(0, 150).map((l, i) => `${i + 1}: ${l}`).join('\n') +
        `\n\n… [${lineCount - 150} more lines — use start_line/end_line] …`;

  const prefix = note ? `${note}\n` : '';
  const suffix = sensitive
    ? '\n\nNote: .env / secret files cannot be attached in DeepSeek; values above are redacted where applicable.'
    : '';
  return `${prefix}${header}\n${body}${suffix}`;
}

function readFileInline(filePath, { start_line, end_line, note } = {}) {
  const abs = resolveAbs(filePath);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${filePath}`);
  if (fs.statSync(abs).isDirectory()) throw new Error(`${filePath} is a directory`);

  const content = fs.readFileSync(abs, 'utf8');
  return formatInlineContent(filePath, content, {
    startLine: start_line,
    endLine  : end_line,
    note,
  });
}

function uploadSuccessMessage(fileName, lineCount) {
  return (
    `✓ File "${fileName}" (${lineCount} lines) was uploaded as a DeepSeek attachment.\n` +
    `If you cannot see its contents in context, call read_file with start_line and end_line for inline text.`
  );
}

module.exports = {
  UPLOAD_LINE_THRESHOLD,
  REPEAT_UPLOAD_STUB_THRESHOLD,
  shouldNeverUpload,
  shouldUseBrowserUpload,
  isUploadStubResult,
  toolFingerprint,
  readFileInline,
  uploadSuccessMessage,
};
