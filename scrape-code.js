const fs = require('fs');
const path = require('path');

// Files and folders to include
const includeExtensions = ['.js', '.html', '.css', '.json', '.md', '.ps1', '.bat'];
const excludeDirs = ['node_modules', 'dist', '.git', 'data', '__pycache__', 'venv'];
const excludeFiles = ['scrape-code.js', 'package-lock.json', 'codebase.txt', 'prompt.md', 'README.md', '.gitignore', 'LICENSE'];

let output = [];
let fileCount = 0;

function shouldInclude(filePath) {
    const ext = path.extname(filePath);
    const fileName = path.basename(filePath);

    // Check if file should be excluded
    if (excludeFiles.includes(fileName)) return false;

    // Check extension
    if (!includeExtensions.includes(ext)) return false;

    // Check if in excluded directory
    const relativePath = path.relative(__dirname, filePath);
    const parts = relativePath.split(path.sep);
    for (const part of parts) {
        if (excludeDirs.includes(part)) return false;
    }

    return true;
}

function readFileContent(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        return `// Error reading file: ${err.message}`;
    }
}

function crawlDirectory(dirPath, baseDir = dirPath) {
    const items = fs.readdirSync(dirPath);

    for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            crawlDirectory(fullPath, baseDir);
        } else if (shouldInclude(fullPath)) {
            const relativePath = path.relative(__dirname, fullPath);
            const content = readFileContent(fullPath);

            output.push(`\n${'='.repeat(80)}`);
            output.push(`FILE: ${relativePath}`);
            output.push(`${'='.repeat(80)}\n`);
            output.push(content);
            output.push(`\n${'='.repeat(80)}\n`);

            fileCount++;
            console.log(`✓ Added: ${relativePath}`);
        }
    }
}

// Start crawling
console.log('🔍 Crawling codebase...\n');
crawlDirectory(__dirname);

// Add summary at the top
const header = [
    '='.repeat(80),
    `DEEPSEEK WEB GATEWAY - COMPLETE CODEBASE`,
    `Generated: ${new Date().toLocaleString()}`,
    `Total files: ${fileCount}`,
    '='.repeat(80),
    '',
    '📁 Project Structure:',
    ''
];

// Add project structure
function getStructure(dirPath, prefix = '') {
    let structure = '';
    const items = fs.readdirSync(dirPath);

    for (const item of items) {
        const fullPath = path.join(dirPath, item);
        if (excludeDirs.includes(item)) continue;
        if (item === 'scrape-code.js') continue;

        try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                structure += `${prefix}📁 ${item}/\n`;
                structure += getStructure(fullPath, prefix + '  ');
            } else if (includeExtensions.includes(path.extname(item))) {
                structure += `${prefix}📄 ${item}\n`;
            }
        } catch (e) { }
    }
    return structure;
}

const structure = getStructure(__dirname);
const fullOutput = [...header, structure, ...output].join('\n');

// Write to file
fs.writeFileSync('codebase.txt', fullOutput, 'utf8');

console.log(`\n✅ Done! Created codebase.txt with ${fileCount} files`);
console.log(`📄 File size: ${(fs.statSync('codebase.txt').size / 1024).toFixed(2)} KB`);