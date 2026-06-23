// src/config.js — Central configuration for DeepSeek Agent
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ─────────────────────────────────────────────
//  Default configuration
// ─────────────────────────────────────────────
const defaults = {
  // Browser
  DEEPSEEK_URL   : 'https://chat.deepseek.com',
  SESSION_DIR    : path.join(os.homedir(), '.deepseek-agent', 'session'),
  HEADLESS       : false,

  // Timing — DeepSeek web has NO output token limits via the Continue button.
  // A deep R1 reasoning response can take 10-20+ minutes. We accommodate that.
  RESPONSE_TIMEOUT : 30 * 60 * 1000, // 30 minutes total per response
  STABLE_DELAY     : 2_500,
  SEND_DELAY       : 400,

  // Agent
  MAX_ITERATIONS   : 999,
  // Wall-clock budget for a single agent.run() — hard cap INDEPENDENT of
  // MAX_ITERATIONS. Prevents the theoretical "999 iters × 30-min response =
  // 21 days" runaway. Default 4 hours; override with SEEKCODE_RUN_BUDGET_MS.
  // The agent checks this between iterations and bails gracefully (preserving
  // whatever output was produced) when the budget is exhausted.
  RUN_BUDGET_MS    : Number(process.env.SEEKCODE_RUN_BUDGET_MS) || (4 * 60 * 60 * 1000),
  WORKING_DIR      : process.cwd(),

  // Project roots allowlist for the GUI's "Open Project" picker.
  // Semicolon-separated (Windows) or colon-separated (Unix) via path.delimiter.
  // Empty array = OPEN MODE (dev convenience): any path accepted.
  // Set SEEKCODE_PROJECT_ROOTS="C:\code;D:\repos" in production so the agent
  // (which has write_file + run_command) can only be pointed at allowed dirs.
  PROJECT_ROOTS    : (process.env.SEEKCODE_PROJECT_ROOTS || '')
                      .split(path.delimiter)
                      .map((s) => s.trim())
                      .filter(Boolean),

  // Output — raised to handle 100K+ token responses (unlimited Continue clicks)
  MAX_OUTPUT_LENGTH : 200_000,
  DEBUG             : false,
};

// ─────────────────────────────────────────────
//  Config loading priority (highest wins):
//
//  1. ~/.deepseek-agent/config.json  — global user config
//  2. ./deepseek-agent.config.json   — per-project config
// ─────────────────────────────────────────────

function loadJson(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch {
    console.warn('[deepseek-agent] Could not parse config file: ' + filePath);
  }
  return {};
}

const globalConfigPath  = path.join(os.homedir(), '.deepseek-agent', 'config.json');
const projectConfigPath = path.join(process.cwd(), 'deepseek-agent.config.json');

const config = {
  ...defaults,
  ...loadJson(globalConfigPath),   // global overrides defaults
  ...loadJson(projectConfigPath),  // project overrides global
};

// Remove comment keys from JSON files
delete config._comment;

// Resolve session dir to absolute path
if (!path.isAbsolute(config.SESSION_DIR)) {
  config.SESSION_DIR = path.resolve(process.cwd(), config.SESSION_DIR);
}

// Ensure required directories exist
fs.mkdirSync(config.SESSION_DIR, { recursive: true });
fs.mkdirSync(path.join(os.homedir(), '.deepseek-agent', 'logs'), { recursive: true });

module.exports = config;
