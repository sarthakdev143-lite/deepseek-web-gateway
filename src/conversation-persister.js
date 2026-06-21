// src/conversation-persister.js
//
// Append-only JSONL persistence for agent conversations, one file per session
// at ~/.deepseek-agent/conversations/<sessionId>.jsonl. Each line is one turn
// or tool event:
//   {"ts":"...","type":"turn","role":"user|assistant","content":"...","toolCalls":[...]}
//
// Purpose: survive browser-tab crashes and gateway restarts. On recreateTab,
// agent.js calls load() and replays the prior turns into the fresh
// ConversationManager so the agent retains context without re-sending to the
// model. The GUI also calls GET /sessions/history to list restorable sessions.

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CONVERSATIONS_DIR = path.join(os.homedir(), '.deepseek-agent', 'conversations');
const MAX_RESULT_PREVIEW = 10_000; // truncate large tool results before persisting

class ConversationPersister {
  static ensureDir() {
    try {
      if (!fs.existsSync(CONVERSATIONS_DIR)) {
        fs.mkdirSync(CONVERSATIONS_DIR, { recursive: true });
      }
      return true;
    } catch (err) {
      // Read-only home / permission issues shouldn't crash the agent.
      return false;
    }
  }

  static getPath(sessionId) {
    // Sanitize sessionId — it's used directly in a filename.
    const safe = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_');
    return path.join(CONVERSATIONS_DIR, `${safe}.jsonl`);
  }

  /** Append one entry (with auto-added timestamp). Never throws. */
  static append(sessionId, entry) {
    if (!sessionId) return false;
    if (!this.ensureDir()) return false;
    try {
      // Truncate oversized payloads so a single tool result can't blow up disk.
      const safe = { ts: new Date().toISOString(), ...entry };
      if (typeof safe.content === 'string' && safe.content.length > MAX_RESULT_PREVIEW) {
        safe.content = safe.content.slice(0, MAX_RESULT_PREVIEW) + '\n…[truncated]';
      }
      if (typeof safe.result === 'string' && safe.result.length > MAX_RESULT_PREVIEW) {
        safe.result = safe.result.slice(0, MAX_RESULT_PREVIEW) + '\n…[truncated]';
      }
      const line = JSON.stringify(safe) + '\n';
      fs.appendFileSync(this.getPath(sessionId), line, 'utf8');
      return true;
    } catch (err) {
      // Persistence is best-effort. A failed append must not break the run.
      return false;
    }
  }

  /** Load all entries for a session. Returns [] if file missing/unreadable. */
  static load(sessionId) {
    if (!sessionId) return [];
    const filePath = this.getPath(sessionId);
    if (!fs.existsSync(filePath)) return [];
    try {
      return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(l => l.trim())
        .map(l => {
          try { return JSON.parse(l); }
          catch { return null; }
        })
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /**
   * List all persisted sessions, newest first. Each entry includes a
   * best-effort preview (first user message) and message count for the GUI.
   */
  static listSessions() {
    if (!this.ensureDir()) return [];
    try {
      return fs.readdirSync(CONVERSATIONS_DIR)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => {
          const sessionId = f.replace(/\.jsonl$/, '');
          const fullPath = path.join(CONVERSATIONS_DIR, f);
          let stats;
          try { stats = fs.statSync(fullPath); } catch { return null; }
          let messageCount = 0;
          let preview = '';
          try {
            // Cheap scan: read only enough to get a preview (first 8 KB).
            const head = fs.readFileSync(fullPath, 'utf8').slice(0, 8192);
            const lines = head.split('\n').filter(Boolean);
            for (const l of lines) {
              try {
                const e = JSON.parse(l);
                if (e.type === 'turn') messageCount++;
                if (!preview && e.role === 'user' && e.content) {
                  preview = String(e.content).slice(0, 120).replace(/\s+/g, ' ');
                }
                if (preview && messageCount > 0) break;
              } catch {}
            }
          } catch {}
          return {
            sessionId,
            lastModified: stats.mtime,
            sizeBytes: stats.size,
            messageCount,
            preview,
          };
        })
        .filter(Boolean)
        .sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
    } catch {
      return [];
    }
  }

  /** Delete a conversation file. Returns true if something was removed. */
  static delete(sessionId) {
    if (!sessionId) return false;
    const filePath = this.getPath(sessionId);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        return true;
      }
    } catch {}
    return false;
  }
}

module.exports = { ConversationPersister };
