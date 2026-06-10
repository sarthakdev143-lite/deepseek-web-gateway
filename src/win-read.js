#!/usr/bin/env node
// Windows-safe file reader - handles paths with spaces
const fs = require('fs');
const path = require('path');

function winRead(filePath) {
  try {
    // Handle quoted paths
    let cleanPath = filePath.replace(/^["']|["']$/g, '');
    
    // If relative, resolve from current working directory
    if (!path.isAbsolute(cleanPath)) {
      cleanPath = path.resolve(process.cwd(), cleanPath);
    }
    
    const content = fs.readFileSync(cleanPath, 'utf8');
    console.log(content);
    return { success: true, content };
  } catch (err) {
    console.error(`ERROR: ${err.message}`);
    return { success: false, error: err.message };
  }
}

// Execute
const targetPath = process.argv[2];
if (!targetPath) {
  console.error('Usage: node win-read.js "<filepath>"');
  process.exit(1);
}

winRead(targetPath);
