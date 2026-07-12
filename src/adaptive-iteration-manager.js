// src/adaptive-iteration-manager.js — Dynamic Iteration Management for Long-Horizon Tasks
'use strict';

const config = require('./config');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_MIN_ITERATIONS = config.ADAPTIVE_MIN_ITERATIONS || 10;
const DEFAULT_MAX_ITERATIONS = config.ADAPTIVE_MAX_ITERATIONS || 500;
const DEFAULT_BASE_ITERATIONS = config.ADAPTIVE_BASE_ITERATIONS || 50;
const PROGRESS_THRESHOLD = config.ADAPTIVE_PROGRESS_THRESHOLD || 0.1; // Min progress per iteration
const STAGNATION_LIMIT = config.ADAPTIVE_STAGNATION_LIMIT || 5; // Iterations without progress
const COMPLETION_CONFIDENCE = config.ADAPTIVE_COMPLETION_CONFIDENCE || 0.8;

// ─────────────────────────────────────────────────────────────────────────────
// AdaptiveIterationManager Class
// ─────────────────────────────────────────────────────────────────────────────

class AdaptiveIterationManager {
  constructor(options = {}) {
    this.minIterations = options.minIterations || DEFAULT_MIN_ITERATIONS;
    this.maxIterations = options.maxIterations || DEFAULT_MAX_ITERATIONS;
    this.baseIterations = options.baseIterations || DEFAULT_BASE_ITERATIONS;
    this.progressThreshold = options.progressThreshold || PROGRESS_THRESHOLD;
    this.stagnationLimit = options.stagnationLimit || STAGNATION_LIMIT;
    this.completionConfidence = options.completionConfidence || COMPLETION_CONFIDENCE;
    
    // Task complexity estimation
    this.taskComplexity = options.taskComplexity || 'unknown'; // simple, moderate, complex, unknown
    this.estimatedIterations = options.estimatedIterations || this.baseIterations;
    
    // Dynamic state
    this.currentIteration = 0;
    this.iterationHistory = []; // { iteration, progress, toolCalls, errors, timeMs, subtaskCompleted }
    this.stagnationCount = 0;
    this.lastProgressScore = 0;
    this.totalProgress = 0;
    this.subtasksCompleted = 0;
    this.subtasksTotal = 0;
    this.startTime = Date.now();
    this.lastIterationTime = Date.now();
    
    // Adaptive parameters
    this.currentMaxIterations = this._calculateInitialMax();
    this.earlyStopEnabled = options.earlyStopEnabled !== false;
    this.extensionEnabled = options.extensionEnabled !== false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Initialization & Configuration
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Set task context for better estimation
   */
  setTaskContext(task, plan = null, context = {}) {
    this.task = task;
    this.taskComplexity = this._estimateComplexity(task, plan, context);
    this.estimatedIterations = this._estimateIterations(this.taskComplexity, plan);
    this.currentMaxIterations = this._calculateInitialMax();
    this.subtasksTotal = plan?.subtasks?.length || context.subtaskCount || 0;
    
    console.log(`[AdaptiveIterations] Task complexity: ${this.taskComplexity}, Estimated iterations: ${this.estimatedIterations}, Max: ${this.currentMaxIterations}`);
  }

  /**
   * Estimate task complexity from description and plan
   */
  _estimateComplexity(task, plan, context) {
    const lowerTask = task.toLowerCase();
    
    // Complexity indicators
    const complexKeywords = [
      'build', 'create', 'implement', 'develop', 'design', 'architect',
      'refactor', 'migrate', 'integrate', 'system', 'platform', 'framework',
      'full stack', 'end-to-end', 'production', 'deploy', 'infrastructure',
      'multiple', 'several', 'many', 'complex', 'comprehensive',
    ];
    
    const simpleKeywords = [
      'fix', 'debug', 'update', 'change', 'modify', 'add', 'remove',
      'simple', 'quick', 'small', 'single', 'one', 'minor',
    ];
    
    let complexScore = 0;
    let simpleScore = 0;
    
    for (const kw of complexKeywords) {
      if (lowerTask.includes(kw)) complexScore++;
    }
    for (const kw of simpleKeywords) {
      if (lowerTask.includes(kw)) simpleScore++;
    }
    
    // Plan-based complexity
    if (plan) {
      const subtaskCount = plan.subtasks?.length || 0;
      const maxDepth = plan.metadata?.currentDepth || 0;
      complexScore += Math.min(subtaskCount / 3, 5);
      complexScore += maxDepth;
    }
    
    // Context-based
    if (context.fileCount > 50) complexScore += 2;
    if (context.fileCount > 200) complexScore += 3;
    if (context.hasTests) complexScore += 1;
    if (context.hasDatabase) complexScore += 2;
    if (context.hasAuth) complexScore += 1;
    if (context.hasApi) complexScore += 1;
    
    if (complexScore >= 6) return 'complex';
    if (complexScore >= 3) return 'moderate';
    if (simpleScore >= 2 && complexScore === 0) return 'simple';
    return 'moderate';
  }

  /**
   * Estimate iterations based on complexity
   */
  _estimateIterations(complexity, plan) {
    const base = this.baseIterations;
    const subtaskCount = plan?.subtasks?.length || 0;
    
    const multipliers = {
      simple: 0.5,
      moderate: 1.0,
      complex: 2.0,
      unknown: 1.0,
    };
    
    let estimate = base * multipliers[complexity];
    
    // Add per-subtask estimate
    if (subtaskCount > 0) {
      estimate += subtaskCount * 3; // ~3 iterations per subtask
    }
    
    return Math.min(Math.max(estimate, this.minIterations), this.maxIterations);
  }

  /**
   * Calculate initial max iterations
   */
  _calculateInitialMax() {
    // Start with 2x estimate, capped at max
    return Math.min(this.estimatedIterations * 2, this.maxIterations);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Iteration Tracking
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Record an iteration's results
   */
  recordIteration(data = {}) {
    this.currentIteration++;
    const now = Date.now();
    const iterationTime = now - this.lastIterationTime;
    this.lastIterationTime = now;
    
    const progressScore = this._calculateProgressScore(data);
    const progressDelta = progressScore - this.lastProgressScore;
    
    const record = {
      iteration: this.currentIteration,
      timestamp: new Date().toISOString(),
      progressScore,
      progressDelta,
      toolCalls: data.toolCalls || 0,
      toolErrors: data.toolErrors || 0,
      subtaskCompleted: data.subtaskCompleted || false,
      subtaskId: data.subtaskId,
      iterationTimeMs: iterationTime,
      totalElapsedMs: now - this.startTime,
      responseLength: data.responseLength || 0,
      hadToolCalls: (data.toolCalls || 0) > 0,
      stagnationCount: this.stagnationCount,
    };
    
    this.iterationHistory.push(record);
    this.lastProgressScore = progressScore;
    this.totalProgress = progressScore;
    
    if (data.subtaskCompleted) {
      this.subtasksCompleted++;
    }
    
    // Update stagnation counter
    if (progressDelta < this.progressThreshold) {
      this.stagnationCount++;
    } else {
      this.stagnationCount = 0;
    }
    
    // Dynamic max iteration adjustment
    this._adjustMaxIterations(record);
    
    return record;
  }

  /**
   * Calculate progress score (0-1)
   */
  _calculateProgressScore(data) {
    let score = 0;
    
    // Subtask completion progress (weight: 0.5)
    if (this.subtasksTotal > 0) {
      score += (this.subtasksCompleted / this.subtasksTotal) * 0.5;
    }
    
    // Tool call productivity (weight: 0.2)
    if (data.toolCalls > 0) {
      const successRate = 1 - (data.toolErrors || 0) / data.toolCalls;
      score += successRate * 0.2;
    }
    
    // Response quality indicator (weight: 0.1)
    if (data.responseLength > 100) score += 0.05;
    if (data.responseLength > 500) score += 0.05;
    
    // Time-based progress (weight: 0.2) - some progress expected per minute
    const elapsedMin = (Date.now() - this.startTime) / 60000;
    if (elapsedMin > 0) {
      const iterationsPerMin = this.currentIteration / elapsedMin;
      if (iterationsPerMin > 1) score += Math.min(iterationsPerMin / 5, 0.2);
    }
    
    return Math.min(score, 1);
  }

  /**
   * Dynamically adjust max iterations based on progress
   */
  _adjustMaxIterations(record) {
    if (!this.extensionEnabled) return;
    
    // Extend if making good progress but nearing limit
    const remainingIterations = this.currentMaxIterations - this.currentIteration;
    const progressRate = this.totalProgress / Math.max(this.currentIteration, 1);
    
    if (remainingIterations < 10 && progressRate > 0.05 && this.totalProgress > 0.3) {
      // Good progress, extend by 20%
      const extension = Math.ceil(this.currentMaxIterations * 0.2);
      this.currentMaxIterations = Math.min(this.currentMaxIterations + extension, this.maxIterations);
      console.log(`[AdaptiveIterations] Extended max iterations to ${this.currentMaxIterations} (progress rate: ${(progressRate * 100).toFixed(1)}%)`);
    }
    
    // Extend if many subtasks remain
    if (this.subtasksTotal > 0) {
      const remainingSubtasks = this.subtasksTotal - this.subtasksCompleted;
      const estimatedNeeded = remainingSubtasks * 3;
      if (this.currentIteration + estimatedNeeded > this.currentMaxIterations) {
        this.currentMaxIterations = Math.min(this.currentIteration + estimatedNeeded + 10, this.maxIterations);
        console.log(`[AdaptiveIterations] Extended for remaining subtasks: ${this.currentMaxIterations}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Decision Making
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check if should continue iterating
   */
  shouldContinue() {
    // Hard limits
    if (this.currentIteration >= this.maxIterations) {
      return { continue: false, reason: 'hard_max_reached', maxIterations: this.maxIterations };
    }
    
    if (this.currentIteration >= this.currentMaxIterations) {
      return { continue: false, reason: 'dynamic_max_reached', currentMax: this.currentMaxIterations };
    }
    
    // Min iterations not met
    if (this.currentIteration < this.minIterations) {
      return { continue: true, reason: 'min_iterations_not_met', minIterations: this.minIterations };
    }
    
    // Stagnation detection
    if (this.stagnationCount >= this.stagnationLimit) {
      if (this.earlyStopEnabled) {
        return { 
          continue: false, 
          reason: 'stagnation_detected', 
          stagnationCount: this.stagnationCount,
          suggestion: 'Consider strategy change or task decomposition'
        };
      }
    }
    
    // Completion confidence check
    if (this.totalProgress >= this.completionConfidence) {
      // High confidence of completion, but allow a few more for cleanup
      if (this.currentIteration >= this.minIterations + 3) {
        return { 
          continue: false, 
          reason: 'completion_confidence_high', 
          progress: this.totalProgress,
          confidence: this.completionConfidence
        };
      }
    }
    
    // Time budget check (if configured)
    const timeBudgetMs = config.RUN_BUDGET_MS;
    if (timeBudgetMs && Date.now() - this.startTime > timeBudgetMs * 0.9) {
      return { continue: false, reason: 'time_budget_exhausted' };
    }
    
    return { continue: true, reason: 'continuing' };
  }

  /**
   * Get recommendation for next action
   */
  getRecommendation() {
    const progressRate = this.totalProgress / Math.max(this.currentIteration, 1);
    const remainingIterations = this.currentMaxIterations - this.currentIteration;
    
    if (this.stagnationCount >= this.stagnationLimit - 1) {
      return {
        action: 'reflect_and_pivot',
        reason: 'Approaching stagnation limit',
        suggestions: [
          'Review current strategy',
          'Decompose remaining work into smaller subtasks',
          'Try different approach or tools',
          'Check for blockers or errors',
        ],
      };
    }
    
    if (progressRate < 0.02 && this.currentIteration > 10) {
      return {
        action: 'decompose',
        reason: 'Low progress rate',
        suggestions: [
          'Break current task into smaller steps',
          'Create explicit plan with subtasks',
          'Focus on one concrete deliverable',
        ],
      };
    }
    
    if (remainingIterations < 5 && this.totalProgress < 0.5) {
      return {
        action: 'prioritize',
        reason: 'Running low on iterations with low progress',
        suggestions: [
          'Focus on highest-value deliverable',
          'Skip optional work',
          'Document current state for continuation',
        ],
      };
    }
    
    return {
      action: 'continue',
      reason: 'Normal progress',
      progressRate: (progressRate * 100).toFixed(1) + '%',
      remainingIterations,
    };
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      currentIteration: this.currentIteration,
      minIterations: this.minIterations,
      maxIterations: this.maxIterations,
      currentMaxIterations: this.currentMaxIterations,
      estimatedIterations: this.estimatedIterations,
      taskComplexity: this.taskComplexity,
      totalProgress: this.totalProgress,
      progressPercent: (this.totalProgress * 100).toFixed(1) + '%',
      subtasksCompleted: this.subtasksCompleted,
      subtasksTotal: this.subtasksTotal,
      stagnationCount: this.stagnationCount,
      elapsedTimeMs: Date.now() - this.startTime,
      shouldContinue: this.shouldContinue(),
      recommendation: this.getRecommendation(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // History & Analysis
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get iteration history summary
   */
  getHistorySummary(lastN = 10) {
    const recent = this.iterationHistory.slice(-lastN);
    return recent.map(r => ({
      iteration: r.iteration,
      progress: (r.progressScore * 100).toFixed(1) + '%',
      delta: (r.progressDelta * 100).toFixed(1) + '%',
      tools: r.toolCalls,
      errors: r.toolErrors,
      subtask: r.subtaskCompleted ? '✓' : '',
      time: (r.iterationTimeMs / 1000).toFixed(1) + 's',
    }));
  }

  /**
   * Detect patterns in iteration history
   */
  analyzePatterns() {
    if (this.iterationHistory.length < 5) return null;
    
    const recent = this.iterationHistory.slice(-20);
    const patterns = [];
    
    // Tool error pattern
    const errorRate = recent.filter(r => r.toolErrors > 0).length / recent.length;
    if (errorRate > 0.3) {
      patterns.push({ type: 'high_error_rate', rate: (errorRate * 100).toFixed(0) + '%' });
    }
    
    // No-tool-call pattern (just thinking)
    const noToolCalls = recent.filter(r => !r.hadToolCalls).length;
    if (noToolCalls > recent.length * 0.5) {
      patterns.push({ type: 'excessive_thinking', count: noToolCalls });
    }
    
    // Oscillation pattern (progress up/down)
    const deltas = recent.map(r => r.progressDelta);
    let oscillations = 0;
    for (let i = 1; i < deltas.length; i++) {
      if (deltas[i] > 0 && deltas[i-1] < 0) oscillations++;
      if (deltas[i] < 0 && deltas[i-1] > 0) oscillations++;
    }
    if (oscillations > 5) {
      patterns.push({ type: 'progress_oscillation', count: oscillations });
    }
    
    // Long iteration times
    const avgTime = recent.reduce((sum, r) => sum + r.iterationTimeMs, 0) / recent.length;
    if (avgTime > 60000) {
      patterns.push({ type: 'slow_iterations', avgMs: avgTime });
    }
    
    return patterns.length > 0 ? patterns : null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Serialization
  // ─────────────────────────────────────────────────────────────────────────────

  toJSON() {
    return {
      currentIteration: this.currentIteration,
      minIterations: this.minIterations,
      maxIterations: this.maxIterations,
      currentMaxIterations: this.currentMaxIterations,
      estimatedIterations: this.estimatedIterations,
      taskComplexity: this.taskComplexity,
      totalProgress: this.totalProgress,
      subtasksCompleted: this.subtasksCompleted,
      subtasksTotal: this.subtasksTotal,
      stagnationCount: this.stagnationCount,
      startTime: this.startTime,
      lastProgressScore: this.lastProgressScore,
      iterationHistory: this.iterationHistory.slice(-50), // Keep last 50
    };
  }

  static fromJSON(data) {
    const manager = new AdaptiveIterationManager({
      minIterations: data.minIterations,
      maxIterations: data.maxIterations,
      baseIterations: data.baseIterations,
    });
    
    manager.currentIteration = data.currentIteration;
    manager.currentMaxIterations = data.currentMaxIterations;
    manager.estimatedIterations = data.estimatedIterations;
    manager.taskComplexity = data.taskComplexity;
    manager.totalProgress = data.totalProgress;
    manager.subtasksCompleted = data.subtasksCompleted;
    manager.subtasksTotal = data.subtasksTotal;
    manager.stagnationCount = data.stagnationCount;
    manager.startTime = data.startTime;
    manager.lastProgressScore = data.lastProgressScore;
    manager.iterationHistory = data.iterationHistory || [];
    
    return manager;
  }
}

module.exports = { AdaptiveIterationManager };