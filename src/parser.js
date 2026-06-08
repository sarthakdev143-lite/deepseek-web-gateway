// src/parser.js — Parse DeepSeek's text responses to extract tool calls
'use strict';

/**
 * Parse a raw DeepSeek response string.
 *
 * Returns one of:
 *   { type: 'tool_call', name: string, args: object, raw: string }
 *   { type: 'final',     content: string,            raw: string }
 *   { type: 'error',     message: string,            raw: string }
 */
function parseResponse(rawText) {
  // Sanitize encoding artifacts first, then strip thinking blocks
  const text = stripThinkingBlocks(fixUnicode(rawText)).trim();

  // ── Strategy 0 (DOM FALLBACK): bare "tool_call\n{ ... }" ─────────────────
  const bareMatch = text.match(/^tool_call\s*\n([\s\S]+)$/i);
  if (bareMatch) {
    const jsonRaw = bareMatch[1].trim();
    try {
      const parsed = JSON.parse(jsonRaw);
      const name   = parsed.name || parsed.tool || parsed.function;
      const args   = parsed.args || parsed.arguments || parsed.parameters || parsed.input || {};
      if (name && typeof name === 'string') {
        return { type: 'tool_call', name, args, raw: rawText };
      }
    } catch {
      const fixed = attemptJsonFix(jsonRaw);
      if (fixed) {
        const name = fixed.name || fixed.tool || fixed.function;
        const args = fixed.args || fixed.arguments || fixed.parameters || fixed.input || {};
        if (name) return { type: 'tool_call', name, args, raw: rawText };
      }
    }
  }

  // ── Strategy 1 (PRIMARY): ```tool_call fenced code block ─────────────────
  const fencedMatch = text.match(/```tool_call\s*([\s\S]*?)```/i);
  if (fencedMatch) {
    const raw = fencedMatch[1].trim();
    try {
      const parsed = JSON.parse(raw);
      const name   = parsed.name || parsed.tool || parsed.function;
      const args   = parsed.args || parsed.arguments || parsed.parameters || parsed.input || {};
      if (name && typeof name === 'string') {
        return { type: 'tool_call', name, args, raw: rawText };
      }
    } catch (e) {
      const fixed = attemptJsonFix(raw);
      if (fixed) {
        const name = fixed.name || fixed.tool || fixed.function;
        const args = fixed.args || fixed.arguments || fixed.parameters || fixed.input || {};
        if (name) return { type: 'tool_call', name, args, raw: rawText };
      }
      return {
        type    : 'error',
        message : 'tool_call block had invalid JSON: ' + e.message + '\nContent: ' + raw.slice(0, 300),
        raw     : rawText,
      };
    }
  }

  // ── Strategy 2: ```json block with "name"/"tool" key ──────────────────────
  const jsonFenceMatch = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (jsonFenceMatch) {
    try {
      const parsed = JSON.parse(jsonFenceMatch[1]);
      const name   = parsed.name || parsed.tool || parsed.function;
      const args   = parsed.args || parsed.arguments || parsed.parameters || parsed.input || {};
      if (name && typeof name === 'string') {
        return { type: 'tool_call', name, args, raw: rawText };
      }
    } catch {}
  }

  // ── Strategy 3: XML <tool_call> ───────────────────────────────────────────
  const xmlMatch = text.match(
    /<tool_call[^>]*>\s*(?:<name>([\s\S]*?)<\/name>\s*)?(?:<input>([\s\S]*?)<\/input>|<args>([\s\S]*?)<\/args>)\s*<\/tool_call>/i
  );
  if (xmlMatch) {
    const name     = (xmlMatch[1] || '').trim();
    const inputRaw = stripCodeFences((xmlMatch[2] || xmlMatch[3] || '').trim());
    if (name) return tryParseToolCall(name, inputRaw, rawText);
  }

  // ── Strategy 4: XML with angle-brackets stripped by DOM ───────────────────
  const domStrippedMatch = text.match(
    /tool_call\s+name\s+([\w_]+)\s*\/name\s+input\s*([\s\S]*?)\s*\/input\s*\/tool_call/i
  );
  if (domStrippedMatch) {
    const name     = domStrippedMatch[1].trim();
    const inputRaw = stripCodeFences(domStrippedMatch[2].trim());
    return tryParseToolCall(name, inputRaw, rawText);
  }

  // ── Strategy 5: Any JSON object with "name" key anywhere in text ──────────
  if (/["'](?:name|tool|function)["']\s*:\s*["'][\w_]+["']/.test(text)) {
    const jsonObj = extractLargestJsonObject(text);
    if (jsonObj) {
      const name = jsonObj.name || jsonObj.tool || jsonObj.function;
      const args = jsonObj.args || jsonObj.arguments || jsonObj.parameters || jsonObj.input || {};
      if (name && typeof name === 'string') {
        return { type: 'tool_call', name, args, raw: rawText };
      }
    }
  }

  // ── Strategy 6: Python-style function call in code block ──────────────────
  const funcMatch = text.match(/```\w*\s*([\w_]+)\(([^)]*)\)\s*```/);
  if (funcMatch) {
    const name    = funcMatch[1];
    const argsRaw = funcMatch[2];
    const args    = {};
    const argRe   = /(\w+)\s*=\s*(?:"([^"]*?)"|'([^']*?)'|(\d+(?:\.\d+)?)|(\btrue\b|\bfalse\b))/g;
    let   m;
    while ((m = argRe.exec(argsRaw)) !== null) {
      const key = m[1];
      if      (m[2] !== undefined) args[key] = m[2];
      else if (m[3] !== undefined) args[key] = m[3];
      else if (m[4] !== undefined) args[key] = parseFloat(m[4]);
      else if (m[5] !== undefined) args[key] = m[5] === 'true';
    }
    if (Object.keys(args).length > 0) {
      return { type: 'tool_call', name, args, raw: rawText };
    }
  }

  // ── No tool call detected — final prose response ───────────────────────────
  return { type: 'final', content: text, raw: rawText };
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

function tryParseToolCall(name, inputRaw, rawText) {
  try {
    const args = JSON.parse(inputRaw);
    return { type: 'tool_call', name, args, raw: rawText };
  } catch (e) {
    const fixed = attemptJsonFix(inputRaw);
    if (fixed !== null) {
      return { type: 'tool_call', name, args: fixed, raw: rawText };
    }
    return {
      type    : 'error',
      message : `Tool "${name}" returned invalid JSON: ${e.message}\nRaw input: ${inputRaw.slice(0, 200)}`,
      raw     : rawText,
    };
  }
}

function stripCodeFences(str) {
  return str
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

// ── Unicode Mojibake Fixer (same as browser.js) ─────────────────────────────
function fixUnicode(text) {
  if (!text) return '';
  const map = {
    "â€œ": "“", "â€": "”", "â€˜": "‘", "â€™": "’",
    "â€”": "—", "â€“": "–", "â€¦": "…", "â€¢": "•",
    "â€°": "‰", "â€¹": "‹", "â€º": "›", "â€ž": "„",
    "â€¡": "‡", "â„¢": "™", "Â©": "©", "Â®": "®",
    "Â°": "°", "Â±": "±", "Â²": "²", "Â³": "³",
    "Âµ": "µ", "Â¶": "¶", "Â·": "·", "Â¹": "¹",
    "Â¼": "¼", "Â½": "½", "Â¾": "¾", "Â¿": "¿",
    "Ã": "À", "Ã": "Á", "Ã": "Â", "Ã": "Ã",
    "Ã„": "Ä", "Ã…": "Å", "Ã†": "Æ", "Ã‡": "Ç",
    "Ãˆ": "È", "Ã‰": "É", "ÃŠ": "Ê", "Ã‹": "Ë",
    "ÃŒ": "Ì", "Ã": "Í", "ÃŽ": "Î", "Ã": "Ï",
    "Ã": "Ð", "Ã‘": "Ñ", "Ã’": "Ò", "Ã“": "Ó",
    "Ã”": "Ô", "Ã•": "Õ", "Ã–": "Ö", "Ã—": "×",
    "Ã˜": "Ø", "Ã™": "Ù", "Ãš": "Ú", "Ã›": "Û",
    "Ãœ": "Ü", "Ã": "Ý", "Ãž": "Þ", "ÃŸ": "ß",
    "Ã ": "à", "Ã¡": "á", "Ã¢": "â", "Ã£": "ã",
    "Ã¤": "ä", "Ã¥": "å", "Ã¦": "æ", "Ã§": "ç",
    "Ã¨": "è", "Ã©": "é", "Ãª": "ê", "Ã«": "ë",
    "Ã¬": "ì", "Ã­": "í", "Ã®": "î", "Ã¯": "ï",
    "Ã°": "ð", "Ã±": "ñ", "Ã²": "ò", "Ã³": "ó",
    "Ã´": "ô", "Ãµ": "õ", "Ã¶": "ö", "Ã·": "÷",
    "Ã¸": "ø", "Ã¹": "ù", "Ãº": "ú", "Ã»": "û",
    "Ã¼": "ü", "Ã½": "ý", "Ã¾": "þ", "Ã¿": "ÿ",
    "Å“": "œ", "Å”": "Œ", "Å¸": "Ÿ", "Ë†": "ˆ"
  };
  const keys = Object.keys(map).sort((a, b) => b.length - a.length);
  const pattern = new RegExp(keys.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
  return text.replace(pattern, m => map[m] || m);
}

function stripThinkingBlocks(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>\n?/gi, '')
    .replace(/^Thinking\.{0,3}\n[\s\S]*?\n\n/m, '')
    .trim();
}

function attemptJsonFix(str) {
  try {
    const fixed = str
      .replace(/,\s*([}\]])/g, '$1')
      .replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
    return JSON.parse(fixed);
  } catch {
    return null;
  }
}

function extractLargestJsonObject(text) {
  let best = null;
  let bestLen = 0;

  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth   = 0;
    let inStr   = false;
    let escape  = false;

    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (escape)          { escape = false; continue; }
      if (ch === '\\' && inStr) { escape = true; continue; }
      if (ch === '"')      { inStr = !inStr; continue; }
      if (inStr)           { continue; }
      if (ch === '{')      { depth++; }
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          const candidate = text.slice(i, j + 1);
          if (candidate.length > bestLen) {
            try {
              const parsed = JSON.parse(candidate);
              best    = parsed;
              bestLen = candidate.length;
            } catch {
              const fixed = attemptJsonFix(candidate);
              if (fixed && candidate.length > bestLen) {
                best    = fixed;
                bestLen = candidate.length;
              }
            }
          }
          break;
        }
      }
    }
  }

  return best;
}

function formatToolResult(toolName, result, isError = false) {
  const status = isError ? 'ERROR' : 'SUCCESS';
  return [
    `[TOOL RESULT: ${toolName} | ${status}]`,
    String(result),
    `[END TOOL RESULT]`,
  ].join('\n');
}

function isAskingQuestion(text) {
  const questionIndicators = [
    /\?(\s*$)/m,
    /could you (please |kindly )?clarify/i,
    /can you provide more/i,
    /what (do you|would you) (want|like|prefer)/i,
    /please (specify|clarify|tell me)/i,
  ];
  return questionIndicators.some(re => re.test(text));
}

module.exports = {
  parseResponse,
  formatToolResult,
  stripThinkingBlocks,
  isAskingQuestion,
};