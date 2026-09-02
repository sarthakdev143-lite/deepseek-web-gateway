// src/run-context.js — Per-run state that must NOT be shared between sessions.
//
// `config.WORKING_DIR` and the read-only flag used to be module-level globals
// mutated at the start of every agent.run(). With two concurrent sessions that
// is a race: session B's workingDir overwrites session A's mid-run, and a
// read-only session can silently regain write access because a second,
// writable session reset the shared flag.
//
// AsyncLocalStorage scopes both values to the async call tree of a single run,
// so concurrent runs cannot observe each other's settings. Callers that are not
// inside a run (the CLI's single-session path, tests) fall back to the global
// config, preserving previous behaviour.
'use strict';

const { AsyncLocalStorage } = require('async_hooks');

const storage = new AsyncLocalStorage();

/**
 * Execute `fn` with a run-scoped context.
 * @param {{workingDir?: string, readOnly?: boolean}} context
 * @param {Function} fn
 */
function runWith(context, fn) {
  return storage.run({ ...context }, fn);
}

/** The context for the currently executing run, or null outside a run. */
function current() {
  return storage.getStore() || null;
}

module.exports = { runWith, current };
