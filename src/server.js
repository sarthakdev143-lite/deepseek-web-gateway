// src/server.js — HTTP wrapper around DeepSeekAgent with self-healing
const express = require('express');
const DeepSeekAgent = require('./agent');
const { SessionManager } = require('./session-manager');
const { HealthMonitor } = require('./health');
const logger = require('./logger');

const app = express();
app.use(express.json());

const sessionManager = new SessionManager();

// Middleware to validate session
async function validateSession(req, res, next) {
    const sessionId = req.params.id;
    if (!sessionId) {
        return res.status(400).json({ error: 'Session ID required' });
    }
    
    const session = sessionManager.getSession(sessionId);
    if (!session) {
        return res.status(404).json({ error: 'Session not found or expired' });
    }
    
    req.session = session;
    
    // Health check and auto-heal
    if (session.healthMonitor) {
        const isHealthy = await session.healthMonitor.checkHealth();
        if (!isHealthy) {
            logger.warn(`Session ${sessionId} unhealthy - attempting auto-heal`);
            const healed = await session.healthMonitor.autoHeal();
            if (!healed) {
                await sessionManager.destroySession(sessionId);
                return res.status(503).json({ error: 'Session unhealthy and could not be recovered' });
            }
        }
    }
    
    next();
}

// Endpoint: create a session (launches browser)
app.post('/session/create', async (req, res) => {
    try {
        const agent = new DeepSeekAgent({ saveLog: false, silent: true });
        await agent.init();
        
        const sessionId = sessionManager.createSession(agent);
        const healthMonitor = new HealthMonitor(agent);
        sessionManager.updateMetadata(sessionId, { healthMonitor: true });
        
        // Attach health monitor to session for access in middleware
        const session = sessionManager.getSession(sessionId);
        session.healthMonitor = healthMonitor;
        
        res.json({ sessionId, status: 'ready', ttl: sessionManager.sessionTTL });
    } catch (err) {
        logger.error(`Session creation failed: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Endpoint: run a task and return result
app.post('/session/:id/chat', validateSession, async (req, res) => {
    const { prompt } = req.body;
    const { agent, healthMonitor } = req.session;
    
    if (!prompt) {
        return res.status(400).json({ error: 'Prompt required' });
    }
    
    try {
        // Execute with circuit breaker protection
        const result = await healthMonitor.executeWithProtection(
            () => agent.run(prompt),
            () => ({ text: 'Circuit breaker active - please retry in a moment', fallback: true })
        );
        
        res.json({ text: result, toolCalls: [] });
    } catch (err) {
        logger.error(`Chat failed for session ${req.params.id}: ${err.message}`);
        res.status(500).json({ error: err.message });
    }
});

// Endpoint: close session
app.post('/session/:id/close', async (req, res) => {
    const sessionId = req.params.id;
    await sessionManager.destroySession(sessionId);
    res.json({ status: 'closed', sessionId });
});

// Endpoint: list sessions (admin)
app.get('/sessions', async (req, res) => {
    const stats = sessionManager.getStats();
    const sessions = Array.from(sessionManager.sessions.keys()).map(id => ({
        id,
        metadata: sessionManager.sessions.get(id)?.metadata || {}
    }));
    res.json({ stats, sessions });
});

// Endpoint: health check with detailed info
app.get('/health', async (req, res) => {
    const stats = sessionManager.getStats();
    res.json({ 
        status: 'ok', 
        version: '2.0.0',
        sessions: stats,
        timestamp: new Date().toISOString()
    });
});

// Graceful shutdown handler
process.on('SIGTERM', async () => {
    logger.info('SIGTERM received - shutting down gracefully');
    await sessionManager.destroyAllSessions();
    process.exit(0);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log("═".repeat(55));
    console.log("  DeepSeek Web Gateway — HTTP API (Self-Healing)");
    console.log(`  Server listening on http://localhost:${PORT}`);
    console.log("  Endpoints:");
    console.log("    GET  /health               — health check");
    console.log("    GET  /sessions             — list active sessions");
    console.log("    POST /session/create       — create agent session");
    console.log("    POST /session/:id/chat     — send task prompt");
    console.log("    POST /session/:id/close    — close session");
    console.log("═".repeat(55));
});
