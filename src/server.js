// src/server.js â€“ HTTP wrapper around DeepSeekAgent
const express = require('express');
const DeepSeekAgent = require('./agent');

const app = express();
app.use(express.json());

let agent = null;

// Endpoint: create a session (launches browser)
app.post('/session/create', async (req, res) => {
    try {
        if (agent) await agent.shutdown();
        agent = new DeepSeekAgent({ saveLog: false });
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
app.listen(PORT, () => console.log(`Gateway HTTP server on port ${PORT}`));