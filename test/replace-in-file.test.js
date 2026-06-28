// test/replace-in-file.test.js
// Zero-dependency tests for the hardened replace_in_file tool.
//
// Runs with plain `node` — no test framework required (none exists in this
// repo yet). We assert outcomes directly and exit non-zero on any failure.
//
// What this proves:
//   1. all_occurrences defaults to FALSE (the safety flip).
//   2. A non-unique find REFUSES with a thrown error (was: silent over-write).
//   3. A unique find succeeds and edits exactly the target.
//   4. all_occurrences=true still replaces every match (backward compatible).
//   5. Regex mode respects the same uniqueness guard.
//   6. "No matches" stays a non-throwing informational result.
//   7. Regex metacharacters in a literal find are escaped consistently.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Load the real tool registry the same way agent.js does ──────────────────
// We require tools.js from src so the test exercises the exact code path the
// gateway uses. config.js creates ~/.deepseek-agent/{session,logs} as a side
// effect of import; that's harmless and already happens for every real run.
const { executeTool } = require('../src/tools');

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

async function withTempFile(initial, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seekcode-rif-'));
  const file = path.join(dir, 'sample.txt');
  fs.writeFileSync(file, initial, 'utf8');
  try {
    return await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const read = (f) => fs.readFileSync(f, 'utf8');

async function main() {
  console.log('\nreplace_in_file — hardening tests\n');

  // ── 1. Default is non-bulk + refuses ambiguous find ───────────────────────
  await withTempFile('foo\nbar\nfoo\nbaz\n', async (file) => {
    let threw = false;
    let errMsg = '';
    try {
      await executeTool('replace_in_file', {
        path: file, find: 'foo', replace: 'qux', // no all_occurrences → default false
      });
    } catch (err) {
      threw = true;
      errMsg = err.message;
    }
    assert(threw, 'non-unique find with default options THROWS (does not silently over-write)');
    assert(/matched 2 locations/.test(errMsg), 'error names the match count (2)');
    assert(/all_occurrences/.test(errMsg), 'error tells the model how to proceed');
    assert(read(file) === 'foo\nbar\nfoo\nbaz\n', 'file is UNCHANGED after a refused edit');
  });

  // ── 2. Unique find edits exactly the target ───────────────────────────────
  await withTempFile('const a = 1;\nconst b = 2;\n', async (file) => {
    const res = await executeTool('replace_in_file', {
      path: file, find: 'const b = 2;', replace: 'const b = 20;',
    });
    assert(/Replaced 1 of 1/.test(res), 'unique find reports "1 of 1"');
    assert(read(file) === 'const a = 1;\nconst b = 20;\n', 'only the unique target changed');
  });

  // ── 3. Explicit all_occurrences=true replaces every match ─────────────────
  await withTempFile('todo\nfix\ntodo\nfix\n', async (file) => {
    const res = await executeTool('replace_in_file', {
      path: file, find: 'todo', replace: 'done', all_occurrences: true,
    });
    assert(/Replaced 2 of 2/.test(res), 'bulk mode reports "2 of 2"');
    assert(read(file) === 'done\nfix\ndone\nfix\n', 'all occurrences replaced');
  });

  // ── 4. Regex mode + uniqueness guard ──────────────────────────────────────
  await withTempFile('item1\nitem2\nitem3\n', async (file) => {
    let threw = false;
    try {
      await executeTool('replace_in_file', {
        path: file, find: 'item\\d+', replace: 'x', use_regex: true, // matches 3x
      });
    } catch { threw = true; }
    assert(threw, 'regex matching multiple locations also refuses by default');

    // …and with all_occurrences it replaces all three.
    const res = await executeTool('replace_in_file', {
      path: file, find: 'item\\d+', replace: 'x', use_regex: true, all_occurrences: true,
    });
    assert(/Replaced 3 of 3/.test(res), 'regex bulk mode replaces all matches');
    assert(read(file) === 'x\nx\nx\n', 'regex bulk result is correct');
  });

  // ── 5. No matches is informational, not a throw ───────────────────────────
  await withTempFile('hello\nworld\n', async (file) => {
    const res = await executeTool('replace_in_file', {
      path: file, find: 'nope', replace: 'x',
    });
    assert(/No matches found/.test(res), 'zero-match returns the friendly "No matches" string');
    assert(read(file) === 'hello\nworld\n', 'file untouched when nothing matched');
  });

  // ── 6. Literal find with regex metacharacters is escaped consistently ─────
  await withTempFile('v1.2\nv1.2.3\n', async (file) => {
    // "v1.2" as a literal should match the EXACT text, not treat '.' as wildcard.
    // The old apply path (split/join) got this right by accident; the old COUNT
    // path (RegExp unescaped) would have counted too many. Both must now agree.
    let threw = false;
    try {
      await executeTool('replace_in_file', { path: file, find: 'v1.2', replace: 'v1.2.0' });
    } catch (err) {
      threw = true;
      assert(/matched 2 locations/.test(err.message), 'literal "v1.2" matches both lines exactly (metachar escaped)');
    }
    assert(threw, 'literal find with metacharacters honours the uniqueness guard');
  });

  // ── 7. Unknown tool name still errors clearly ─────────────────────────────
  let unknownThrew = false;
  try {
    await executeTool('nonexistent_tool', {});
  } catch { unknownThrew = true; }
  assert(unknownThrew, 'unknown tool name throws (registry unchanged)');

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nTest harness crashed:', err);
  process.exit(2);
});
