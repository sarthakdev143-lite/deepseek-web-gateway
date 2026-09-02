#!/usr/bin/env node
// test/run-all.js — Runs every test file in this directory as a child process.
//
// The tests are dependency-free scripts that signal failure via exit code, so
// the runner just needs to execute each one and aggregate results. Isolating
// them in child processes keeps a crash or a stray process.exit() in one file
// from taking down the whole suite.
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;

// Anything matching these is a test entry point.
const isTestFile = (name) =>
  (name.endsWith('.test.js') || name === 'selector-contract.js') && name !== path.basename(__filename);

const files = fs.readdirSync(TEST_DIR).filter(isTestFile).sort();

if (files.length === 0) {
  console.error('No test files found in', TEST_DIR);
  process.exit(1);
}

console.log(`Running ${files.length} test file(s)\n`);

const failures = [];
const started = Date.now();

for (const file of files) {
  const full = path.join(TEST_DIR, file);
  process.stdout.write(`── ${file}\n`);

  const result = spawnSync(process.execPath, [full], {
    stdio: 'inherit',
    cwd: path.dirname(TEST_DIR),
  });

  if (result.status !== 0) {
    failures.push({ file, status: result.status, signal: result.signal });
    console.log(`   FAILED (exit ${result.status}${result.signal ? `, signal ${result.signal}` : ''})\n`);
  } else {
    console.log('   passed\n');
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (failures.length > 0) {
  console.error(`${failures.length} of ${files.length} test file(s) failed in ${seconds}s:`);
  for (const f of failures) console.error(`  - ${f.file}`);
  process.exit(1);
}

console.log(`All ${files.length} test file(s) passed in ${seconds}s.`);
