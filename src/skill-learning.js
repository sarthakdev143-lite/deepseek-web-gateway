// src/skill-learning.js — Skill Learning from Successes and Failures
'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');

const SKILLS_DIR = path.join(config.SESSION_DIR || process.cwd(), '.seekcode', 'skills');
fs.mkdirSync(SKILLS_DIR, { recursive: true });
fs.mkdirSync(path.join(SKILLS_DIR, 'patterns'), { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// SkillLearning Class
// ─────────────────────────────────────────────────────────────────────────────

class SkillLearning {
  constructor(options = {}) {
    this.sessionId = options.sessionId || `skill_${Date.now()}`;
    this.skills = new Map(); // skillId -> Skill
    this.patterns = new Map(); // patternId -> Pattern
    this.taskTemplates = new Map(); // templateId -> Template
    
    // Configuration
    this.minSuccessRate = options.minSuccessRate || config.SKILL_MIN_SUCCESS_RATE || 0.7;
    this.minUsageCount = options.minUsageCount || config.SKILL_MIN_USAGE || 3;
    this.similarityThreshold = options.similarityThreshold || config.SKILL_SIMILARITY_THRESHOLD || 0.6;
    
    // Statistics
    this.stats = {
      skillsLearned: 0,
      skillsApplied: 0,
      patternsExtracted: 0,
      successfulApplications: 0,
      failedApplications: 0,
    };
    
    // Load existing skills
    this._loadSkills();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Skill Extraction from Episodes
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Extract skills from a completed episode (task execution)
   */
  extractSkillsFromEpisode(episode) {
    if (!episode || episode.outcome !== 'success') return [];
    
    const skills = [];
    
    // Group steps by tool sequences
    const toolSequences = this._extractToolSequences(episode.steps);
    
    for (const sequence of toolSequences) {
      if (sequence.length < 2) continue; // Need at least 2 steps for a skill
      
      const skill = this._createSkillFromSequence(sequence, episode);
      if (skill) {
        skills.push(skill);
      }
    }
    
    // Also extract patterns from successful outcomes
    const outcomePatterns = this._extractOutcomePatterns(episode);
    for (const pattern of outcomePatterns) {
      this._addPattern(pattern);
    }
    
    return skills;
  }

  /**
   * Extract tool call sequences from episode steps
   */
  _extractToolSequences(steps) {
    const sequences = [];
    let currentSequence = [];
    
    for (const step of steps) {
      if (step.type === 'tool_call' || step.toolName) {
        currentSequence.push({
          tool: step.toolName,
          args: step.args,
          result: step.result,
          success: !step.isError,
          timestamp: step.timestamp,
        });
      } else if (currentSequence.length > 0) {
        // Non-tool step breaks the sequence
        if (currentSequence.length >= 2) {
          sequences.push(currentSequence);
        }
        currentSequence = [];
      }
    }
    
    if (currentSequence.length >= 2) {
      sequences.push(currentSequence);
    }
    
    return sequences;
  }

  /**
   * Create a skill from a tool sequence
   */
  _createSkillFromSequence(sequence, episode) {
    // Generalize the sequence
    const generalizedSteps = sequence.map(s => ({
      tool: s.tool,
      argsPattern: this._generalizeArgs(s.args),
      expectedOutcome: s.success ? 'success' : 'error',
    }));
    
    // Create skill signature
    const signature = this._generateSignature(generalizedSteps);
    
    // Check if similar skill exists
    const existingSkill = this._findSimilarSkill(signature);
    if (existingSkill) {
      // Update existing skill
      existingSkill.usageCount++;
      existingSkill.successCount++;
      existingSkill.lastUsed = new Date().toISOString();
      existingSkill.episodes.push(episode.id);
      this._persistSkill(existingSkill);
      return existingSkill;
    }
    
    // Create new skill
    const skill = {
      id: `skill_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: this._generateSkillName(generalizedSteps, episode.task),
      description: this._generateSkillDescription(generalizedSteps, episode.task),
      steps: generalizedSteps,
      signature,
      taskType: this._classifyTaskType(episode.task),
      usageCount: 1,
      successCount: 1,
      successRate: 1.0,
      createdAt: new Date().toISOString(),
      lastUsed: new Date().toISOString(),
      episodes: [episode.id],
      context: {
        workingDir: episode.context?.workingDir,
        fileTypes: this._extractFileTypes(episode),
        toolsUsed: [...new Set(sequence.map(s => s.tool))],
      },
      applicability: this._calculateApplicability(generalizedSteps),
    };
    
    this.skills.set(skill.id, skill);
    this._persistSkill(skill);
    this.stats.skillsLearned++;
    
    console.log(`[SkillLearning] Learned new skill: ${skill.name} (${skill.steps.length} steps)`);
    
    return skill;
  }

  /**
   * Generalize arguments to patterns
   */
  _generalizeArgs(args) {
    if (!args || typeof args !== 'object') return args;
    
    const generalized = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string') {
        // Replace specific paths with placeholders
        if (value.includes('/') || value.includes('\\')) {
          generalized[key] = '<path>';
        } else if (value.match(/^[a-zA-Z_][a-zA-Z0-9_]*$/)) {
          generalized[key] = '<identifier>';
        } else if (value.length > 50) {
          generalized[key] = '<long_string>';
        } else {
          generalized[key] = value;
        }
      } else if (typeof value === 'number') {
        generalized[key] = '<number>';
      } else if (typeof value === 'boolean') {
        generalized[key] = '<boolean>';
      } else {
        generalized[key] = value;
      }
    }
    return generalized;
  }

  /**
   * Generate a unique signature for a skill
   */
  _generateSignature(steps) {
    return steps.map(s => `${s.tool}:${JSON.stringify(s.argsPattern)}`).join('→');
  }

  /**
   * Find similar existing skill
   */
  _findSimilarSkill(signature) {
    for (const skill of this.skills.values()) {
      const similarity = this._calculateSimilarity(signature, skill.signature);
      if (similarity >= this.similarityThreshold) {
        return skill;
      }
    }
    return null;
  }

  /**
   * Calculate similarity between two signatures
   */
  _calculateSimilarity(sig1, sig2) {
    const steps1 = sig1.split('→');
    const steps2 = sig2.split('→');
    
    if (steps1.length !== steps2.length) return 0;
    
    let matches = 0;
    for (let i = 0; i < steps1.length; i++) {
      if (steps1[i] === steps2[i]) matches++;
    }
    
    return matches / steps1.length;
  }

  /**
   * Generate a human-readable skill name
   */
  _generateSkillName(steps, task) {
    const toolNames = steps.map(s => s.tool).join('_');
    const taskWords = task.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3)
      .slice(0, 3)
      .join('_');
    
    return `${taskWords || 'generic'}_${toolNames}`.slice(0, 60);
  }

  /**
   * Generate skill description
   */
  _generateSkillDescription(steps, task) {
    const toolFlow = steps.map(s => s.tool).join(' → ');
    return `Automated workflow for "${task.slice(0, 80)}": ${toolFlow}`;
  }

  /**
   * Classify task type
   */
  _classifyTaskType(task) {
    const lower = task.toLowerCase();
    if (lower.includes('test')) return 'testing';
    if (lower.includes('debug') || lower.includes('fix')) return 'debugging';
    if (lower.includes('refactor')) return 'refactoring';
    if (lower.includes('create') || lower.includes('build') || lower.includes('implement')) return 'development';
    if (lower.includes('search') || lower.includes('find') || lower.includes('analyze')) return 'analysis';
    return 'general';
  }

  /**
   * Extract file types from episode
   */
  _extractFileTypes(episode) {
    const types = new Set();
    for (const step of episode.steps || []) {
      if (step.args?.path) {
        const ext = path.extname(step.args.path);
        if (ext) types.add(ext);
      }
    }
    return Array.from(types);
  }

  /**
   * Calculate applicability score for different contexts
   */
  _calculateApplicability(steps) {
    const tools = steps.map(s => s.tool);
    return {
      hasRead: tools.includes('read_file'),
      hasWrite: tools.includes('write_file') || tools.includes('replace_in_file'),
      hasCommand: tools.includes('run_command'),
      hasSearch: tools.includes('search_files') || tools.includes('search_in_file'),
      toolCount: tools.length,
      uniqueTools: [...new Set(tools)].length,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pattern Extraction
  // ─────────────────────────────────────────────────────────────────────────────

  _extractOutcomePatterns(episode) {
    const patterns = [];
    
    // Success pattern: what led to success?
    const successSteps = episode.steps?.filter(s => s.type === 'tool_call' && !s.isError) || [];
    if (successSteps.length > 0) {
      patterns.push({
        type: 'success_sequence',
        taskType: this._classifyTaskType(episode.task),
        steps: successSteps.map(s => ({ tool: s.toolName, args: this._generalizeArgs(s.args) })),
        outcome: 'success',
        episodeId: episode.id,
      });
    }
    
    // Error recovery pattern: what fixed an error?
    const errorSteps = episode.steps?.filter(s => s.type === 'tool_call' && s.isError) || [];
    const recoverySteps = episode.steps?.filter((s, i) => {
      return i > 0 && episode.steps[i-1]?.isError && s.type === 'tool_call' && !s.isError;
    }) || [];
    
    if (errorSteps.length > 0 && recoverySteps.length > 0) {
      patterns.push({
        type: 'error_recovery',
        errorTools: errorSteps.map(s => s.toolName),
        recoveryTools: recoverySteps.map(s => s.toolName),
        episodeId: episode.id,
      });
    }
    
    return patterns;
  }

  _addPattern(pattern) {
    const id = `pattern_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.patterns.set(id, { ...pattern, id, createdAt: new Date().toISOString() });
    this.stats.patternsExtracted++;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Skill Application
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Find applicable skills for a task
   */
  findApplicableSkills(task, context = {}) {
    const taskType = this._classifyTaskType(task);
    const applicable = [];
    
    for (const skill of this.skills.values()) {
      // Check task type match
      if (skill.taskType !== taskType && skill.taskType !== 'general' && taskType !== 'general') {
        continue;
      }
      
      // Check minimum usage and success rate
      if (skill.usageCount < this.minUsageCount) continue;
      if (skill.successRate < this.minSuccessRate) continue;
      
      // Check context compatibility
      const compatibility = this._checkContextCompatibility(skill, context);
      if (compatibility < 0.3) continue;
      
      applicable.push({
        skill,
        compatibility,
        relevance: this._calculateRelevance(skill, task),
      });
    }
    
    // Sort by relevance and compatibility
    return applicable
      .sort((a, b) => (b.relevance * b.compatibility) - (a.relevance * a.compatibility))
      .slice(0, 5);
  }

  _checkContextCompatibility(skill, context) {
    let score = 0;
    let factors = 0;
    
    // File type compatibility
    if (context.fileTypes && skill.context.fileTypes) {
      const overlap = context.fileTypes.filter(t => skill.context.fileTypes.includes(t)).length;
      const total = new Set([...context.fileTypes, ...skill.context.fileTypes]).size;
      if (total > 0) {
        score += overlap / total;
        factors++;
      }
    }
    
    // Tool availability
    if (context.availableTools && skill.context.toolsUsed) {
      const available = skill.context.toolsUsed.filter(t => context.availableTools.includes(t)).length;
      if (skill.context.toolsUsed.length > 0) {
        score += available / skill.context.toolsUsed.length;
        factors++;
      }
    }
    
    // Working directory similarity
    if (context.workingDir && skill.context.workingDir) {
      const rel = path.relative(skill.context.workingDir, context.workingDir);
      if (!rel.startsWith('..') && rel.length < 50) {
        score += 0.5;
        factors++;
      }
    }
    
    return factors > 0 ? score / factors : 0.5;
  }

  _calculateRelevance(skill, task) {
    // Simple keyword matching for relevance
    const taskWords = task.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    const skillWords = skill.name.toLowerCase().split(/[_/\s]+/).filter(w => w.length > 3);
    
    let matches = 0;
    for (const tw of taskWords) {
      for (const sw of skillWords) {
        if (tw.includes(sw) || sw.includes(tw)) {
          matches++;
          break;
        }
      }
    }
    
    return taskWords.length > 0 ? matches / taskWords.length : 0;
  }

  /**
   * Apply a skill to generate a plan
   */
  applySkill(skillId, task, context = {}) {
    const skill = this.skills.get(skillId);
    if (!skill) return null;
    
    // Update stats
    this.stats.skillsApplied++;
    skill.usageCount++;
    skill.lastUsed = new Date().toISOString();
    this._persistSkill(skill);
    
    // Generate plan from skill steps
    const plan = {
      skillId,
      skillName: skill.name,
      task,
      steps: skill.steps.map((s, i) => ({
        stepNumber: i + 1,
        tool: s.tool,
        argsTemplate: s.argsPattern,
        description: `Execute ${s.tool} with ${JSON.stringify(s.argsPattern)}`,
        expectedOutcome: s.expectedOutcome,
      })),
      estimatedDuration: skill.steps.length * 30000, // 30s per step estimate
    };
    
    return plan;
  }

  /**
   * Record skill application outcome
   */
  recordSkillOutcome(skillId, success) {
    const skill = this.skills.get(skillId);
    if (!skill) return;
    
    if (success) {
      skill.successCount++;
      this.stats.successfulApplications++;
    } else {
      this.stats.failedApplications++;
    }
    
    skill.successRate = skill.successCount / skill.usageCount;
    this._persistSkill(skill);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Task Templates
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Create a task template from a successful episode
   */
  createTaskTemplate(episode) {
    if (!episode || episode.outcome !== 'success') return null;
    
    const template = {
      id: `template_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name: this._generateTemplateName(episode.task),
      taskPattern: this._generalizeTask(episode.task),
      originalTask: episode.task,
      steps: episode.steps
        .filter(s => s.type === 'tool_call')
        .map(s => ({
          tool: s.toolName,
          argsPattern: this._generalizeArgs(s.args),
          description: s.description || `Run ${s.toolName}`,
        })),
      estimatedDuration: episode.durationMs,
      successRate: 1.0,
      usageCount: 1,
      createdAt: new Date().toISOString(),
      tags: this._extractTags(episode),
    };
    
    this.taskTemplates.set(template.id, template);
    this._persistTemplate(template);
    
    return template;
  }

  _generalizeTask(task) {
    // Replace specific identifiers with placeholders
    return task
      .replace(/[a-zA-Z_][a-zA-Z0-9_]*\.(js|ts|py|java|cpp|go|rs)/g, '<filename>')
      .replace(/[a-zA-Z_][a-zA-Z0-9_]*\(/g, '<function>()')
      .replace(/\b\d+\b/g, '<number>')
      .replace(/['"`][^'"`]{5,}['"`]/g, '<string>');
  }

  _generateTemplateName(task) {
    return task.slice(0, 50).replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '_');
  }

  _extractTags(episode) {
    const tags = new Set();
    tags.add(this._classifyTaskType(episode.task));
    
    for (const step of episode.steps || []) {
      if (step.toolName) tags.add(step.toolName);
    }
    
    return Array.from(tags);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Persistence
  // ─────────────────────────────────────────────────────────────────────────────

  _persistSkill(skill) {
    try {
      const filePath = path.join(SKILLS_DIR, `${skill.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8');
      
      // Update index
      this._updateIndex();
    } catch (err) {
      console.warn('[SkillLearning] Persist skill failed:', err.message);
    }
  }

  _persistTemplate(template) {
    try {
      const filePath = path.join(SKILLS_DIR, 'templates', `${template.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(template, null, 2), 'utf8');
    } catch (err) {
      console.warn('[SkillLearning] Persist template failed:', err.message);
    }
  }

  _updateIndex() {
    try {
      const index = {
        sessionId: this.sessionId,
        updatedAt: new Date().toISOString(),
        skills: Array.from(this.skills.values()).map(s => ({
          id: s.id,
          name: s.name,
          taskType: s.taskType,
          usageCount: s.usageCount,
          successRate: s.successRate,
        })),
        patterns: Array.from(this.patterns.values()).map(p => ({
          id: p.id,
          type: p.type,
          taskType: p.taskType,
        })),
        templates: Array.from(this.taskTemplates.values()).map(t => ({
          id: t.id,
          name: t.name,
          usageCount: t.usageCount,
        })),
      };
      
      fs.writeFileSync(
        path.join(SKILLS_DIR, 'index.json'),
        JSON.stringify(index, null, 2),
        'utf8'
      );
    } catch (err) {
      console.warn('[SkillLearning] Index update failed:', err.message);
    }
  }

  _loadSkills() {
    try {
      const indexPath = path.join(SKILLS_DIR, 'index.json');
      if (!fs.existsSync(indexPath)) return;
      
      const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
      
      // Load skills
      for (const skillInfo of index.skills || []) {
        const skillPath = path.join(SKILLS_DIR, `${skillInfo.id}.json`);
        if (fs.existsSync(skillPath)) {
          const skill = JSON.parse(fs.readFileSync(skillPath, 'utf8'));
          this.skills.set(skill.id, skill);
        }
      }
      
      // Load patterns
      for (const patternInfo of index.patterns || []) {
        const patternPath = path.join(SKILLS_DIR, 'patterns', `${patternInfo.id}.json`);
        if (fs.existsSync(patternPath)) {
          const pattern = JSON.parse(fs.readFileSync(patternPath, 'utf8'));
          this.patterns.set(pattern.id, pattern);
        }
      }
      
      // Load templates
      const templatesDir = path.join(SKILLS_DIR, 'templates');
      if (fs.existsSync(templatesDir)) {
        for (const file of fs.readdirSync(templatesDir)) {
          if (file.endsWith('.json')) {
            const template = JSON.parse(fs.readFileSync(path.join(templatesDir, file), 'utf8'));
            this.taskTemplates.set(template.id, template);
          }
        }
      }
      
      console.log(`[SkillLearning] Loaded ${this.skills.size} skills, ${this.patterns.size} patterns, ${this.taskTemplates.size} templates`);
    } catch (err) {
      console.warn('[SkillLearning] Load failed:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Statistics & Export
  // ─────────────────────────────────────────────────────────────────────────────

  getStats() {
    return {
      ...this.stats,
      totalSkills: this.skills.size,
      totalPatterns: this.patterns.size,
      totalTemplates: this.taskTemplates.size,
      avgSuccessRate: this.skills.size > 0
        ? (Array.from(this.skills.values()).reduce((sum, s) => sum + s.successRate, 0) / this.skills.size).toFixed(2)
        : 0,
      topSkills: Array.from(this.skills.values())
        .filter(s => s.usageCount >= this.minUsageCount)
        .sort((a, b) => b.successRate * b.usageCount - a.successRate * a.usageCount)
        .slice(0, 10)
        .map(s => ({
          id: s.id,
          name: s.name,
          usageCount: s.usageCount,
          successRate: (s.successRate * 100).toFixed(1) + '%',
          taskType: s.taskType,
        })),
    };
  }

  getSkillsByType(taskType) {
    return Array.from(this.skills.values())
      .filter(s => s.taskType === taskType || s.taskType === 'general')
      .sort((a, b) => b.successRate * b.usageCount - a.successRate * a.usageCount);
  }

  exportSkills() {
    return {
      sessionId: this.sessionId,
      exportedAt: new Date().toISOString(),
      skills: Array.from(this.skills.values()),
      patterns: Array.from(this.patterns.values()),
      templates: Array.from(this.taskTemplates.values()),
    };
  }
}

module.exports = { SkillLearning };