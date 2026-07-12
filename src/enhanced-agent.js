// src/enhanced-agent.js — Enhanced DeepSeek Agent with Planning, Memory, Reflection, and Resilience
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const config = require('./config');
const logger = require('./logger');
const DeepSeekBrowser = require('./browser');
const { executeTool, setReadOnly } = require('./tools');
const { parseResponse, formatToolResult, READ_ONLY_TOOLS } = require('./parser');
const { ConversationManager } = require('./prompt');
const { getSessionLogger } = require('./session-logger');
const { ConversationPersister } = require('./conversation-persister');
const {
  REPEAT_UPLOAD_STUB_THRESHOLD,
  shouldNeverUpload,
  shouldUseBrowserUpload,
  isUploadStubResult,
  toolFingerprint,
  readFileInline,
  uploadSuccessMessage,
} = require('./read-file-delivery');

// New enhanced modules
const { TaskPlanner } = require('./task-planner');
const { WorkingMemory } = require('./working-memory');
const { LongTermMemory } = require('./long-term-memory');
const { SelfReflection, REFLECTION_TYPES } = require('./self-reflection');
const { ProgressTracker } = require('./progress-tracker');
const { AdaptiveIterationManager } = require('./adaptive-iteration-manager');
const { ToolResultAnalyzer } = require('./tool-result-analyzer');
const { SkillLearning } = require('./skill-learning');
const { getBrowserPool, shutdownBrowserPool } = require('./browser-pool-manager');

// ─────────────────────────────────────────────────────────────────────────────
// Global Error Boundary
// ─────────────────────────────────────────────────────────────────────────────

process.on('unhandledRejection', (reason, promise) => {
  if (reason.message?.includes('browser') || reason.message?.includes('context')) {
    logger.warn('🔄 Enhanced Agent rejection caught: ' + reason.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Enhanced Agent Class
// ─────────────────────────────────────────────────────────────────────────────

class EnhancedDeepSeekAgent {
  constructor(options = {}) {
    this.silent = options.silent || false;
    this.browser = new DeepSeekBrowser();
    this.conversations = new Map();
    this.options = options;
    this._running = false;
    this.sandbox = null;
    this.sessionLogger = null;
    this._toolCallTracker = new Map();
    this._crashRetried = false;
    this._lastIter = 0;
    
    // Enhanced modules
    this.taskPlanner = null;
    this.workingMemory = null;
    this.longTermMemory = null;
    this.selfReflection = null;
    this.progressTracker = null;
    this.iterationManager = null;
    this.toolAnalyzer = null;
    this.skillLearning = null;
    
    // Configuration
    this.enablePlanning = options.enablePlanning !== false;
    this.enableMemory = options.enableMemory !== false;
    this.enableReflection = options.enableReflection !== false;
    this.enableProgressTracking = options.enableProgressTracking !== false;
    this.enableAdaptiveIterations = options.enableAdaptiveIterations !== false;
    this.enableToolAnalysis = options.enableToolAnalysis !== false;
    this.enableSkillLearning = options.enableSkillLearning !== false;
    this.enableSubAgents = options.enableSubAgents !== false;
    this.enableBrowserPool = options.enableBrowserPool !== false;
    
    // Session identification
    this.sessionId = options.sessionId || `enhanced_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Initialization
  // ─────────────────────────────────────────────────────────────────────────────

  async init() {
    if (this.enableBrowserPool) {
      // Use browser pool for resilience
      const pool = await getBrowserPool();
      // For now, use direct browser - pool integration would be deeper
    }
    
    await this.browser.launch();
    await this.browser.newChat();
    
    // Initialize enhanced modules
    this._initializeEnhancedModules();
    
    logger.success('Enhanced DeepSeek Agent initialized with all capabilities');
  }

  _initializeEnhancedModules() {
    // Task Planner
    if (this.enablePlanning) {
      this.taskPlanner = new TaskPlanner({
        sessionId: this.sessionId,
        maxSubtasks: config.MAX_SUBTASKS || 20,
        maxDepth: config.MAX_PLAN_DEPTH || 3,
      });
    }
    
    // Working Memory
    if (this.enableMemory) {
      this.workingMemory = new WorkingMemory({
        sessionId: this.sessionId,
        maxTokens: config.MAX_CONTEXT_TOKENS || 100000,
        summaryTriggerRatio: config.SUMMARY_TRIGGER_RATIO || 0.7,
      });
      
      // Long-term Memory
      this.longTermMemory = new LongTermMemory({
        sessionId: this.sessionId,
      });
      
      // Skill Learning
      if (this.enableSkillLearning) {
        this.skillLearning = new SkillLearning({
          sessionId: this.sessionId,
        });
      }
    }
    
    // Self Reflection
    if (this.enableReflection) {
      this.selfReflection = new SelfReflection({
        sessionId: this.sessionId,
        agent: this,
        workingMemory: this.workingMemory,
        longTermMemory: this.longTermMemory,
        taskPlanner: this.taskPlanner,
        iterationInterval: config.REFLECTION_INTERVAL || 5,
        errorThreshold: config.REFLECTION_ERROR_THRESHOLD || 3,
        timeThresholdMs: config.REFLECTION_TIME_THRESHOLD_MS || 10 * 60 * 1000,
      });
    }
    
    // Progress Tracker
    if (this.enableProgressTracking) {
      this.progressTracker = new ProgressTracker({
        sessionId: this.sessionId,
        task: '',
        workingDir: config.WORKING_DIR || process.cwd(),
        checkpointInterval: config.CHECKPOINT_INTERVAL || 5,
      });
    }
    
    // Adaptive Iteration Manager
    if (this.enableAdaptiveIterations) {
      this.iterationManager = new AdaptiveIterationManager({
        minIterations: config.ADAPTIVE_MIN_ITERATIONS || 10,
        maxIterations: config.ADAPTIVE_MAX_ITERATIONS || 500,
        baseIterations: config.ADAPTIVE_BASE_ITERATIONS || 50,
      });
    }
    
    // Tool Result Analyzer
    if (this.enableToolAnalysis) {
      this.toolAnalyzer = new ToolResultAnalyzer({
        maxSummaryLength: config.TOOL_SUMMARY_MAX_LENGTH || 500,
      });
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Conversation Management
  // ─────────────────────────────────────────────────────────────────────────────

  get conversation() {
    const tabName = this.browser.activeTab || 'default';
    if (!this.conversations.has(tabName)) {
      this.conversations.set(tabName, new ConversationManager());
    }
    return this.conversations.get(tabName);
  }

  set conversation(val) {
    const tabName = this.browser.activeTab || 'default';
    if (val) this.conversations.set(tabName, val);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────────

  async runWithTimeout(prompt, timeoutMs = 120000, options = {}) {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs)
    );
    
    try {
      return await Promise.race([this.run(prompt, options), timeoutPromise]);
    } catch (err) {
      if (err.message.includes('timed out')) {
        console.warn('Operation timeout - attempting recovery');
        await this.shutdown().catch(() => {});
        await this.init();
      }
      throw err;
    }
  }

  async run(task, options = {}) {
    this._running = true;
    this._toolCallTracker = new Map();
    this._crashRetried = false;
    this._lastIter = 0;
    const maxIter = config.MAX_ITERATIONS;
    const runStart = Date.now();
    
    // Initialize session logging
    const slog = options.sessionLogger || getSessionLogger() || null;
    const tab = options.tab || this.browser.activeTab || 'default';
    const model = options.model || 'default';
    
    // Streaming callbacks
    const { onToken, onToolCall, onThinking } = options;
    const streamMode = typeof onToken === 'function';
    const streamEvents = (ev) => {
      if (ev.type === 'token' && onToken) onToken(ev.content);
      else if (ev.type === 'thinking' && onThinking) onThinking(ev);
    };
    
    // Persistence
    const persistSessionId = options.sessionId || this.sessionId;
    const persist = (entry) => {
      if (persistSessionId) ConversationPersister.append(persistSessionId, entry);
    };
    
    // Abort signal
    const abortSignal = options.abortSignal || null;
    const isAborted = () => !!(abortSignal && abortSignal.aborted);
    let abortedRun = false;
    let budgetExhausted = false;
    
    // Working directory
    if (options.workingDir) {
      config.WORKING_DIR = options.workingDir;
      slog?.logInfo(`Working directory set to: ${options.workingDir}`);
    }
    
    // Read-only mode
    if (options.readOnly) {
      setReadOnly(true);
      logger.warn('⛔ Read-only mode active');
      slog?.logOrchestration('READ_ONLY_MODE', { active: true });
    } else {
      setReadOnly(false);
    }
    
    // Tab/Model switching
    if (options.tab) {
      await this.browser.switchTab(options.tab);
      slog?.logOrchestration('TAB_SWITCH', { tab: options.tab });
    }
    if (options.model) {
      await this.browser.selectModel(this.browser.activeTab, options.model);
      slog?.logOrchestration('MODEL_SELECT', { tab, model });
    }
    
    // Initialize enhanced modules with task context
    this._initializeTaskContext(task, options);
    
    // Snapshot working directory
    const dirListing = this._getWorkingDirListing();
    
    // Log task start
    logger.header(`[Tab: ${tab}] Task: ${task.slice(0, 80)}${task.length > 80 ? '…' : ''}`);
    
    const conversation = this.conversation;
    let firstMsg;
    
    if (conversation.turnCount === 0) {
      firstMsg = conversation.buildFirstMessage(task, dirListing);
    } else {
      firstMsg = task;
      conversation.messages.push({ role: 'user', content: firstMsg });
    }
    
    // Persist user task
    persist({ type: 'turn', role: 'user', content: task });
    slog?.logRequest(firstMsg, { tab, model, round: 0 });
    
    logger.info(`Sending task to DeepSeek (${tab})...`);
    await this._browserCallWithCrashRecovery(
      () => this.browser.sendMessage(firstMsg, tab),
      { tab, sessionId: persistSessionId, slog }
    );
    
    // Enhanced agent loop
    for (let iter = 1; iter <= maxIter; iter++) {
      this._lastIter = iter;
      
      // Check abort
      if (isAborted()) {
        abortedRun = true;
        logger.warn('⛔ Abort signal received — stopping agent loop.');
        slog?.logWarn('Run aborted by client', { iter, totalDurationMs: Date.now() - runStart });
        break;
      }
      
      // Check wall-clock budget
      const elapsedMs = Date.now() - runStart;
      if (config.RUN_BUDGET_MS && elapsedMs > config.RUN_BUDGET_MS) {
        budgetExhausted = true;
        break;
      }
      
      // Adaptive iteration check
      if (this.iterationManager) {
        const continueCheck = this.iterationManager.shouldContinue();
        if (!continueCheck.continue) {
          logger.warn(`Adaptive iteration limit: ${continueCheck.reason}`);
          slog?.logWarn('Adaptive iteration limit reached', continueCheck);
          break;
        }
      }
      
      logger.iteration(iter, maxIter);
      slog?.logOrchestration('ITERATION_START', { iter, maxIter, tab, model });
      
      // Record iteration in progress tracker
      if (this.progressTracker) {
        this.progressTracker.recordIteration({
          toolCalls: 0,
          toolErrors: 0,
          responseLength: 0,
        });
      }
      
      const responseStart = Date.now();
      const rawResponse = await this._browserCallWithCrashRecovery(
        () => streamMode 
          ? this.browser.streamListen(tab, streamEvents)
          : this.browser.waitForResponse(tab),
        { tab, sessionId: persistSessionId, slog }
      );
      const responseDurMs = Date.now() - responseStart;
      
      if (!rawResponse || rawResponse.trim().length === 0) {
        logger.warn('Empty response received — retrying...');
        slog?.logWarn('Empty response — retrying', { iter });
        const retryMsg = 'Please continue. If you are waiting for input, proceed with your best judgement.';
        slog?.logRequest(retryMsg, { tab, model, round: iter });
        await this._browserCallWithCrashRecovery(
          () => this.browser.sendMessage(retryMsg, tab),
          { tab, sessionId: persistSessionId, slog }
        );
        continue;
      }
      
      slog?.logResponse(rawResponse, { tab, model, durationMs: responseDurMs });
      conversation.addAssistantMessage(rawResponse);
      
      // Parse response
      const parsed = parseResponse(rawResponse);
      
      // Persist assistant message
      persist({
        type: 'turn',
        role: 'assistant',
        content: rawResponse,
        toolCalls: parsed.type === 'tool_calls'
          ? parsed.calls
          : (parsed.type === 'tool_call' ? [{ name: parsed.name, args: parsed.args }] : []),
        iteration: iter,
      });
      
      if (isAborted()) {
        abortedRun = true;
        logger.warn('⛔ Abort signal received after response — skipping tool execution.');
        break;
      }
      
      // Enhanced: Add to working memory
      if (this.workingMemory) {
        this.workingMemory.addMessage('assistant', rawResponse, { iteration: iter, type: parsed.type });
      }
      
      // Handle different response types
      if (parsed.type === 'tool_calls') {
        await this._handleToolCalls(parsed.calls, iter, tab, model, slog, persist, options);
        continue;
      }
      
      if (parsed.type === 'tool_call') {
        await this._handleToolCall(parsed, iter, tab, model, slog, persist, options);
        continue;
      }
      
      if (parsed.type === 'error') {
        await this._handleParseError(parsed, iter, tab, model, slog, persist);
        continue;
      }
      
      if (parsed.type === 'final') {
        const finalResult = await this._handleFinalResponse(parsed, iter, tab, model, slog, persist, options, runStart);
        this._running = false;
        return finalResult;
      }
    }
    
    // Loop exited without final response
    this._running = false;
    return this._handleLoopExit(abortedRun, budgetExhausted, runStart, maxIter);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Task Context Initialization
  // ─────────────────────────────────────────────────────────────────────────────

  _initializeTaskContext(task, options) {
    // Update progress tracker task
    if (this.progressTracker) {
      this.progressTracker.task = task;
    }
    
    // Set task context for iteration manager
    if (this.iterationManager) {
      this.iterationManager.setTaskContext(task, this.taskPlanner?.currentPlan, {
        fileCount: this._countFiles(config.WORKING_DIR),
        hasTests: this._hasTests(config.WORKING_DIR),
        hasDatabase: this._hasDatabase(config.WORKING_DIR),
        hasAuth: this._hasAuth(config.WORKING_DIR),
        hasApi: this._hasApi(config.WORKING_DIR),
      });
    }
    
    // Set focus in working memory
    if (this.workingMemory) {
      this.workingMemory.setFocus(task.slice(0, 200));
    }
    
    // Get relevant long-term memory context
    if (this.longTermMemory) {
      const ltmContext = this.longTermMemory.getRelevantContext(task);
      if (ltmContext) {
        // Store in working memory for prompt inclusion
        this.workingMemory?.addMessage('system', `LONG-TERM MEMORY CONTEXT:\n${ltmContext}`, {
          type: 'ltm_context',
          source: 'long_term_memory',
        });
      }
    }
    
    // Create plan if planning enabled and no existing plan
    if (this.taskPlanner && this.enablePlanning && !this.taskPlanner.currentPlan) {
      this._createInitialPlan(task, options);
    }
  }

  async _createInitialPlan(task, options) {
    try {
      const context = {
        workingDir: config.WORKING_DIR || process.cwd(),
        filesCount: this._countFiles(config.WORKING_DIR),
        recentFiles: this._getRecentFiles(config.WORKING_DIR).slice(0, 10),
      };
      
      const plan = await this.taskPlanner.decomposeTask(task, context);
      
      // Add plan to conversation for context
      if (this.workingMemory) {
        this.workingMemory.addPlanEntry(plan.id, plan.task, plan.subtasks);
      }
      
      // Log plan creation
      logger.info(`Created execution plan with ${plan.subtasks.length} subtasks`);
      
      // Start first subtask if available
      const readyTasks = this.taskPlanner.getReadySubtasks();
      if (readyTasks.length > 0) {
        this.taskPlanner.startSubtask(readyTasks[0].id);
      }
    } catch (err) {
      logger.warn(`Plan creation failed: ${err.message}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool Call Handling (Enhanced)
  // ─────────────────────────────────────────────────────────────────────────────

  async _handleToolCalls(calls, iter, tab, model, slog, persist, options) {
    const callsArray = calls;
    logger.info(`⚡ Parallel batch: ${callsArray.length} tool call(s) — executing...`);
    slog?.logOrchestration('PARALLEL_TOOL_BATCH', { count: callsArray.length, tools: callsArray.map(c => c.name), iter });
    
    const readCalls = callsArray.filter(c => READ_ONLY_TOOLS.has(c.name));
    const mutateCalls = callsArray.filter(c => !READ_ONLY_TOOLS.has(c.name));
    const parallelReadCalls = readCalls.filter(c => c.name !== 'read_file');
    const sequentialReadCalls = readCalls.filter(c => c.name === 'read_file');
    
    const results = new Array(callsArray.length);
    
    const runReadOnlyCall = async (call, mode) => {
      const idx = callsArray.indexOf(call);
      const tStart = Date.now();
      logger.toolCall(`[${mode}] ${call.name}`, call.args);
      slog?.logToolCall(call.name, call.args, { tab, iteration: iter, parallel: mode === 'parallel' });
      
      try {
        const result = await this._executeToolWithEvents(call.name, call.args, options.onToolCall);
        const analysis = this.toolAnalyzer ? this.toolAnalyzer.analyze(call.name, call.args, result, false, Date.now() - tStart) : null;
        slog?.logToolResult(call.name, result, { isError: false, durationMs: Date.now() - tStart, iteration: iter });
        results[idx] = { call, result, isError: false, analysis };
        
        // Record in progress tracker
        if (this.progressTracker) {
          this.progressTracker.recordToolCall(call.name, false, result);
        }
        
        // Update working memory
        if (this.workingMemory) {
          this.workingMemory.addToolResult(call.name, call.args, result, false, Date.now() - tStart);
        }
      } catch (err) {
        slog?.logToolResult(call.name, err.message, { isError: true, durationMs: Date.now() - tStart, iteration: iter });
        slog?.logError(`Tool error: ${call.name}`, { error: err.message, args: call.args, iter });
        results[idx] = { call, result: `Error: ${err.message}`, isError: true };
        
        if (this.progressTracker) {
          this.progressTracker.recordToolCall(call.name, true, err.message);
        }
      }
    };
    
    // 1. Parallel read-only
    await Promise.all(parallelReadCalls.map(call => runReadOnlyCall(call, 'parallel')));
    
    // 2. Sequential read_file
    for (const call of sequentialReadCalls) {
      await runReadOnlyCall(call, 'sequential');
    }
    
    // 3. Sequential mutations
    for (const call of mutateCalls) {
      const idx = callsArray.indexOf(call);
      const tStart = Date.now();
      logger.toolCall(`[sequential] ${call.name}`, call.args);
      slog?.logToolCall(call.name, call.args, { tab, iteration: iter, parallel: false });
      
      try {
        const isMutationTool = ['write_file', 'replace_in_file', 'append_to_file', 'delete_file', 'move_file', 'copy_file'].includes(call.name);
        const sigBefore = isMutationTool ? this._workspaceSignature() : null;
        
        const result = await this._executeToolWithEvents(call.name, call.args, options.onToolCall);
        const analysis = this.toolAnalyzer ? this.toolAnalyzer.analyze(call.name, call.args, result, false, Date.now() - tStart) : null;
        
        slog?.logToolResult(call.name, result, { isError: false, durationMs: Date.now() - tStart, iteration: iter });
        
        // Check for no-op mutations
        if (isMutationTool) {
          const sigAfter = this._workspaceSignature();
          if (sigBefore === sigAfter) {
            const warn = '⚠️ WARNING: Tool ran but no filesystem changes detected. Check path and content.';
            logger.warn(`Mutation tool ${call.name} executed but no filesystem changes detected.`);
            slog?.logWarn(`No-op mutation: ${call.name}`, { args: call.args });
            results[idx] = { call, result: result + '\n\n' + warn, isError: false, analysis };
          } else {
            results[idx] = { call, result, isError: false, analysis };
          }
        } else {
          results[idx] = { call, result, isError: false, analysis };
        }
        
        if (this.progressTracker) {
          this.progressTracker.recordToolCall(call.name, false, result);
        }
        
        if (this.workingMemory) {
          this.workingMemory.addToolResult(call.name, call.args, result, false, Date.now() - tStart);
        }
        
        // Record file changes
        if (['write_file', 'replace_in_file', 'append_to_file', 'delete_file', 'move_file', 'copy_file'].includes(call.name)) {
          const filePath = call.args.path || call.args.source || call.args.destination;
          if (filePath) {
            this.progressTracker?.recordFileChange(filePath, call.name === 'delete_file' ? 'delete' : 'modify');
            if (this.workingMemory) {
              this.workingMemory.addMessage('system', `FILE ${call.name === 'delete_file' ? 'DELETED' : 'MODIFIED'}: ${filePath}`, { type: 'file_change' });
            }
          }
        }
        
      } catch (err) {
        slog?.logToolResult(call.name, err.message, { isError: true, durationMs: Date.now() - tStart, iteration: iter });
        slog?.logError(`Tool error: ${call.name}`, { error: err.message, args: call.args, iter });
        results[idx] = { call, result: `Error: ${err.message}`, isError: true };
        
        if (this.progressTracker) {
          this.progressTracker.recordToolCall(call.name, true, err.message);
        }
      }
    }
    
    // Send combined results
    const combined = results
      .filter(Boolean)
      .map(({ call, result, isError }) => formatToolResult(call.name, result, isError))
      .join('\n\n');
    
    for (const r of results.filter(Boolean)) {
      persist({ type: 'tool_result', name: r.call.name, result: r.result, isError: r.isError });
    }
    
    const feedbackMsg = conversation.addBatchToolResults(combined);
    slog?.logRequest(feedbackMsg, { tab, model, round: iter, type: 'parallel_batch_result' });
    await this._browserCallWithCrashRecovery(
      () => this.browser.sendMessage(feedbackMsg, tab),
      { tab, sessionId: persistSessionId, slog }
    );
    
    // Enhanced: Record batch analysis
    if (this.toolAnalyzer) {
      const batchAnalysis = this.toolAnalyzer.generateBatchSummary(results.filter(Boolean).map(r => r.analysis).filter(Boolean));
      if (this.workingMemory) {
        this.workingMemory.addMessage('system', `BATCH ANALYSIS:\n${batchAnalysis}`, { type: 'batch_analysis' });
      }
    }
    
    // Enhanced: Self-reflection on tool results
    if (this.selfReflection) {
      this.selfReflection.onToolResult(callsArray[0].name, callsArray[0].args, combined, false, 0);
    }
    
    // Enhanced: Check if subtask completed
    if (this.taskPlanner && this.taskPlanner.currentPlan) {
      const currentSubtask = this.taskPlanner.currentPlan.subtasks.find(st => st.status === 'in_progress');
      if (currentSubtask && this._isSubtaskComplete(currentSubtask, combined)) {
        this.taskPlanner.completeSubtask(currentSubtask.id, combined);
        this.progressTracker?.recordSubtaskComplete(currentSubtask.id, combined);
        this.iterationManager?.recordIteration({ subtaskCompleted: true, subtaskId: currentSubtask.id });
        
        // Start next ready subtask
        const ready = this.taskPlanner.getReadySubtasks();
        if (ready.length > 0) {
          this.taskPlanner.startSubtask(ready[0].id);
        }
      }
    }
  }

  async _handleToolCall(parsed, iter, tab, model, slog, persist, options) {
    logger.toolCall(parsed.name, parsed.args);
    slog?.logToolCall(parsed.name, parsed.args, { tab, iteration: iter });
    
    const toolStart = Date.now();
    const isMutationTool = ['write_file', 'replace_in_file', 'append_to_file', 'delete_file', 'move_file', 'copy_file'].includes(parsed.name);
    const sigBefore = isMutationTool ? this._workspaceSignature() : null;
    
    let result;
    let isError = false;
    
    try {
      result = await this._executeToolWithEvents(parsed.name, parsed.args, options.onToolCall);
      const toolDurMs = Date.now() - toolStart;
      logger.toolResult(result);
      slog?.logToolResult(parsed.name, result, { isError: false, durationMs: toolDurMs, iteration: iter });
      
      const analysis = this.toolAnalyzer ? this.toolAnalyzer.analyze(parsed.name, parsed.args, result, false, toolDurMs) : null;
      
      if (isMutationTool) {
        const sigAfter = this._workspaceSignature();
        if (sigBefore === sigAfter) {
          const warn = '⚠️ WARNING: Tool ran but no filesystem changes detected. Check path and content.';
          logger.warn(`Mutation tool ${parsed.name} executed but no filesystem changes detected.`);
          slog?.logWarn(`No-op mutation: ${parsed.name}`, { args: parsed.args });
          result += '\n\n' + warn;
        }
      }
      
      if (this.progressTracker) {
        this.progressTracker.recordToolCall(parsed.name, false, result);
      }
      if (this.workingMemory) {
        this.workingMemory.addToolResult(parsed.name, parsed.args, result, false, toolDurMs);
      }
      if (this.selfReflection) {
        this.selfReflection.onToolResult(parsed.name, parsed.args, result, false, toolDurMs);
      }
      
    } catch (err) {
      result = `Error: ${err.message}`;
      isError = true;
      const toolDurMs = Date.now() - toolStart;
      logger.toolResult(result, true);
      slog?.logToolResult(parsed.name, result, { isError: true, durationMs: toolDurMs, iteration: iter });
      slog?.logError(`Tool error: ${parsed.name}`, { error: err.message, args: parsed.args, iter });
      
      const analysis = this.toolAnalyzer ? this.toolAnalyzer.analyze(parsed.name, parsed.args, err.message, true, toolDurMs) : null;
      
      if (this.progressTracker) {
        this.progressTracker.recordToolCall(parsed.name, true, err.message);
      }
      if (this.workingMemory) {
        this.workingMemory.addToolResult(parsed.name, parsed.args, err.message, true, toolDurMs);
      }
      if (this.selfReflection) {
        this.selfReflection.onError(err, { tool: parsed.name, args: parsed.args, iteration: iter });
      }
    }
    
    const feedbackMsg = conversation.addToolResult(parsed.name, result, isError);
    slog?.logRequest(feedbackMsg, { tab, model, round: iter, type: 'tool_feedback' });
    persist({ type: 'tool_result', name: parsed.name, result, isError });
    await this._browserCallWithCrashRecovery(
      () => this.browser.sendMessage(feedbackMsg, tab),
      { tab, sessionId: persistSessionId, slog }
    );
  }

  async _handleParseError(parsed, iter, tab, model, slog, persist) {
    logger.warn(`Parse error: ${parsed.message}`);
    slog?.logWarn(`Parse error at iter ${iter}`, { message: parsed.message, rawPreview: parsed.raw?.slice(0, 300) });
    
    const recovery = conversation.addToolResult(
      'SYSTEM',
      `Parse error: ${parsed.message}\n\nPlease try again with valid JSON in your tool call.`,
      true
    );
    slog?.logRequest(recovery, { tab, model, round: iter, type: 'parse_error_recovery' });
    await this._browserCallWithCrashRecovery(
      () => this.browser.sendMessage(recovery, tab),
      { tab, sessionId: persistSessionId, slog }
    );
  }

  async _handleFinalResponse(parsed, iter, tab, model, slog, persist, options, runStart) {
    const looksLikeToolCall = (
      /tool_call/i.test(parsed.content) ||
      /"name"\s*:\s*"[\w_]+"/.test(parsed.content) ||
      /write_file|read_file|run_command|list_directory/i.test(parsed.content.slice(0, 200))
    );
    
    if (looksLikeToolCall && conversation.turnCount <= maxIter - 2) {
      logger.warn('Response looks like a tool call but was not parsed — asking AI to retry format...');
      slog?.logWarn('Malformed tool call — asking retry', { preview: parsed.content.slice(0, 200) });
      const retry = conversation.addToolResult(
        'SYSTEM',
        'Your response appeared to contain a tool call but it could not be parsed. ' +
        'Please respond with ONLY a ```tool_call code block and nothing else — no prose before or after it.',
        true
      );
      slog?.logRequest(retry, { tab, model, round: iter, type: 'malformed_tool_retry' });
      await this._browserCallWithCrashRecovery(
        () => this.browser.sendMessage(retry, tab),
        { tab, sessionId: persistSessionId, slog }
      );
      return; // Continue loop
    }
    
    if (!this.silent) logger.finalOutput(parsed.content);
    slog?.logOrchestration('FINAL_RESPONSE', {
      tab, model,
      totalIterations: iter,
      totalDurationMs: Date.now() - runStart,
      responseLen: parsed.content.length,
    });
    
    if (this.options.saveLog) {
      await this._saveConversationLog(options.task || '', parsed.content);
    }
    
    // Mark completion in progress tracker
    if (this.progressTracker) {
      this.progressTracker.recordIteration({ completed: true });
    }
    
    // Record final episode in long-term memory
    if (this.longTermMemory && this.taskPlanner?.currentPlan) {
      const episodeId = this.longTermMemory.startEpisode(this.taskPlanner.currentPlan.task, {
        workingDir: config.WORKING_DIR,
        plan: this.taskPlanner.currentPlan,
      });
      
      // Add steps from working memory
      if (this.workingMemory) {
        const steps = this.workingMemory.rawMessages
          .filter(m => m.metadata.type === 'tool_result')
          .map(m => ({
            type: 'tool_call',
            toolName: m.metadata.toolName,
            args: m.metadata.args,
            result: m.content,
            isError: m.metadata.isError,
            timestamp: m.timestamp,
          }));
        
        for (const step of steps) {
          this.longTermMemory.addEpisodeStep(episodeId, step);
        }
      }
      
      this.longTermMemory.endEpisode(episodeId, 'success', parsed.content, []);
    }
    
    // Extract skills from successful execution
    if (this.skillLearning && this.taskPlanner?.currentPlan) {
      this.skillLearning.extractSkillsFromEpisode({
        id: this.sessionId,
        task: this.taskPlanner.currentPlan.task,
        outcome: 'success',
        steps: this.workingMemory?.rawMessages
          .filter(m => m.metadata.type === 'tool_result')
          .map(m => ({
            type: 'tool_call',
            toolName: m.metadata.toolName,
            args: m.metadata.args,
            result: m.content,
            isError: m.metadata.isError,
            timestamp: m.timestamp,
          })) || [],
        durationMs: Date.now() - runStart,
      });
    }
    
    persist({ type: 'final', content: parsed.content, iterations: iter, durationMs: Date.now() - runStart });
    this._running = false;
    return parsed.content;
  }

  _handleLoopExit(abortedRun, budgetExhausted, runStart, maxIter) {
    const totalMs = Date.now() - runStart;
    const totalMin = Math.floor(totalMs / 60000);
    const iterationsCompleted = Math.max(0, (this._lastIter || 1) - 1);
    
    if (abortedRun) {
      const msg = `⛔ Run aborted by client after ${totalMin}min (${iterationsCompleted} iteration(s) completed). Partial output preserved in the conversation.`;
      logger.warn(msg);
      persist({ type: 'aborted', iterations: iterationsCompleted, durationMs: totalMs });
      return msg;
    }
    
    if (budgetExhausted) {
      const budgetMin = Math.floor((config.RUN_BUDGET_MS || 0) / 60000);
      const msg = `⏱️ Wall-clock budget exhausted after ${totalMin}min (cap: ${budgetMin}min, ${iterationsCompleted} iteration(s) completed). The task may be incomplete. Override with SEEKCODE_RUN_BUDGET_MS.`;
      logger.warn(msg);
      persist({ type: 'budget_exhausted', iterations: iterationsCompleted, durationMs: totalMs });
      return msg;
    }
    
    const warn = `⚠ Reached maximum iterations (${maxIter}). The task may be incomplete.`;
    logger.warn(warn);
    persist({ type: 'max_iterations', iterations: iterationsCompleted, durationMs: totalMs });
    return warn;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Crash Recovery
  // ─────────────────────────────────────────────────────────────────────────────

  _isBrowserTeardownError(err) {
    const msg = String((err && err.message) || err);
    return /Target page.*closed|Target closed|context or browser has been closed|Browser has been closed|Execution context was destroyed|frame was detached/i.test(msg);
  }

  async _browserCallWithCrashRecovery(fn, { tab, sessionId, slog } = {}) {
    try {
      return await fn();
    } catch (err) {
      if (!this._isBrowserTeardownError(err) || this._crashRetried) throw err;
      this._crashRetried = true;
      logger.warn(`🔄 Browser round-trip failed ("${err.message}") — recreating tab "${tab}" and retrying once...`);
      slog?.logWarn('Browser teardown mid-iteration — recreating tab', { tab, error: err.message });
      try {
        await this.recreateTab(tab, sessionId);
      } catch (recErr) {
        logger.error(`Tab recreate failed: ${recErr.message}`);
        throw err;
      }
      return await fn();
    }
  }

  async recreateTab(tab = 'default', sessionId = null) {
    const page = this.browser.pages.get(tab);
    if (page && !page.isClosed()) await page.close().catch(() => {});
    this.browser.pages.delete(tab);
    this.browser.adaptiveSelectors.delete(tab);
    await this.browser.switchTab(tab);
    await this.browser.newChat(tab);

    this.conversations.delete(tab);
    let replayed = 0;
    if (sessionId) {
      const history = ConversationPersister.load(sessionId);
      if (history.length > 0) {
        logger.info(`Replaying ${history.length} persisted entries into tab "${tab}"...`);
        const conv = this.conversation;
        for (const entry of history) {
          if (entry.type === 'turn' && (entry.role === 'user' || entry.role === 'assistant')) {
            conv.addMessage(entry.role, entry.content);
            replayed++;
          }
        }
      }
    }
    return { tab, recreated: true, replayed };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Tool Execution
  // ─────────────────────────────────────────────────────────────────────────────

  _trackToolResult(toolName, args, result) {
    const fp = toolFingerprint(toolName, args);
    const entry = this._toolCallTracker.get(fp) || { count: 0, uploadStubCount: 0 };
    entry.count += 1;
    if (isUploadStubResult(result)) entry.uploadStubCount += 1;
    else entry.uploadStubCount = 0;
    this._toolCallTracker.set(fp, entry);
    return entry;
  }

  _shouldForceInlineReadFile(args) {
    const fp = toolFingerprint('read_file', args);
    const entry = this._toolCallTracker.get(fp);
    return (entry?.uploadStubCount || 0) >= REPEAT_UPLOAD_STUB_THRESHOLD;
  }

  async _executeToolWithEvents(name, args, onToolCall) {
    if (typeof onToolCall !== 'function') {
      return this._executeToolSafely(name, args);
    }
    const id = `tc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    onToolCall({ type: 'tool_call_start', toolCallId: id, name, args });
    const startMs = Date.now();
    try {
      const result = await this._executeToolSafely(name, args);
      onToolCall({
        type: 'tool_call_result',
        toolCallId: id,
        result: typeof result === 'string' ? result : JSON.stringify(result),
        durationMs: Date.now() - startMs,
        isError: false,
      });
      return result;
    } catch (err) {
      onToolCall({
        type: 'tool_call_result',
        toolCallId: id,
        result: err.message,
        durationMs: Date.now() - startMs,
        isError: true,
      });
      throw err;
    }
  }

  async _executeToolSafely(toolName, args) {
    const tab = this.browser.activeTab || 'default';
    
    if (toolName === 'upload_file') {
      const { path: filePath } = args;
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(config.WORKING_DIR, filePath);
      if (!fs.existsSync(absPath)) throw new Error(`File not found: ${filePath}`);
      if (shouldNeverUpload(filePath)) {
        throw new Error(`Cannot upload "${path.basename(filePath)}" as a DeepSeek attachment — this file type is not exposed to the model. Use read_file instead; content is returned inline with secrets redacted.`);
      }
      logger.info(`Uploading file ${filePath} directly via browser...`);
      const res = await this.browser.uploadFile(absPath, tab);
      if (res.uploaded) {
        const lineCount = fs.readFileSync(absPath, 'utf8').split('\n').length;
        const result = uploadSuccessMessage(res.fileName, lineCount);
        this._trackToolResult(toolName, args, result);
        return result;
      }
      throw new Error(`Browser failed to upload the file. Use read_file for inline content.`);
    }
    
    if (toolName === 'read_file') {
      const { path: filePath, start_line, end_line } = args;
      const absPath = path.isAbsolute(filePath) ? filePath : path.resolve(config.WORKING_DIR, filePath);
      
      if (shouldNeverUpload(filePath)) {
        logger.info(`Returning inline (redacted) read for sensitive file: ${filePath}`);
        const result = readFileInline(filePath, { start_line, end_line });
        this._trackToolResult(toolName, args, result);
        return result;
      }
      
      if (this._shouldForceInlineReadFile(args)) {
        logger.warn(`Forcing inline read for ${filePath} after repeated upload-stub results`);
        const result = readFileInline(filePath, {
          start_line,
          end_line,
          note: '⚠ Previous read_file calls returned an attachment stub but content was not visible. Inline copy:',
        });
        this._trackToolResult(toolName, args, result);
        return result;
      }
      
      if (fs.existsSync(absPath) && !fs.statSync(absPath).isDirectory()) {
        const content = fs.readFileSync(absPath, 'utf8');
        const lineCount = content.split('\n').length;
        
        if (shouldUseBrowserUpload(filePath, lineCount, start_line, end_line)) {
          logger.info(`File ${filePath} has ${lineCount} lines. Attempting direct upload...`);
          try {
            const res = await this.browser.uploadFile(absPath, tab);
            if (res.uploaded) {
              const result = uploadSuccessMessage(res.fileName, lineCount);
              this._trackToolResult(toolName, args, result);
              return result;
            }
          } catch (err) {
            logger.warn(`Failed to upload ${filePath}: ${err.message}. Falling back to inline text.`);
          }
        }
      }
      
      const inlineResult = await executeTool(toolName, args);
      this._trackToolResult(toolName, args, inlineResult);
      return inlineResult;
    }
    
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

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  _workspaceSignature() {
    try {
      const crypto = require('crypto');
      const files = [];
      const skip = new Set(['.git', 'node_modules', '.seekcode']);
      
      const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (skip.has(item.name)) continue;
          const abs = path.join(dir, item.name);
          if (item.isDirectory()) {
            walk(abs);
          } else {
            const stat = fs.statSync(abs);
            const sig = stat.size > 5 * 1024 * 1024
              ? `size:${stat.size}`
              : crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
            files.push(`${item.name}:${sig}`);
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
      const excluded = new Set(['node_modules', '.git', 'dist', '.next', 'build']);
      const maxEntries = 80;
      const entries = [];
      
      const walk = (dir, depth) => {
        if (depth > 3 || entries.length >= maxEntries) return;
        let items;
        try {
          items = fs.readdirSync(dir, { withFileTypes: true });
        } catch { return; }
        items.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });
        for (const item of items) {
          if (entries.length >= maxEntries) return;
          if (item.name.startsWith('.') || excluded.has(item.name)) continue;
          if (item.name.endsWith('.lock')) continue;
          const relPath = path.relative(config.WORKING_DIR, path.join(dir, item.name));
          entries.push((item.isDirectory() ? relPath + '/' : relPath));
          if (item.isDirectory()) walk(path.join(dir, item.name), depth + 1);
        }
      };
      
      walk(config.WORKING_DIR, 1);
      return entries.length > 0 ? entries.join('\n') : '(empty directory)';
    } catch {
      return '(could not read directory)';
    }
  }

  async _saveConversationLog(task, finalResponse) {
    try {
      const logsDir = path.join(os.homedir(), '.deepseek-agent', 'logs');
      fs.mkdirSync(logsDir, { recursive: true });
      
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const logFile = path.join(logsDir, `enhanced-session-${ts}.txt`);
      const content = [
        'Enhanced DeepSeek Agent — Session Log',
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

  async shutdown() {
    if (this.sandbox) {
      try { await this.sandbox.cleanup(); } catch (err) { logger.warn(`Sandbox cleanup failed: ${err.message}`); }
    }
    try {
      const { stopAllServers } = require('./tools');
      await stopAllServers();
    } catch (err) { logger.warn(`Failed to stop background servers: ${err.message}`); }
    await this.browser.close();
    
    // Persist enhanced modules
    this.workingMemory?.persist();
    this.longTermMemory?.persist();
    this.skillLearning?.persist();
    this.progressTracker?.persist();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Subtask Completion Detection
  // ─────────────────────────────────────────────────────────────────────────────

  _isSubtaskComplete(subtask, toolResults) {
    // Heuristic: subtask is complete if tool results indicate success and no errors
    const hasErrors = toolResults.includes('ERROR');
    const hasSuccess = toolResults.includes('SUCCESS') || toolResults.includes('✓');
    return hasSuccess && !hasErrors;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utility Methods
  // ─────────────────────────────────────────────────────────────────────────────

  _countFiles(dir) {
    try {
      let count = 0;
      const walk = (d) => {
        if (!fs.existsSync(d)) return;
        const items = fs.readdirSync(d, { withFileTypes: true });
        for (const item of items) {
          if (['.git', 'node_modules', 'dist', 'build', '.seekcode'].includes(item.name)) continue;
          if (item.isDirectory()) walk(path.join(d, item.name));
          else count++;
        }
      };
      walk(dir);
      return count;
    } catch { return 0; }
  }

  _getRecentFiles(dir, limit = 10) {
    try {
      const files = [];
      const walk = (d) => {
        if (!fs.existsSync(d)) return;
        const items = fs.readdirSync(d, { withFileTypes: true });
        for (const item of items) {
          if (['.git', 'node_modules', 'dist', 'build', '.seekcode'].includes(item.name)) continue;
          const abs = path.join(d, item.name);
          if (item.isDirectory()) walk(abs);
          else {
            try {
              const stat = fs.statSync(abs);
              files.push({ path: path.relative(dir, abs), mtime: stat.mtime });
            } catch {}
          }
        }
      };
      walk(dir);
      return files.sort((a, b) => b.mtime - a.mtime).slice(0, limit).map(f => f.path);
    } catch { return []; }
  }

  _hasTests(dir) {
    try {
      const files = fs.readdirSync(dir, { recursive: true });
      return files.some(f => /\.(test|spec)\.(js|ts|jsx|tsx|py)$/.test(f));
    } catch { return false; }
  }

  _hasDatabase(dir) {
    try {
      const files = fs.readdirSync(dir, { recursive: true });
      return files.some(f => /\.(sql|prisma|migrate|schema)\.(js|ts|json)$/.test(f));
    } catch { return false; }
  }

  _hasAuth(dir) {
    try {
      const files = fs.readdirSync(dir, { recursive: true });
      return files.some(f => /auth|passport|jwt|session/.test(f));
    } catch { return false; }
  }

  _hasApi(dir) {
    try {
      const files = fs.readdirSync(dir, { recursive: true });
      return files.some(f => /api|route|endpoint|controller/.test(f));
    } catch { return false; }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Export
// ─────────────────────────────────────────────────────────────────────────────

module.exports = { EnhancedDeepSeekAgent };