// src/subagent-worker.js — Sub-agent worker process
// This runs in a separate Node.js process to execute delegated subtasks
'use strict';

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// Load task from file (passed as command line argument)
// ─────────────────────────────────────────────────────────────────────────────

const taskFile = process.argv[2];
if (!taskFile || !fs.existsSync(taskFile)) {
  console.error('Task file not provided or not found:', taskFile);
  process.exit(1);
}

let taskData;
try {
  taskData = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
} catch (err) {
  console.error('Failed to parse task file:', err.message);
  process.exit(1);
}

const { task, subtask, workingDir, config, parentSessionId } = taskData;
const subAgentId = process.env.SUBAGENT_ID;

// ─────────────────────────────────────────────────────────────────────────────
// Setup working directory
// ─────────────────────────────────────────────────────────────────────────────

process.chdir(workingDir);

// ─────────────────────────────────────────────────────────────────────────────
// IPC Communication with parent
// ─────────────────────────────────────────────────────────────────────────────

function sendToParent(type, payload) {
  if (process.connected) {
    process.send({ type, payload, from: subAgentId, timestamp: new Date().toISOString() });
  }
}

function log(message) {
  sendToParent('log', message);
}

function progress(message) {
  sendToParent('progress', message);
}

function sendResult(result) {
  sendToParent('result', result);
  // Also write to output file
  const outputFile = path.join(__dirname, '..', '.seekcode', 'subagents', `${subAgentId}_output.json`);
  try {
    fs.writeFileSync(outputFile, JSON.stringify(result, null, 2), 'utf8');
  } catch {}
}

function sendError(error) {
  sendToParent('error', error);
}

// ─────────────────────────────────────────────────────────────────────────────
// Simplified Agent Implementation for Sub-Agent
// ─────────────────────────────────────────────────────────────────────────────

class SubAgentRunner {
  constructor() {
    this.iteration = 0;
    this.maxIterations = config.maxIterations || 50;
    this.conversation = [];
    this.tools = this._initTools();
  }

  _initTools() {
    // Import tools from the main package
    const toolsPath = path.join(__dirname, 'tools');
    let toolsModule;
    try {
      toolsModule = require(toolsPath);
    } catch {
      // Fallback to local tools
      toolsModule = require('./tools');
    }
    
    return {
      read_file: toolsModule.executeTool?.bind(null, 'read_file') || this._stubTool('read_file'),
      write_file: toolsModule.executeTool?.bind(null, 'write_file') || this._stubTool('write_file'),
      replace_in_file: toolsModule.executeTool?.bind(null, 'replace_in_file') || this._stubTool('replace_in_file'),
      run_command: toolsModule.executeTool?.bind(null, 'run_command') || this._stubTool('run_command'),
      list_directory: toolsModule.executeTool?.bind(null, 'list_directory') || this._stubTool('list_directory'),
      find_files: toolsModule.executeTool?.bind(null, 'find_files') || this._stubTool('find_files'),
      search_files: toolsModule.executeTool?.bind(null, 'search_files') || this._stubTool('search_files'),
      get_file_info: toolsModule.executeTool?.bind(null, 'get_file_info') || this._stubTool('get_file_info'),
    };
  }

  _stubTool(name) {
    return async (...args) => {
      log(`Tool ${name} called with: ${JSON.stringify(args)}`);
      return `Tool ${name} not available in sub-agent context`;
    };
  }

  async run() {
    log(`Starting sub-agent for task: ${task}`);
    progress(`Initializing in ${workingDir}`);
    
    // Build initial prompt
    const prompt = this._buildPrompt();
    
    try {
      for (this.iteration = 1; this.iteration <= this.maxIterations; this.iteration++) {
        progress(`Iteration ${this.iteration}/${this.maxIterations}`);
        
        // Call the LLM (via the same browser automation or direct API)
        const response = await this._callLLM(prompt);
        
        // Parse response for tool calls or final answer
        const parsed = this._parseResponse(response);
        
        if (parsed.type === 'tool_calls' || parsed.type === 'tool_call') {
          const calls = parsed.type === 'tool_calls' ? parsed.calls : [parsed];
          
          for (const call of calls) {
            log(`Executing tool: ${call.name}`);
            try {
              const tool = this.tools[call.name];
              if (!tool) {
                throw new Error(`Unknown tool: ${call.name}`);
              }
              
              const result = await tool(call.args);
              this.conversation.push({ role: 'tool', name: call.name, content: String(result) });
              progress(`${call.name} completed`);
            } catch (err) {
              log(`Tool error: ${err.message}`);
              this.conversation.push({ role: 'tool', name: call.name, content: `Error: ${err.message}`, isError: true });
            }
          }
        } else if (parsed.type === 'final') {
          log(`Task completed: ${parsed.content.slice(0, 100)}...`);
          sendResult({
            success: true,
            output: parsed.content,
            iterations: this.iteration,
            subtask: subtask?.id,
          });
          return;
        } else {
          log(`Parse error: ${parsed.message}`);
          this.conversation.push({ role: 'user', content: `Parse error: ${parsed.message}. Please respond with valid tool_call or final output.` });
        }
      }
      
      // Max iterations reached
      sendResult({
        success: false,
        output: 'Max iterations reached',
        iterations: this.iteration,
        subtask: subtask?.id,
      });
      
    } catch (err) {
      log(`Fatal error: ${err.message}`);
      sendError(err.message);
      sendResult({
        success: false,
        output: `Fatal error: ${err.message}`,
        error: err.message,
        subtask: subtask?.id,
      });
      process.exit(1);
    }
  }

  _buildPrompt() {
    return `You are a sub-agent executing a specific subtask.

PARENT TASK: ${task}
YOUR SUBTASK: ${subtask?.description || task}
SUBTASK TYPE: ${subtask?.type || 'code'}
WORKING DIRECTORY: ${workingDir}

Available tools:
- read_file(path, start_line?, end_line?)
- write_file(path, content)
- replace_in_file(path, find, replace, use_regex?, all_occurrences?)
- run_command(command, timeout?, background?)
- list_directory(path?, recursive?)
- find_files(pattern, directory?, case_sensitive?, context_lines?)
- search_files(query, path?, case_sensitive?)
- get_file_info(path)

Output format:
For tool calls:
\`\`\`tool_call
{"name": "tool_name", "args": {...}}
\`\`\`

For final answer:
\`\`\`final
Your final response here
\`\`\`

Focus on completing ONLY your assigned subtask. Be concise.`;
  }

  async _callLLM(prompt) {
    // In a real implementation, this would call the LLM via the same mechanism
    // For now, we'll use a simplified approach - could use a direct API call
    // or communicate back to parent for LLM access
    
    // Request LLM response from parent
    return new Promise((resolve) => {
      const requestId = `llm_${Date.now()}`;
      
      const handler = (msg) => {
        if (msg.type === 'llm_response' && msg.requestId === requestId) {
          process.off('message', handler);
          resolve(msg.payload);
        }
      };
      
      process.on('message', handler);
      
      sendToParent('llm_request', { prompt, requestId, conversation: this.conversation });
      
      // Timeout
      setTimeout(() => {
        process.off('message', handler);
        resolve('{"type": "final", "content": "LLM request timed out"}');
      }, 60000);
    });
  }

  _parseResponse(response) {
    // Try to parse tool_call blocks
    const toolCallRegex = /```tool_call\s*(\{[\s\S]*?\})\s*```/g;
    const matches = [...response.matchAll(toolCallRegex)];
    
    if (matches.length > 0) {
      const calls = matches.map(m => {
        try {
          return JSON.parse(m[1]);
        } catch {
          return null;
        }
      }).filter(Boolean);
      
      if (calls.length === 1) {
        return { type: 'tool_call', ...calls[0] };
      }
      return { type: 'tool_calls', calls };
    }
    
    // Try final block
    const finalMatch = response.match(/```final\s*([\s\S]*?)\s*```/);
    if (finalMatch) {
      return { type: 'final', content: finalMatch[1].trim() };
    }
    
    // Check if it looks like a plain final answer (no tool calls)
    if (!response.includes('tool_call') && response.length > 10) {
      return { type: 'final', content: response.trim() };
    }
    
    return { type: 'error', message: 'Could not parse response' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handle Parent Messages
// ─────────────────────────────────────────────────────────────────────────────

process.on('message', (msg) => {
  if (msg.type === 'terminate') {
    log(`Termination requested: ${msg.payload?.reason}`);
    process.exit(0);
  }
  
  if (msg.type === 'status_request') {
    sendToParent('status_response', {
      requestId: msg.payload.requestId,
      status: runner?.iteration || 0,
      iteration: runner?.iteration || 0,
    });
  }
  
  if (msg.type === 'llm_response') {
    // Handled by promise in _callLLM
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────────────────────────────────────

const runner = new SubAgentRunner();
runner.run().catch(err => {
  log(`Runner crashed: ${err.message}`);
  sendError(err.message);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  log('Received SIGTERM');
  process.exit(0);
});

process.on('SIGINT', () => {
  log('Received SIGINT');
  process.exit(0);
});