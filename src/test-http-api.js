#!/usr/bin/env node
const http = require('http');

async function testGateway() {
  console.log('🧪 Testing Gateway HTTP API\n');

  const baseUrl = 'http://localhost:8080';

  // Test 1: Health check
  console.log('→ Test 1: GET /health');
  let res = await fetch(baseUrl + '/health');
  let data = await res.json();
  console.log(`  Status: ${res.status}`);
  console.log(`  Response:`, data, '\n');

  // Test 2: Create session
  console.log('→ Test 2: POST /session/create');
  res = await fetch(baseUrl + '/session/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  data = await res.json();
  const sessionId = data.sessionId;
  console.log(`  Status: ${res.status}`);
  console.log(`  Session ID:`, sessionId, '\n');

  if (!sessionId) {
    console.error('✗ Failed to create session');
    process.exit(1);
  }

  // Test 3: Send a simple prompt
  console.log('→ Test 3: POST /session/:id/chat');
  console.log('  Sending: "Say hello"');
  res = await fetch(baseUrl + `/session/${sessionId}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: 'Say hello in one short sentence.' }),
  });
  data = await res.json();
  console.log(`  Status: ${res.status}`);
  console.log(`  Response text (first 200 chars):`);
  console.log(`    "${(data.text || '').substring(0, 200)}..."\n`);

  if (res.status !== 200) {
    console.error('✗ Request failed:', data);
    process.exit(1);
  }

  // Test 4: Close session
  console.log('→ Test 4: POST /session/:id/close');
  res = await fetch(baseUrl + `/session/${sessionId}/close`, { method: 'POST' });
  data = await res.json();
  console.log(`  Status: ${res.status}`);
  console.log(`  Response:`, data);

  console.log('\n✅ All tests passed!\n');
}

testGateway().catch(err => {
  console.error('✗ Test failed:', err.message);
  process.exit(1);
});