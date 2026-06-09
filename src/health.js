// src/health.js — Self-healing health monitoring and recovery
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class HealthMonitor {

  async safePageCheck() {
    try {
      if (!this.agent || !this.agent.browser) return false;
      if (!this.agent.browser.page) {
        // Attempt to recover missing page
        logger.warn('Page missing - attempting to recreate');
        await this.agent.browser.init();
        return !!this.agent.browser.page;
      }
      return true;
    } catch (err) {
      logger.warn(`Page check failed: ${err.message}`);
      return false;
    }
  }

  constructor(agent) {
    this.agent = agent;
    this.healthStatus = 'unknown';
    this.lastHeartbeat = Date.now();
    this.recoveryAttempts = 0;
    this.maxRecoveryAttempts = 3;
    this.circuitBreaker = {
      failures: 0,
      lastFailureTime: 0,
      state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
      threshold: 5,
      timeout: 60000 // 60 seconds
    };
  }

  
  async checkHealth() {
    const isPageSafe = await this.safePageCheck();
    if (!isPageSafe) {
      this.healthStatus = 'unhealthy';
      return false;
    }
    
    try {
      // Safe page title check with timeout
      const title = await Promise.race([
        this.agent.browser.page.title(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 5000))
      ]).catch(() => null);
      
      if (!title || title.includes('error') || title.includes('Error')) {
        this.healthStatus = 'degraded';
        return false;
      }

      this.healthStatus = 'healthy';
      this.lastHeartbeat = Date.now();
      this.circuitBreaker.failures = 0;
      return true;
    } catch (err) {
      this.healthStatus = 'unhealthy';
      this.circuitBreaker.failures++;
      this.circuitBreaker.lastFailureTime = Date.now();
      
      if (this.circuitBreaker.failures >= this.circuitBreaker.threshold) {
        this.circuitBreaker.state = 'OPEN';
        logger.warn(`Circuit breaker OPEN - ${this.circuitBreaker.failures} failures`);
      }
      
      return false;
    }
  }


  async autoHeal() {
    if (this.circuitBreaker.state === 'OPEN') {
      const timeSinceLastFailure = Date.now() - this.circuitBreaker.lastFailureTime;
      if (timeSinceLastFailure > this.circuitBreaker.timeout) {
        this.circuitBreaker.state = 'HALF_OPEN';
        logger.info('Circuit breaker HALF_OPEN - testing recovery');
      } else {
        return false;
      }
    }

    if (this.recoveryAttempts >= this.maxRecoveryAttempts) {
      logger.error('Max recovery attempts reached - manual intervention required');
      return false;
    }

    this.recoveryAttempts++;
    logger.info(`Auto-healing attempt ${this.recoveryAttempts}/${this.maxRecoveryAttempts}`);

    const strategies = [
      this.reloadPage.bind(this),
      this.restartBrowser.bind(this),
      this.clearSession.bind(this)
    ];

    for (const strategy of strategies) {
      try {
        const success = await strategy();
        if (success) {
          this.recoveryAttempts = 0;
          this.circuitBreaker.state = 'CLOSED';
          logger.success('Auto-healing successful');
          return true;
        }
      } catch (err) {
        logger.warn(`Recovery strategy failed: ${err.message}`);
      }
    }

    return false;
  }

  async reloadPage() {
    if (!this.agent.browser.page) return false;
    await this.agent.browser.page.reload({ waitUntil: 'networkidle' });
    await this.agent.browser._ensureLoggedIn();
    return await this.checkHealth();
  }

  async restartBrowser() {
    await this.agent.shutdown();
    await this.agent.init();
    return await this.checkHealth();
  }

  async clearSession() {
    const sessionDir = path.resolve(process.env.DEEPSEEK_SESSION_DIR || './.deepseek-session');
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
      logger.info('Cleared corrupted session data');
    }
    return await this.restartBrowser();
  }

  // Circuit breaker wrapper for tool execution
  async executeWithProtection(fn, fallback) {
    if (this.circuitBreaker.state === 'OPEN') {
      logger.warn('Circuit breaker OPEN - using fallback');
      return fallback ? await fallback() : null;
    }

    try {
      const result = await fn();
      if (this.circuitBreaker.state === 'HALF_OPEN') {
        this.circuitBreaker.state = 'CLOSED';
        this.circuitBreaker.failures = 0;
        logger.info('Circuit breaker CLOSED -恢复正常');
      }
      return result;
    } catch (err) {
      this.circuitBreaker.failures++;
      if (this.circuitBreaker.failures >= this.circuitBreaker.threshold) {
        this.circuitBreaker.state = 'OPEN';
      }
      throw err;
    }
  }
}

module.exports = { HealthMonitor };
