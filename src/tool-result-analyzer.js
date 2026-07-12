// src/tool-result-analyzer.js — Tool Result Analysis and Summarization
'use strict';

const config = require('./config');

// ─────────────────────────────────────────────────────────────────────────────
// ToolResultAnalyzer Class
// ─────────────────────────────────────────────────────────────────────────────

class ToolResultAnalyzer {
  constructor(options = {}) {
    this.maxSummaryLength = options.maxSummaryLength || config.TOOL_SUMMARY_MAX_LENGTH || 500;
    this.enableDetailedAnalysis = options.enableDetailedAnalysis !== false;
    
    // Statistics
    this.stats = {
      totalCalls: 0,
      totalErrors: 0,
      byTool: {},
      byOutcome: { success: 0, error: 0, partial: 0 },
      totalOutputSize: 0,
      totalDurationMs: 0,
    };
    
    // Pattern recognition
    this.patterns = {
      commonErrors: new Map(),
      successfulPatterns: new Map(),
      outputTypes: new Map(),
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Main Analysis
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Analyze a tool result and produce a summary
   */
  analyze(toolName, args, result, isError, durationMs = 0) {
    this._updateStats(toolName, isError, result, durationMs);
    
    const analysis = {
      toolName,
      args: this._sanitizeArgs(args),
      isError,
      durationMs,
      timestamp: new Date().toISOString(),
      summary: '',
      keyFindings: [],
      outputType: 'unknown',
      outputSize: 0,
      actionable: false,
      suggestedNextSteps: [],
    };
    
    if (isError) {
      analysis.summary = this._analyzeError(toolName, args, result);
      analysis.keyFindings = this._extractErrorInsights(toolName, result);
      analysis.suggestedNextSteps = this._suggestErrorRecovery(toolName, result);
    } else {
      analysis.summary = this._analyzeSuccess(toolName, args, result);
      analysis.keyFindings = this._extractSuccessInsights(toolName, args, result);
      analysis.outputType = this._classifyOutput(result);
      analysis.outputSize = this._estimateOutputSize(result);
      analysis.actionable = this._isActionable(toolName, result);
      analysis.suggestedNextSteps = this._suggestNextSteps(toolName, args, result);
    }
    
    // Track patterns
    this._trackPatterns(toolName, analysis);
    
    return analysis;
  }

  /**
   * Analyze a batch of tool results
   */
  analyzeBatch(results) {
    return results.map(r => this.analyze(r.toolName, r.args, r.result, r.isError, r.durationMs));
  }

  /**
   * Generate a combined summary for multiple tool results
   */
  generateBatchSummary(analyses) {
    if (!analyses || analyses.length === 0) return 'No tool results to summarize.';
    
    const errors = analyses.filter(a => a.isError);
    const successes = analyses.filter(a => !a.isError);
    
    let summary = `TOOL BATCH SUMMARY (${analyses.length} calls: ${successes.length} succeeded, ${errors.length} failed)\n\n`;
    
    // Errors first
    if (errors.length > 0) {
      summary += `ERRORS (${errors.length}):\n`;
      for (const err of errors) {
        summary += `  ✗ ${err.toolName}: ${err.summary.slice(0, 100)}\n`;
      }
      summary += '\n';
    }
    
    // Successes grouped by tool
    const byTool = this._groupBy(successes, 'toolName');
    for (const [toolName, toolResults] of Object.entries(byTool)) {
      summary += `${toolName.toUpperCase()} (${toolResults.length}):\n`;
      for (const res of toolResults.slice(0, 3)) {
        summary += `  ✓ ${res.summary.slice(0, 120)}\n`;
      }
      if (toolResults.length > 3) {
        summary += `  ... and ${toolResults.length - 3} more\n`;
      }
      summary += '\n';
    }
    
    // Key findings
    const allFindings = analyses.flatMap(a => a.keyFindings);
    if (allFindings.length > 0) {
      summary += `KEY FINDINGS:\n`;
      for (const finding of allFindings.slice(0, 5)) {
        summary += `  • ${finding}\n`;
      }
      summary += '\n';
    }
    
    // Next steps
    const allSteps = analyses.flatMap(a => a.suggestedNextSteps);
    if (allSteps.length > 0) {
      summary += `SUGGESTED NEXT STEPS:\n`;
      for (const step of allSteps.slice(0, 5)) {
        summary += `  → ${step}\n`;
      }
    }
    
    return summary.trim();
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Error Analysis
  // ─────────────────────────────────────────────────────────────────────────────

  _analyzeError(toolName, args, error) {
    const errorStr = String(error);
    
    // Tool-specific error analysis
    switch (toolName) {
      case 'read_file':
        if (errorStr.includes('ENOENT') || errorStr.includes('not found')) {
          return `File not found: ${args.path || 'unknown path'}`;
        }
        if (errorStr.includes('EACCES') || errorStr.includes('permission')) {
          return `Permission denied reading: ${args.path}`;
        }
        if (errorStr.includes('is a directory')) {
          return `Path is a directory, not a file: ${args.path}`;
        }
        return `Read failed: ${errorStr.slice(0, 100)}`;
        
      case 'write_file':
      case 'replace_in_file':
      case 'append_to_file':
        if (errorStr.includes('ENOENT')) {
          return `Parent directory missing for: ${args.path}`;
        }
        if (errorStr.includes('EACCES') || errorStr.includes('permission')) {
          return `Permission denied writing: ${args.path}`;
        }
        if (errorStr.includes('no matches found') || errorStr.includes('matched')) {
          return `Pattern not found in file: ${args.path}`;
        }
        if (errorStr.includes('matched') && errorStr.includes('location')) {
          return `Pattern matches multiple locations in: ${args.path} (need more context)`;
        }
        return `Write failed: ${errorStr.slice(0, 100)}`;
        
      case 'run_command':
        if (errorStr.includes('ENOENT') || errorStr.includes('command not found')) {
          return `Command not found: ${args.command?.split(' ')[0] || 'unknown'}`;
        }
        if (errorStr.includes('timeout') || errorStr.includes('ETIMEDOUT')) {
          return `Command timed out after ${args.timeout || 'default'}ms`;
        }
        if (errorStr.includes('exit code')) {
          const codeMatch = errorStr.match(/exit code[:\s]+(\d+)/i);
          return `Command failed with exit code ${codeMatch?.[1] || 'unknown'}: ${args.command?.slice(0, 50)}`;
        }
        return `Command failed: ${errorStr.slice(0, 100)}`;
        
      case 'list_directory':
      case 'find_files':
        if (errorStr.includes('ENOENT')) {
          return `Directory not found: ${args.path || args.directory || 'unknown'}`;
        }
        return `Directory listing failed: ${errorStr.slice(0, 100)}`;
        
      case 'search_files':
      case 'search_in_file':
        return `Search failed: ${errorStr.slice(0, 100)}`;
        
      default:
        return `${toolName} error: ${errorStr.slice(0, 150)}`;
    }
  }

  _extractErrorInsights(toolName, error) {
    const insights = [];
    const errorStr = String(error);
    
    // Categorize error
    if (errorStr.includes('ENOENT') || errorStr.includes('not found')) {
      insights.push('Resource not found - verify paths exist');
    }
    if (errorStr.includes('EACCES') || errorStr.includes('permission')) {
      insights.push('Permission issue - check file/directory permissions');
    }
    if (errorStr.includes('timeout') || errorStr.includes('ETIMEDOUT')) {
      insights.push('Operation timed out - consider increasing timeout or optimizing');
    }
    if (errorStr.includes('no matches') || errorStr.includes('matched.*location')) {
      insights.push('Pattern matching issue - pattern not unique or not found');
    }
    if (errorStr.includes('exit code')) {
      insights.push('Command execution failed - check command syntax and dependencies');
    }
    if (errorStr.includes('JSON') || errorStr.includes('parse')) {
      insights.push('JSON parsing error - verify output format');
    }
    
    // Track common errors
    const errorKey = `${toolName}:${insights[0] || 'unknown'}`;
    this.patterns.commonErrors.set(errorKey, (this.patterns.commonErrors.get(errorKey) || 0) + 1);
    
    return insights;
  }

  _suggestErrorRecovery(toolName, error) {
    const steps = [];
    const errorStr = String(error);
    
    if (errorStr.includes('ENOENT') || errorStr.includes('not found')) {
      steps.push('Verify the path exists using list_directory or find_files');
      steps.push('Check working directory and relative paths');
    }
    if (errorStr.includes('EACCES') || errorStr.includes('permission')) {
      steps.push('Check file permissions');
      steps.push('Try running with appropriate permissions');
    }
    if (errorStr.includes('no matches') || errorStr.includes('matched.*location')) {
      steps.push('Read the file first to see exact content');
      steps.push('Use more context in find pattern to make it unique');
      steps.push('Consider using all_occurrences: true if bulk replace intended');
    }
    if (errorStr.includes('timeout') || errorStr.includes('ETIMEDOUT')) {
      steps.push('Increase timeout parameter');
      steps.push('Break command into smaller steps');
    }
    if (errorStr.includes('exit code')) {
      steps.push('Run command with verbose output to diagnose');
      steps.push('Check command syntax and available dependencies');
    }
    
    if (steps.length === 0) {
      steps.push('Review error details and adjust approach');
      steps.push('Consider alternative tool or method');
    }
    
    return steps.slice(0, 3);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Success Analysis
  // ─────────────────────────────────────────────────────────────────────────────

  _analyzeSuccess(toolName, args, result) {
    const resultStr = String(result);
    const size = resultStr.length;
    
    // Tool-specific summaries
    switch (toolName) {
      case 'read_file':
        const lines = resultStr.match(/^\[\S+ \|\s*(\d+)\s*lines?/m);
        const lineCount = lines ? lines[1] : resultStr.split('\n').length;
        return `Read ${lineCount} lines from ${args.path}`;
        
      case 'write_file':
        const bytes = resultStr.match(/Wrote\s+([\d.]+\s*\w+)/i);
        return `Wrote file: ${args.path} (${bytes ? bytes[1] : 'unknown size'})`;
        
      case 'replace_in_file':
        const replaced = resultStr.match(/Replaced\s+(\d+)\s+of\s+(\d+)/i);
        return replaced 
          ? `Replaced ${replaced[1]} of ${replaced[2]} occurrences in ${args.path}`
          : `Modified file: ${args.path}`;
          
      case 'append_to_file':
        return `Appended to: ${args.path}`;
        
      case 'delete_file':
        return `Deleted: ${args.path}`;
        
      case 'run_command':
        const exitCode = resultStr.match(/exit code[:\s]+(\d+)/i);
        const hasOutput = resultStr.length > 50;
        return `Command ${exitCode && exitCode[1] === '0' ? 'succeeded' : 'failed'} (exit ${exitCode?.[1] || 'unknown'})${hasOutput ? ' with output' : ''}: ${args.command?.slice(0, 40)}...`;
        
      case 'list_directory':
        const items = resultStr.split('\n').filter(l => l.trim()).length;
        return `Listed ${items} items in ${args.path || 'working directory'}`;
        
      case 'find_files':
        const matches = resultStr.split('\n').filter(l => l.trim() && !l.startsWith('[')).length;
        return `Found ${matches} files matching "${args.pattern}"`;
        
      case 'search_files':
      case 'search_in_file':
        const matchCount = resultStr.match(/(\d+)\s+match/);
        return `Found ${matchCount ? matchCount[1] : 'multiple'} matches for "${args.query}"`;
        
      case 'get_file_info':
        return `Got metadata for: ${args.path}`;
        
      default:
        return `${toolName} completed (${this._formatSize(size)})`;
    }
  }

  _extractSuccessInsights(toolName, args, result) {
    const insights = [];
    const resultStr = String(result);
    
    // Tool-specific insights
    switch (toolName) {
      case 'read_file':
        if (resultStr.includes('lines')) {
          const lines = parseInt(resultStr.match(/(\d+)\s*lines/)?.[1] || '0');
          if (lines > 1000) insights.push(`Large file (${lines} lines) - consider reading in sections`);
          if (lines < 10) insights.push('Small file - good for full context');
        }
        if (resultStr.includes('export') || resultStr.includes('function') || resultStr.includes('class')) {
          insights.push('File contains code definitions - useful for understanding structure');
        }
        break;
        
      case 'run_command':
        if (resultStr.includes('PASS') || resultStr.includes('passed') || resultStr.includes('✓')) {
          insights.push('Tests/command passed successfully');
        }
        if (resultStr.includes('FAIL') || resultStr.includes('failed') || resultStr.includes('✗')) {
          insights.push('Tests/command failed - review output for details');
        }
        if (resultStr.includes('warning') || resultStr.includes('WARN')) {
          insights.push('Warnings present - may indicate issues');
        }
        if (resultStr.length > 5000) {
          insights.push('Large output - consider filtering or paging');
        }
        break;
        
      case 'search_files':
      case 'search_in_file':
        const matches = resultStr.match(/(\d+)\s+match/);
        if (matches && parseInt(matches[1]) > 20) {
          insights.push(`Many matches (${matches[1]}) - refine search query`);
        }
        if (matches && parseInt(matches[1]) === 0) {
          insights.push('No matches found - try different query or check file paths');
        }
        break;
        
      case 'list_directory':
      case 'find_files':
        const count = resultStr.split('\n').filter(l => l.trim() && !l.startsWith('[')).length;
        if (count > 50) insights.push(`Large directory (${count} items) - consider filtering`);
        break;
    }
    
    // Track successful patterns
    const patternKey = `${toolName}:${insights[0] || 'success'}`;
    this.patterns.successfulPatterns.set(patternKey, (this.patterns.successfulPatterns.get(patternKey) || 0) + 1);
    
    return insights;
  }

  _suggestNextSteps(toolName, args, result) {
    const steps = [];
    const resultStr = String(result);
    
    switch (toolName) {
      case 'read_file':
        if (resultStr.length > 3000) {
          steps.push('Use start_line/end_line to read specific sections');
        }
        steps.push('Search within file for specific patterns');
        steps.push('Check related files in same directory');
        break;
        
      case 'write_file':
      case 'replace_in_file':
        steps.push('Verify changes with read_file');
        steps.push('Run tests to validate modifications');
        steps.push('Check for related files that may need updates');
        break;
        
      case 'run_command':
        if (resultStr.includes('FAIL') || resultStr.includes('failed')) {
          steps.push('Analyze error output for root cause');
          steps.push('Run specific failing test in isolation');
        } else {
          steps.push('Verify output meets expectations');
          steps.push('Run related tests or validation');
        }
        break;
        
      case 'search_files':
      case 'search_in_file':
        steps.push('Read relevant files to understand context');
        steps.push('Refine search if too many/few results');
        break;
        
      case 'list_directory':
      case 'find_files':
        steps.push('Read key files to understand codebase');
        steps.push('Look for configuration or entry point files');
        break;
    }
    
    return steps.slice(0, 3);
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Classification & Helpers
  // ─────────────────────────────────────────────────────────────────────────────

  _classifyOutput(result) {
    const str = String(result);
    
    if (str.includes('```') || str.match(/^(function|class|const|let|var|import|export)\s/m)) return 'code';
    if (str.match(/^\[.*\|\s*\d+\s*lines?\]/m)) return 'file_content';
    if (str.includes('exit code') || str.includes('STDOUT') || str.includes('STDERR')) return 'command_output';
    if (str.match(/^\s*[-*]\s/m) || str.match(/^\s*\d+\.\s/m)) return 'list';
    if (str.startsWith('{') && str.endsWith('}')) return 'json';
    if (str.includes('error') || str.includes('Error') || str.includes('Exception')) return 'error';
    if (str.length < 200) return 'short_text';
    return 'text';
  }

  _estimateOutputSize(result) {
    return String(result).length;
  }

  _isActionable(toolName, result) {
    const str = String(result);
    
    // Read operations are actionable if they reveal something to act on
    if (toolName === 'read_file') {
      return str.includes('TODO') || str.includes('FIXME') || str.includes('BUG') || 
             str.includes('error') || str.includes('Error') || str.length > 100;
    }
    
    // Search operations are actionable if they found something
    if (toolName === 'search_files' || toolName === 'search_in_file') {
      return !str.includes('0 match');
    }
    
    // Commands are actionable if they produced output
    if (toolName === 'run_command') {
      return str.length > 50;
    }
    
    // Write operations are actionable by nature (they change state)
    if (['write_file', 'replace_in_file', 'append_to_file', 'delete_file'].includes(toolName)) {
      return true;
    }
    
    return false;
  }

  _sanitizeArgs(args) {
    if (!args) return {};
    const sanitized = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.length > 200) {
        sanitized[key] = value.slice(0, 200) + '...[truncated]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = '[object]';
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  _formatSize(bytes) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }

  _groupBy(array, key) {
    return array.reduce((groups, item) => {
      const groupKey = item[key];
      if (!groups[groupKey]) groups[groupKey] = [];
      groups[groupKey].push(item);
      return groups;
    }, {});
  }

  _trackPatterns(toolName, analysis) {
    const outputType = analysis.outputType;
    this.patterns.outputTypes.set(outputType, (this.patterns.outputTypes.get(outputType) || 0) + 1);
  }

  _updateStats(toolName, isError, result, durationMs) {
    this.stats.totalCalls++;
    this.stats.totalDurationMs += durationMs;
    this.stats.totalOutputSize += String(result).length;
    
    if (!this.stats.byTool[toolName]) {
      this.stats.byTool[toolName] = { calls: 0, errors: 0, totalDuration: 0, totalSize: 0 };
    }
    this.stats.byTool[toolName].calls++;
    this.stats.byTool[toolName].totalDuration += durationMs;
    this.stats.byTool[toolName].totalSize += String(result).length;
    
    if (isError) {
      this.stats.totalErrors++;
      this.stats.byTool[toolName].errors++;
      this.stats.byOutcome.error++;
    } else {
      this.stats.byOutcome.success++;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Statistics & Reporting
  // ─────────────────────────────────────────────────────────────────────────────

  getStats() {
    return {
      ...this.stats,
      errorRate: this.stats.totalCalls > 0 
        ? (this.stats.totalErrors / this.stats.totalCalls * 100).toFixed(1) + '%'
        : '0%',
      avgDurationMs: this.stats.totalCalls > 0
        ? Math.round(this.stats.totalDurationMs / this.stats.totalCalls)
        : 0,
      avgOutputSize: this.stats.totalCalls > 0
        ? Math.round(this.stats.totalOutputSize / this.stats.totalCalls)
        : 0,
      topTools: Object.entries(this.stats.byTool)
        .sort((a, b) => b[1].calls - a[1].calls)
        .slice(0, 10)
        .map(([name, data]) => ({
          name,
          calls: data.calls,
          errors: data.errors,
          errorRate: data.calls > 0 ? (data.errors / data.calls * 100).toFixed(1) + '%' : '0%',
          avgMs: data.calls > 0 ? Math.round(data.totalDuration / data.calls) : 0,
        })),
      commonErrors: Array.from(this.patterns.commonErrors.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([pattern, count]) => ({ pattern, count })),
      successfulPatterns: Array.from(this.patterns.successfulPatterns.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([pattern, count]) => ({ pattern, count })),
      outputTypes: Object.fromEntries(this.patterns.outputTypes),
    };
  }

  reset() {
    this.stats = {
      totalCalls: 0,
      totalErrors: 0,
      byTool: {},
      byOutcome: { success: 0, error: 0, partial: 0 },
      totalOutputSize: 0,
      totalDurationMs: 0,
    };
    this.patterns = {
      commonErrors: new Map(),
      successfulPatterns: new Map(),
      outputTypes: new Map(),
    };
  }
}

module.exports = { ToolResultAnalyzer };