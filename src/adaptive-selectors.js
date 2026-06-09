// src/adaptive-selectors.js — Self-healing selector system that adapts to UI changes
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class AdaptiveSelector {
  constructor(page) {
    this.page = page;
    this.selectorCache = new Map();
    this.selectorHistory = [];
    this.learningMode = true;
    this.cacheFile = path.join(process.cwd(), '.seekcode', 'selectors.json');
    this.loadCachedSelectors();
  }

  async findElement(selectorGroup, context = {}) {
    const startTime = Date.now();
    
    // Check cache first
    const cacheKey = `${selectorGroup}_${JSON.stringify(context)}`;
    if (this.selectorCache.has(cacheKey)) {
      const cached = this.selectorCache.get(cacheKey);
      if (Date.now() - cached.timestamp < 3600000) { // 1 hour cache
        const element = await this.trySelector(cached.selector);
        if (element) {
          logger.dim(`Using cached selector for ${selectorGroup}: ${cached.selector}`);
          return element;
        }
      }
    }

    // Try all selectors in the group
    const selectors = this.getSelectorsForGroup(selectorGroup);
    for (const selector of selectors) {
      const element = await this.trySelector(selector);
      if (element) {
        // Cache successful selector
        this.selectorCache.set(cacheKey, {
          selector: selector,
          timestamp: Date.now(),
          successCount: (this.selectorCache.get(cacheKey)?.successCount || 0) + 1
        });
        this.recordSuccess(selectorGroup, selector);
        logger.dim(`Found element for ${selectorGroup} using: ${selector} (${Date.now() - startTime}ms)`);
        return element;
      }
    }

    // If all fail, try to learn new selectors
    if (this.learningMode) {
      const newSelector = await this.learnSelector(selectorGroup, context);
      if (newSelector) {
        const element = await this.trySelector(newSelector);
        if (element) {
          logger.success(`Learned new selector for ${selectorGroup}: ${newSelector}`);
          this.addLearnedSelector(selectorGroup, newSelector);
          return element;
        }
      }
    }

    logger.warn(`Could not find element for ${selectorGroup} after trying ${selectors.length} selectors`);
    return null;
  }

  async trySelector(selector) {
    try {
      const element = await this.page.$(selector);
      if (element && await element.isVisible()) {
        return element;
      }
      return null;
    } catch (err) {
      return null;
    }
  }

  getSelectorsForGroup(group) {
    const baseSelectors = this.getBaseSelectors(group);
    const learned = this.getLearnedSelectors(group);
    const dynamic = this.generateDynamicSelectors(group);
    
    return [...baseSelectors, ...learned, ...dynamic];
  }

  getBaseSelectors(group) {
    const selectorMap = {
      chatInput: [
        '#chat-input',
        'textarea[placeholder*="Ask"]',
        'textarea[placeholder*="message"]',
        '[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'input[type="text"]',
        '[class*="input"]',
        '[class*="chat-input"]'
      ],
      sendButton: [
        'button[aria-label*="Send"]',
        'button[type="submit"]',
        'svg[data-icon="paper-plane"]',
        '[class*="send-btn"]',
        'button:has(svg)',
        '[data-testid="send-button"]'
      ],
      stopButton: [
        'button[aria-label*="Stop"]',
        '[class*="stop"]',
        'button:has(svg[data-icon="stop"])',
        '[role="button"][aria-label*="stop"]'
      ],
      newChat: [
        'button[aria-label*="New chat"]',
        'a[href="/"]',
        '[class*="new-chat"]',
        'button:has(svg[data-icon="plus"])',
        '[data-testid="new-chat-button"]'
      ],
      messageContainer: [
        '[class*="message-list"]',
        '[class*="chat-history"]',
        '[class*="conversation"]',
        'main > div',
        '[role="log"]'
      ]
    };
    
    return selectorMap[group] || [];
  }

  async learnSelector(group, context) {
    logger.info(`Attempting to learn selector for ${group}...`);
    
    // Analyze DOM to find likely elements
    const candidates = await this.page.evaluate((groupHint) => {
      const elements = [];
      
      // Look for elements based on group hints
      if (groupHint === 'chatInput') {
        document.querySelectorAll('textarea, [contenteditable], input[type="text"]').forEach(el => {
          elements.push({
            selector: el.id ? `#${el.id}` : null,
            class: el.className,
            tag: el.tagName,
            placeholder: el.placeholder,
            score: 10
          });
        });
      } else if (groupHint === 'sendButton') {
        document.querySelectorAll('button, [role="button"]').forEach(el => {
          const text = el.textContent?.toLowerCase() || '';
          const aria = el.getAttribute('aria-label')?.toLowerCase() || '';
          if (text.includes('send') || aria.includes('send')) {
            elements.push({
              selector: el.id ? `#${el.id}` : null,
              class: el.className,
              tag: el.tagName,
              text: text,
              score: 20
            });
          }
        });
      }
      
      return elements;
    }, group);
    
    // Generate best selector from candidates
    for (const candidate of candidates) {
      if (candidate.selector) {
        return candidate.selector;
      }
      if (candidate.class && typeof candidate.class === 'string') {
        const classSelector = `.${candidate.class.split(' ')[0]}`;
        return classSelector;
      }
    }
    
    return null;
  }

  generateDynamicSelectors(group) {
    // Generate selectors based on common patterns
    const dynamic = [];
    
    if (group === 'chatInput') {
      dynamic.push('[class*="input"]');
      dynamic.push('[class*="chat"] textarea');
    } else if (group === 'sendButton') {
      dynamic.push('button[class*="icon"]');
      dynamic.push('[class*="submit"]');
    }
    
    return dynamic;
  }

  getLearnedSelectors(group) {
    const learned = [];
    
    // Load from history
    for (const record of this.selectorHistory) {
      if (record.group === group && record.success && record.selector) {
        learned.push(record.selector);
      }
    }
    
    return learned.slice(0, 5); // Limit to last 5 learned selectors
  }

  recordSuccess(group, selector) {
    this.selectorHistory.unshift({
      group,
      selector,
      success: true,
      timestamp: Date.now()
    });
    
    // Keep last 100 records
    if (this.selectorHistory.length > 100) {
      this.selectorHistory = this.selectorHistory.slice(0, 100);
    }
    
    this.saveSelectors();
  }

  addLearnedSelector(group, selector) {
    // Add to persistent storage
    let learned = this.loadLearnedSelectors();
    if (!learned[group]) learned[group] = [];
    
    if (!learned[group].includes(selector)) {
      learned[group].unshift(selector);
      if (learned[group].length > 10) learned[group] = learned[group].slice(0, 10);
      this.saveLearnedSelectors(learned);
    }
  }

  loadCachedSelectors() {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const data = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8'));
        this.selectorHistory = data.history || [];
        logger.dim(`Loaded ${this.selectorHistory.length} cached selectors`);
      }
    } catch (err) {
      logger.warn(`Failed to load cached selectors: ${err.message}`);
    }
  }

  saveSelectors() {
    try {
      const dir = path.dirname(this.cacheFile);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify({
        history: this.selectorHistory,
        updated: Date.now()
      }, null, 2));
    } catch (err) {
      logger.warn(`Failed to save selectors: ${err.message}`);
    }
  }

  loadLearnedSelectors() {
    try {
      const learnedFile = path.join(process.cwd(), '.seekcode', 'learned-selectors.json');
      if (fs.existsSync(learnedFile)) {
        return JSON.parse(fs.readFileSync(learnedFile, 'utf8'));
      }
    } catch (err) {}
    return {};
  }

  saveLearnedSelectors(learned) {
    try {
      const learnedFile = path.join(process.cwd(), '.seekcode', 'learned-selectors.json');
      fs.mkdirSync(path.dirname(learnedFile), { recursive: true });
      fs.writeFileSync(learnedFile, JSON.stringify(learned, null, 2));
    } catch (err) {}
  }

  async waitForAnySelector(selectors, timeout = 30000) {
    const start = Date.now();
    
    while (Date.now() - start < timeout) {
      for (const selector of selectors) {
        const element = await this.trySelector(selector);
        if (element) return { selector, element };
      }
      await this.page.waitForTimeout(500);
    }
    
    return null;
  }
}

module.exports = { AdaptiveSelector };
