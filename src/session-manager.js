'use strict';
const fs = require('fs').promises;
// src/session-manager.js — Multi-session management with persistence
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class SessionManager {

  startAutoCleanup(intervalMs = 300000) { // 5 minutes default
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const staleSessions = [];
      
      for (const [id, session] of this.sessions.entries()) {
        const lastActivity = session.lastActivity || session.createdAt;
        if (now - lastActivity > this.sessionTTL * 1000) {
          staleSessions.push(id);
        }
      }
      
      for (const id of staleSessions) {
        this.destroySession(id).catch(err => {
          console.error(`Failed to cleanup stale session ${id}: ${err.message}`);
        });
      }
      
      if (staleSessions.length > 0) {
        console.log(`Auto-cleaned ${staleSessions.length} stale sessions`);
      }
    }, intervalMs);
    
    // Ensure cleanup on process exit
    process.on('beforeExit', () => {
      if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    });
  }

  
  constructor() {
    this.sessions = new Map(); // Consider WeakMap for auto-GC
    this.sessionTTL = 30 * 60; // 30 minutes
    this.maxSessions = 100;
    this.cleanupInterval = null;
    
    // Monitor memory usage
    setInterval(() => {
      const used = process.memoryUsage();
      if (used.heapUsed > 500 * 1024 * 1024) { // 500MB
        console.warn(`High memory usage: ${Math.round(used.heapUsed / 1024 / 1024)}MB`);
        this.pruneOldestSessions();
      }
    }, 60000);
  }
  
  pruneOldestSessions() {
    const sessions = Array.from(this.sessions.entries());
    if (sessions.length > this.maxSessions) {
      const toRemove = sessions.slice(0, sessions.length - this.maxSessions);
      toRemove.forEach(([id]) => this.destroySession(id));
      console.log(`Pruned ${toRemove.length} old sessions`);
    }
  }


  generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  createSession(agent) {
    // Clean up old sessions if at capacity
    if (this.sessions.size >= this.maxSessions) {
      this.evictOldestSession();
    }

    const sessionId = this.generateSessionId();
    const session = {
      id: sessionId,
      agent: agent,
      createdAt: Date.now(),
      lastAccessed: Date.now(),
      metadata: {}
    };

    this.sessions.set(sessionId, session);
    this.persistSession(sessionId);
    
    logger.success(`Session created: ${sessionId}`);
    return sessionId;
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    
    // Check expiration
    if (Date.now() - session.lastAccessed > this.sessionTTL) {
      this.destroySession(sessionId);
      return null;
    }
    
    session.lastAccessed = Date.now();
    return session;
  }

  async destroySession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) {
      try {
        if (session.agent) {
          await session.agent.shutdown();
        }
      } catch (err) {
        logger.warn(`Error shutting down session ${sessionId}: ${err.message}`);
      }
      this.sessions.delete(sessionId);
      this.deletePersistedSession(sessionId);
      logger.info(`Session destroyed: ${sessionId}`);
    }
  }

  async destroyAllSessions() {
    const promises = Array.from(this.sessions.keys()).map(id => this.destroySession(id));
    await Promise.all(promises);
    logger.info('All sessions destroyed');
  }

  evictOldestSession() {
    let oldest = null;
    let oldestTime = Date.now();
    
    for (const [id, session] of this.sessions.entries()) {
      if (session.lastAccessed < oldestTime) {
        oldest = id;
        oldestTime = session.lastAccessed;
      }
    }
    
    if (oldest) {
      logger.info(`Evicting oldest session: ${oldest}`);
      this.destroySession(oldest);
    }
  }

  cleanupExpiredSessions() {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.lastAccessed > this.sessionTTL) {
        logger.info(`Cleaning up expired session: ${id}`);
        this.destroySession(id);
      }
    }
  }

  persistSession(sessionId) {
    try {
      await fs.promises.mkdir(this.persistenceDir, { recursive: true });
      const session = this.sessions.get(sessionId);
      if (session) {
        const data = {
          id: session.id,
          createdAt: session.createdAt,
          lastAccessed: session.lastAccessed,
          metadata: session.metadata
        };
        const filePath = path.join(this.persistenceDir, `${sessionId}.json`);
        await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
      }
    } catch (err) {
      logger.warn(`Failed to persist session: ${err.message}`);
    }
  }

  deletePersistedSession(sessionId) {
    try {
      const filePath = path.join(this.persistenceDir, `${sessionId}.json`);
      if (await fs.promises.access(filePath)) {
        await fs.promises.unlink(filePath);
      }
    } catch (err) {
      logger.warn(`Failed to delete persisted session: ${err.message}`);
    }
  }

  loadPersistedSessions() {
    try {
      if (!await fs.promises.access(this.persistenceDir)) return;
      
      const files = fs.readdirSync(this.persistenceDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.persistenceDir, file);
          const data = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
          
          // Check if session is still valid
          if (Date.now() - data.lastAccessed <= this.sessionTTL) {
            // Note: We can't restore the actual agent, only metadata
            logger.dim(`Found persisted session: ${data.id} (requires recreation)`);
          } else {
            await fs.promises.unlink(filePath);
          }
        }
      }
    } catch (err) {
      logger.warn(`Failed to load persisted sessions: ${err.message}`);
    }
  }

  getStats() {
    return {
      activeSessions: this.sessions.size,
      maxSessions: this.maxSessions,
      sessionTTL: this.sessionTTL,
      persistenceDir: this.persistenceDir
    };
  }

  updateMetadata(sessionId, metadata) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.metadata = { ...session.metadata, ...metadata };
      this.persistSession(sessionId);
    }
  }
}

module.exports = { SessionManager };
