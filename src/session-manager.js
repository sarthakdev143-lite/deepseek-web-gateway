// src/session-manager.js — Multi-session management with persistence
'use strict';

const fs     = require('fs');
const crypto = require('crypto');
const path   = require('path');
const logger = require('./logger');

class SessionManager {
  constructor() {
    this.sessions       = new Map();
    this.sessionTTL     = 30 * 60 * 1000; // 30 minutes in ms
    this.maxSessions    = 100;
    this.cleanupInterval = null;
    this.persistenceDir = path.join(process.cwd(), '.seekcode', 'sessions');

    fs.mkdirSync(this.persistenceDir, { recursive: true });
  }

  // ── Auto cleanup ───────────────────────────────────────────────────────────
  startAutoCleanup(intervalMs = 300_000) {
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);

    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      const stale = [];

      for (const [id, session] of this.sessions.entries()) {
        // ── CRITICAL: never kill a session that has an active in-flight request
        if ((session.activeRequests || 0) > 0) {
          // Refresh lastAccessed so it doesn't expire while work is happening
          session.lastAccessed = Date.now();
          continue;
        }
        const lastActivity = session.lastAccessed || session.createdAt;
        if (now - lastActivity > this.sessionTTL) stale.push(id);
      }

      for (const id of stale) {
        this.destroySession(id).catch(err =>
          logger.warn(`Auto-cleanup failed for ${id}: ${err.message}`)
        );
      }

      if (stale.length > 0) logger.dim(`Auto-cleaned ${stale.length} stale sessions`);
    }, intervalMs);

    process.on('beforeExit', () => {
      if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    });
  }

  // ── Session CRUD ───────────────────────────────────────────────────────────
  generateSessionId() {
    return crypto.randomBytes(16).toString('hex');
  }

  createSession(agent) {
    if (this.sessions.size >= this.maxSessions) {
      this._evictOldest();
    }

    const sessionId = this.generateSessionId();
    const session   = {
      id             : sessionId,
      agent,
      createdAt      : Date.now(),
      lastAccessed   : Date.now(),
      activeRequests : 0,   // ← guard: don't kill sessions with in-flight requests
      metadata       : {},
    };

    this.sessions.set(sessionId, session);
    this._persistSession(sessionId);

    logger.success(`Session created: ${sessionId}`);
    return sessionId;
  }

  /**
   * Signal that a request has started on this session.
   * Auto-cleanup will not destroy sessions with activeRequests > 0.
   */
  incrementActiveRequests(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.activeRequests = (session.activeRequests || 0) + 1;
    session.lastAccessed = Date.now(); // reset TTL clock
  }

  /**
   * Signal that a request has finished on this session.
   * Also refreshes lastAccessed so the TTL window starts from now.
   */
  decrementActiveRequests(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.activeRequests = Math.max(0, (session.activeRequests || 1) - 1);
    session.lastAccessed = Date.now(); // reset TTL after request ends
  }

  /**
   * Called periodically during a long-running request to keep lastAccessed fresh
   * so the session is never considered stale while work is actively happening.
   */
  heartbeat(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) session.lastAccessed = Date.now();
  }

  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Lazy expiration check — but NEVER expire sessions with active requests
    if ((session.activeRequests || 0) === 0 && Date.now() - session.lastAccessed > this.sessionTTL) {
      this.destroySession(sessionId).catch(() => {});
      return null;
    }

    session.lastAccessed = Date.now();
    return session;
  }

  async destroySession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    try {
      if (session.agent) await session.agent.shutdown();
    } catch (err) {
      logger.warn(`Error shutting down agent for session ${sessionId}: ${err.message}`);
    }

    this.sessions.delete(sessionId);
    await this._deletePersistedSession(sessionId);
    logger.info(`Session destroyed: ${sessionId}`);
  }

  async destroyAllSessions() {
    await Promise.all(
      Array.from(this.sessions.keys()).map(id => this.destroySession(id))
    );
    logger.info('All sessions destroyed');
  }

  // ── Metadata ───────────────────────────────────────────────────────────────
  updateMetadata(sessionId, metadata) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.metadata = { ...session.metadata, ...metadata };
    this._persistSession(sessionId);
  }

  getStats() {
    return {
      activeSessions : this.sessions.size,
      maxSessions    : this.maxSessions,
      sessionTTL     : this.sessionTTL,
      persistenceDir : this.persistenceDir,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────────────
  _evictOldest() {
    let oldestId  = null;
    let oldestTime = Date.now();

    for (const [id, session] of this.sessions.entries()) {
      if (session.lastAccessed < oldestTime) {
        oldestId   = id;
        oldestTime = session.lastAccessed;
      }
    }

    if (oldestId) {
      logger.info(`Evicting oldest session: ${oldestId}`);
      this.destroySession(oldestId).catch(() => {});
    }
  }

  async _persistSession(sessionId) {
    try {
      const session = this.sessions.get(sessionId);
      if (!session) return;

      const data     = { id: session.id, createdAt: session.createdAt, lastAccessed: session.lastAccessed, metadata: session.metadata };
      const filePath = path.join(this.persistenceDir, `${sessionId}.json`);
      await fs.promises.writeFile(filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      logger.warn(`Failed to persist session ${sessionId}: ${err.message}`);
    }
  }

  async _deletePersistedSession(sessionId) {
    try {
      const filePath = path.join(this.persistenceDir, `${sessionId}.json`);
      // FIXED: existsSync — fs.promises.access resolves with undefined (falsy)
      // so using it as a boolean always returned false, never deleting anything.
      if (fs.existsSync(filePath)) {
        await fs.promises.unlink(filePath);
      }
    } catch (err) {
      logger.warn(`Failed to delete persisted session ${sessionId}: ${err.message}`);
    }
  }

  async loadPersistedSessions() {
    try {
      // FIXED: existsSync
      if (!fs.existsSync(this.persistenceDir)) return;

      const files = fs.readdirSync(this.persistenceDir).filter(f => f.endsWith('.json'));

      for (const file of files) {
        try {
          const filePath = path.join(this.persistenceDir, file);
          const data     = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));

          if (Date.now() - data.lastAccessed <= this.sessionTTL) {
            // Session metadata exists but agent can't be restored — user must reconnect
            logger.dim(`Found persisted session (requires recreation): ${data.id}`);
          } else {
            // Expired — clean it up
            await fs.promises.unlink(filePath);
          }
        } catch {
          // Skip corrupt session files
        }
      }
    } catch (err) {
      logger.warn(`Failed to load persisted sessions: ${err.message}`);
    }
  }

  pruneOldestSessions() {
    const entries = Array.from(this.sessions.entries())
      .sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);

    if (entries.length > this.maxSessions) {
      const toRemove = entries.slice(0, entries.length - this.maxSessions);
      toRemove.forEach(([id]) => this.destroySession(id).catch(() => {}));
      logger.dim(`Pruned ${toRemove.length} old sessions`);
    }
  }
}

module.exports = { SessionManager };