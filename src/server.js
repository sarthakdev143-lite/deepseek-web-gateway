// src/server.js "" HTTP wrapper around DeepSeekAgent
const express = require('express');
const DeepSeekAgent = require('./agent');

const app = express();
app.use(express.json());

let agent = null;

// Endpoint: create a session (launches browser)
app.post('/session/create', async (req, res) => {
    try {
        if (agent) await agent.shutdown();
        agent = new DeepSeekAgent({ saveLog: false, silent: true });
        await agent.init();
        res.json({ sessionId: 'default', status: 'ready' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Endpoint: run a task and return result
app.post('/session/:id/chat', async (req, res) => {
    const { prompt } = req.body;
    if (!agent) {
        return res.status(400).json({ error: 'No active session. Call /session/create first.' });
    }
    try {
        const result = await agent.run(prompt);
        res.json({ text: result, toolCalls: [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Endpoint: close session
app.post('/session/:id/close', async (req, res) => {
    if (agent) await agent.shutdown();
    agent = null;
    res.json({ status: 'closed' });
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log("═".repeat(55));
    console.log("  DeepSeek Web Gateway — HTTP API");
    console.log(`  Server listening on http://localhost:${PORT}`);
    console.log("  Endpoints:");
    console.log("    GET  /health               — health check");
    console.log("    POST /session/create       — create agent session");
    console.log("    POST /session/:id/chat     — send task prompt");
    console.log("    POST /session/:id/close    — close session");
    console.log("═".repeat(55));
});