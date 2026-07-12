// src/config.js — Central configuration for DeepSeek Agent
const path = require('path');
const fs   = require('fs');
const os   = require('os');

// ─────────────────────────────────────────────
// Default configuration
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

  // Project roots allowlist for the GUI's "Open Project" picker security gate.
  // Semicolon-separated (Windows) or colon-separated (Unix) via path.delimiter.
  // Empty array = OPEN MODE (dev convenience): any path accepted.
  // Set SEEKCODE_PROJECT_ROOTS="C:\\code;D:\\repos" in production so the agent
  // (which has write_file + run_command) can only be pointed at allowed dirs.
  PROJECT_ROOTS    : (process.env.SEEKCODE_PROJECT_ROOTS || '')
                      .split(path.delimiter)
                      .map((s) => s.trim())
                      .filter(Boolean),

  // Output — raised to handle 100K+ token responses (unlimited Continue clicks)
  MAX_OUTPUT_LENGTH : 200_000,
  DEBUG             : false,

  // ─────────────────────────────────────────────
  // Enhanced Features Configuration
  // ─────────────────────────────────────────────

  // Task Planning
  MAX_SUBTASKS        : 20,
  MAX_PLAN_DEPTH      : 3,

  // Working Memory
  MAX_CONTEXT_TOKENS      : 100_000,
  SUMMARY_TRIGGER_RATIO   : 0.7,
  MAX_SUMMARY_LENGTH      : 2_000,
  MAX_RAW_MESSAGES        : 50,

  // Long-term Memory
  LTM_MAX_ENTRIES         : 10_000,
  LTM_MAX_EPISODES        : 1_000,
  LTM_SIMILARITY_THRESHOLD: 0.7,
  LTM_EMBEDDING_DIM       : 384,

  // Self-Reflection
  REFLECTION_INTERVAL       : 5,
  REFLECTION_ERROR_THRESHOLD: 3,
  REFLECTION_TIME_THRESHOLD_MS: 10 * 60 * 1000,
  REFLECTION_STUCK_ITERATIONS: 3,
  REFLECTION_FAILURE_RATE   : 0.5,

  // Progress Tracking
  CHECKPOINT_INTERVAL     : 5,
  MAX_CHECKPOINTS         : 20,
  MAX_EPISODES            : 100,

  // Adaptive Iterations
  ADAPTIVE_MIN_ITERATIONS  : 10,
  ADAPTIVE_MAX_ITERATIONS  : 500,
  ADAPTIVE_BASE_ITERATIONS : 50,
  ADAPTIVE_PROGRESS_THRESHOLD: 0.1,
  ADAPTIVE_STAGNATION_LIMIT : 5,
  ADAPTIVE_COMPLETION_CONFIDENCE: 0.8,

  // Tool Analysis
  TOOL_SUMMARY_MAX_LENGTH : 500,

  // Skill Learning
  SKILL_MIN_SUCCESS_RATE  : 0.7,
  SKILL_MIN_USAGE         : 3,
  SKILL_SIMILARITY_THRESHOLD: 0.6,

  // Browser Pool
  BROWSER_POOL_SIZE       : 2,
  BROWSER_MAX_POOL_SIZE   : 5,
  BROWSER_IDLE_TIMEOUT    : 5 * 60 * 1000,
  BROWSER_MAX_AGE         : 60 * 60 * 1000,
  BROWSER_HEALTH_CHECK_INTERVAL: 30 * 1000,
  BROWSER_CRASH_RECOVERY_RETRIES: 3,
};

// ─────────────────────────────────────────────
// Config loading priority (highest wins):
//
// 1. ~/.deepseek-agent/config.json  — global user config
// 2. ./deepseek-agent.config.json   — per-project config
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
fs.mkdirSync(path.join(config.SESSION_DIR, '..', 'working-memory'), { recursive: true });
fs.mkdirSync(path.join(config.SESSION_DIR, '..', 'long-term-memory'), { recursive: true });
fs.mkdirSync(path.join(config.SESSION_DIR, '..', 'plans'), { recursive: true });
fs.mkdirSync(path.join(config.SESSION_DIR, '..', 'checkpoints'), { recursive: true });
fs.mkdirSync(path.join(config.SESSION_DIR, '..', 'skills'), { recursive: true });
fs.mkdirSync(path.join(config.SESSION_DIR, '..', 'browser-pool'), { recursive: true });

module.exports = config;