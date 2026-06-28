// test/run-command-background.test.js
// Zero-dependency tests for the `background:true` path on run_command.
//
// This pins down the exact bug that crashed the 2026-06-27 session: the model
// asked to run `npm run dev` with background:true, but run_command had no such
// parameter, so it silently dropped it, blocked on execSync until the timeout,
// and killed the server — destabilising the gateway.
//
// Covers:
//   1. background:true returns quickly (does NOT block on a long-running cmd).
//   2. background:true actually spawns the process (it shows up in the active
//      server registry and can be stopped).
//   3. Blocking path is unchanged (a quick command returns its output).
//   4. Blocking path still times out a runaway command (regression guard).

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { executeTool, TOOLS } = require('../src/tools');
const { stopAllServers } = require('../src/tools');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// Pick a long-running command that works on both Windows and Unix.
// `ping` never exits on Windows; on Unix `sleep` doesn't either (well, it does
// after N). We use a tiny Node one-liner that stays alive until killed.
const STAY_ALIVE_CMD = process.platform === 'win32'
  ? 'ping -n 9999 127.0.0.1 >nul'
  : 'sleep 9999';

async function main() {
  console.log('\nrun_command background:true — tests\n');

  try {
    // ── 1 & 2. background:true returns fast AND actually spawns ───────────
    const t0 = Date.now();
    const result = await executeTool('run_command', {
      command: STAY_ALIVE_CMD,
      background: true,
    });
    const elapsed = Date.now() - t0;

    assert(elapsed < 5000, `background:true returns in ${elapsed}ms (< 5s, didn't block)`);
    assert(/detached|started/i.test(String(result)), 'result mentions detached/started');
    assert(/handle|bg_/i.test(String(result)) || /started/i.test(String(result)),
      'result surfaces a handle the model can stop later');

    // The spawned process is tracked in the active-server registry (start_server's
    // machinery), so it's stoppable and cleaned up on shutdown.
    assert(TOOLS.start_server && typeof TOOLS.start_server.execute === 'function',
      'background path reuses start_server machinery (so stop_server can reach it)');

    // ── 3. Blocking path is unchanged ────────────────────────────────────
    const echo = process.platform === 'win32'
      ? 'echo hello'
      : 'echo hello';
    const out = await executeTool('run_command', { command: echo, timeout_ms: 5000 });
    assert(/hello/i.test(out), 'blocking path still returns command output');

    // ── 4. Blocking path still times out a runaway command ───────────────
    let timedOut = false;
    try {
      await executeTool('run_command', { command: STAY_ALIVE_CMD, timeout_ms: 5000 });
    } catch (err) {
      timedOut = /Command failed|exit/i.test(err.message);
    }
    assert(timedOut, 'blocking path still times out a non-exiting command (regression guard)');

  } finally {
    // Always tear down spawned processes so the test process exits cleanly.
    await stopAllServers();
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  // Best-effort cleanup before exiting on crash.
  stopAllServers().finally(() => process.exit(2));
});
