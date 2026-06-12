// src/agent.js — The core agent loop that ties everything together
'use strict';

const fs                           = require('fs');
const path                         = require('path');
const os                           = require('os');
const config                       = require('./config');
const logger                       = require('./logger');
const DeepSeekBrowser              = require('./browser');
const { executeTool }              = require('./tools');
const { parseResponse,
        formatToolResult }         = require('./parser');
const { ConversationManager }      = require('./prompt');

// Global error boundary for agent.js
process.on('unhandledRejection', (reason, promise) => {
  // Defer handling to main orchestrator or ignore non-fatal resets
  if (reason.message?.includes('browser') || reason.message?.includes('context')) {
    logger.warn('🔄 Agent rejection caught in global boundary: ' + reason.message);
  }
});

// ─────────────────────────────────────────────
//  Agent class
// ─────────────────────────────────────────────

class DeepSeekAgent {

  async runWithTimeout(prompt, timeoutMs = 120000, options = {}) {
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    );
    
    try {
      return await Promise.race([this.run(prompt, options), timeoutPromise]);
    } catch (err) {
      if (err.message.includes('timed out')) {
        // Attempt to recover browser state
        console.warn('Operation timeout - attempting recovery');
        await this.shutdown().catch(() => {});
        await this.init();
      }
      throw err;
    }
  }

  constructor(options = {}) {
    this.silent = options.silent || false;
    this.browser      = new DeepSeekBrowser();
    this.conversations = new Map(); // tabName -> ConversationManager
    this.options      = options;
    this._running     = false;
    this.sandbox      = null; // Will be initialized on first command execution
  }

  get conversation() {
    const tabName = this.browser.activeTab || 'default';
    if (!this.conversations.has(tabName)) {
      this.conversations.set(tabName, new ConversationManager());
    }
    return this.conversations.get(tabName);
  }

  set conversation(val) {
    const tabName = this.browser.activeTab || 'default';
    if (val) {
      this.conversations.set(tabName, val);
    }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Boot the browser and load DeepSeek */
  async init() {
    await this.browser.launch();
    await this.browser.newChat();
  }

  /** Shut down cleanly */
  async shutdown() {
    // Clean up sandbox if it exists
    if (this.sandbox) {
      try {
        await this.sandbox.cleanup();
      } catch (err) {
        logger.warn(`Sandbox cleanup failed: ${err.message}`);
      }
    }
    await this.browser.close();
  }

  /**
   * Run a task to completion.
   * Returns the final response string.
   */
  async run(task, options = {}) {
    this._running   = true;
    const maxIter   = config.MAX_ITERATIONS;

    // Switch tab and configure model
    if (options.tab) {
      await this.browser.switchTab(options.tab);
    }
    if (options.model) {
      await this.browser.selectModel(this.browser.activeTab, options.model);
    }

    // ── 1. Snapshot working directory ──────────────────────────────────────
    const dirListing = this._getWorkingDirListing();

    // ── 2. Build and send first message ───────────────────────────────────
    logger.header(`[Tab: ${this.browser.activeTab}] Task: ${task.slice(0, 80)}${task.length > 80 ? '…' : ''}`);

    const conversation = this.conversation;
    let firstMsg;
    
    // Only build first message with system prompt if conversation is empty
    if (conversation.turnCount === 0) {
      firstMsg = conversation.buildFirstMessage(task, dirListing);
    } else {
      firstMsg = task;
      conversation.messages.push({ role: 'user', content: firstMsg });
    }

    if (config.DEBUG) {
      logger.dim('--- Message sent (truncated) ---');
      logger.dim(firstMsg.slice(0, 600) + '...');
    }

    logger.info(`Sending task to DeepSeek (${this.browser.activeTab})...`);
    await this.browser.sendMessage(firstMsg);

    // ── 3. Agent loop ──────────────────────────────────────────────────────
    for (let iter = 1; iter <= maxIter; iter++) {
      logger.iteration(iter, maxIter);

      // Wait for response from DeepSeek
      const rawResponse = await this.browser.waitForResponse();

      if (!rawResponse || rawResponse.trim().length === 0) {
        logger.warn('Empty response received — retrying...');
        await this.browser.sendMessage('Please continue. If you are waiting for input, proceed with your best judgement.');
        continue;
      }

      if (config.DEBUG) {
        logger.dim(`--- Raw response (${rawResponse.length} chars) ---`);
        logger.dim(rawResponse.slice(0, 400));
      }

      // Record the AI response in conversation history
      conversation.addAssistantMessage(rawResponse);

      // Parse the response
      const parsed = parseResponse(rawResponse);

      // ── Case 1: Tool call ──────────────────────────────────────────────
      if (parsed.type === 'tool_call') {
        logger.toolCall(parsed.name, parsed.args);

        let result;
        let isError = false;

        const isMutationTool = ['write_file', 'replace_in_file', 'append_to_file', 'delete_file', 'move_file', 'copy_file'].includes(parsed.name);
        const sigBefore = isMutationTool ? this._workspaceSignature() : null;

        try {
          result = await this._executeToolSafely(parsed.name, parsed.args);
          logger.toolResult(result);

          if (isMutationTool) {
            const sigAfter = this._workspaceSignature();
            if (sigBefore === sigAfter) {
              logger.warn(`Mutation tool ${parsed.name} executed but no filesystem changes detected.`);
              result += '\n\n⚠️ WARNING: The tool ran successfully, but no file changes were detected on disk. Please verify if the target file path and matching content are correct.';
            }
          }
        } catch (err) {
          result = `Error: ${err.message}`;
          isError = true;
          logger.toolResult(result, true);
        }

        // Feed result back
        const feedbackMsg = conversation.addToolResult(parsed.name, result, isError);
        await this.browser.sendMessage(feedbackMsg);
        continue;
      }

      // ── Case 2: Parse error ────────────────────────────────────────────
      if (parsed.type === 'error') {
        logger.warn(`Parse error: ${parsed.message}`);
        const recovery = conversation.addToolResult(
          'SYSTEM',
          `Parse error: ${parsed.message}\n\nPlease try again with valid JSON in your tool call.`,
          true
        );
        await this.browser.sendMessage(recovery);
        continue;
      }

      // ── Case 3: Final response ─────────────────────────────────────────
      if (parsed.type === 'final') {
        const looksLikeToolCall = (
          /tool_call/i.test(parsed.content) ||
          /"name"\s*:\s*"[\w_]+"/.test(parsed.content) ||
          /write_file|read_file|run_command|list_directory/i.test(parsed.content.slice(0, 200))
        );

        if (looksLikeToolCall && conversation.turnCount <= maxIter - 2) {
          logger.warn('Response looks like a tool call but was not parsed — asking AI to retry format...');
          const retry = conversation.addToolResult(
            'SYSTEM',
            'Your response appeared to contain a tool call but it could not be parsed. ' +
            'Please respond with ONLY a ```tool_call code block and nothing else — no prose before or after it.',
            true
          );
          await this.browser.sendMessage(retry);
          continue;
        }

        if (!this.silent) logger.finalOutput(parsed.content);

        // Optionally save conversation log
        if (this.options.saveLog) {
          await this._saveConversationLog(task, parsed.content);
        }

        this._running = false;
        return parsed.content;
      }
    }

    // ── Hit max iterations ─────────────────────────────────────────────────
    this._running = false;
    const warn = `⚠ Reached maximum iterations (${maxIter}). The task may be incomplete.`;
    logger.warn(warn);
    return warn;
  }

  // ── Interactive (REPL) Mode ────────────────────────────────────────────────

  async runInteractive() {
    const readline = require('readline');

    logger.header('Interactive Mode — Type your task and press Enter');
    logger.info('Commands: "exit" or "quit" to stop, "new" to start a new chat\n');

    const rl = readline.createInterface({
      input    : process.stdin,
      output   : process.stdout,
      terminal : true,
    });

    const ask = () => new Promise(resolve => rl.question('\n\x1b[96m❯ Task:\x1b[0m ', resolve));

    while (true) {
      let task;
      try {
        task = (await ask()).trim();
      } catch {
        break; // stdin closed
      }

      if (!task) continue;

      if (['exit', 'quit', 'q'].includes(task.toLowerCase())) {
        logger.info('Exiting...');
        break;
      }

      if (task.toLowerCase() === 'new') {
        logger.info('Starting new chat...');
        await this.browser.newChat();
        this.conversations.clear();
        continue;
      }

      // Reset conversations map for each new task
      this.conversations.clear();

      try {
        await this.browser.newChat();
        await this.run(task);
      } catch (err) {
        logger.error(`Task failed: ${err.message}`);
        if (config.DEBUG) console.error(err);
      }
    }

    rl.close();
  }

  // ── Secure Tool Execution with Sandbox ─────────────────────────────────────

  async _executeToolSafely(toolName, args) {
    if (toolName !== 'run_command') {
      return await executeTool(toolName, args);
    }

    const { command, cwd, timeout, env } = args;
    
    let SecuritySandbox;
    try {
      SecuritySandbox = require('./security/SecuritySandbox').SecuritySandbox;
    } catch (err) {
      logger.warn('⚠️ Security sandbox not available. Commands run directly on host (unsafe).');
      return await executeTool(toolName, args);
    }

    if (!this.sandbox) {
      logger.info('Initializing security sandbox...');
      this.sandbox = new SecuritySandbox({
        policy: config.SECURITY_POLICY || {
          approvalRequired: { delete: true, writeOutsideProject: true, network: true, shell: true, install: true },
          allowNetwork: false,
        },
        docker: {
          image: config.DOCKER_IMAGE || 'node:20-alpine',
          memory: config.DOCKER_MEMORY || '512m',
          network: config.ALLOW_NETWORK ? 'bridge' : 'none',
          timeout: config.COMMAND_TIMEOUT || 60000,
        },
      });
    }

    try {
      logger.dim(`[Sandbox] Executing: ${command.slice(0, 100)}`);
      const result = await this.sandbox.execute(command, { cwd, env, timeout });
      
      let output = result.stdout;
      if (result.stderr) output += '\n\nSTDERR:\n' + result.stderr;
      if (!result.sandboxed) {
        output += '\n\n⚠️ WARNING: Command ran on host (Docker unavailable). Install Docker for sandboxing.';
      }
      return output || '(command completed with no output)';
    } catch (err) {
      throw new Error(`Sandbox execution failed: ${err.message}`);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  _workspaceSignature() {
    try {
      const crypto = require('crypto');
      const files = [];
      const skip = new Set(['.git', 'node_modules', '.seekcode']);
      
      const walk = dir => {
        if (!fs.existsSync(dir)) return;
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (skip.has(item.name)) continue;
          const abs = path.join(dir, item.name);
          if (item.isDirectory()) {
            walk(abs);
          } else {
            const stat = fs.statSync(abs);
            files.push(`${item.name}:${stat.size}:${stat.mtimeMs}`);
          }
        }
      };
      
      walk(config.WORKING_DIR);
      return crypto.createHash('sha1').update(files.join(',')).digest('hex');
    } catch {
      return '';
    }
  }

  _getWorkingDirListing() {
    try {
      const excluded = new Set(["node_modules", ".git", "dist", ".next", "build"]);
      const maxEntries = 80;
      const entries = [];

      function walk(dir, depth) {
        if (depth > 3 || entries.length >= maxEntries) return;
        let items;
        try {
          items = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        items.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });
        for (const item of items) {
          if (entries.length >= maxEntries) return;
          if (item.name.startsWith(".") || excluded.has(item.name)) continue;
          if (item.name.endsWith(".lock")) continue;
          const relPath = path.relative(config.WORKING_DIR, path.join(dir, item.name));
          entries.push((item.isDirectory() ? relPath + "/" : relPath));
          if (item.isDirectory()) {
            walk(path.join(dir, item.name), depth + 1);
          }
        }
      }

      walk(config.WORKING_DIR, 1);
      return entries.length > 0 ? entries.join("\n") : "(empty directory)";
    } catch {
      return "(could not read directory)";
    }
  }

  async _saveConversationLog(task, finalResponse) {
    try {
      const logsDir = path.join(os.homedir(), '.deepseek-agent', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });

      const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const logFile  = path.join(logsDir, `session-${ts}.txt`);
      const content  = [
        `DeepSeek Agent — Session Log`,
        `Date: ${new Date().toISOString()}`,
        `Task: ${task}`,
        `Working Dir: ${config.WORKING_DIR}`,
        '═'.repeat(60),
        this.conversation.exportLog(),
        '',
        '═'.repeat(60),
        'FINAL RESPONSE:',
        finalResponse,
      ].join('\n');

      fs.writeFileSync(logFile, content, 'utf8');
      logger.dim(`Conversation saved: ${logFile}`);
    } catch (err) {
      logger.warn(`Could not save log: ${err.message}`);
    }
  }
}

module.exports = DeepSeekAgent;