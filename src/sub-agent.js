// src/sub-agent.js — SubAgent Delegation System for Parallel Subtask Execution
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const config = require('./config');

const SUBAGENT_DIR = path.join(config.SESSION_DIR || process.cwd(), '.seekcode', 'subagents');
fs.mkdirSync(SUBAGENT_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// SubAgent Class - Represents a delegated sub-agent
// ─────────────────────────────────────────────────────────────────────────────

class SubAgent {
  constructor(options = {}) {
    this.id = options.id || `subagent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.task = options.task;
    this.subtask = options.subtask; // Reference to parent plan subtask
    this.workingDir = options.workingDir || process.cwd();
    this.parentAgent = options.parentAgent; // Reference to parent agent for context
    this.config = options.config || {};
    
    // State
    this.status = 'initializing'; // initializing, running, completed, failed, terminated
    this.process = null;
    this.startTime = null;
    this.endTime = null;
    this.result = null;
    this.error = null;
    this.logs = [];
    this.outputFile = path.join(SUBAGENT_DIR, `${this.id}_output.json`);
    this.logFile = path.join(SUBAGENT_DIR, `${this.id}_log.txt`);
    
    // Communication
    this.messageQueue = [];
    this.responseHandlers = new Map();
  }

  /**
   * Start the sub-agent as a separate process
   */
  async start() {
    this.status = 'running';
    this.startTime = Date.now();
    
    // Write task to file for subprocess
    const taskFile = path.join(SUBAGENT_DIR, `${this.id}_task.json`);
    fs.writeFileSync(taskFile, JSON.stringify({
      task: this.task,
      subtask: this.subtask,
      workingDir: this.workingDir,
      config: this.config,
      parentSessionId: this.parentAgent?.sessionId,
    }), 'utf8');
    
    // Spawn sub-agent process
    return new Promise((resolve, reject) => {
      // Use the same Node.js executable and entry point
      const entryPoint = path.resolve(__dirname, '..', 'src', 'subagent-worker.js');
      
      this.process = spawn(process.execPath, [entryPoint, taskFile], {
        cwd: this.workingDir,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { 
          ...process.env, 
          SUBAGENT_ID: this.id,
          PARENT_SESSION: this.parentAgent?.sessionId || '',
        },
      });
      
      // Handle stdout/stderr
      this.process.stdout.on('data', (data) => {
        const line = data.toString().trim();
        this.logs.push({ timestamp: new Date().toISOString(), type: 'stdout', data: line });
        this._appendLog(`[STDOUT] ${line}`);
      });
      
      this.process.stderr.on('data', (data) => {
        const line = data.toString().trim();
        this.logs.push({ timestamp: new Date().toISOString(), type: 'stderr', data: line });
        this._appendLog(`[STDERR] ${line}`);
      });
      
      // Handle IPC messages from sub-agent
      this.process.on('message', (msg) => this._handleMessage(msg));
      
      // Handle completion
      this.process.on('exit', (code, signal) => {
        this.endTime = Date.now();
        if (code === 0 && this.status !== 'terminated') {
          this.status = 'completed';
          this._loadResult();
          resolve(this.result);
        } else if (this.status === 'terminated') {
          this.status = 'terminated';
          resolve({ terminated: true });
        } else {
          this.status = 'failed';
          this.error = `Process exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`;
          this._loadResult();
          reject(new Error(this.error));
        }
      });
      
      this.process.on('error', (err) => {
        this.status = 'failed';
        this.error = err.message;
        reject(err);
      });
      
      // Timeout handling
      const timeout = this.config.timeout || 10 * 60 * 1000; // 10 min default
      setTimeout(() => {
        if (this.status === 'running') {
          this.terminate('timeout');
          reject(new Error('Sub-agent timeout'));
        }
      }, timeout);
    });
  }

  /**
   * Send a message to the sub-agent
   */
  sendMessage(type, payload) {
    if (this.process && this.process.connected) {
      this.process.send({ type, payload, from: 'parent', timestamp: new Date().toISOString() });
    } else {
      this.messageQueue.push({ type, payload, timestamp: new Date().toISOString() });
    }
  }

  /**
   * Request status from sub-agent
   */
  requestStatus() {
    return new Promise((resolve) => {
      const requestId = `status_${Date.now()}`;
      this.responseHandlers.set(requestId, resolve);
      this.sendMessage('status_request', { requestId });
      
      // Timeout
      setTimeout(() => {
        if (this.responseHandlers.has(requestId)) {
          this.responseHandlers.delete(requestId);
          resolve({ timeout: true });
        }
      }, 5000);
    });
  }

  /**
   * Terminate the sub-agent
   */
  terminate(reason = 'parent_request') {
    if (this.process && !this.process.killed) {
      this.status = 'terminated';
      this.sendMessage('terminate', { reason });
      this.process.kill('SIGTERM');
      
      // Force kill after 5 seconds
      setTimeout(() => {
        if (this.process && !this.process.killed) {
          this.process.kill('SIGKILL');
        }
      }, 5000);
    }
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      id: this.id,
      task: this.task,
      subtask: this.subtask?.id,
      status: this.status,
      startTime: this.startTime,
      endTime: this.endTime,
      durationMs: this.endTime ? this.endTime - this.startTime : (this.startTime ? Date.now() - this.startTime : 0),
      error: this.error,
      result: this.result,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────────

  _handleMessage(msg) {
    switch (msg.type) {
      case 'status_response':
        if (this.responseHandlers.has(msg.requestId)) {
          this.responseHandlers.get(msg.requestId)(msg.payload);
          this.responseHandlers.delete(msg.requestId);
        }
        break;
        
      case 'progress':
        this.logs.push({ timestamp: new Date().toISOString(), type: 'progress', data: msg.payload });
        this._appendLog(`[PROGRESS] ${msg.payload}`);
        break;
        
      case 'result':
        this.result = msg.payload;
        break;
        
      case 'error':
        this.error = msg.payload;
        break;
        
      case 'log':
        this.logs.push({ timestamp: new Date().toISOString(), type: 'log', data: msg.payload });
        this._appendLog(`[LOG] ${msg.payload}`);
        break;
    }
  }

  _loadResult() {
    try {
      if (fs.existsSync(this.outputFile)) {
        this.result = JSON.parse(fs.readFileSync(this.outputFile, 'utf8'));
      }
    } catch (err) {
      console.warn(`[SubAgent ${this.id}] Failed to load result:`, err.message);
    }
  }

  _appendLog(line) {
    try {
      fs.appendFileSync(this.logFile, line + '\n', 'utf8');
    } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SubAgentManager - Manages a pool of sub-agents
// ─────────────────────────────────────────────────────────────────────────────

class SubAgentManager {
  constructor(options = {}) {
    this.parentAgent = options.parentAgent;
    this.maxConcurrent = options.maxConcurrent || config.MAX_SUBAGENTS || 3;
    this.defaultTimeout = options.defaultTimeout || 10 * 60 * 1000;
    
    this.activeAgents = new Map(); // id -> SubAgent
    this.completedAgents = new Map(); // id -> SubAgent (completed)
    this.pendingTasks = []; // Queue of tasks waiting for slot
    this.totalSpawned = 0;
    this.totalCompleted = 0;
    this.totalFailed = 0;
  }

  /**
   * Delegate a subtask to a sub-agent
   */
  async delegate(subtask, taskContext = {}) {
    // Wait for available slot
    await this._waitForSlot();
    
    const subAgent = new SubAgent({
      id: `subagent_${subtask.id}_${Date.now()}`,
      task: subtask.description,
      subtask,
      workingDir: taskContext.workingDir || this.parentAgent?.config?.WORKING_DIR || process.cwd(),
      parentAgent: this.parentAgent,
      config: {
        timeout: subtask.metadata?.timeout || this.defaultTimeout,
        readOnly: taskContext.readOnly,
        model: taskContext.model,
      },
    });
    
    this.activeAgents.set(subAgent.id, subAgent);
    this.totalSpawned++;
    
    // Start the sub-agent
    const promise = subAgent.start().then((result) => {
      this._onSubAgentComplete(subAgent, result);
      return result;
    }).catch((error) => {
      this._onSubAgentFailed(subAgent, error);
      throw error;
    });
    
    // Attach promise to subAgent for await
    subAgent.promise = promise;
    
    return subAgent;
  }

  /**
   * Delegate multiple subtasks in parallel (up to maxConcurrent)
   */
  async delegateParallel(subtasks, taskContext = {}) {
    const results = [];
    
    // Start all delegations (they'll queue internally)
    const promises = subtasks.map(subtask => this.delegate(subtask, taskContext));
    
    // Wait for all to complete
    const settled = await Promise.allSettled(promises);
    
    for (let i = 0; i < settled.length; i++) {
      const subtask = subtasks[i];
      const result = settled[i];
      
      if (result.status === 'fulfilled') {
        results.push({ subtask, result: result.value, status: 'completed' });
      } else {
        results.push({ subtask, error: result.reason, status: 'failed' });
      }
    }
    
    return results;
  }

  /**
   * Get status of all sub-agents
   */
  getStatus() {
    const active = Array.from(this.activeAgents.values()).map(a => a.getStatus());
    const completed = Array.from(this.completedAgents.values()).map(a => a.getStatus());
    
    return {
      active: active.length,
      queued: this.pendingTasks.length,
      maxConcurrent: this.maxConcurrent,
      totalSpawned: this.totalSpawned,
      totalCompleted: this.totalCompleted,
      totalFailed: this.totalFailed,
      agents: [...active, ...completed],
    };
  }

  /**
   * Terminate all active sub-agents
   */
  async terminateAll(reason = 'parent_shutdown') {
    const promises = Array.from(this.activeAgents.values()).map(agent => {
      agent.terminate(reason);
      return agent.promise.catch(() => {});
    });
    
    await Promise.allSettled(promises);
  }

  /**
   * Get logs for a specific sub-agent
   */
  getLogs(subAgentId) {
    const agent = this.activeAgents.get(subAgentId) || this.completedAgents.get(subAgentId);
    return agent?.logs || [];
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Private Methods
  // ─────────────────────────────────────────────────────────────────────────────

  async _waitForSlot() {
    while (this.activeAgents.size >= this.maxConcurrent) {
      // Wait for any agent to complete
      await this._waitForAnyCompletion();
    }
  }

  _waitForAnyCompletion() {
    return new Promise((resolve) => {
      const check = () => {
        if (this.activeAgents.size < this.maxConcurrent) {
          resolve();
        } else {
          setTimeout(check, 1000);
        }
      };
      check();
    });
  }

  _onSubAgentComplete(agent, result) {
    this.activeAgents.delete(agent.id);
    this.completedAgents.set(agent.id, agent);
    this.totalCompleted++;
    this._processQueue();
  }

  _onSubAgentFailed(agent, error) {
    this.activeAgents.delete(agent.id);
    this.completedAgents.set(agent.id, agent);
    this.totalFailed++;
    this._processQueue();
  }

  _processQueue() {
    while (this.pendingTasks.length > 0 && this.activeAgents.size < this.maxConcurrent) {
      const { subtask, context, resolve, reject } = this.pendingTasks.shift();
      this.delegate(subtask, context).then(resolve).catch(reject);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SubAgent Worker (runs in separate process)
// ─────────────────────────────────────────────────────────────────────────────

// This will be written to a separate file: subagent-worker.js

module.exports = { SubAgent, SubAgentManager };