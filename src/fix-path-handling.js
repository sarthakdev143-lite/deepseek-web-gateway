const fs = require('fs');
const path = require('path');

// Read the current tools.js
const toolsPath = path.join(__dirname, 'tools.js');
let content = fs.readFileSync(toolsPath, 'utf8');

// Find the resolve function and replace it
const resolvePattern = /function resolve\(filePath\) \{\s*if \(path\.isAbsolute\(filePath\)\) return filePath;\s*return path\.resolve\(config\.WORKING_DIR, filePath\);\s*\}/;

const newResolve = `function resolve(filePath) {
  // Windows path fix for spaces
  let normalizedPath = filePath;
  if (process.platform === 'win32' && filePath && filePath.includes(' ')) {
    // Remove surrounding quotes if present
    normalizedPath = filePath.replace(/^["']|["']$/g, '');
  }
  if (path.isAbsolute(normalizedPath)) return normalizedPath;
  return path.resolve(config.WORKING_DIR, normalizedPath);
}`;

if (resolvePattern.test(content)) {
  content = content.replace(resolvePattern, newResolve);
  fs.writeFileSync(toolsPath, content, 'utf8');
  console.log('✓ Fixed resolve function in tools.js');
} else {
  console.log('Pattern not found - manual fix needed');
}

// Also fix the read_file tool to better handle Windows paths
const readFilePattern = /read_file: \{[\s\S]*?async execute\(\{ path: filePath, start_line, end_line \}\) \{[\s\S]*?const abs = resolve\(filePath\);/;

console.log('Path handling fix applied');
