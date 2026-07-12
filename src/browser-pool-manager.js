// src/browser-pool-manager.js — Browser Pool Manager for Resilience and Scalability
'use strict';

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const config = require('./config');
const logger = require('./logger');

const POOL_DIR = path.join(config.SESSION_DIR || process.cwd(), '.seekcode', 'browser-pool');
fs.mkdirSync(POOL_DIR, { recursive: true });

// ─────────────────────────────────────────────────────────────────────────────
// Browser Pool Configuration
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_POOL_SIZE = config.BROWSER_POOL_SIZE || 2;
const MAX_POOL_SIZE = config.BROWSER_MAX_POOL_SIZE || 5;
const BROWSER_IDLE_TIMEOUT = config.BROWSER_IDLE_TIMEOUT || 5 * 60 * 1000; // 5 minutes
const BROWSER_MAX_AGE = config.BROWSER_MAX_AGE || 60 * 60 * 1000; // 1 hour
const PAGE_IDLE_TIMEOUT = config.PAGE_IDLE_TIMEOUT || 2 * 60 * 1000; // 2 minutes
const HEALTH_CHECK_INTERVAL = config.BROWSER_HEALTH_CHECK_INTERVAL || 30 * 1000; // 30 seconds
const CRASH_RECOVERY_RETRIES = config.BROWSER_CRASH_RECOVERY_RETRIES || 3;

// ─────────────────────────────────────────────────────────────────────────────
// Browser Instance Wrapper
// ─────────────────────────────────────────────────────────────────────────────

class BrowserInstance {
  constructor(browser, id, options = {}) {
    this.browser = browser;
    this.id = id;
    this.createdAt = Date.now();
    this.lastUsedAt = Date.now();
    this.pageCount = 0;
    this.maxPages = options.maxPages || 10;
    this.isHealthy = true;
    this.crashCount = 0;
    this.contextOptions = options.contextOptions || {};
    this._pageCreatedCallbacks = new Set();
    this._pageClosedCallbacks = new Set();
    
    // Set up browser event handlers
    this._setupEventHandlers();
  }

  _setupEventHandlers() {
    this.browser.on('disconnected', () => {
      this.isHealthy = false;
      logger.warn(`[BrowserPool] Browser ${this.id} disconnected`);
    });
  }

  async newPage(options = {}) {
    if (this.pageCount >= this.maxPages) {
      throw new Error(`Browser ${this.id} at max page capacity (${this.maxPages})`);
    }
    
    const context = await this.browser.newContext(this.contextOptions);
    const page = await context.newPage();
    
    this.pageCount++;
    this.lastUsedAt = Date.now();
    
    // Track page for cleanup
    const pageId = `page_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    page._poolPageId = pageId;
    page._poolBrowserId = this.id;
    page._poolCreatedAt = Date.now();
    
    // Set up page crash handling
    page.on('crash', () => {
      logger.warn(`[BrowserPool] Page ${pageId} crashed in browser ${this.id}`);
      this.pageCount = Math.max(0, this.pageCount - 1);
      this._notifyPageClosed(pageId);
    });
    
    page.on('close', () => {
      this.pageCount = Math.max(0, this.pageCount - 1);
      this._notifyPageClosed(pageId);
    });
    
    this._notifyPageCreated(page);
    
    return page;
  }

  async closePage(page) {
    if (page && !page.isClosed()) {
      await page.close();
    }
  }

  get isAvailable() {
    return this.isHealthy && this.pageCount < this.maxPages;
  }

  get age() {
    return Date.now() - this.createdAt;
  }

  get idleTime() {
    return Date.now() - this.lastUsedAt;
  }

  async close() {
    try {
      await this.browser.close();
    } catch (err) {
      logger.warn(`[BrowserPool] Error closing browser ${this.id}: ${err.message}`);
    }
    this.isHealthy = false;
  }

  // Callbacks for pool monitoring
  onPageCreated(callback) { this._pageCreatedCallbacks.add(callback); }
  onPageClosed(callback) { this._pageClosedCallbacks.add(callback); }
  _notifyPageCreated(page) { this._pageCreatedCallbacks.forEach(cb => cb(page)); }
  _notifyPageClosed(pageId) { this._pageClosedCallbacks.forEach(cb => cb(pageId)); }

  toJSON() {
    return {
      id: this.id,
      createdAt: this.createdAt,
      lastUsedAt: this.lastUsedAt,
      pageCount: this.pageCount,
      maxPages: this.maxPages,
      isHealthy: this.isHealthy,
      crashCount: this.crashCount,
      age: this.age,
      idleTime: this.idleTime,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser Pool Manager
// ─────────────────────────────────────────────────────────────────────────────

class BrowserPoolManager {
  constructor(options = {}) {
    this.minSize = options.minSize || DEFAULT_POOL_SIZE;
    this.maxSize = options.maxSize || MAX_POOL_SIZE;
    this.idleTimeout = options.idleTimeout || BROWSER_IDLE_TIMEOUT;
    this.maxAge = options.maxAge || BROWSER_MAX_AGE;
    this.healthCheckInterval = options.healthCheckInterval || HEALTH_CHECK_INTERVAL;
    this.crashRecoveryRetries = options.crashRecoveryRetries || CRASH_RECOVERY_RETRIES;
    
    // Browser launch options
    this.launchOptions = options.launchOptions || {
      headless: config.HEADLESS !== false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
      ],
    };
    
    this.contextOptions = options.contextOptions || {
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
      bypassCSP: true,
    };
    
    // Pool state
    this.browsers = new Map(); // id -> BrowserInstance
    this.allocatedPages = new Map(); // pageId -> { browserId, page, allocatedAt, tabName }
    this.isShuttingDown = false;
    this.healthCheckTimer = null;
    this.stats = {
      totalCreated: 0,
      totalClosed: 0,
      totalCrashes: 0,
      totalRecoveries: 0,
      currentAllocations: 0,
      peakAllocations: 0,
    };
    
    // Initialize pool
    this._initialize();
  }

  async _initialize() {
    logger.info(`[BrowserPool] Initializing pool (min: ${this.minSize}, max: ${this.maxSize})`);
    
    // Create initial browsers
    for (let i = 0; i < this.minSize; i++) {
      await this._createBrowser();
    }
    
    // Start health checks
    this._startHealthChecks();
    
    logger.success(`[BrowserPool] Pool initialized with ${this.browsers.size} browsers`);
  }

  async _createBrowser() {
    if (this.isShuttingDown) return null;
    if (this.browsers.size >= this.maxSize) return null;
    
    try {
      const browser = await chromium.launch(this.launchOptions);
      const id = `browser_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      
      const instance = new BrowserInstance(browser, id, {
        maxPages: 10,
        contextOptions: this.contextOptions,
      });
      
      // Set up event forwarding
      instance.onPageCreated((page) => this._onPageCreated(instance.id, page));
      instance.onPageClosed((pageId) => this._onPageClosed(instance.id, pageId));
      
      this.browsers.set(id, instance);
      this.stats.totalCreated++;
      
      logger.info(`[BrowserPool] Created browser ${id} (pool size: ${this.browsers.size})`);
      
      return instance;
    } catch (err) {
      logger.error(`[BrowserPool] Failed to create browser: ${err.message}`);
      throw err;
    }
  }

  async _onPageCreated(browserId, page) {
    // Mask automation
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
  }

  _onPageClosed(browserId, pageId) {
    const allocation = this.allocatedPages.get(pageId);
    if (allocation) {
      this.allocatedPages.delete(pageId);
      this.stats.currentAllocations = Math.max(0, this.stats.currentAllocations - 1);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Acquire a browser instance (creates new if needed)
   */
  async acquire(options = {}) {
    if (this.isShuttingDown) {
      throw new Error('Browser pool is shutting down');
    }
    
    // Find available browser
    let instance = this._findAvailableBrowser();
    
    if (!instance) {
      // Try to create new browser if under max
      if (this.browsers.size < this.maxSize) {
        instance = await this._createBrowser();
      }
      
      // If still no browser, wait for one to become available
      if (!instance) {
        instance = await this._waitForAvailableBrowser();
      }
    }
    
    if (!instance) {
      throw new Error('No available browser in pool');
    }
    
    return instance;
  }

  /**
   * Acquire a page from the pool
   */
  async acquirePage(tabName = 'default', options = {}) {
    const instance = await this.acquire(options);
    const page = await instance.newPage(options);
    
    // Track allocation
    const pageId = page._poolPageId;
    this.allocatedPages.set(pageId, {
      browserId: instance.id,
      page,
      allocatedAt: Date.now(),
      tabName,
      options,
    });
    this.stats.currentAllocations++;
    this.stats.peakAllocations = Math.max(this.stats.peakAllocations, this.stats.currentAllocations);
    
    // Set up crash recovery for this page
    page._poolRecoveryAttempts = 0;
    page._poolMaxRecovery = this.crashRecoveryRetries;
    
    logger.dim(`[BrowserPool] Allocated page ${pageId} from browser ${instance.id} for tab ${tabName}`);
    
    return { page, browserId: instance.id, pageId };
  }

  /**
   * Release a page back to the pool
   */
  async releasePage(pageId, options = {}) {
    const allocation = this.allocatedPages.get(pageId);
    if (!allocation) {
      logger.warn(`[BrowserPool] Attempted to release unknown page: ${pageId}`);
      return false;
    }
    
    const { page, browserId } = allocation;
    const instance = this.browsers.get(browserId);
    
    if (instance && !page.isClosed()) {
      // Optionally clean up page state
      if (!options.keepAlive) {
        await instance.closePage(page);
      }
    }
    
    this.allocatedPages.delete(pageId);
    this.stats.currentAllocations = Math.max(0, this.stats.currentAllocations - 1);
    
    logger.dim(`[BrowserPool] Released page ${pageId} from browser ${browserId}`);
    
    return true;
  }

  /**
   * Recover a crashed page
   */
  async recoverPage(pageId, tabName, sessionId = null) {
    const allocation = this.allocatedPages.get(pageId);
    if (!allocation) {
      throw new Error(`No allocation found for page ${pageId}`);
    }
    
    const { browserId, options } = allocation;
    const instance = this.browsers.get(browserId);
    
    if (!instance || !instance.isHealthy) {
      // Need new browser
      logger.warn(`[BrowserPool] Browser ${browserId} unhealthy, creating new browser for recovery`);
      return await this.acquirePage(tabName, options);
    }
    
    // Create new page in same browser
    const page = await instance.newPage(options);
    
    // Update allocation
    const newPageId = page._poolPageId;
    this.allocatedPages.set(newPageId, {
      browserId,
      page,
      allocatedAt: Date.now(),
      tabName,
      options,
      recoveredFrom: pageId,
    });
    this.allocatedPages.delete(pageId);
    
    logger.info(`[BrowserPool] Recovered page ${pageId} -> ${newPageId} in browser ${browserId}`);
    
    return { page, browserId, pageId: newPageId };
  }

  /**
   * Get a page by tab name (for tab switching)
   */
  getPageByTab(tabName) {
    for (const [pageId, allocation] of this.allocatedPages) {
      if (allocation.tabName === tabName) {
        return { page: allocation.page, pageId, browserId: allocation.browserId };
      }
    }
    return null;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Pool Management
  // ─────────────────────────────────────────────────────────────────────────────

  _findAvailableBrowser() {
    for (const instance of this.browsers.values()) {
      if (instance.isAvailable && instance.idleTime < this.idleTimeout) {
        return instance;
      }
    }
    return null;
  }

  async _waitForAvailableBrowser(timeout = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const instance = this._findAvailableBrowser();
      if (instance) return instance;
      await new Promise(r => setTimeout(r, 500));
    }
    return null;
  }

  _startHealthChecks() {
    this.healthCheckTimer = setInterval(() => this._healthCheck(), this.healthCheckInterval);
    this.healthCheckTimer.unref(); // Don't prevent exit
  }

  async _healthCheck() {
    if (this.isShuttingDown) return;
    
    const now = Date.now();
    const toClose = [];
    
    for (const [id, instance] of this.browsers) {
      // Check if browser is still connected
      if (!instance.isHealthy || !instance.browser.isConnected()) {
        logger.warn(`[BrowserPool] Browser ${id} unhealthy, marking for replacement`);
        instance.isHealthy = false;
        instance.crashCount++;
        this.stats.totalCrashes++;
        toClose.push(id);
        continue;
      }
      
      // Check age
      if (instance.age > this.maxAge) {
        logger.info(`[BrowserPool] Browser ${id} reached max age (${Math.round(instance.age / 60000)}min), recycling`);
        toClose.push(id);
        continue;
      }
      
      // Check idle timeout (but keep minimum pool size)
      if (instance.idleTime > this.idleTimeout && this.browsers.size > this.minSize) {
        logger.info(`[BrowserPool] Browser ${id} idle for ${Math.round(instance.idleTime / 60000)}min, closing`);
        toClose.push(id);
        continue;
      }
      
      // Check for stuck pages
      if (instance.pageCount > 0) {
        // Could add stuck page detection here
      }
    }
    
    // Close unhealthy browsers
    for (const id of toClose) {
      await this._closeBrowser(id, 'health_check');
    }
    
    // Ensure minimum pool size
    while (this.browsers.size < this.minSize && !this.isShuttingDown) {
      await this._createBrowser();
    }
  }

  async _closeBrowser(id, reason) {
    const instance = this.browsers.get(id);
    if (!instance) return;
    
    // Close all pages first
    // Note: In practice, pages are managed by their allocations
    
    await instance.close();
    this.browsers.delete(id);
    this.stats.totalClosed++;
    
    logger.info(`[BrowserPool] Closed browser ${id} (${reason}), pool size: ${this.browsers.size}`);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Crash Recovery
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Handle browser crash - called by agent when browser teardown detected
   */
  async handleBrowserCrash(browserId, affectedPages = []) {
    logger.warn(`[BrowserPool] Handling crash for browser ${browserId}, ${affectedPages.length} pages affected`);
    
    const instance = this.browsers.get(browserId);
    if (instance) {
      instance.isHealthy = false;
      instance.crashCount++;
      this.stats.totalCrashes++;
    }
    
    // Recover affected pages
    const recoveredPages = [];
    for (const pageId of affectedPages) {
      const allocation = this.allocatedPages.get(pageId);
      if (allocation) {
        try {
          const recovered = await this.recoverPage(pageId, allocation.tabName, allocation.options.sessionId);
          recoveredPages.push({ original: pageId, recovered: recovered.pageId });
          this.stats.totalRecoveries++;
        } catch (err) {
          logger.error(`[BrowserPool] Failed to recover page ${pageId}: ${err.message}`);
        }
      }
    }
    
    // Close crashed browser
    await this._closeBrowser(browserId, 'crash');
    
    return recoveredPages;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Shutdown
  // ─────────────────────────────────────────────────────────────────────────────

  async shutdown() {
    logger.info('[BrowserPool] Shutting down...');
    this.isShuttingDown = true;
    
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
    
    // Close all pages
    for (const [pageId, allocation] of this.allocatedPages) {
      try {
        if (!allocation.page.isClosed()) {
          await allocation.page.close();
        }
      } catch {}
    }
    this.allocatedPages.clear();
    
    // Close all browsers
    for (const [id, instance] of this.browsers) {
      await instance.close();
    }
    this.browsers.clear();
    
    logger.success('[BrowserPool] Shutdown complete');
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Statistics & Monitoring
  // ─────────────────────────────────────────────────────────────────────────────

  getStats() {
    return {
      ...this.stats,
      poolSize: this.browsers.size,
      minSize: this.minSize,
      maxSize: this.maxSize,
      allocatedPages: this.allocatedPages.size,
      browsers: Array.from(this.browsers.values()).map(b => b.toJSON()),
    };
  }

  getHealth() {
    const healthy = Array.from(this.browsers.values()).filter(b => b.isHealthy).length;
    return {
      healthy,
      total: this.browsers.size,
      isHealthy: healthy > 0,
      utilization: this.stats.currentAllocations / Math.max(this.browsers.size * 10, 1),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Persistence (for recovery after process restart)
  // ─────────────────────────────────────────────────────────────────────────────

  persistState() {
    try {
      const state = {
        timestamp: new Date().toISOString(),
        stats: this.stats,
        browsers: Array.from(this.browsers.values()).map(b => b.toJSON()),
        allocations: Array.from(this.allocatedPages.entries()).map(([id, a]) => ({
          pageId: id,
          browserId: a.browserId,
          tabName: a.tabName,
          allocatedAt: a.allocatedAt,
        })),
      };
      
      const filePath = path.join(POOL_DIR, 'pool-state.json');
      fs.writeFileSync(filePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      logger.warn('[BrowserPool] Persist state failed:', err.message);
    }
  }

  static loadState() {
    try {
      const filePath = path.join(POOL_DIR, 'pool-state.json');
      if (!fs.existsSync(filePath)) return null;
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Singleton Instance
// ─────────────────────────────────────────────────────────────────────────────

let _poolInstance = null;

async function getBrowserPool(options = {}) {
  if (!_poolInstance) {
    _poolInstance = new BrowserPoolManager(options);
    // Give it a moment to initialize
    await new Promise(r => setTimeout(r, 1000));
  }
  return _poolInstance;
}

async function shutdownBrowserPool() {
  if (_poolInstance) {
    await _poolInstance.shutdown();
    _poolInstance = null;
  }
}

module.exports = { BrowserPoolManager, BrowserInstance, getBrowserPool, shutdownBrowserPool };