// src/progress-tracker.js — Progress Tracker with Checkpointing and Resume Capability
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

const CHECKPOINT_DIR = path.join(config.SESSION_DIR || process.cwd(), '.seekcode', 'checkpoints');
fs.mkdirSync(CHECKPOINT_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// ProgressTracker Class
// ─────────────────────────────────────────────────────────────────────────────

class ProgressTracker {
  constructor(options = {}) {
    this.sessionId = options.sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.task = options.task || '';
    this.workingDir = options.workingDir || process.cwd();
    this.checkpointInterval = options.checkpointInterval || 5; // Every N iterations
    this.maxCheckpoints = options.maxCheckpoints || 10;
    
    // State
    this.checkpoints = [];
    this.currentCheckpoint = null;
    this.iteration = 0;
    this.startTime = Date.now();
    this.lastCheckpointTime = 0;
    this.totalToolCalls = 0;
    this.totalErrors = 0;
    this.filesModified = new Set();
    this.filesCreated = new Set();
    this.filesDeleted = new Set();
    this.metadata = {
      sessionId: this.sessionId,
      task: this.task,
      workingDir: this.workingDir,
      createdAt: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
      version: 1,
    };
    
    // Load existing checkpoints if any
    this._loadCheckpoints();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Checkpoint Management
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a checkpoint of current state
   */
  async createCheckpoint(agentState = {}) {
    const checkpointId = `checkpoint_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    // Capture workspace state
    const workspaceSignature = await this._captureWorkspaceSignature();
    
    const checkpoint = {
      id: checkpointId,
      iteration: this.iteration,
      timestamp: new Date().toISOString(),
      elapsedMs: Date.now() - this.startTime,
      task: this.task,
      workingDir: this.workingDir,
      workspaceSignature,
      agentState: this._sanitizeAgentState(agentState),
      stats: {
        toolCalls: this.totalToolCalls,
        errors: this.totalErrors,
        filesModified: Array.from(this.filesModified),
        filesCreated: Array.from(this.filesCreated),
        filesDeleted: Array.from(this.filesDeleted),
      },
      metadata: { ...this.metadata, lastUpdated: new Date().toISOString() },
    };
    
    this.checkpoints.push(checkpoint);
    this.currentCheckpoint = checkpoint;
    this.lastCheckpointTime = Date.now();
    
    // Persist
    await this._persistCheckpoint(checkpoint);
    
    // Cleanup old checkpoints
    this._cleanupOldCheckpoints();
    
    console.log(`[ProgressTracker] Checkpoint created: ${checkpointId} (iteration ${this.iteration})`);
    
    return checkpoint;
  }

  /**
   * Capture workspace signature for change detection
   */
  async _captureWorkspaceSignature() {
    try {
      const crypto = require('crypto');
      const files = [];
      const skip = new Set(['.git', 'node_modules', '.seekcode', 'dist', 'build', '.next', 'coverage']);
      
      const walk = (dir) => {
        if (!fs.existsSync(dir)) return;
        const items = fs.readdirSync(dir, { withFileTypes: true });
        for (const item of items) {
          if (skip.has(item.name)) continue;
          const abs = path.join(dir, item.name);
          if (item.isDirectory()) {
            walk(abs);
          } else {
            try {
              const stat = fs.statSync(abs);
              if (stat.size > 10 * 1024 * 1024) {
                files.push(`${path.relative(this.workingDir, abs)}:size:${stat.size}`);
              } else {
                const hash = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex');
                files.push(`${path.relative(this.workingDir, abs)}:sha1:${hash}`);
              }
            } catch {}
          }
        }
      };
      
      walk(this.workingDir);
      files.sort();
      return crypto.createHash('sha1').update(files.join('\n')).digest('hex');
    } catch (err) {
      console.warn('[ProgressTracker] Workspace signature failed:', err.message);
      return null;
    }
  }

  /**
   * Sanitize agent state for checkpoint
   */
  _sanitizeAgentState(agentState) {
    if (!agentState) return {};
    
    const sanitized = {};
    const allowedKeys = [
      'conversation',
      'currentPlan',
      'currentSubtask',
      'workingMemory',
      'longTermMemory',
      'reflections',
      'browserState',
    ];
    
    for (const key of allowedKeys) {
      if (agentState[key] !== undefined) {
        try {
          // Deep clone with size limit
          const serialized = JSON.stringify(agentState[key]);
          if (serialized.length < 50000) { // 50KB limit per state section
            sanitized[key] = JSON.parse(serialized);
          } else {
            sanitized[key] = `[Large state truncated: ${serialized.length} chars]`;
          }
        } catch {
          sanitized[key] = '[Non-serializable]';
        }
      }
    }
    
    return sanitized;
  }

  /**
   * Persist checkpoint to disk
   */
  async _persistCheckpoint(checkpoint) {
    try {
      const filePath = path.join(CHECKPOINT_DIR, `${this.sessionId}_${checkpoint.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2), 'utf8');
      
      // Also update index
      this._updateIndex();
    } catch (err) {
      console.warn('[ProgressTracker] Persist failed:', err.message);
    }
  }

  /**
   * Update checkpoint index
   */
  _updateIndex() {
    try {
      const indexPath = path.join(CHECKPOINT_DIR, `${this.sessionId}_index.json`);
      const index = {
        sessionId: this.sessionId,
        task: this.task,
        checkpoints: this.checkpoints.map(cp => ({
          id: cp.id,
          iteration: cp.iteration,
          timestamp: cp.timestamp,
          elapsedMs: cp.elapsedMs,
        })),
        latest: this.currentCheckpoint?.id,
        updatedAt: new Date().toISOString(),
      };
      fs.writeFileSync(indexPath, JSON.stringify(index, null, 2), 'utf8');
    } catch (err) {
      console.warn('[ProgressTracker] Index update failed:', err.message);
    }
  }

  /**
   * Load existing checkpoints
   */
  _loadCheckpoints() {
    try {
      const indexPath = path.join(CHECKPOINT_DIR, `${this.sessionId}_index.json`);
      if (!fs.existsSync(indexPath)) return;
      
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      this.checkpoints = [];
      
      for (const cpInfo of index.checkpoints) {
        const filePath = path.join(CHECKPOINT_DIR, `${this.sessionId}_${cpInfo.id}.json`);
        if (fs.existsSync(filePath)) {
          const checkpoint = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          this.checkpoints.push(checkpoint);
        }
      }
      
      this.checkpoints.sort((a, b) => a.iteration - b.iteration);
      this.currentCheckpoint = this.checkpoints[this.checkpoints.length - 1] || null;
      
      if (this.currentCheckpoint) {
        this.iteration = this.currentCheckpoint.iteration;
        console.log(`[ProgressTracker] Loaded ${this.checkpoints.length} checkpoints, latest at iteration ${this.iteration}`);
      }
    } catch (err) {
      console.warn('[ProgressTracker] Load failed:', err.message);
    }
  }

  /**
   * Clean up old checkpoints beyond max
   */
  _cleanupOldCheckpoints() {
    if (this.checkpoints.length <= this.maxCheckpoints) return;
    
    const toRemove = this.checkpoints.slice(0, this.checkpoints.length - this.maxCheckpoints);
    for (const cp of toRemove) {
      try {
        const filePath = path.join(CHECKPOINT_DIR, `${this.sessionId}_${cp.id}.json`);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch {}
    }
    
    this.checkpoints = this.checkpoints.slice(-this.maxCheckpoints);
    this._updateIndex();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Progress Tracking
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Record an iteration
   */
  recordIteration(agentState = {}) {
    this.iteration++;
    this.metadata.lastUpdated = new Date().toISOString();
    
    // Auto-checkpoint
    if (this.iteration % this.checkpointInterval === 0) {
      this.createCheckpoint(agentState);
    }
  }

  /**
   * Record tool call
   */
  recordToolCall(toolName, success, durationMs = 0) {
    this.totalToolCalls++;
    if (!success) this.totalErrors++;
    this.metadata.lastUpdated = new Date().toISOString();
  }

  /**
   * Record file modification
   */
  recordFileChange(filePath, changeType) {
    const relPath = path.relative(this.workingDir, filePath);
    switch (changeType) {
      case 'create':
        this.filesCreated.add(relPath);
        this.filesModified.add(relPath);
        break;
      case 'modify':
        this.filesModified.add(relPath);
        break;
      case 'delete':
        this.filesDeleted.add(relPath);
        this.filesModified.delete(relPath);
        this.filesCreated.delete(relPath);
        break;
    }
    this.metadata.lastUpdated = new Date().toISOString();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Resume Capability
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get resume data for continuing from a checkpoint
   */
  getResumeData(checkpointId = null) {
    const checkpoint = checkpointId 
      ? this.checkpoints.find(cp => cp.id === checkpointId)
      : this.currentCheckpoint;
    
    if (!checkpoint) return null;
    
    return {
      checkpoint,
      canResume: true,
      resumeInstructions: this._generateResumeInstructions(checkpoint),
    };
  }

  /**
   * Generate instructions for resuming from checkpoint
   */
  _generateResumeInstructions(checkpoint) {
    const instructions = [];
    
    instructions.push(`RESUME FROM CHECKPOINT: ${checkpoint.id}`);
    instructions.push(`Original task: ${checkpoint.task}`);
    instructions.push(`Iteration: ${checkpoint.iteration}`);
    instructions.push(`Elapsed time: ${Math.round(checkpoint.elapsedMs / 60000)} minutes`);
    instructions.push('');
    
    if (checkpoint.agentState.currentPlan) {
      const plan = checkpoint.agentState.currentPlan;
      instructions.push(`ACTIVE PLAN: ${plan.task}`);
      instructions.push(`Progress: ${plan.metadata?.completedSubtasks || 0}/${plan.metadata?.totalSubtasks || 0} subtasks`);
      
      const pending = plan.subtasks?.filter(st => st.status === 'pending') || [];
      const inProgress = plan.subtasks?.filter(st => st.status === 'in_progress') || [];
      
      if (inProgress.length > 0) {
        instructions.push(`\nIN PROGRESS:`);
        for (const st of inProgress) {
          instructions.push(`  - ${st.description} (${st.id})`);
        }
      }
      
      if (pending.length > 0) {
        instructions.push(`\nREADY TO START:`);
        for (const st of pending.slice(0, 5)) {
          instructions.push(`  - ${st.description} (${st.id})`);
        }
      }
    }
    
    if (checkpoint.stats.filesModified.length > 0) {
      instructions.push(`\nFILES MODIFIED THIS SESSION:`);
      for (const f of checkpoint.stats.filesModified.slice(0, 10)) {
        instructions.push(`  - ${f}`);
      }
    }
    
    instructions.push(`\nCONTINUE FROM HERE. Do not redo completed work.`);
    
    return instructions.join('\n');
  }

  /**
   * Verify workspace integrity against checkpoint
   */
  async verifyWorkspace(checkpointId = null) {
    const checkpoint = checkpointId 
      ? this.checkpoints.find(cp => cp.id === checkpointId)
      : this.currentCheckpoint;
    
    if (!checkpoint || !checkpoint.workspaceSignature) {
      return { verified: false, reason: 'No workspace signature in checkpoint' };
    }
    
    const currentSignature = await this._captureWorkspaceSignature();
    
    if (currentSignature === checkpoint.workspaceSignature) {
      return { verified: true, message: 'Workspace matches checkpoint' };
    }
    
    // Find differences
    return { 
      verified: false, 
      reason: 'Workspace has changed since checkpoint',
      expected: checkpoint.workspaceSignature,
      actual: currentSignature,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Status & Reporting
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Get progress summary
   */
  getProgress() {
    const elapsed = Date.now() - this.startTime;
    return {
      sessionId: this.sessionId,
      task: this.task,
      iteration: this.iteration,
      elapsedMs: elapsed,
      elapsedFormatted: this._formatDuration(elapsed),
      checkpoints: this.checkpoints.length,
      latestCheckpoint: this.currentCheckpoint?.id,
      stats: {
        toolCalls: this.totalToolCalls,
        errors: this.totalErrors,
        filesModified: this.filesModified.size,
        filesCreated: this.filesCreated.size,
        filesDeleted: this.filesDeleted.size,
      },
      velocity: this.iteration > 0 ? (this.iteration / (elapsed / 60000)).toFixed(2) : 0,
    };
  }

  /**
   * Get all checkpoints
   */
  getCheckpoints() {
    return this.checkpoints.map(cp => ({
      id: cp.id,
      iteration: cp.iteration,
      timestamp: cp.timestamp,
      elapsedMs: cp.elapsedMs,
      stats: cp.stats,
    }));
  }

  /**
   * Export progress report
   */
  exportReport() {
    const progress = this.getProgress();
    const checkpoints = this.getCheckpoints();
    
    let report = `PROGRESS REPORT\n`;
    report += `================\n\n`;
    report += `Session: ${progress.sessionId}\n`;
    report += `Task: ${progress.task}\n`;
    report += `Iteration: ${progress.iteration}\n`;
    report += `Elapsed: ${progress.elapsedFormatted}\n`;
    report += `Velocity: ${progress.velocity} iterations/min\n\n`;
    report += `Statistics:\n`;
    report += `  Tool calls: ${progress.stats.toolCalls}\n`;
    report += `  Errors: ${progress.stats.errors}\n`;
    report += `  Files modified: ${progress.stats.filesModified}\n`;
    report += `  Files created: ${progress.stats.filesCreated}\n`;
    report += `  Files deleted: ${progress.stats.filesDeleted}\n\n`;
    
    report += `Checkpoints (${checkpoints.length}):\n`;
    for (const cp of checkpoints) {
      report += `  ${cp.id} - Iteration ${cp.iteration} - ${new Date(cp.timestamp).toLocaleTimeString()} (${Math.round(cp.elapsedMs / 60000)}min)\n`;
    }
    
    if (this.currentCheckpoint) {
      report += `\n${this._generateResumeInstructions(this.currentCheckpoint)}`;
    }
    
    return report;
  }

  _formatDuration(ms) {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    
    if (hours > 0) return `${hours}h ${mins}m ${seconds}s`;
    return `${mins}m ${seconds}s`;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Persistence
  // ─────────────────────────────────────────────────────────────────────────────

  persist() {
    try {
      const filePath = path.join(CHECKPOINT_DIR, `${this.sessionId}_progress.json`);
      const data = {
        metadata: this.metadata,
        iteration: this.iteration,
        startTime: this.startTime,
        totalToolCalls: this.totalToolCalls,
        totalErrors: this.totalErrors,
        filesModified: Array.from(this.filesModified),
        filesCreated: Array.from(this.filesCreated),
        filesDeleted: Array.from(this.filesDeleted),
        checkpoints: this.checkpoints.map(cp => ({
          id: cp.id,
          iteration: cp.iteration,
          timestamp: cp.timestamp,
          elapsedMs: cp.elapsedMs,
          stats: cp.stats,
        })),
        currentCheckpointId: this.currentCheckpoint?.id,
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[ProgressTracker] Persist failed:', err.message);
    }
  }

  static load(sessionId) {
    try {
      const filePath = path.join(CHECKPOINT_DIR, `${sessionId}_progress.json`);
      if (!fs.existsSync(filePath)) return null;
      
      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const tracker = new ProgressTracker({ sessionId: data.metadata.sessionId, task: data.metadata.task });
      tracker.iteration = data.iteration;
      tracker.startTime = data.startTime;
      tracker.totalToolCalls = data.totalToolCalls;
      tracker.totalErrors = data.totalErrors;
      tracker.filesModified = new Set(data.filesModified);
      tracker.filesCreated = new Set(data.filesCreated);
      tracker.filesDeleted = new Set(data.filesDeleted);
      tracker.checkpoints = data.checkpoints;
      tracker.currentCheckpoint = data.currentCheckpointId 
        ? tracker.checkpoints.find(cp => cp.id === data.currentCheckpointId) || null
        : null;
      
      return tracker;
    } catch (err) {
      console.warn('[ProgressTracker] Load failed:', err.message);
      return null;
    }
  }

  static listSessions() {
    try {
      return fs.readdirSync(CHECKPOINT_DIR)
        .filter(f => f.endsWith('_index.json'))
        .map(f => {
          const index = JSON.parse(fs.readFileSync(path.join(CHECKPOINT_DIR, f), 'utf8'));
          return {
            sessionId: index.sessionId,
            task: index.task,
            checkpointCount: index.checkpoints.length,
            latestCheckpoint: index.latest,
            updatedAt: index.updatedAt,
          };
        })
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } catch {
      return [];
    }
  }
}

module.exports = { ProgressTracker };