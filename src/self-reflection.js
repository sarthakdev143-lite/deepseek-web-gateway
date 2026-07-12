// src/self-reflection.js — Self-Reflection Module for Progress Monitoring and Self-Correction
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

const REFLECTION_DIR = path.join(config.SESSION_DIR || process.cwd(), '.seekcode', 'reflections');
fs.mkdirSync(REFLECTION_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// Reflection Types
// ─────────────────────────────────────────────────────────────────────────────

const REFLECTION_TYPES = {
  PROGRESS: 'progress',           // Periodic progress check
  ERROR: 'error',                 // Error analysis
  STRATEGY_CHANGE: 'strategy_change', // Strategy pivot
  COMPLETION: 'completion',       // Task completion review
  STUCK: 'stuck',                 // Detected stuck state
  QUALITY: 'quality',             // Output quality review
  LEARNING: 'learning',           // Learning extraction
};

const REFLECTION_TRIGGERS = {
  ITERATION_INTERVAL: 5,          // Reflect every N iterations
  ERROR_THRESHOLD: 3,             // Reflect after N errors
  TIME_THRESHOLD_MS: 10 * 60 * 1000, // Reflect after 10 minutes
  STUCK_ITERATIONS: 3,            // Reflect if no progress for N iterations
  TOOL_FAILURE_RATE: 0.5,         // Reflect if >50% tool failures
};

// ─────────────────────────────────────────────────────────────────────────────
// SelfReflection Class
// ─────────────────────────────────────────────────────────────────────────────

class SelfReflection {
  constructor(options = {}) {
    this.sessionId = options.sessionId || `session_${Date.now()}`;
    this.agent = options.agent; // Reference to agent for tool access
    this.workingMemory = options.workingMemory;
    this.longTermMemory = options.longTermMemory;
    this.taskPlanner = options.taskPlanner;
    
    // Configuration
    this.iterationInterval = options.iterationInterval || REFLECTION_TRIGGERS.ITERATION_INTERVAL;
    this.errorThreshold = options.errorThreshold || REFLECTION_TRIGGERS.ERROR_THRESHOLD;
    this.timeThresholdMs = options.timeThresholdMs || REFLECTION_TRIGGERS.TIME_THRESHOLD_MS;
    this.stuckIterations = options.stuckIterations || REFLECTION_TRIGGERS.STUCK_ITERATIONS;
    this.failureRateThreshold = options.failureRateThreshold || REFLECTION_TRIGGERS.TOOL_FAILURE_RATE;
    
    // State
    this.reflections = [];
    this.iterationCount = 0;
    this.errorCount = 0;
    this.toolCalls = 0;
    this.toolFailures = 0;
    this.lastProgressTime = Date.now();
    this.lastProgressState = null;
    this.stuckCounter = 0;
    this.runStartTime = Date.now();
    this.enabled = options.enabled !== false;
    
    // Reflection history file
    this.historyFile = path.join(REFLECTION_DIR, `${this.sessionId}_reflections.jsonl`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Event Handlers (called by agent)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Call at the start of each agent iteration
   */
  onIterationStart(iteration, task, context = {}) {
    if (!this.enabled) return;
    
    this.iterationCount = iteration;
    this._checkTimeTrigger();
    this._checkStuckTrigger(context);
  }

  /**
   * Call after each tool execution
   */
  onToolResult(toolName, args, result, isError, durationMs) {
    if (!this.enabled) return;
    
    this.toolCalls++;
    if (isError) {
      this.errorCount++;
      this.toolFailures++;
      this._checkErrorTrigger();
    }
    
    // Track progress
    if (!isError && this._indicatesProgress(result)) {
      this.lastProgressTime = Date.now();
      this.stuckCounter = 0;
    }
  }

  /**
   * Call when a subtask completes
   */
  onSubtaskComplete(subtaskId, result) {
    if (!this.enabled) return;
    this.lastProgressTime = Date.now();
    this.stuckCounter = 0;
  }

  /**
   * Call when an error occurs
   */
  onError(error, context = {}) {
    if (!this.enabled) return;
    this.errorCount++;
    this._checkErrorTrigger();
    
    // Record error reflection
    this.reflect(REFLECTION_TYPES.ERROR, {
      error: error.message || String(error),
      stack: error.stack,
      context,
      iteration: this.iterationCount,
    });
  }

  /**
   * Call periodically or manually to trigger reflection
   */
  async maybeReflect(context = {}) {
    if (!this.enabled) return null;
    
    // Check triggers
    if (this._shouldReflect()) {
      return await this.reflect(REFLECTION_TYPES.PROGRESS, context);
    }
    
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Core Reflection Logic
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Perform a reflection of the given type
   */
  async reflect(type, context = {}) {
    const reflection = {
      id: `refl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      type,
      timestamp: new Date().toISOString(),
      iteration: this.iterationCount,
      context: this._sanitizeContext(context),
      analysis: null,
      insights: [],
      actions: [],
      metrics: this._collectMetrics(),
    };

    // Generate analysis based on type
    reflection.analysis = await this._generateAnalysis(type, context);
    reflection.insights = this._extractInsights(reflection.analysis, type);
    reflection.actions = this._deriveActions(reflection.insights, type, context);

    // Store reflection
    this.reflections.push(reflection);
    this._persistReflection(reflection);

    // Execute immediate actions if any
    for (const action of reflection.actions) {
      if (action.immediate && action.execute) {
        try {
          await action.execute(this.agent);
        } catch (err) {
          console.warn('[Reflection] Action execution failed:', err.message);
        }
      }
    }

    // Add to working memory if available
    if (this.workingMemory) {
      this.workingMemory.addReflection(
        `REFLECTION (${type}): ${reflection.analysis}\nInsights: ${reflection.insights.join('; ')}`,
        type
      );
    }

    // Store learning in long-term memory
    if (this.longTermMemory && reflection.insights.length > 0) {
      for (const insight of reflection.insights) {
        if (insight.type === 'learning') {
          this.longTermMemory.rememberFact(
            insight.content,
            'reflection_learning',
            { source: 'self_reflection', reflectionId: reflection.id, iteration: this.iterationCount }
          );
        }
      }
    }

    console.log(`[SelfReflection] ${type.toUpperCase()} at iteration ${this.iterationCount}: ${reflection.insights.length} insights, ${reflection.actions.length} actions`);
    
    return reflection;
  }

  /**
   * Generate analysis based on reflection type
   */
  async _generateAnalysis(type, context) {
    const metrics = this._collectMetrics();
    const recentHistory = this._getRecentHistory(5);

    switch (type) {
      case REFLECTION_TYPES.PROGRESS:
        return this._analyzeProgress(metrics, recentHistory, context);
      
      case REFLECTION_TYPES.ERROR:
        return this._analyzeErrors(metrics, recentHistory, context);
      
      case REFLECTION_TYPES.STRATEGY_CHANGE:
        return this._analyzeStrategy(metrics, recentHistory, context);
      
      case REFLECTION_TYPES.COMPLETION:
        return this._analyzeCompletion(metrics, recentHistory, context);
      
      case REFLECTION_TYPES.STUCK:
        return this._analyzeStuck(metrics, recentHistory, context);
      
      case REFLECTION_TYPES.QUALITY:
        return this._analyzeQuality(metrics, recentHistory, context);
      
      case REFLECTION_TYPES.LEARNING:
        return this._analyzeLearning(metrics, recentHistory, context);
      
      default:
        return 'General reflection performed.';
    }
  }

  /**
   * Analyze progress
   */
  _analyzeProgress(metrics, history, context) {
    const { taskPlanner, currentSubtask, elapsedMs } = context;
    
    let analysis = `Progress Reflection (Iteration ${this.iterationCount}, ${Math.round(elapsedMs / 60000)}min elapsed):\n`;
    
    // Overall metrics
    analysis += `  Tools: ${metrics.toolCalls} calls, ${metrics.toolFailures} failures (${metrics.failureRate.toFixed(1)}%)\n`;
    analysis += `  Errors: ${metrics.errorCount}\n`;
    analysis += `  Time since progress: ${Math.round((Date.now() - this.lastProgressTime) / 1000)}s\n`;
    
    // Plan progress
    if (taskPlanner && this.taskPlanner) {
      const planProgress = this.taskPlanner.getProgress();
      if (planProgress) {
        analysis += `  Plan: ${planProgress.percentComplete}% (${planProgress.completed}/${planProgress.total} subtasks)\n`;
        analysis += `  Current phase: ${planProgress.currentPhase}\n`;
      }
    }
    
    // Subtask status
    if (currentSubtask) {
      analysis += `  Current subtask: ${currentSubtask.description} (${currentSubtask.status})\n`;
    }
    
    // Recent activity
    if (history.length > 0) {
      analysis += `  Recent: ${history.slice(-3).map(h => `${h.type}:${h.toolName || h.role}`).join(', ')}\n`;
    }
    
    // Assess velocity
    const velocity = this.iterationCount / (elapsedMs / 60000);
    analysis += `  Velocity: ${velocity.toFixed(1)} iterations/min\n`;
    
    if (velocity < 0.5 && elapsedMs > 5 * 60 * 1000) {
      analysis += `  ⚠ LOW VELOCITY: Consider strategy change\n`;
    }
    
    return analysis;
  }

  /**
   * Analyze errors
   */
  _analyzeErrors(metrics, history, context) {
    const recentErrors = history.filter(h => h.type === 'tool_result' && h.isError).slice(-5);
    
    let analysis = `Error Analysis (${this.errorCount} total errors):\n`;
    
    if (recentErrors.length > 0) {
      analysis += '  Recent errors:\n';
      for (const err of recentErrors) {
        analysis += `    - ${err.toolName}: ${err.error?.slice(0, 100)}\n`;
      }
    }
    
    // Error patterns
    const errorTypes = this._categorizeErrors(recentErrors);
    if (Object.keys(errorTypes).length > 0) {
      analysis += '  Error patterns:\n';
      for (const [type, count] of Object.entries(errorTypes)) {
        analysis += `    - ${type}: ${count}\n`;
      }
    }
    
    // Failure rate
    if (metrics.failureRate > this.failureRateThreshold * 100) {
      analysis += `  ⚠ HIGH FAILURE RATE (${metrics.failureRate.toFixed(1)}%): Strategy revision needed\n`;
    }
    
    return analysis;
  }

  /**
   * Analyze strategy
   */
  _analyzeStrategy(metrics, history, context) {
    let analysis = `Strategy Review:\n`;
    
    // Check if current approach is working
    const recentSuccess = history.filter(h => h.type === 'tool_result' && !h.isError).length;
    const recentTotal = history.filter(h => h.type === 'tool_result').length;
    const recentSuccessRate = recentTotal > 0 ? recentSuccess / recentTotal : 0;
    
    analysis += `  Recent success rate: ${(recentSuccessRate * 100).toFixed(1)}%\n`;
    
    // Tool diversity
    const toolsUsed = new Set(history.filter(h => h.toolName).map(h => h.toolName));
    analysis += `  Tools used: ${Array.from(toolsUsed).join(', ')}\n`;
    
    // Repetition check
    const lastActions = history.slice(-10).map(h => h.toolName || h.role).filter(Boolean);
    const repetitions = this._countRepetitions(lastActions);
    if (repetitions > 3) {
      analysis += `  ⚠ REPETITIVE PATTERN: ${repetitions} repeated actions\n`;
    }
    
    // Plan alignment
    if (this.taskPlanner && this.taskPlanner.currentPlan) {
      const readyTasks = this.taskPlanner.getReadySubtasks();
      analysis += `  Ready subtasks: ${readyTasks.length}\n`;
      if (readyTasks.length > 0 && !currentSubtask) {
        analysis += `  ⚠ NO ACTIVE SUBTASK but ${readyTasks.length} ready\n`;
      }
    }
    
    return analysis;
  }

  /**
   * Analyze completion
   */
  _analyzeCompletion(metrics, history, context) {
    let analysis = `Task Completion Review:\n`;
    
    if (this.taskPlanner && this.taskPlanner.currentPlan) {
      const progress = this.taskPlanner.getProgress();
      analysis += `  Plan completion: ${progress.percentComplete}%\n`;
      analysis += `  Failed subtasks: ${progress.failed}\n`;
    }
    
    // Outcome quality
    const finalOutput = context.finalOutput || '';
    analysis += `  Output length: ${finalOutput.length} chars\n`;
    analysis += `  Has code: ${/\`\`\`/.test(finalOutput)}\n`;
    analysis += `  Has file paths: ${/[\w\/.-]+\.\w{2,4}/.test(finalOutput)}\n`;
    
    return analysis;
  }

  /**
   * Analyze stuck state
   */
  _analyzeStuck(metrics, history, context) {
    let analysis = `STUCK DETECTED (${this.stuckCounter} iterations without progress):\n`;
    
    analysis += `  Last progress: ${Math.round((Date.now() - this.lastProgressTime) / 1000)}s ago\n`;
    analysis += `  Current iteration: ${this.iterationCount}\n`;
    analysis += `  Errors since progress: ${this.errorCount}\n`;
    
    // What was happening
    const recentTools = history
      .filter(h => h.type === 'tool_result')
      .slice(-5)
      .map(h => `${h.toolName}(${h.isError ? 'ERROR' : 'OK'})`);
    analysis += `  Recent tools: ${recentTools.join(' → ')}\n`;
    
    // Hypothesize causes
    const causes = [];
    if (metrics.failureRate > 50) causes.push('High tool failure rate');
    if (this.stuckCounter > 5) causes.push('Extended stagnation');
    if (this.errorCount > 10) causes.push('Accumulated errors');
    if (toolsUsed.size < 2) causes.push('Limited tool diversity');
    
    analysis += `  Likely causes: ${causes.join(', ') || 'Unknown'}\n`;
    
    return analysis;
  }

  /**
   * Analyze quality
   */
  _analyzeQuality(metrics, history, context) {
    let analysis = `Quality Review:\n`;
    
    const output = context.currentOutput || '';
    analysis += `  Output length: ${output.length}\n`;
    analysis += `  Structure: ${this._assessStructure(output)}\n`;
    analysis += `  Completeness: ${this._assessCompleteness(output, context)}\n`;
    
    return analysis;
  }

  /**
   * Analyze learning
   */
  _analyzeLearning(metrics, history, context) {
    let analysis = `Learning Extraction:\n`;
    
    // Patterns that worked
    const successfulTools = history
      .filter(h => h.type === 'tool_result' && !h.isError)
      .map(h => h.toolName);
    const toolSuccess = this._countFrequency(successfulTools);
    analysis += `  Effective tools: ${Object.entries(toolSuccess).sort((a,b) => b[1]-a[1]).slice(0,3).map(([t,c]) => `${t}(${c})`).join(', ')}\n`;
    
    // Patterns that failed
    const failedTools = history
      .filter(h => h.type === 'tool_result' && h.isError)
      .map(h => h.toolName);
    const toolFail = this._countFrequency(failedTools);
    analysis += `  Problematic tools: ${Object.entries(toolFail).sort((a,b) => b[1]-a[1]).slice(0,3).map(([t,c]) => `${t}(${c})`).join(', ')}\n`;
    
    return analysis;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Insight Extraction & Action Derivation
  // ─────────────────────────────────────────────────────────────────────────────

  _extractInsights(analysis, type) {
    const insights = [];
    
    // Pattern-based insight extraction
    if (analysis.includes('LOW VELOCITY') || analysis.includes('LOW VELOCITY')) {
      insights.push({ type: 'strategy', content: 'Velocity below threshold - consider parallel execution or simpler approach', severity: 'warning' });
    }
    
    if (analysis.includes('HIGH FAILURE RATE')) {
      insights.push({ type: 'strategy', content: 'Tool failure rate exceeds threshold - verify tool usage and inputs', severity: 'critical' });
    }
    
    if (analysis.includes('REPETITIVE PATTERN')) {
      insights.push({ type: 'strategy', content: 'Detected repetitive tool usage - may indicate stuck loop', severity: 'warning' });
    }
    
    if (analysis.includes('STUCK DETECTED')) {
      insights.push({ type: 'stuck', content: 'No progress for multiple iterations - requires intervention', severity: 'critical' });
    }
    
    if (analysis.includes('ERROR') && type === REFLECTION_TYPES.ERROR) {
      insights.push({ type: 'error', content: 'Error pattern detected - review error categories for systemic issue', severity: 'warning' });
    }
    
    if (analysis.includes('Effective tools')) {
      insights.push({ type: 'learning', content: 'Identified effective tool patterns for future tasks', severity: 'info' });
    }
    
    if (analysis.includes('Plan completion: 100%')) {
      insights.push({ type: 'completion', content: 'All planned subtasks completed successfully', severity: 'success' });
    }
    
    return insights;
  }

  _deriveActions(insights, type, context) {
    const actions = [];
    
    for (const insight of insights) {
      switch (insight.type) {
        case 'stuck':
          actions.push({
            type: 'strategy_change',
            description: 'Switch to alternative approach',
            immediate: true,
            execute: async (agent) => {
              await agent.requestStrategyChange('stuck_detected');
            },
          });
          actions.push({
            type: 'subtask_skip',
            description: 'Skip blocked subtask and try next available',
            immediate: true,
            execute: async (agent) => {
              if (agent.taskPlanner) {
                const ready = agent.taskPlanner.getReadySubtasks();
                if (ready.length > 0) {
                  agent.taskPlanner.startSubtask(ready[0].id);
                }
              }
            },
          });
          break;
          
        case 'strategy':
          if (insight.content.includes('velocity')) {
            actions.push({
              type: 'parallel_execution',
              description: 'Enable parallel tool execution for independent tasks',
              immediate: false,
              execute: async (agent) => {
                agent.enableParallelExecution(true);
              },
            });
          }
          if (insight.content.includes('failure rate')) {
            actions.push({
              type: 'tool_validation',
              description: 'Validate tool inputs before execution',
              immediate: true,
              execute: async (agent) => {
                agent.enableInputValidation(true);
              },
            });
          }
          break;
          
        case 'error':
          actions.push({
            type: 'error_recovery',
            description: 'Analyze error pattern and apply fix',
            immediate: true,
            execute: async (agent) => {
              await agent.analyzeAndFixErrors();
            },
          });
          break;
          
        case 'learning':
          actions.push({
            type: 'skill_capture',
            description: 'Capture successful pattern as reusable skill',
            immediate: false,
            execute: async (agent) => {
              if (agent.longTermMemory) {
                // Extract skill from recent successful sequence
                await agent.captureSkillFromHistory();
              }
            },
          });
          break;
      }
    }
    
    return actions;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Trigger Checks
  // ─────────────────────────────────────────────────────────────────────────────

  _shouldReflect() {
    // Iteration-based
    if (this.iterationCount > 0 && this.iterationCount % this.iterationInterval === 0) {
      return true;
    }
    
    // Time-based
    if (Date.now() - this.runStartTime > this.timeThresholdMs) {
      return true;
    }
    
    // Stuck-based
    if (this.stuckCounter >= this.stuckIterations) {
      return true;
    }
    
    return false;
  }

  _checkTimeTrigger() {
    if (Date.now() - this.runStartTime > this.timeThresholdMs) {
      this.reflect(REFLECTION_TYPES.PROGRESS, { trigger: 'time_threshold' });
    }
  }

  _checkErrorTrigger() {
    if (this.errorCount >= this.errorThreshold) {
      this.reflect(REFLECTION_TYPES.ERROR, { trigger: 'error_threshold' });
    }
  }

  _checkStuckTrigger(context) {
    const currentState = this._getProgressState(context);
    
    if (this.lastProgressState && this._statesEqual(currentState, this.lastProgressState)) {
      this.stuckCounter++;
    } else {
      this.stuckCounter = 0;
      this.lastProgressState = currentState;
    }
    
    if (this.stuckCounter >= this.stuckIterations) {
      this.reflect(REFLECTION_TYPES.STUCK, { trigger: 'stuck_detection', stuckCounter: this.stuckCounter });
    }
  }

  _getProgressState(context) {
    return {
      completedSubtasks: context.completedSubtasks || 0,
      currentSubtask: context.currentSubtask?.id || null,
      toolCalls: this.toolCalls,
      errors: this.errorCount,
    };
  }

  _statesEqual(a, b) {
    return a.completedSubtasks === b.completedSubtasks &&
           a.currentSubtask === b.currentSubtask &&
           a.toolCalls === b.toolCalls &&
           a.errors === b.errors;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  _collectMetrics() {
    return {
      iterationCount: this.iterationCount,
      toolCalls: this.toolCalls,
      toolFailures: this.toolFailures,
      failureRate: this.toolCalls > 0 ? (this.toolFailures / this.toolCalls * 100) : 0,
      errorCount: this.errorCount,
      elapsedMs: Date.now() - this.runStartTime,
      timeSinceProgress: Date.now() - this.lastProgressTime,
      stuckCounter: this.stuckCounter,
      reflectionCount: this.reflections.length,
    };
  }

  _getRecentHistory(limit = 10) {
    // This would be populated from working memory or agent history
    return [];
  }

  _sanitizeContext(context) {
    const sanitized = { ...context };
    // Remove large objects
    for (const key of Object.keys(sanitized)) {
      const val = sanitized[key];
      if (typeof val === 'string' && val.length > 1000) {
        sanitized[key] = val.slice(0, 1000) + '...[truncated]';
      } else if (typeof val === 'object' && val !== null) {
        try {
          const str = JSON.stringify(val);
          if (str.length > 1000) {
            sanitized[key] = '[Large object]';
          }
        } catch {}
      }
    }
    return sanitized;
  }

  _indicatesProgress(result) {
    if (!result) return false;
    const str = String(result);
    return str.length > 10 && !str.includes('Error') && !str.includes('error');
  }

  _categorizeErrors(errors) {
    const categories = {};
    for (const err of errors) {
      const msg = err.error || '';
      if (msg.includes('not found') || msg.includes('ENOENT')) categories['not_found'] = (categories['not_found'] || 0) + 1;
      else if (msg.includes('permission') || msg.includes('EACCES')) categories['permission'] = (categories['permission'] || 0) + 1;
      else if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) categories['timeout'] = (categories['timeout'] || 0) + 1;
      else if (msg.includes('syntax') || msg.includes('parse')) categories['syntax'] = (categories['syntax'] || 0) + 1;
      else categories['other'] = (categories['other'] || 0) + 1;
    }
    return categories;
  }

  _countRepetitions(actions) {
    let count = 0;
    for (let i = 1; i < actions.length; i++) {
      if (actions[i] === actions[i-1]) count++;
    }
    return count;
  }

  _countFrequency(arr) {
    return arr.reduce((acc, val) => {
      acc[val] = (acc[val] || 0) + 1;
      return acc;
    }, {});
  }

  _assessStructure(output) {
    const hasSections = /^#{1,3}\s/.test(output);
    const hasBullets = /^[\s]*[-*]\s/.test(output);
    const hasCode = /```/.test(output);
    const hasSteps = /\d+\.\s/.test(output);
    return { hasSections, hasBullets, hasCode, hasSteps };
  }

  _assessCompleteness(output, context) {
    if (!context.expectedOutputs) return 'unknown';
    const covered = context.expectedOutputs.filter(eo => output.includes(eo)).length;
    return `${covered}/${context.expectedOutputs.length}`;
  }

  _persistReflection(reflection) {
    try {
      const line = JSON.stringify(reflection) + '\n';
      fs.appendFileSync(this.historyFile, line, 'utf8');
    } catch (err) {
      console.warn('[Reflection] Persist failed:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────────

  getReflections(type = null) {
    if (type) return this.reflections.filter(r => r.type === type);
    return this.reflections;
  }

  getLatestReflection() {
    return this.reflections[this.reflections.length - 1] || null;
  }

  getSummary() {
    const byType = this.reflections.reduce((acc, r) => {
      acc[r.type] = (acc[r.type] || 0) + 1;
      return acc;
    }, {});
    
    return {
      total: this.reflections.length,
      byType,
      latest: this.getLatestReflection()?.type,
      metrics: this._collectMetrics(),
    };
  }

  enable() { this.enabled = true; }
  disable() { this.enabled = false; }

  reset() {
    this.iterationCount = 0;
    this.errorCount = 0;
    this.toolCalls = 0;
    this.toolFailures = 0;
    this.lastProgressTime = Date.now();
    this.stuckCounter = 0;
    this.runStartTime = Date.now();
    this.reflections = [];
  }
}

module.exports = { SelfReflection, REFLECTION_TYPES };