// =============================================================================
// code/parser-v2.js  →  deepseek-web-gateway/src/parser.js  (REPLACE)
// =============================================================================
// Robust multi-strategy tool-call parser for DeepSeek R1/V3 free-form output.
//
// Goals (vs. current parser):
//   1. Strip <think>...</think> and <reasoning>...</reasoning> BEFORE parsing
//   2. Case-insensitive fence matching (tool_call, tool_calls, tool-call)
//   3. Handle JSON arrays of tool calls
//   4. Lenient JSON parsing (trailing commas, single quotes, JS comments)
//   5. Balanced-brace extraction for JSON embedded in prose
//   6. Normalize output to {name, args} shape
//   7. Deduplicate by name+args signature
//
// API is unchanged — drop-in replacement for existing parser.js.
// =============================================================================

'use strict';

// Read-only tools that are safe to run in parallel (preserved from original)
const READ_ONLY_TOOLS = new Set([
  'read_file', 'list_directory', 'search_files', 'search_in_file',
  'http_get', 'get_file_info', 'find_file', 'get_diagnostics',
  'find_files', 'search_file', 'get_symbol_signatures',
]);

// ─────────────────────────────────────────────────────────────────────────────
//  Pre-cleaning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strip DeepSeek R1 thinking blocks before parsing.
 * R1 emits <think>...</think> which can contain JSON-like text that confuses
 * the parser. We strip these blocks entirely before looking for tool calls.
 *
 * Also strips <reasoning>...</reasoning> and <language>...</language> wrappers
 * that some model variants emit.
 */
function stripThinkingBlocks(text) {
  if (!text) return '';
  let out = text;
  // Remove <think>...</think> (case-insensitive, multiline, non-greedy)
  out = out.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '');
  // Remove <reasoning>...</reasoning>
  out = out.replace(/<reasoning[^>]*>[\s\S]*?<\/reasoning>/gi, '');
  // Remove <language>...</language>
  out = out.replace(/<language[^>]*>[\s\S]*?<\/language>/gi, '');
  // Remove unclosed <think> (model started thinking but didn't close)
  out = out.replace(/<think[^>]*>[\s\S]*$/gi, '');
  return out;
}

/**
 * Normalize tool_call fence tags.
 * DeepSeek sometimes emits ```tool_calls (plural) or ```tool-call (hyphen).
 * Normalize all variants to ```tool_call so downstream regex matches.
 */
function normalizeFenceTags(text) {
  return text
    .replace(/```tool-calls\b/gi, '```tool_call')
    .replace(/```tool_calls\b/gi, '```tool_call')
    .replace(/```tool-call\b/gi, '```tool_call')
    .replace(/```tool calls\b/gi, '```tool_call')
    .replace(/```toolcall\b/gi, '```tool_call');
}

function stripUiNoise(text) {
  return text
    .replace(/^\s*(?:Copy|Download|Run|Insert|Edit)\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function fixUnicode(text) {
  if (!text) return '';
  // Common Unicode artifacts from web scraping
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/\ufeff/g, '')
    .replace(/\u2028/g, '\n')
    .replace(/\u2029/g, '\n');
}

// ─────────────────────────────────────────────────────────────────────────────
//  Lenient JSON parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract a balanced { ... } or [ ... ] substring from text.
 * Handles string literals (so braces inside strings don't count).
 */
function extractBalanced(s, open, close) {
  const start = s.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\') { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Try to parse JSON with progressively more lenient cleanup.
 */
function lenientJsonParse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();

  // 1. Strict JSON.parse
  try { return JSON.parse(trimmed); } catch {}

  // 2. Strip trailing commas
  let cleaned = trimmed.replace(/,\s*([}\]])/g, '$1');
  try { return JSON.parse(cleaned); } catch {}

  // 3. Single-quote → double-quote
  cleaned = cleaned
    .replace(/(['"]?)([\w_-]+)\1\s*:/g, '"$2":')
    .replace(/'([^']*)'/g, '"$1"');
  try { return JSON.parse(cleaned); } catch {}

  // 4. Strip JS comments
  cleaned = cleaned
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  try { return JSON.parse(cleaned); } catch {}

  // 5. Extract first balanced object or array
  const objMatch = extractBalanced(trimmed, '{', '}');
  if (objMatch) {
    try { return JSON.parse(objMatch); } catch {}
    // Try lenient on the extracted substring
    let c2 = objMatch.replace(/,\s*([}\]])/g, '$1')
                    .replace(/(['"]?)([\w_-]+)\1\s*:/g, '"$2":')
                    .replace(/'([^']*)'/g, '"$1"');
    try { return JSON.parse(c2); } catch {}
  }
  const arrMatch = extractBalanced(trimmed, '[', ']');
  if (arrMatch) {
    try { return JSON.parse(arrMatch); } catch {}
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Tool-call normalization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize a parsed object to {name, args} shape.
 * Handles many common key naming variations:
 *   name | tool | function | action  →  name
 *   args | arguments | parameters | input | data  →  args
 *
 * Also handles:
 *   - Array of calls → returns array
 *   - args as string → parse as JSON
 *   - args spread on the object itself
 */
function normalizeToolCall(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;

  // Handle array of calls
  if (Array.isArray(parsed)) {
    return parsed.map(normalizeToolCall).filter(Boolean);
  }

  // Extract name from common keys
  const name = parsed.name || parsed.tool || parsed.function || parsed.action;
  if (!name || typeof name !== 'string') return null;

  // Extract args from common keys
  let args = parsed.args || parsed.arguments || parsed.parameters ||
             parsed.input || parsed.data || {};

  // If args is a string, try to parse it
  if (typeof args === 'string') {
    args = lenientJsonParse(args) || {};
  }

  // If args is missing or not an object, use remaining keys on the parsed object
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    const { name: _n, tool: _t, function: _f, action: _a,
            args: _args, arguments: _arg, parameters: _p,
            input: _i, data: _d, ...rest } = parsed;
    args = rest || {};
  }

  return { name, args };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Extraction strategies
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strategy 1: Extract all ```tool_call fenced blocks.
 * Case-insensitive (after normalizeFenceTags).
 */
function parseFencedToolCalls(text) {
  const results = [];
  const fenceRe = /```tool_call\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    const parsed = lenientJsonParse(m[1].trim());
    const normalized = normalizeToolCall(parsed);
    if (normalized) {
      if (Array.isArray(normalized)) results.push(...normalized);
      else results.push(normalized);
    }
  }
  return results;
}

/**
 * Strategy 2: Extract all fenced JSON blocks (any tag or no tag).
 * Filters to blocks starting with { or [.
 */
function parseFencedJsonBlocks(text) {
  const results = [];
  const fenceRe = /```(?:json|tool_call|js|javascript)?\s*([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(text)) !== null) {
    const raw = m[1].trim();
    if (!raw.startsWith('{') && !raw.startsWith('[')) continue;
    const parsed = lenientJsonParse(raw);
    const normalized = normalizeToolCall(parsed);
    if (normalized) {
      if (Array.isArray(normalized)) results.push(...normalized);
      else results.push(normalized);
    }
  }
  return results;
}

/**
 * Strategy 3: Bare "tool_call" header followed by JSON.
 * Pattern: "tool_call" or "tool_call:" followed by a JSON object.
 */
function parseBareToolCallHeader(text) {
  const results = [];
  // Match "tool_call" possibly followed by colon/equals, then a { ... }
  const headerRe = /(?:^|\n)\s*tool_call\s*[:=]?\s*(\{[\s\S]*?\})(?:\n|$)/gi;
  let m;
  while ((m = headerRe.exec(text)) !== null) {
    const parsed = lenientJsonParse(m[1]);
    const normalized = normalizeToolCall(parsed);
    if (normalized) {
      if (Array.isArray(normalized)) results.push(...normalized);
      else results.push(normalized);
    }
  }
  return results;
}

/**
 * Strategy 4: XML <tool_call> tags with <name> and <args>/<input> children.
 */
function parseXmlToolCalls(text) {
  const results = [];
  const xmlRe = /<tool_call[^>]*>([\s\S]*?)<\/tool_call>/gi;
  let m;
  while ((m = xmlRe.exec(text)) !== null) {
    const inner = m[1];
    const nameMatch = inner.match(/<name[^>]*>([\s\S]*?)<\/name>/i);
    const argsMatch = inner.match(/<(?:args|arguments|input|parameters)[^>]*>([\s\S]*?)<\/(?:args|arguments|input|parameters)>/i);
    if (nameMatch) {
      const name = nameMatch[1].trim();
      let args = {};
      if (argsMatch) {
        const argsRaw = argsMatch[1].trim();
        // Strip code fences if present
        const argsClean = argsRaw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
        args = lenientJsonParse(argsClean) || {};
      }
      results.push({ name, args });
    }
  }
  return results;
}

/**
 * Strategy 5: Literal JSON objects with "name" key, embedded in prose.
 * Pattern: {"name":"..."} or { "name": "..." } anywhere in text.
 * Uses balanced-brace extraction to handle nested objects.
 */
function parseLiteralJsonObjects(text) {
  const results = [];
  // Find all positions where {"name" or {'name' or { "name" appears
  const nameKeyRe = /\{\s*['"]name['"]\s*:\s*['"]([\w_-]+)['"]/gi;
  let m;
  while ((m = nameKeyRe.exec(text)) !== null) {
    // Extract balanced object starting from m.index
    const balanced = extractBalanced(text.slice(m.index), '{', '}');
    if (balanced) {
      const parsed = lenientJsonParse(balanced);
      const normalized = normalizeToolCall(parsed);
      if (normalized && !Array.isArray(normalized)) {
        results.push(normalized);
      }
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Merge + dedup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Merge tool call lists while preserving first-seen order.
 * Dedup by name + JSON.stringify(args).
 */
function mergeToolCalls(...lists) {
  const merged = [];
  const seen = new Set();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const call of list) {
      if (!call || !call.name) continue;
      const key = `${call.name}:${JSON.stringify(call.args || {})}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(call);
    }
  }
  return merged;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main entry point
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the parse result object from a list of tool calls.
 * @param {Array} calls — array of {name, args}
 * @param {string} rawText — original raw response text
 * @returns {Object|null} — {type, calls/name/args, raw}
 */
function buildToolCallParseResult(calls, rawText) {
  if (calls.length > 1) {
    return { type: 'tool_calls', calls, raw: rawText };
  }
  if (calls.length === 1) {
    return { type: 'tool_call', name: calls[0].name, args: calls[0].args, raw: rawText };
  }
  return null;
}

/**
 * Parse a raw DeepSeek response string.
 *
 * Returns one of:
 *   { type: 'tool_calls', calls: [{name, args}], raw: string }  ← multiple
 *   { type: 'tool_call', name: string, args: object, raw: string }
 *   { type: 'final', content: string, raw: string }
 *   { type: 'error', message: string, raw: string }
 */
function parseResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return { type: 'final', content: '', raw: rawText || '' };
  }

  // 0. Pre-clean
  const cleaned = fixUnicode(rawText);
  const noThink = stripThinkingBlocks(cleaned);
  const normalized = normalizeFenceTags(noThink);
  const text = stripUiNoise(normalized).trim();

  // 1. Run all extraction strategies
  const allCalls = mergeToolCalls(
    parseFencedToolCalls(text),
    parseFencedJsonBlocks(text),
    parseBareToolCallHeader(text),
    parseXmlToolCalls(text),
    parseLiteralJsonObjects(text),
  );

  // 2. If we found tool calls, return them
  if (allCalls.length > 0) {
    return buildToolCallParseResult(allCalls, rawText);
  }

  // 3. No tool calls found — this is a final answer
  // Strip any leftover ```tool_call fences that failed to parse (so user doesn't see them)
  const finalContent = text
    .replace(/```tool_call\s*[\s\S]*?```/gi, '')
    .replace(/```(?:json)?\s*\{[\s\S]*?\}\s*```/gi, (match) => {
      // Only strip if it looks like a failed tool call (has "name" key)
      return /"name"\s*:/.test(match) ? '' : match;
    })
    .trim();

  if (finalContent) {
    return { type: 'final', content: finalContent, raw: rawText };
  }

  // 4. Empty response after cleanup
  return { type: 'error', message: 'Empty response after parsing', raw: rawText };
}

/**
 * Parse all tool calls from text (preserved API from original parser).
 * Returns array of {name, args}.
 */
function parseAllToolCalls(text) {
  if (!text) return [];
  const cleaned = fixUnicode(text);
  const noThink = stripThinkingBlocks(cleaned);
  const normalized = normalizeFenceTags(noThink);
  return mergeToolCalls(
    parseFencedToolCalls(normalized),
    parseFencedJsonBlocks(normalized),
    parseBareToolCallHeader(normalized),
    parseXmlToolCalls(normalized),
    parseLiteralJsonObjects(normalized),
  );
}

/**
 * Parse all JSON-fenced tool calls (preserved API).
 */
function parseAllJsonFenceToolCalls(text) {
  return parseFencedJsonBlocks(text || '');
}

/**
 * Format a tool result for sending back to the model.
 * (Preserved from original — used by agent.js)
 */
function formatToolResult(name, result, isError = false) {
  const status = isError ? 'ERROR' : 'SUCCESS';
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  return `[TOOL ${status}] ${name}\n${resultStr}`;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Exports (API-compatible with original parser.js)
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Public API
  parseResponse,
  parseAllToolCalls,
  parseAllJsonFenceToolCalls,
  formatToolResult,
  mergeToolCalls,

  // Constants
  READ_ONLY_TOOLS,

  // Exported for testing
  stripThinkingBlocks,
  normalizeFenceTags,
  lenientJsonParse,
  extractBalanced,
  normalizeToolCall,
  parseFencedToolCalls,
  parseFencedJsonBlocks,
  parseBareToolCallHeader,
  parseXmlToolCalls,
  parseLiteralJsonObjects,
};
