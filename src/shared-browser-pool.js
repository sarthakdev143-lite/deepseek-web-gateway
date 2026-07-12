// shared-browser-pool.js — Robust Chromium pool with WebSocket streaming, auto-reconnect, session persistence
'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const config = require('./config');
const logger = require('./logger');
const EventEmitter = require('events');

// ─── Configuration ────────────────────────────────────────────────────────────
const POOL_CONFIG = {
  maxContexts: 3,                    // Max browser contexts
  maxPagesPerContext: 5,             // Max pages per context
  healthCheckInterval: 15000,        // 15s health checks
  heartbeatInterval: 30000,          // 30s heartbeat
  maxInactivity: 3 * 60 * 1000,      // 3 min inactivity timeout
  navigationTimeout: 60000,          // 60s navigation timeout
  actionTimeout: 30000,              // 30s action timeout
  maxRetries: 3,                     // Max retries per operation
  retryDelay: 2000,                  // 2s base retry delay
  maxContextAge: 10 * 60 * 1000,     // 10 min max context age
  cookieSaveInterval: 60000,         // 1 min cookie save
};

// ─── Browser Context Wrapper ─────────────────────────────────────────────────
class BrowserContextWrapper extends EventEmitter {
  constructor(context, id) {
    super();
    this.context = context;
    this.id = id;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.pages = new Map();
    this.pageCount = 0;
    this.closed = false;
    this.restarting = false;
    
    this.setupContextListeners();
  }

  setupContextListeners() {
    this.context.on('close', () => {
      if (!this.closed) {
        this.emit('unexpected-close', this.id);
      }
    });

    this.context.on('page', (page) => {
      this.pages.set(page._guid, page);
      page.on('close', () => {
        this.pages.delete(page._guid);
        this.updateActivity();
      });
      page.on('crash', () => {
        logger.warn(`Page crashed in context ${this.id}`);
        this.updateActivity();
      });
    });
  }

  updateActivity() {
    this.lastActivity = Date.now();
  }

  async newPage() {
    if (this.pages.size >= POOL_CONFIG.maxPagesPerContext) {
      throw new Error(`Max pages (${POOL_CONFIG.maxPagesPerContext}) reached for context ${this.id}`);
    }
    const page = await this.context.newPage();
    this.pages.set(page._guid, page);
    this.updateActivity();
    return page;
  }

  async closePage(pageGuid) {
    const page = this.pages.get(pageGuid);
    if (page && !page.isClosed()) {
      await page.close();
    }
    this.pages.delete(pageGuid);
  }

  async healthCheck() {
    if (this.closed) return false;
    if (this.restarting) return false;
    
    try {
      // Check browser connection
      if (!this.context.browser() || !this.context.browser().isConnected()) {
        return false;
      }

      // Check if we have responsive pages
      const pages = Array.from(this.pages.values());
      if (pages.length > 0) {
        // Ping first page
        await pages[0].evaluate(() => 1).catch(() => false);
      }
      return true;
    } catch (err) {
      logger.warn(`Health check failed for context ${this.id}: ${err.message}`);
      return false;
    }
  }

  async saveCookies() {
    try {
      const sessionDir = path.resolve(config.SESSION_DIR);
      const cookiesFile = path.join(sessionDir, 'cookies.json');
      const cookies = await this.context.cookies();
      await fs.promises.writeFile(cookiesFile, JSON.stringify(cookies, null, 2), 'utf8');
    } catch (err) {
      logger.dim('Cookie save failed: ' + err.message);
    }
  }

  isExpired() {
    return Date.now() - this.createdAt > POOL_CONFIG.maxContextAge;
  }

  async close() {
    this.closed = true;
    for (const page of this.pages.values()) {
      try { await page.close(); } catch {}
    }
    try { await this.context.close(); } catch {}
  }

  getStats() {
    return {
      id: this.id,
      age: Date.now() - this.createdAt,
      lastActivity: Date.now() - this.lastActivity,
      pageCount: this.pages.size,
      closed: this.closed,
      restarting: this.restarting,
    };
  }
}

// ─── Robust Browser Pool ─────────────────────────────────────────────────────
class RobustBrowserPool extends EventEmitter {
  constructor() {
    super();
    this.contexts = new Map();
    this.nextId = 1;
    this.healthCheckInterval = null;
    this.cookieSaveInterval = null;
    this.contextAgeInterval = null;
    this.requestQueue = [];
    this.processing = false;
  }

  async initialize() {
    logger.info('Initializing robust browser pool...');
    await this.createContext();
    this.startMonitoring();
    logger.success('Browser pool initialized');
  }

  async createContext() {
    const id = `ctx-${this.nextId++}`;
    const ctx = await this.launchContext();
    const wrapper = new BrowserContextWrapper(ctx, id);
    
    wrapper.on('unexpected-close', (id) => {
      logger.warn(`Context ${id} closed unexpectedly, scheduling replacement...`);
      setTimeout(() => this.replaceContext(id), 1000);
    });

    this.contexts.set(id, wrapper);
    logger.info(`Created browser context ${id}`);
    return wrapper;
  }

  async launchContext() {
    const sessionDir = path.resolve(config.SESSION_DIR);
    const cookiesFile = path.join(sessionDir, 'cookies.json');

    let cookies = [];
    if (fs.existsSync(cookiesFile)) {
      try {
        cookies = JSON.parse(await fs.promises.readFile(cookiesFile, 'utf8'));
        logger.success('Loaded saved cookies');
      } catch (e) {
        logger.warn('Could not load cookies: ' + e.message);
      }
    }

    const ctx = await chromium.launchPersistentContext(sessionDir, {
      headless: config.HEADLESS,
      viewport: null,
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--no-first-run',
        '--disable-default-apps',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
      ignoreDefaultArgs: ['--enable-automation'],
    });

    if (cookies.length > 0) {
      await ctx.addCookies(cookies);
    }

    return ctx;
  }

  async getContext() {
    // Find available context
    for (const [id, ctx] of this.contexts) {
      if (!ctx.closed && !ctx.restarting && ctx.pages.size < POOL_CONFIG.maxPagesPerContext && !ctx.isExpired()) {
        const healthy = await ctx.healthCheck();
        if (healthy) return ctx;
      }
    }

    // Create new context if under limit
    if (this.contexts.size < POOL_CONFIG.maxContexts) {
      return await this.createContext();
    }

    // Wait for available context
    return new Promise((resolve) => {
      const check = setInterval(async () => {
        for (const [id, ctx] of this.contexts) {
          if (!ctx.closed && !ctx.restarting && ctx.pages.size < POOL_CONFIG.maxPagesPerContext) {
            const healthy = await ctx.healthCheck();
            if (healthy) {
              clearInterval(check);
              resolve(ctx);
              return;
            }
          }
        }, 1000);
      // Timeout after 30s
      setTimeout(() => {
        clearInterval(check);
        reject(new Error('No available browser context'));
      }, 30000);
    });
  }

  async replaceContext(oldId) {
    const oldCtx = this.contexts.get(oldId);
    if (oldCtx) {
      oldCtx.restarting = true;
      await oldCtx.close();
      this.contexts.delete(oldId);
    }
    await this.createContext();
  }

  async acquirePage() {
    const ctx = await this.getContext();
    const page = await ctx.newPage();
    return { page, contextId: ctx.id };
  }

  async releasePage(pageGuid, contextId) {
    const ctx = this.contexts.get(contextId);
    if (ctx) {
      await ctx.closePage(pageGuid);
    }
  }

  startMonitoring() {
    // Health check interval
    this.healthCheckInterval = setInterval(async () => {
      for (const [id, ctx] of this.contexts) {
        if (ctx.closed || ctx.restarting) continue;
        
        const healthy = await ctx.healthCheck();
        if (!healthy) {
          logger.warn(`Context ${id} unhealthy, replacing...`);
          this.replaceContext(id);
          continue;
        }

        // Check context age
        if (ctx.isExpired()) {
          logger.info(`Context ${id} expired (${POOL_CONFIG.maxContextAge/60000}min), replacing...`);
          this.replaceContext(id);
        }
      }
    }, POOL_CONFIG.healthCheckInterval);

    // Cookie save interval
    this.cookieSaveInterval = setInterval(async () => {
      for (const [id, ctx] of this.contexts) {
        if (!ctx.closed) await ctx.saveCookies();
      }
    }, POOL_CONFIG.cookieSaveInterval);
  }

  stopMonitoring() {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    if (this.cookieSaveInterval) clearInterval(this.cookieSaveInterval);
  }

  async shutdown() {
    this.stopMonitoring();
    for (const [id, ctx] of this.contexts) {
      await ctx.close();
    }
    this.contexts.clear();
  }

  getStats() {
    const stats = {};
    for (const [id, ctx] of this.contexts) {
      stats[id] = ctx.getStats();
    }
    return stats;
  }
}

// ─── WebSocket-based Streaming (Replaces XHR polling) ────────────────────────
class WebSocketStreamer {
  constructor(page, tabName) {
    this.page = page;
    this.tabName = tabName;
    this.ws = null;
    this.reconnectAttempts = 0;
    this.maxReconnects = 5;
    this.listeners = new Map();
  }

  async connect() {
    // Inject WebSocket client into page
    await this.page.evaluate(() => {
      window.__deepseek_ws = new WebSocket('wss://chat.deepseek.com/api/v1/ws/stream');
      window.__deepseek_ws.onmessage = (event) => {
        if (window.__deepseek_listeners) {
          window.__deepseek_listeners.forEach(cb => cb(event.data));
        }
      };
      window.__deepseek_ws.onclose = () => {
        if (window.__deepseek_reconnect) window.__deepseek_reconnect();
      };
      window.__deepseek_reconnect = () => {
        if (window.__deepseek_ws) window.__deepseek_ws.close();
        window.__deepseek_ws = new WebSocket('wss://chat.deepseek.com/api/v1/ws/stream');
      };
      window.__deepseek_listeners = new Set();
    });

    // Wait for connection
    await this.page.waitForFunction(() => window.__deepseek_ws?.readyState === WebSocket.OPEN, { timeout: 10000 });
  }

  subscribe(callback) {
    const id = Math.random().toString(36).substr(2);
    this.listeners.set(id, callback);
    
    this.page.evaluate((id) => {
      window.__deepseek_listeners.add((data) => {
        window.__deepseek_callbacks[id](data);
      });
    }, id);

    // Set up callback bridge
    this.page.exposeFunction(`__deepseek_callback_${id}`, (data) => {
      const cb = this.listeners.get(id);
      if (cb) cb(data);
    });

    return () => {
      this.listeners.delete(id);
    };
  }

  async send(message) {
    await this.page.evaluate((msg) => {
      if (window.__deepseek_ws?.readyState === WebSocket.OPEN) {
        window.__deepseek_ws.send(JSON.stringify(msg));
      }
    }, message);
  }

  async close() {
    await this.page.evaluate(() => {
      if (window.__deepseek_ws) window.__deepseek_ws.close();
    });
  }
}

// ─── Request Queue with Retry Logic ─────────────────────────────────────────
class RequestQueue {
  constructor(pool, maxConcurrent = 3) {
    this.pool = pool;
    this.maxConcurrent = maxConcurrent;
    this.active = 0;
    this.queue = [];
  }

  async enqueue(fn, retries = 3) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, retries, resolve, reject });
      this.process();
    });

    async process() {
      if (this.active >= this.maxConcurrent || this.queue.length === 0) return;
      
      this.active++;
      const { fn, retries, resolve, reject } = this.queue.shift();
      
      try {
        const result = await fn();
        resolve(result);
      } catch (err) {
        if (retries > 0 && this.isRetryable(err)) {
          logger.warn(`Operation failed, retrying (${retries} left): ${err.message}`);
          setTimeout(() => {
            this.queue.unshift({ fn, retries: retries - 1, resolve, reject });
            this.active--;
            this.process();
          }, 2000 * (4 - retries));
        } else {
          reject(err);
        }
      } finally {
        this.active--;
        this.process();
      }
    }

    isRetryable(err) {
      const msg = err.message.toLowerCase();
      return msg.includes('econnreset') || 
             msg.includes('econnrefused') || 
             msg.includes('etimedout') ||
             msg.includes('target closed') ||
             msg.includes('context destroyed') ||
             msg.includes('navigation');
    }
  }
}

// ─── Export ───────────────────────────────────────────────────────────────────
const pool = new RobustBrowserPool();

module.exports = {
  pool,
  RobustBrowserPool,
  BrowserContextWrapper,
  WebSocketStreamer,
  RequestQueue,
  POOL_CONFIG,
  initialize: () => pool.initialize(),
  acquirePage: () => pool.acquirePage(),
  releasePage: (pageGuid, contextId) => pool.releasePage(pageGuid, contextId),
  getStats: () => pool.getStats(),
  shutdown: () => pool.shutdown(),
};
