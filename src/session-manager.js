// src/session-manager.js — Multi-session management with persistence
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

class SessionManager {
  constructor() {
    this.sessions = new Map();
    this.persistenceDir = path.join(process.cwd(), '.seekcode', 'sessions');
    this.maxSessions = 10;
    this.sessionTTL = 30 * 60 * 1000; // 30 minutes
    
    // Cleanup interval
    setInterval(() => this.cleanupExpiredSessions(), 60000);
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
      fs.mkdirSync(this.persistenceDir, { recursive: true });
      const session = this.sessions.get(sessionId);
      if (session) {
        const data = {
          id: session.id,
          createdAt: session.createdAt,
          lastAccessed: session.lastAccessed,
          metadata: session.metadata
        };
        const filePath = path.join(this.persistenceDir, `${sessionId}.json`);
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      }
    } catch (err) {
      logger.warn(`Failed to persist session: ${err.message}`);
    }
  }

  deletePersistedSession(sessionId) {
    try {
      const filePath = path.join(this.persistenceDir, `${sessionId}.json`);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      logger.warn(`Failed to delete persisted session: ${err.message}`);
    }
  }

  loadPersistedSessions() {
    try {
      if (!fs.existsSync(this.persistenceDir)) return;
      
      const files = fs.readdirSync(this.persistenceDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.persistenceDir, file);
          const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
          
          // Check if session is still valid
          if (Date.now() - data.lastAccessed <= this.sessionTTL) {
            // Note: We can't restore the actual agent, only metadata
            logger.dim(`Found persisted session: ${data.id} (requires recreation)`);
          } else {
            fs.unlinkSync(filePath);
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
