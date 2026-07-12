// src/long-term-memory.js — Long-term semantic/episodic memory with vector search
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const MEMORY_DIR = path.join(config.SESSION_DIR || process.cwd(), '.seekcode', 'long-term-memory');
const MAX_ENTRIES = config.LTM_MAX_ENTRIES || 10000;
const MAX_EPISODES = config.LTM_MAX_EPISODES || 1000;
const SIMILARITY_THRESHOLD = config.LTM_SIMILARITY_THRESHOLD || 0.7;
const EMBEDDING_DIM = config.LTM_EMBEDDING_DIM || 384; // For future embedding integration

fs.mkdirSync(MEMORY_DIR, { recursive: true });
fs.mkdirSync(path.join(MEMORY_DIR, 'episodes'), { recursive: true });
fs.mkdirSync(path.join(MEMORY_DIR, 'semantic'), { recursive: true });
fs.mkdirSync(path.join(MEMORY_DIR, 'skills'), { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// Simple TF-IDF-like text similarity (placeholder for real embeddings)
// ─────────────────────────────────────────────────────────────────────────────

class SimpleTextIndex {
  constructor() {
    this.documents = new Map(); // id -> { text, tokens, vector, metadata }
    this.vocabulary = new Map(); // token -> { docFreq, idf }
    this.totalDocs = 0;
  }

  _tokenize(text) {
    return text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 2 && t.length < 50)
      .slice(0, 1000);
  }

  _computeTF(tokens) {
    const tf = new Map();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }
    // Normalize
    const maxFreq = Math.max(...tf.values());
    for (const [token, freq] of tf) {
      tf.set(token, freq / maxFreq);
    }
    return tf;
  }

  _updateVocabulary(tokens) {
    const uniqueTokens = new Set(tokens);
    for (const token of uniqueTokens) {
      const entry = this.vocabulary.get(token) || { docFreq: 0 };
      entry.docFreq++;
      this.vocabulary.set(token, entry);
    }
    this.totalDocs++;
    
    // Recompute IDF
    for (const [token, entry] of this.vocabulary) {
      entry.idf = Math.log(this.totalDocs / (entry.docFreq + 1));
    }
  }

  _computeVector(tf) {
    const vector = new Map();
    for (const [token, tfVal] of tf) {
      const vocabEntry = this.vocabulary.get(token);
      if (vocabEntry) {
        vector.set(token, tfVal * vocabEntry.idf);
      }
    }
    return vector;
  }

  _cosineSimilarity(vecA, vecB) {
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    const allTokens = new Set([...vecA.keys(), ...vecB.keys()]);
    for (const token of allTokens) {
      const a = vecA.get(token) || 0;
      const b = vecB.get(token) || 0;
      dotProduct += a * b;
      normA += a * a;
      normB += b * b;
    }
    
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  add(id, text, metadata = {}) {
    const tokens = this._tokenize(text);
    this._updateVocabulary(tokens);
    const tf = this._computeTF(tokens);
    const vector = this._computeVector(tf);
    
    this.documents.set(id, {
      text,
      tokens,
      tf,
      vector,
      metadata: { ...metadata, addedAt: new Date().toISOString() },
    });
    
    return id;
  }

  remove(id) {
    return this.documents.delete(id);
  }

  search(query, topK = 10, threshold = SIMILARITY_THRESHOLD) {
    const queryTokens = this._tokenize(query);
    const queryTF = this._computeTF(queryTokens);
    const queryVector = this._computeVector(queryTF);
    
    const results = [];
    for (const [id, doc] of this.documents) {
      const similarity = this._cosineSimilarity(queryVector, doc.vector);
      if (similarity >= threshold) {
        results.push({ id, similarity, ...doc });
      }
    }
    
    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);
  }

  get(id) {
    return this.documents.get(id);
  }

  size() {
    return this.documents.size;
  }

  // For serialization
  toJSON() {
    return {
      documents: Array.from(this.documents.entries()),
      vocabulary: Array.from(this.vocabulary.entries()),
      totalDocs: this.totalDocs,
    };
  }

  static fromJSON(data) {
    const index = new SimpleTextIndex();
    index.documents = new Map(data.documents || []);
    index.vocabulary = new Map(data.vocabulary || []);
    index.totalDocs = data.totalDocs || 0;
    return index;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// LongTermMemory Class
// ─────────────────────────────────────────────────────────────────────────────

class LongTermMemory {
  constructor(options = {}) {
    this.sessionId = options.sessionId || `ltm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.maxEntries = options.maxEntries || MAX_ENTRIES;
    this.maxEpisodes = options.maxEpisodes || MAX_EPISODES;
    
    // Semantic memory: facts, knowledge, patterns
    this.semanticIndex = new SimpleTextIndex();
    
    // Episodic memory: complete task episodes with outcomes
    this.episodicIndex = new SimpleTextIndex();
    this.episodes = new Map(); // episodeId -> full episode data
    
    // Skill memory: learned procedures and patterns
    this.skillIndex = new SimpleTextIndex();
    this.skills = new Map(); // skillId -> skill data
    
    // Metadata
    this.metadata = {
      sessionId: this.sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      semanticCount: 0,
      episodicCount: 0,
      skillCount: 0,
      totalQueries: 0,
      successfulRecalls: 0,
    };
    
    // Load existing memory
    this._load();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Semantic Memory (Facts, Knowledge, Patterns)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Store a semantic fact/knowledge item
   */
  rememberFact(fact, category = 'general', metadata = {}) {
    const id = `fact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const text = `${category}: ${fact}`;
    
    this.semanticIndex.add(id, text, {
      category,
      fact,
      ...metadata,
      type: 'semantic_fact',
    });
    
    this.metadata.semanticCount++;
    this.metadata.updatedAt = new Date().toISOString();
    
    // Trim if needed
    this._trimSemantic();
    
    return id;
  }

  /**
   * Recall relevant facts for a query
   */
  recallFacts(query, options = {}) {
    const { topK = 10, threshold = SIMILARITY_THRESHOLD, category } = options;
    this.metadata.totalQueries++;
    
    let results = this.semanticIndex.search(query, topK * 2, threshold);
    
    if (category) {
      results = results.filter(r => r.metadata.category === category);
    }
    
    results = results.slice(0, topK);
    
    if (results.length > 0) {
      this.metadata.successfulRecalls++;
    }
    
    return results.map(r => ({
      fact: r.metadata.fact,
      category: r.metadata.category,
      similarity: r.similarity,
      metadata: r.metadata,
    }));
  }

  /**
   * Get all facts in a category
   */
  getFactsByCategory(category) {
    const results = [];
    for (const [id, doc] of this.semanticIndex.documents) {
      if (doc.metadata.category === category) {
        results.push({
          id,
          fact: doc.metadata.fact,
          metadata: doc.metadata,
        });
      }
    }
    return results;
  }

  _trimSemantic() {
    if (this.semanticIndex.size() <= this.maxEntries) return;
    
    // Remove oldest entries (by addedAt)
    const entries = Array.from(this.semanticIndex.documents.entries())
      .sort((a, b) => new Date(a[1].metadata.addedAt) - new Date(b[1].metadata.addedAt));
    
    const toRemove = entries.slice(0, entries.length - this.maxEntries);
    for (const [id] of toRemove) {
      this.semanticIndex.remove(id);
      this.metadata.semanticCount--;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Episodic Memory (Task Episodes with Outcomes)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Start recording an episode
   */
  startEpisode(task, context = {}) {
    const episodeId = `episode_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    
    const episode = {
      id: episodeId,
      task,
      context,
      startTime: new Date().toISOString(),
      endTime: null,
      steps: [],
      outcome: null, // success, failure, partial
      summary: null,
      lessons: [],
      metadata: {
        ...context,
        workingDir: context.workingDir || process.cwd(),
      },
    };
    
    this.episodes.set(episodeId, episode);
    return episodeId;
  }

  /**
   * Add a step to the current episode
   */
  addEpisodeStep(episodeId, step) {
    const episode = this.episodes.get(episodeId);
    if (!episode) return false;
    
    episode.steps.push({
      ...step,
      timestamp: new Date().toISOString(),
      stepNumber: episode.steps.length + 1,
    });
    
    return true;
  }

  /**
   * End an episode with outcome
   */
  endEpisode(episodeId, outcome, summary = '', lessons = []) {
    const episode = this.episodes.get(episodeId);
    if (!episode) return false;
    
    episode.endTime = new Date().toISOString();
    episode.outcome = outcome; // success, failure, partial
    episode.summary = summary;
    episode.lessons = lessons;
    episode.durationMs = new Date(episode.endTime) - new Date(episode.startTime);
    episode.stepCount = episode.steps.length;
    
    // Index for retrieval
    const indexText = `Task: ${episode.task}\nOutcome: ${outcome}\nSummary: ${summary}\nLessons: ${lessons.join('; ')}`;
    this.episodicIndex.add(episodeId, indexText, {
      task: episode.task,
      outcome,
      durationMs: episode.durationMs,
      stepCount: episode.stepCount,
      type: 'episode',
    });
    
    this.metadata.episodicCount++;
    this.metadata.updatedAt = new Date().toISOString();
    
    // Persist episode
    this._persistEpisode(episode);
    
    // Trim if needed
    this._trimEpisodic();
    
    // Extract semantic facts from successful episodes
    if (outcome === 'success' && lessons.length > 0) {
      for (const lesson of lessons) {
        this.rememberFact(lesson, 'lesson_learned', { sourceEpisode: episodeId });
      }
    }
    
    return true;
  }

  /**
   * Recall relevant episodes for a task
   */
  recallEpisodes(query, options = {}) {
    const { topK = 5, threshold = SIMILARITY_THRESHOLD, outcome } = options;
    this.metadata.totalQueries++;
    
    let results = this.episodicIndex.search(query, topK * 2, threshold);
    
    if (outcome) {
      results = results.filter(r => r.metadata.outcome === outcome);
    }
    
    results = results.slice(0, topK);
    
    if (results.length > 0) {
      this.metadata.successfulRecalls++;
    }
    
    return results.map(r => {
      const episode = this.episodes.get(r.id);
      return {
        id: r.id,
        task: r.metadata.task,
        outcome: r.metadata.outcome,
        summary: episode?.summary,
        lessons: episode?.lessons || [],
        durationMs: r.metadata.durationMs,
        stepCount: r.metadata.stepCount,
        similarity: r.similarity,
        startTime: episode?.startTime,
      };
    });
  }

  /**
   * Get episode by ID
   */
  getEpisode(episodeId) {
    return this.episodes.get(episodeId) || null;
  }

  _trimEpisodic() {
    if (this.episodes.size <= this.maxEpisodes) return;
    
    // Remove oldest episodes
    const sorted = Array.from(this.episodes.entries())
      .sort((a, b) => new Date(a[1].startTime) - new Date(b[1].startTime));
    
    const toRemove = sorted.slice(0, sorted.length - this.maxEpisodes);
    for (const [id] of toRemove) {
      this.episodes.delete(id);
      this.episodicIndex.remove(id);
      this.metadata.episodicCount--;
    }
  }

  _persistEpisode(episode) {
    try {
      const filePath = path.join(MEMORY_DIR, 'episodes', `${episode.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(episode, null, 2), 'utf8');
    } catch (err) {
      console.warn('[LTM] Episode persist failed:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Skill Memory (Learned Procedures)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Learn a skill/procedure from successful execution
   */
  learnSkill(name, description, steps, context = {}, metadata = {}) {
    const skillId = `skill_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;
    
    const skill = {
      id: skillId,
      name,
      description,
      steps, // Array of { action, tool, args, expectedResult }
      context,
      metadata: {
        ...metadata,
        createdAt: new Date().toISOString(),
        usageCount: 0,
        successRate: 1.0,
        lastUsed: null,
      },
      type: 'skill',
    };
    
    this.skills.set(skillId, skill);
    
    // Index for retrieval
    const indexText = `Skill: ${name}\nDescription: ${description}\nSteps: ${steps.map(s => s.action).join(' → ')}`;
    this.skillIndex.add(skillId, indexText, {
      name,
      description,
      stepCount: steps.length,
      type: 'skill',
    });
    
    this.metadata.skillCount++;
    this.metadata.updatedAt = new Date().toISOString();
    
    // Persist skill
    this._persistSkill(skill);
    
    return skillId;
  }

  /**
   * Recall relevant skills for a task
   */
  recallSkills(query, options = {}) {
    const { topK = 5, threshold = SIMILARITY_THRESHOLD } = options;
    this.metadata.totalQueries++;
    
    const results = this.skillIndex.search(query, topK, threshold);
    
    if (results.length > 0) {
      this.metadata.successfulRecalls++;
    }
    
    return results.map(r => {
      const skill = this.skills.get(r.id);
      return {
        id: r.id,
        name: r.metadata.name,
        description: r.metadata.description,
        steps: skill?.steps || [],
        stepCount: r.metadata.stepCount,
        successRate: skill?.metadata.successRate || 1.0,
        usageCount: skill?.metadata.usageCount || 0,
        similarity: r.similarity,
      };
    });
  }

  /**
   * Record skill usage outcome
   */
  recordSkillUsage(skillId, success) {
    const skill = this.skills.get(skillId);
    if (!skill) return false;
    
    skill.metadata.usageCount++;
    skill.metadata.lastUsed = new Date().toISOString();
    
    // Update success rate (exponential moving average)
    const alpha = 0.1;
    skill.metadata.successRate = skill.metadata.successRate * (1 - alpha) + (success ? 1 : 0) * alpha;
    
    this._persistSkill(skill);
    return true;
  }

  _persistSkill(skill) {
    try {
      const filePath = path.join(MEMORY_DIR, 'skills', `${skill.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(skill, null, 2), 'utf8');
    } catch (err) {
      console.warn('[LTM] Skill persist failed:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Persistence & Loading
  // ─────────────────────────────────────────────────────────────────────────────

  _load() {
    try {
      // Load metadata
      const metaPath = path.join(MEMORY_DIR, `${this.sessionId}_meta.json`);
      if (fs.existsSync(metaPath)) {
        this.metadata = { ...this.metadata, ...JSON.parse(fs.readFileSync(metaPath, 'utf8')) };
      }

      // Load semantic index
      const semanticPath = path.join(MEMORY_DIR, 'semantic', `${this.sessionId}_index.json`);
      if (fs.existsSync(semanticPath)) {
        const data = JSON.parse(fs.readFileSync(semanticPath, 'utf8'));
        this.semanticIndex = SimpleTextIndex.fromJSON(data);
        this.metadata.semanticCount = this.semanticIndex.size();
      }

      // Load episodic index
      const episodicPath = path.join(MEMORY_DIR, 'episodes', `${this.sessionId}_index.json`);
      if (fs.existsSync(episodicPath)) {
        const data = JSON.parse(fs.readFileSync(episodicPath, 'utf8'));
        this.episodicIndex = SimpleTextIndex.fromJSON(data);
        this.metadata.episodicCount = this.episodicIndex.size();
      }

      // Load skill index
      const skillPath = path.join(MEMORY_DIR, 'skills', `${this.sessionId}_index.json`);
      if (fs.existsSync(skillPath)) {
        const data = JSON.parse(fs.readFileSync(skillPath, 'utf8'));
        this.skillIndex = SimpleTextIndex.fromJSON(data);
        this.metadata.skillCount = this.skillIndex.size();
      }

      // Load episodes (lazy - only load when accessed)
      // Load skills
      const skillsDir = path.join(MEMORY_DIR, 'skills');
      if (fs.existsSync(skillsDir)) {
        for (const file of fs.readdirSync(skillsDir)) {
          if (file.endsWith('.json') && !file.endsWith('_index.json')) {
            try {
              const skill = JSON.parse(fs.readFileSync(path.join(skillsDir, file), 'utf8'));
              this.skills.set(skill.id, skill);
            } catch {}
          }
        }
      }

      console.log(`[LTM] Loaded: ${this.metadata.semanticCount} facts, ${this.metadata.episodicCount} episodes, ${this.metadata.skillCount} skills`);
    } catch (err) {
      console.warn('[LTM] Load failed:', err.message);
    }
  }

  persist() {
    try {
      // Metadata
      const metaPath = path.join(MEMORY_DIR, `${this.sessionId}_meta.json`);
      fs.writeFileSync(metaPath, JSON.stringify(this.metadata, null, 2), 'utf8');

      // Indices
      const semanticPath = path.join(MEMORY_DIR, 'semantic', `${this.sessionId}_index.json`);
      fs.writeFileSync(semanticPath, JSON.stringify(this.semanticIndex.toJSON(), null, 2), 'utf8');

      const episodicPath = path.join(MEMORY_DIR, 'episodes', `${this.sessionId}_index.json`);
      fs.writeFileSync(episodicPath, JSON.stringify(this.episodicIndex.toJSON(), null, 2), 'utf8');

      const skillPath = path.join(MEMORY_DIR, 'skills', `${this.sessionId}_index.json`);
      fs.writeFileSync(skillPath, JSON.stringify(this.skillIndex.toJSON(), null, 2), 'utf8');

      this.metadata.updatedAt = new Date().toISOString();
    } catch (err) {
      console.warn('[LTM] Persist failed:', err.message);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  getStats() {
    return {
      sessionId: this.sessionId,
      semanticFacts: this.metadata.semanticCount,
      episodes: this.metadata.episodicCount,
      skills: this.metadata.skillCount,
      totalQueries: this.metadata.totalQueries,
      successfulRecalls: this.metadata.successfulRecalls,
      recallRate: this.metadata.totalQueries > 0 
        ? (this.metadata.successfulRecalls / this.metadata.totalQueries * 100).toFixed(1) + '%'
        : 'N/A',
    };
  }

  /**
   * Get relevant context for a new task (combines all memory types)
   */
  getRelevantContext(task, options = {}) {
    const { maxFacts = 5, maxEpisodes = 3, maxSkills = 3 } = options;
    
    const facts = this.recallFacts(task, { topK: maxFacts });
    const episodes = this.recallEpisodes(task, { topK: maxEpisodes, outcome: 'success' });
    const skills = this.recallSkills(task, { topK: maxSkills });
    
    let context = '';
    if (facts.length > 0) {
      context += 'RELEVANT FACTS:\n' + facts.map(f => `  - [${f.category}] ${f.fact}`).join('\n') + '\n\n';
    }
    if (episodes.length > 0) {
      context += 'RELEVANT PAST EPISODES:\n' + episodes.map(e => 
        `  - Task: ${e.task}\n    Outcome: ${e.outcome}\n    Lessons: ${e.lessons.join('; ')}`
      ).join('\n\n') + '\n\n';
    }
    if (skills.length > 0) {
      context += 'RELEVANT SKILLS:\n' + skills.map(s => 
        `  - ${s.name}: ${s.description} (${s.steps.length} steps, ${(s.successRate * 100).toFixed(0)}% success)`
      ).join('\n') + '\n\n';
    }
    
    return context.trim();
  }

  clear() {
    this.semanticIndex = new SimpleTextIndex();
    this.episodicIndex = new SimpleTextIndex();
    this.episodes.clear();
    this.skillIndex = new SimpleTextIndex();
    this.skills.clear();
    this.metadata = {
      ...this.metadata,
      semanticCount: 0,
      episodicCount: 0,
      skillCount: 0,
      updatedAt: new Date().toISOString(),
    };
  }
}

module.exports = { LongTermMemory, SimpleTextIndex };