'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * TaskPlanner - Decomposes complex tasks into manageable subtasks with dependencies
 * and tracks progress through the execution plan.
 */
class TaskPlanner {
  constructor(options = {}) {
    this.maxSubtasks = options.maxSubtasks || config.MAX_SUBTASKS || 20;
    this.maxDepth = options.maxDepth || config.MAX_PLAN_DEPTH || 3;
    this.plansDir = options.plansDir || path.join(config.SESSION_DIR, 'plans');
    this.currentPlan = null;
    this.planHistory = [];
    
    if (!fs.existsSync(this.plansDir)) {
      fs.mkdirSync(this.plansDir, { recursive: true });
    }
  }

  /**
   * Decompose a complex task into a hierarchical plan with subtasks
   * @param {string} task - The main task description
   * @param {Object} context - Current context (working dir, files, etc.)
   * @returns {Object} Plan object with subtasks and dependencies
   */
  async decomposeTask(task, context = {}) {
    const planId = `plan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    const plan = {
      id: planId,
      task,
      context: this._summarizeContext(context),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'planning',
      subtasks: [],
      dependencies: new Map(),
      metadata: {
        totalSubtasks: 0,
        completedSubtasks: 0,
        failedSubtasks: 0,
        currentDepth: 0,
      }
    };

    // Decompose using heuristic rules + LLM-assisted decomposition if available
    const subtasks = await this._decomposeHeuristically(task, context);
    
    plan.subtasks = subtasks.map((st, idx) => ({
      id: `subtask_${idx}_${Math.random().toString(36).slice(2, 8)}`,
      description: st.description,
      type: st.type || 'code', // code, research, test, debug, refactor, document
      priority: st.priority || 'medium', // high, medium, low
      dependencies: st.dependencies || [], // array of subtask IDs
      status: 'pending', // pending, in_progress, completed, failed, blocked
      assignedAgent: null, // for subagent delegation
      result: null,
      error: null,
      startedAt: null,
      completedAt: null,
      attempts: 0,
      maxAttempts: st.maxAttempts || 3,
      metadata: st.metadata || {},
    }));

    // Build dependency graph
    this._buildDependencyGraph(plan);

    plan.status = 'ready';
    plan.metadata.totalSubtasks = plan.subtasks.length;
    plan.metadata.currentDepth = this._calculateMaxDepth(plan);

    this.currentPlan = plan;
    this._savePlan(plan);
    
    return plan;
  }

  /**
   * Heuristic task decomposition based on task patterns
   */
  async _decomposeHeuristically(task, context) {
    const subtasks = [];
    const lowerTask = task.toLowerCase();

    // Pattern: Build/Create/Implement a feature/system
    if (/(build|create|implement|develop|make|construct)/i.test(task)) {
      subtasks.push(
        { description: 'Analyze requirements and design architecture', type: 'research', priority: 'high' },
        { description: 'Set up project structure and dependencies', type: 'code', priority: 'high' },
        { description: 'Implement core functionality', type: 'code', priority: 'high', dependencies: ['subtask_0', 'subtask_1'] },
        { description: 'Write tests for core functionality', type: 'test', priority: 'medium', dependencies: ['subtask_2'] },
        { description: 'Integration testing and debugging', type: 'test', priority: 'high', dependencies: ['subtask_3'] },
        { description: 'Documentation and cleanup', type: 'document', priority: 'low', dependencies: ['subtask_4'] }
      );
    }
    // Pattern: Debug/Fix issue
    else if (/(debug|fix|solve|resolve|troubleshoot)/i.test(task)) {
      subtasks.push(
        { description: 'Reproduce and understand the issue', type: 'debug', priority: 'high' },
        { description: 'Analyze root cause (logs, stack traces, code)', type: 'debug', priority: 'high', dependencies: ['subtask_0'] },
        { description: 'Implement fix', type: 'code', priority: 'high', dependencies: ['subtask_1'] },
        { description: 'Test fix and verify no regressions', type: 'test', priority: 'high', dependencies: ['subtask_2'] },
        { description: 'Document fix and update tests', type: 'document', priority: 'medium', dependencies: ['subtask_3'] }
      );
    }
    // Pattern: Refactor/Improve/Optimize
    else if (/(refactor|optimize|improve|cleanup|modernize)/i.test(task)) {
      subtasks.push(
        { description: 'Analyze current codebase and identify issues', type: 'research', priority: 'high' },
        { description: 'Design improved architecture/approach', type: 'research', priority: 'high', dependencies: ['subtask_0'] },
        { description: 'Implement refactored code', type: 'code', priority: 'high', dependencies: ['subtask_1'] },
        { description: 'Run tests and verify behavior preserved', type: 'test', priority: 'high', dependencies: ['subtask_2'] },
        { description: 'Performance benchmarking', type: 'test', priority: 'medium', dependencies: ['subtask_3'] }
      );
    }
    // Pattern: Research/Analyze/Investigate
    else if (/(research|analyze|investigate|explore|study|understand)/i.test(task)) {
      subtasks.push(
        { description: 'Define research questions and scope', type: 'research', priority: 'high' },
        { description: 'Gather information from codebase/docs/web', type: 'research', priority: 'high', dependencies: ['subtask_0'] },
        { description: 'Synthesize findings and identify patterns', type: 'research', priority: 'medium', dependencies: ['subtask_1'] },
        { description: 'Document findings and recommendations', type: 'document', priority: 'medium', dependencies: ['subtask_2'] }
      );
    }
    // Pattern: Test/Validate/Verify
    else if (/(test|validate|verify|check|audit)/i.test(task)) {
      subtasks.push(
        { description: 'Design test strategy and identify test cases', type: 'test', priority: 'high' },
        { description: 'Implement test suite', type: 'code', priority: 'high', dependencies: ['subtask_0'] },
        { description: 'Execute tests and collect results', type: 'test', priority: 'high', dependencies: ['subtask_1'] },
        { description: 'Analyze results and report findings', type: 'research', priority: 'medium', dependencies: ['subtask_2'] }
      );
    }
    // Default: Generic decomposition
    else {
      subtasks.push(
        { description: `Analyze and understand: ${task}`, type: 'research', priority: 'high' },
        { description: `Plan approach for: ${task}`, type: 'research', priority: 'high', dependencies: ['subtask_0'] },
        { description: `Execute: ${task}`, type: 'code', priority: 'high', dependencies: ['subtask_1'] },
        { description: `Verify and test: ${task}`, type: 'test', priority: 'high', dependencies: ['subtask_2'] },
        { description: `Document: ${task}`, type: 'document', priority: 'medium', dependencies: ['subtask_3'] }
      );
    }

    // Limit subtasks
    return subtasks.slice(0, this.maxSubtasks);
  }

  /**
   * Build dependency graph and validate for cycles
   */
  _buildDependencyGraph(plan) {
    const graph = new Map();
    const subtaskMap = new Map(plan.subtasks.map(st => [st.id, st]));

    for (const subtask of plan.subtasks) {
      graph.set(subtask.id, new Set(subtask.dependencies));
    }

    // Validate no cycles
    if (this._hasCycle(graph)) {
      // Remove all dependencies if cycle detected
      for (const subtask of plan.subtasks) {
        subtask.dependencies = [];
      }
      console.warn('Cycle detected in plan dependencies, flattened to sequential');
    }

    plan.dependencies = graph;
  }

  _hasCycle(graph) {
    const visited = new Set();
    const recStack = new Set();

    const dfs = (node) => {
      visited.add(node);
      recStack.add(node);

      for (const neighbor of graph.get(node) || []) {
        if (!visited.has(neighbor)) {
          if (dfs(neighbor)) return true;
        } else if (recStack.has(neighbor)) {
          return true;
        }
      }

      recStack.delete(node);
      return false;
    };

    for (const node of graph.keys()) {
      if (!visited.has(node)) {
        if (dfs(node)) return true;
      }
    }
    return false;
  }

  _calculateMaxDepth(plan) {
    const depthMap = new Map();
    
    const computeDepth = (subtaskId) => {
      if (depthMap.has(subtaskId)) return depthMap.get(subtaskId);
      
      const subtask = plan.subtasks.find(st => st.id === subtaskId);
      if (!subtask || subtask.dependencies.length === 0) {
        depthMap.set(subtaskId, 0);
        return 0;
      }

      const maxDepDepth = Math.max(...subtask.dependencies.map(dep => computeDepth(dep)));
      const depth = maxDepDepth + 1;
      depthMap.set(subtaskId, depth);
      return depth;
    };

    return Math.max(...plan.subtasks.map(st => computeDepth(st.id)), 0);
  }

  /**
   * Get next executable subtasks (dependencies satisfied)
   */
  getReadySubtasks(plan = this.currentPlan) {
    if (!plan) return [];
    
    const completed = new Set(plan.subtasks.filter(st => st.status === 'completed').map(st => st.id));
    
    return plan.subtasks.filter(st => {
      if (st.status !== 'pending') return false;
      return st.dependencies.every(depId => completed.has(depId));
    });
  }

  /**
   * Start a subtask
   */
  startSubtask(subtaskId, agentId = null, plan = this.currentPlan) {
    if (!plan) return null;
    
    const subtask = plan.subtasks.find(st => st.id === subtaskId);
    if (!subtask) return null;
    
    if (subtask.status !== 'pending') return null;
    
    const readyTasks = this.getReadySubtasks(plan);
    if (!readyTasks.some(st => st.id === subtaskId)) {
      subtask.status = 'blocked';
      return { success: false, reason: 'Dependencies not satisfied', blockedBy: subtask.dependencies };
    }

    subtask.status = 'in_progress';
    subtask.startedAt = new Date().toISOString();
    subtask.assignedAgent = agentId;
    subtask.attempts++;
    plan.updatedAt = new Date().toISOString();
    
    this._savePlan(plan);
    return { success: true, subtask };
  }

  /**
   * Complete a subtask
   */
  completeSubtask(subtaskId, result, plan = this.currentPlan) {
    if (!plan) return false;
    
    const subtask = plan.subtasks.find(st => st.id === subtaskId);
    if (!subtask) return false;
    
    subtask.status = 'completed';
    subtask.result = result;
    subtask.completedAt = new Date().toISOString();
    plan.metadata.completedSubtasks++;
    plan.updatedAt = new Date().toISOString();
    
    this._savePlan(plan);
    return true;
  }

  /**
   * Fail a subtask
   */
  failSubtask(subtaskId, error, plan = this.currentPlan) {
    if (!plan) return false;
    
    const subtask = plan.subtasks.find(st => st.id === subtaskId);
    if (!subtask) return false;
    
    subtask.status = 'failed';
    subtask.error = error;
    subtask.completedAt = new Date().toISOString();
    plan.metadata.failedSubtasks++;
    plan.updatedAt = new Date().toISOString();
    
    // Check if we should retry
    if (subtask.attempts < subtask.maxAttempts) {
      subtask.status = 'pending';
      subtask.error = null;
    }
    
    this._savePlan(plan);
    return true;
  }

  /**
   * Get plan progress summary
   */
  getProgress(plan = this.currentPlan) {
    if (!plan) return null;
    
    const total = plan.subtasks.length;
    const completed = plan.subtasks.filter(st => st.status === 'completed').length;
    const inProgress = plan.subtasks.filter(st => st.status === 'in_progress').length;
    const failed = plan.subtasks.filter(st => st.status === 'failed').length;
    const blocked = plan.subtasks.filter(st => st.status === 'blocked').length;
    const pending = plan.subtasks.filter(st => st.status === 'pending').length;
    
    return {
      planId: plan.id,
      total,
      completed,
      inProgress,
      failed,
      blocked,
      pending,
      percentComplete: total > 0 ? Math.round((completed / total) * 100) : 0,
      status: plan.status,
      currentPhase: this._getCurrentPhase(plan),
    };
  }

  _getCurrentPhase(plan) {
    const inProgress = plan.subtasks.filter(st => st.status === 'in_progress');
    if (inProgress.length > 0) {
      return inProgress.map(st => st.description).join('; ');
    }
    const ready = this.getReadySubtasks(plan);
    if (ready.length > 0) {
      return `Ready: ${ready.map(st => st.description).join('; ')}`;
    }
    return 'All tasks complete or blocked';
  }

  /**
   * Save plan to disk
   */
  _savePlan(plan) {
    try {
      const filePath = path.join(this.plansDir, `${plan.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(plan, null, 2), 'utf8');
    } catch (err) {
      console.warn('Failed to save plan:', err.message);
    }
  }

  /**
   * Load plan from disk
   */
  loadPlan(planId) {
    try {
      const filePath = path.join(this.plansDir, `${planId}.json`);
      if (!fs.existsSync(filePath)) return null;
      
      const plan = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      this.currentPlan = plan;
      return plan;
    } catch (err) {
      console.warn('Failed to load plan:', err.message);
      return null;
    }
  }

  /**
   * List all saved plans
   */
  listPlans() {
    try {
      return fs.readdirSync(this.plansDir)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          const plan = JSON.parse(fs.readFileSync(path.join(this.plansDir, f), 'utf8'));
          return {
            id: plan.id,
            task: plan.task,
            status: plan.status,
            progress: this.getProgress(plan),
            createdAt: plan.createdAt,
            updatedAt: plan.updatedAt,
          };
        })
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } catch {
      return [];
    }
  }

  /**
   * Generate a human-readable plan summary for the prompt
   */
  formatPlanForPrompt(plan = this.currentPlan) {
    if (!plan) return 'No active plan';
    
    const progress = this.getProgress(plan);
    let output = `CURRENT PLAN: ${plan.task}\n`;
    output += `Progress: ${progress.percentComplete}% (${progress.completed}/${progress.total} subtasks)\n\n`;
    
    for (const subtask of plan.subtasks) {
      const statusIcon = {
        pending: '⏳',
        in_progress: '🔄',
        completed: '✅',
        failed: '❌',
        blocked: '🔒',
      }[subtask.status] || '?';
      
      const deps = subtask.dependencies.length > 0 
        ? ` (depends on: ${subtask.dependencies.join(', ')})` 
        : '';
      
      output += `${statusIcon} [${subtask.priority.toUpperCase()}] ${subtask.description}${deps}\n`;
      
      if (subtask.status === 'completed' && subtask.result) {
        output += `    Result: ${String(subtask.result).slice(0, 100)}...\n`;
      } else if (subtask.status === 'failed' && subtask.error) {
        output += `    Error: ${subtask.error}\n`;
      }
    }
    
    return output;
  }

  _summarizeContext(context) {
    return {
      workingDir: context.workingDir,
      filesCount: context.filesCount,
      recentFiles: context.recentFiles?.slice(0, 5),
      hasActivePlan: !!this.currentPlan,
    };
  }
}

module.exports = { TaskPlanner };