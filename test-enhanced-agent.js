// test-enhanced-agent.js — Test script for enhanced agent
'use strict';

const path = require('path');
const fs = require('fs');
const config = require('./src/config');
const { EnhancedDeepSeekAgent } = require('./src/enhanced-agent');

async function testEnhancedAgent() {
  console.log('=== Testing Enhanced DeepSeek Agent ===\n');
  
  // Create a test workspace
  const testDir = path.join(config.WORKING_DIR, 'test-enhanced-agent');
  if (!fs.existsSync(testDir)) {
    fs.mkdirSync(testDir, { recursive: true });
  }
  
  // Create a simple test task
  const task = `
Create a simple Node.js module that:
1. Exports a function "calculateFibonacci(n)" that returns the nth Fibonacci number
2. Exports a function "isPrime(n)" that returns true if n is prime
3. Add JSDoc comments to both functions
4. Write a test file that tests both functions with at least 5 test cases each
5. Run the tests to verify they pass
  `.trim();
  
  const agent = new EnhancedDeepSeekAgent({
    saveLog: true,
    silent: false,
    enablePlanning: true,
    enableMemory: true,
    enableReflection: true,
    enableProgressTracking: true,
    enableAdaptiveIterations: true,
    enableToolAnalysis: true,
    enableSkillLearning: true,
    workingDir: testDir,
  });
  
  try {
    console.log('Initializing agent...');
    await agent.init();
    
    console.log('\nRunning test task...');
    console.log('Task:', task);
    console.log('\n--- Agent Output ---\n');
    
    const result = await agent.run(task, {
      workingDir: testDir,
      sessionId: `test_${Date.now()}`,
    });
    
    console.log('\n--- Final Result ---');
    console.log(result);
    
    // Check if files were created
    console.log('\n--- Created Files ---');
    const files = fs.readdirSync(testDir, { recursive: true });
    console.log(files);
    
    // Check for test results
    const testFile = path.join(testDir, 'test.js');
    if (fs.existsSync(testFile)) {
      console.log('\n--- Test File Content ---');
      console.log(fs.readFileSync(testFile, 'utf8'));
    }
    
    await agent.shutdown();
    console.log('\n=== Test Completed Successfully ===');
    
  } catch (err) {
    console.error('Test failed:', err.message);
    console.error(err.stack);
    await agent.shutdown().catch(() => {});
    process.exit(1);
  }
}

testEnhancedAgent();