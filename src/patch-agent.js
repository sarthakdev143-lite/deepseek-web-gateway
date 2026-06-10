const fs = require('fs');
const path = require('path');

const agentPath = path.join(__dirname, 'agent.js');
let content = fs.readFileSync(agentPath, 'utf8');

// Add Windows path fix to the executeTool function or where read_file is handled
const windowsFix = `
// WINDOWS PATH FIX: If on Windows and path has spaces, try alternative method
if (process.platform === 'win32' && filePath && filePath.includes(' ')) {
  try {
    // First attempt with original resolve
    let abs = resolve(filePath);
    if (fs.existsSync(abs)) {
      // Continue normal flow
    } else {
      // Fallback: use spawn to read via wrapper
      const { execSync } = require('child_process');
      const wrapperPath = path.join(__dirname, 'win-read.js');
      const result = execSync(\`node "\${wrapperPath}" "\${filePath}"\`, { encoding: 'utf8', stdio: 'pipe' });
      return result;
    }
  } catch(e) {
    // Fall through to normal error handling
  }
}
`;

// Insert before the resolve call in read_file
const readFilePattern = /read_file: \{[\s\S]*?async execute\(\{ path: filePath, start_line, end_line \}\) \{[\s\S]*?const abs = resolve\(filePath\);/;

if (readFilePattern.test(content)) {
  content = content.replace(readFilePattern, (match) => {
    return match.replace('const abs = resolve(filePath);', windowsFix + '\n  const abs = resolve(filePath);');
  });
  fs.writeFileSync(agentPath, content, 'utf8');
  console.log('✓ Patched agent.js with Windows path fallback');
} else {
  console.log('Could not find read_file pattern in agent.js');
  // Alternative: patch the tools.js resolve function directly
  const toolsPath = path.join(__dirname, 'tools.js');
  let toolsContent = fs.readFileSync(toolsPath, 'utf8');
  const enhancedResolve = `function resolve(filePath) {
  // Windows: handle spaces by normalizing and checking existence
  let normalizedPath = filePath;
  if (process.platform === 'win32' && filePath && filePath.includes(' ')) {
    normalizedPath = filePath.replace(/^[\"']|[\"']$/g, '');
    // If normalized path doesn't exist but original might via short name, try exec
    if (!fs.existsSync(normalizedPath) && fs.existsSync(filePath)) {
      return filePath;
    }
  }
  if (path.isAbsolute(normalizedPath)) return normalizedPath;
  return path.resolve(config.WORKING_DIR, normalizedPath);
}`;
  
  const oldResolve = /function resolve\(filePath\) \{[\s\S]*?\n\}/;
  if (oldResolve.test(toolsContent)) {
    toolsContent = toolsContent.replace(oldResolve, enhancedResolve);
    fs.writeFileSync(toolsPath, toolsContent, 'utf8');
    console.log('✓ Enhanced resolve function in tools.js');
  }
}
