// src/working-memory.js — Working Memory for context management and summarization
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const MEMORY_DIR = path.join(config.SESSION_DIR || process.cwd(), '.seekcode', 'working-memory');
const MAX_CONTEXT_TOKENS = config.MAX_CONTEXT_TOKENS || 100000;
const SUMMARY_TRIGGER_RATIO = config.SUMMARY_TRIGGER_RATIO || 0.7; // Summarize when 70% full
const MAX_SUMMARY_LENGTH = config.MAX_SUMMARY_LENGTH || 2000;
const MAX_RAW_MESSAGES = config.MAX_RAW_MESSAGES || 50; // Keep last N raw messages
const COMPRESSION_RATIO_TARGET = 0.3; // Target 30% of original size

fs.mkdirSync(MEMORY_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// WorkingMemory Class
// ─────────────────────────────────────────────────────────────────────────────

class WorkingMemory {
  constructor(options = {}) {
    this.sessionId = options.sessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.maxTokens = options.maxTokens || MAX_CONTEXT_TOKENS;
    this.summaryTriggerRatio = options.summaryTriggerRatio || SUMMARY_TRIGGER_RATIO;
    this.maxSummaryLength = options.maxSummaryLength || MAX_SUMMARY_LENGTH;
    this.maxRawMessages = options.maxRawMessages || MAX_RAW_MESSAGES;
    
    // Memory stores
    this.rawMessages = []; // Recent messages in full detail
    this.summarizedBlocks = []; // Older messages compressed into summaries
    this.keyFacts = new Map(); // Extracted key facts (file paths, decisions, errors, etc.)
    this.currentFocus = null; // Current task focus
    this.metadata = {
      sessionId: this.sessionId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      totalMessages: 0,
      totalTokensEstimate: 0,
      compressionCount: 0,
    };
    
    // Token estimation (rough: 1 token ≈ 4 chars)
    this.charPerToken = 4;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Core Memory Operations
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Add a message to working memory
   */
  addMessage(role, content, metadata = {}) {
    const message = {
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      timestamp: new Date().toISOString(),
      tokenEstimate: this._estimateTokens(content),
      metadata: {
        ...metadata,
        type: metadata.type || (role === 'assistant' && content.includes('tool_call') ? 'tool_call' : 'conversation'),
      },
    };

    this.rawMessages.push(message);
    this.metadata.totalMessages++;
    this.metadata.totalTokensEstimate += message.tokenEstimate;
    this.metadata.updatedAt = new Date().toISOString();

    // Extract key facts from the message
    this._extractKeyFacts(message);

    // Check if we need to compress
    if (this._shouldCompress()) {
      this._compressOldestMessages();
    }

    // Persist periodically
    if (this.metadata.totalMessages % 10 === 0) {
      this.persist();
    }

    return message.id;
  }

  /**
   * Add a tool result with special handling
   */
  addToolResult(toolName, args, result, isError = false, durationMs = 0) {
    const content = `[TOOL ${isError ? 'ERROR' : 'SUCCESS'}] ${toolName}\n${typeof result === 'string' ? result : JSON.stringify(result, null, 2)}`;
    
    return this.addMessage('tool_result', content, {
      type: 'tool_result',
      toolName,
      args,
      isError,
      durationMs,
      resultSummary: this._summarizeToolResult(toolName, result, isError),
    });
  }

  /**
   * Add a planning entry
   */
  addPlanEntry(planId, planSummary, subtasks) {
    return this.addMessage('system', `PLAN CREATED: ${planSummary}`, {
      type: 'plan',
      planId,
      subtasks: subtasks.map(st => ({ id: st.id, description: st.description, status: st.status })),
    });
  }

  /**
   * Add a reflection entry
   */
  addReflection(reflectionText, type = 'progress') {
    return this.addMessage('system', `REFLECTION (${type}): ${reflectionText}`, {
      type: 'reflection',
      reflectionType: type, // progress, error, strategy_change, completion
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Context Building for Prompts
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Build context string for inclusion in prompts
   */
  buildContext(options = {}) {
    const {
      includeRaw = true,
      includeSummaries = true,
      includeKeyFacts = true,
      maxTokens = this.maxTokens,
      focus = this.currentFocus,
    } = options;

    const parts = [];
    let tokenCount = 0;

    // 1. Key facts (always include, high priority)
    if (includeKeyFacts && this.keyFacts.size > 0) {
      const factsSection = this._formatKeyFacts(focus);
      const factsTokens = this._estimateTokens(factsSection);
      if (tokenCount + factsTokens <= maxTokens * 0.2) { // Max 20% for facts
        parts.push(factsSection);
        tokenCount += factsTokens;
      }
    }

    // 2. Summarized blocks (older context)
    if (includeSummaries && this.summarizedBlocks.length > 0) {
      for (const block of this.summarizedBlocks) {
        const blockText = this._formatSummarizedBlock(block);
        const blockTokens = this._estimateTokens(blockText);
        if (tokenCount + blockTokens <= maxTokens * 0.5) { // Max 50% for summaries
          parts.push(blockText);
          tokenCount += blockTokens;
        } else {
          break;
        }
      }
    }

    // 3. Raw messages (recent context)
    if (includeRaw && this.rawMessages.length > 0) {
      const recentMessages = this.rawMessages.slice(-this.maxRawMessages);
      for (const msg of recentMessages) {
        const msgText = this._formatMessage(msg);
        const msgTokens = this._estimateTokens(msgText);
        if (tokenCount + msgTokens <= maxTokens * 0.8) { // Max 80% for raw
          parts.unshift(msgText); // Add to end (most recent last)
          tokenCount += msgTokens;
        } else {
          break;
        }
      }
    }

    // 4. Current focus
    if (focus) {
      parts.push(`\nCURRENT FOCUS: ${focus}\n`);
    }

    const context = parts.join('\n---\n');
    return {
      text: context,
      tokenEstimate: tokenCount,
      rawMessageCount: this.rawMessages.length,
      summaryBlockCount: this.summarizedBlocks.length,
      keyFactCount: this.keyFacts.size,
    };
  }

  /**
   * Build a compact context for quick reference
   */
  buildCompactContext(maxTokens = 5000) {
    return this.buildContext({
      maxTokens,
      includeRaw: true,
      includeSummaries: false,
      includeKeyFacts: true,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Summarization & Compression
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Check if compression is needed
   */
  _shouldCompress() {
    return (
      this.rawMessages.length > this.maxRawMessages &&
      this.metadata.totalTokensEstimate > this.maxTokens * this.summaryTriggerRatio
    );
  }

  /**
   * Compress oldest messages into a summary block
   */
  async _compressOldestMessages() {
    if (this.rawMessages.length <= this.maxRawMessages) return;

    // Determine how many messages to compress
    const messagesToCompress = this.rawMessages.slice(0, this.rawMessages.length - this.maxRawMessages);
    const remainingMessages = this.rawMessages.slice(this.rawMessages.length - this.maxRawMessages);

    // Generate summary
    const summary = await this._generateSummary(messagesToCompress);

    // Create summary block
    const block = {
      id: `summary_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      messageCount: messagesToCompress.length,
      timeRange: {
        start: messagesToCompress[0].timestamp,
        end: messagesToCompress[messagesToCompress.length - 1].timestamp,
      },
      summary,
      tokenEstimate: this._estimateTokens(summary),
      originalTokenEstimate: messagesToCompress.reduce((sum, m) => sum + m.tokenEstimate, 0),
      keyFacts: this._extractBlockKeyFacts(messagesToCompress),
    };

    this.summarizedBlocks.push(block);
    this.rawMessages = remainingMessages;
    this.metadata.compressionCount++;
    this.metadata.totalTokensEstimate = this._recalculateTokenEstimate();

    console.log(`[WorkingMemory] Compressed ${messagesToCompress.length} messages into summary (${block.tokenEstimate} tokens, ${Math.round(block.tokenEstimate / block.originalTokenEstimate * 100)}% of original)`);
  }

  /**
   * Generate a summary of messages using heuristic extraction
   * (In production, this would call an LLM for better summarization)
   */
  async _generateSummary(messages) {
    // Heuristic summary generation
    const byRole = this._groupByRole(messages);
    const toolCalls = messages.filter(m => m.metadata.type === 'tool_result');
    const plans = messages.filter(m => m.metadata.type === 'plan');
    const reflections = messages.filter(m => m.metadata.type === 'reflection');

    let summary = `CONVERSATION SUMMARY (${messages.length} messages, ${messages[0].timestamp} to ${messages[messages.length - 1].timestamp}):\n\n`;

    if (plans.length > 0) {
      summary += `Plans created: ${plans.length}\n`;
      for (const plan of plans.slice(-2)) {
        summary += `  - ${plan.content.slice(0, 200)}\n`;
      }
      summary += '\n';
    }

    if (toolCalls.length > 0) {
      const toolStats = this._aggregateToolCalls(toolCalls);
      summary += `Tool calls: ${toolCalls.length} (${Object.entries(toolStats).map(([k, v]) => `${k}: ${v}`).join(', ')})\n`;
      const errors = toolCalls.filter(t => t.metadata.isError);
      if (errors.length > 0) {
        summary += `  Errors: ${errors.length} (${errors.slice(-3).map(e => e.metadata.toolName).join(', ')})\n`;
      }
      summary += '\n';
    }

    if (reflections.length > 0) {
      summary += `Reflections: ${reflections.length}\n`;
      for (const r of reflections.slice(-3)) {
        summary += `  - ${r.content.slice(0, 150)}\n`;
      }
      summary += '\n';
    }

    // User/Assistant exchange summary
    const userMsgs = byRole.user || [];
    const assistantMsgs = byRole.assistant || [];
    summary += `User messages: ${userMsgs.length}, Assistant responses: ${assistantMsgs.length}\n`;

    // Key topics
    const topics = this._extractTopics(messages);
    if (topics.length > 0) {
      summary += `Key topics: ${topics.slice(0, 10).join(', ')}\n`;
    }

    return summary.trim();
  }

  /**
   * Group messages by role
   */
  _groupByRole(messages) {
    return messages.reduce((acc, msg) => {
      if (!acc[msg.role]) acc[msg.role] = [];
      acc[msg.role].push(msg);
      return acc;
    }, {});
  }

  /**
   * Aggregate tool call statistics
   */
  _aggregateToolCalls(toolCalls) {
    return toolCalls.reduce((acc, call) => {
      const name = call.metadata.toolName || 'unknown';
      acc[name] = (acc[name] || 0) + 1;
      return acc;
    }, {});
  }

  /**
   * Extract key topics from messages
   */
  _extractTopics(messages) {
    const topics = new Set();
    const topicPatterns = [
      /(?:file|path|directory)\s+[`'"]([^`'"\s]+)[`'"\s]/gi,
      /(?:function|method|class|component)\s+[`'"]([^`'"\s]+)[`'"\s]/gi,
      /(?:error|exception|fail)\s*[:]\s*([^\n.]+)/gi,
      /(?:test|spec)\s+[`'"]([^`'"\s]+)[`'"\s]/gi,
      /(?:npm|yarn|pnpm)\s+(install|run|build|test|dev)/gi,
      /(?:git\s+\w+)/gi,
    ];

    for (const msg of messages) {
      const content = msg.content;
      for (const pattern of topicPatterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
          if (match[1]) topics.add(match[1].trim());
          else if (match[0]) topics.add(match[0].trim());
        }
      }
    }

    return Array.from(topics).slice(0, 20);
  }

  /**
   * Extract key facts from a block of messages
   */
  _extractBlockKeyFacts(messages) {
    const facts = [];
    
    for (const msg of messages) {
      const extracted = this._extractKeyFacts(msg);
      facts.push(...extracted);
    }

    // Deduplicate
    const uniqueFacts = [];
    const seen = new Set();
    for (const fact of facts) {
      const key = `${fact.type}:${fact.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueFacts.push(fact);
      }
    }

    return uniqueFacts.slice(0, 20);
  }

  /**
   * Extract key facts from a single message
   */
  _extractKeyFacts(message) {
    const facts = [];
    const content = message.content;

    // File paths
    const filePaths = content.match(/[`'"]([^`'"\s]+\.(?:js|ts|jsx|tsx|py|json|md|yml|yaml|css|html|vue|svelte|go|rs|java|cpp|c|h|sh|bash|zsh|fish|toml|ini|config|env|txt))[`'"\s]/g);
    if (filePaths) {
      for (const fp of filePaths.slice(0, 10)) {
        facts.push({ type: 'file_path', value: fp.replace(/[`'"\s]/g, ''), timestamp: message.timestamp });
      }
    }

    // Error messages
    const errors = content.match(/(?:Error|Exception|Failed|Error:)\s*([^\n]{10,200})/gi);
    if (errors) {
      for (const err of errors.slice(0, 5)) {
        facts.push({ type: 'error', value: err.trim().slice(0, 200), timestamp: message.timestamp });
      }
    }

    // Commands run
    const commands = content.match(/(?:run|execute|command)\s*[:]\s*[`'"]([^`'"\n]{5,200})[`'"\n]/gi);
    if (commands) {
      for (const cmd of commands.slice(0, 5)) {
        facts.push({ type: 'command', value: cmd.replace(/^(?:run|execute|command)\s*[:]\s*[`'"\s]*/i, '').trim(), timestamp: message.timestamp });
      }
    }

    // Test results
    const testResults = content.match(/(?:test|spec).*?(?:pass|fail|PASS|FAIL|✓|✗).{0,100}/gi);
    if (testResults) {
      for (const tr of testResults.slice(0, 5)) {
        facts.push({ type: 'test_result', value: tr.trim().slice(0, 200), timestamp: message.timestamp });
      }
    }

    // Decisions/choices
    const decisions = content.match(/(?:decide|choose|select|will use|going to use|approach)\s+.{10,200}/gi);
    if (decisions) {
      for (const dec of decisions.slice(0, 3)) {
        facts.push({ type: 'decision', value: dec.trim().slice(0, 200), timestamp: message.timestamp });
      }
    }

    // Store in key facts map
    for (const fact of facts) {
      const key = `${fact.type}:${fact.value}`;
      if (!this.keyFacts.has(key)) {
        this.keyFacts.set(key, { ...fact, count: 1, firstSeen: message.timestamp });
      } else {
        const existing = this.keyFacts.get(key);
        existing.count++;
        existing.lastSeen = message.timestamp;
      }
    }

    return facts;
  }

  /**
   * Summarize a tool result for memory
   */
  _summarizeToolResult(toolName, result, isError) {
    const str = typeof result === 'string' ? result : JSON.stringify(result);
    if (str.length < 200) return str;
    
    // Tool-specific summaries
    if (toolName === 'read_file') {
      const lines = str.match(/^\[.*?\|\s*(\d+)\s*lines?/m);
      return lines ? `Read file (${lines[1]} lines)` : 'Read file';
    }
    if (toolName === 'write_file' || toolName === 'replace_in_file' || toolName === 'append_to_file') {
      return isError ? 'Write failed' : 'File modified';
    }
    if (toolName === 'run_command') {
      const exitCode = str.match(/exit code[:\s]+(\d+)/i);
      return exitCode ? `Command exited with code ${exitCode[1]}` : 'Command executed';
    }
    if (toolName === 'list_directory' || toolName === 'find_files') {
      const count = str.split('\n').length;
      return `Listed ${count} items`;
    }
    if (toolName === 'search_files' || toolName === 'search_in_file') {
      const matches = str.match(/(\d+)\s+match/);
      return matches ? `${matches[1]} matches found` : 'Search completed';
    }

    return str.slice(0, 200) + '...';
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Formatting
  // ─────────────────────────────────────────────────────────────────────────────

  _formatMessage(msg) {
    const roleLabel = msg.role === 'tool_result' ? 'TOOL' : msg.role.toUpperCase();
    const meta = msg.metadata.type ? ` [${msg.metadata.type}]` : '';
    return `[${roleLabel}${meta}] ${msg.content}`;
  }

  _formatSummarizedBlock(block) {
    return `[SUMMARY ${block.timeRange.start} → ${block.timeRange.end} (${block.messageCount} msgs)]\n${block.summary}`;
  }

  _formatKeyFacts(focus = null) {
    if (this.keyFacts.size === 0) return '';

    const facts = Array.from(this.keyFacts.values())
      .sort((a, b) => (b.lastSeen || b.firstSeen).localeCompare(a.lastSeen || a.firstSeen))
      .slice(0, 30);

    // Group by type
    const byType = {};
    for (const fact of facts) {
      if (!byType[fact.type]) byType[fact.type] = [];
      byType[fact.type].push(fact);
    }

    let output = 'KEY FACTS:\n';
    for (const [type, typeFacts] of Object.entries(byType)) {
      output += `  ${type.toUpperCase()}: `;
      output += typeFacts.slice(0, 5).map(f => f.value).join('; ');
      if (typeFacts.length > 5) output += ` ... (+${typeFacts.length - 5} more)`;
      output += '\n';
    }
    return output;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Token Estimation
  // ─────────────────────────────────────────────────────────────────────────────

  _estimateTokens(text) {
    if (!text) return 0;
    return Math.ceil(String(text).length / this.charPerToken);
  }

  _recalculateTokenEstimate() {
    let total = this.rawMessages.reduce((sum, m) => sum + m.tokenEstimate, 0);
    total += this.summarizedBlocks.reduce((sum, b) => sum + b.tokenEstimate, 0);
    total += this._estimateTokens(this._formatKeyFacts());
    return total;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Persistence
  // ─────────────────────────────────────────────────────────────────────────────

  persist() {
    try {
      const filePath = path.join(MEMORY_DIR, `${this.sessionId}.json`);
      const data = {
        metadata: this.metadata,
        rawMessages: this.rawMessages,
        summarizedBlocks: this.summarizedBlocks,
        keyFacts: Array.from(this.keyFacts.entries()),
        currentFocus: this.currentFocus,
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[WorkingMemory] Persist failed:', err.message);
    }
  }

  static load(sessionId) {
    try {
      const filePath = path.join(MEMORY_DIR, `${sessionId}.json`);
      if (!fs.existsSync(filePath)) return null;

      const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const memory = new WorkingMemory({ sessionId });
      memory.rawMessages = data.rawMessages || [];
      memory.summarizedBlocks = data.summarizedBlocks || [];
      memory.keyFacts = new Map(data.keyFacts || []);
      memory.currentFocus = data.currentFocus;
      memory.metadata = { ...memory.metadata, ...data.metadata };
      return memory;
    } catch (err) {
      console.warn('[WorkingMemory] Load failed:', err.message);
      return null;
    }
  }

  static listSessions() {
    try {
      return fs.readdirSync(MEMORY_DIR)
        .filter(f => f.endsWith('.json'))
        .map(f => {
          const data = JSON.parse(fs.readFileSync(path.join(MEMORY_DIR, f), 'utf8'));
          return {
            sessionId: data.metadata.sessionId,
            createdAt: data.metadata.createdAt,
            updatedAt: data.metadata.updatedAt,
            messageCount: data.metadata.totalMessages,
            tokenEstimate: data.metadata.totalTokensEstimate,
          };
        })
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    } catch {
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Utilities
  // ─────────────────────────────────────────────────────────────────────────────

  setFocus(focus) {
    this.currentFocus = focus;
    this.metadata.updatedAt = new Date().toISOString();
  }

  clearFocus() {
    this.currentFocus = null;
  }

  getStats() {
    return {
      sessionId: this.sessionId,
      rawMessages: this.rawMessages.length,
      summarizedBlocks: this.summarizedBlocks.length,
      keyFacts: this.keyFacts.size,
      tokenEstimate: this.metadata.totalTokensEstimate,
      compressionCount: this.metadata.compressionCount,
      currentFocus: this.currentFocus,
    };
  }

  clear() {
    this.rawMessages = [];
    this.summarizedBlocks = [];
    this.keyFacts.clear();
    this.currentFocus = null;
    this.metadata = {
      ...this.metadata,
      totalMessages: 0,
      totalTokensEstimate: 0,
      compressionCount: 0,
      updatedAt: new Date().toISOString(),
    };
  }
}

module.exports = { WorkingMemory };