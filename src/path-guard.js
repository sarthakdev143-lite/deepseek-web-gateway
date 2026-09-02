// src/path-guard.js — Filesystem containment for agent-controlled paths.
//
// The agent can call write_file / delete_file / run_command with paths it
// chooses itself. PROJECT_ROOTS is the allowlist that says where that is
// permitted. Previously the allowlist was only checked at /session/create,
// while the tool layer resolved any absolute path verbatim — so the allowlist
// had no effect on the tools it was meant to constrain. This module is the
// single enforcement point used by both the HTTP layer and the tool layer.
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Resolve `target` to an absolute path with symlinks resolved.
 *
 * Plain `path.resolve` is not enough: a symlink inside an allowed root can
 * point anywhere, and the lexical path still *looks* contained. We therefore
 * realpath the deepest ancestor that exists and re-append the components that
 * don't exist yet (needed for write_file to a new path).
 *
 * @param {string} target
 * @returns {string} absolute, symlink-resolved path
 */
function realpathDeepest(target) {
  let current = path.resolve(target);
  const pending = [];

  for (;;) {
    try {
      const real = fs.realpathSync(current);
      if (pending.length === 0) return real;
      return path.join(real, ...pending.slice().reverse());
    } catch {
      const parent = path.dirname(current);
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return path.resolve(target);
      pending.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * True if `child` is `parent` or lives underneath it.
 * Case-insensitive on Windows, where `D:\Code` and `d:\code` are the same dir.
 */
function isWithin(child, parent) {
  let c = path.resolve(child);
  let p = path.resolve(parent);

  if (process.platform === 'win32') {
    c = c.toLowerCase();
    p = p.toLowerCase();
  }

  if (c === p) return true;
  const prefix = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(prefix);
}

/**
 * Check a path against the configured roots.
 *
 * @param {string} target        path the agent wants to touch
 * @param {string[]} roots       PROJECT_ROOTS (empty = open mode)
 * @returns {{allowed: boolean, resolved: string, reason?: string}}
 */
function checkPath(target, roots) {
  if (target === undefined || target === null || target === '') {
    return { allowed: false, resolved: '', reason: 'Empty path' };
  }

  const resolved = realpathDeepest(target);

  // Open mode — no allowlist configured (local dev default).
  if (!Array.isArray(roots) || roots.length === 0) {
    return { allowed: true, resolved };
  }

  for (const root of roots) {
    if (isWithin(resolved, realpathDeepest(root))) {
      return { allowed: true, resolved };
    }
  }

  return {
    allowed: false,
    resolved,
    reason:
      `Path "${resolved}" is outside the allowed project roots. ` +
      `Allowed: ${roots.join(', ')}`,
  };
}

/**
 * Same as checkPath but throws — for use inside tool implementations where the
 * error message is surfaced back to the agent.
 * @throws {Error} if the path escapes the allowlist
 */
function assertWithinRoots(target, roots) {
  const result = checkPath(target, roots);
  if (!result.allowed) {
    const err = new Error(result.reason);
    err.code = 'EPATHNOTALLOWED';
    throw err;
  }
  return result.resolved;
}

module.exports = { realpathDeepest, isWithin, checkPath, assertWithinRoots };
