#!/usr/bin/env node
/**
 * audit_exec_usage.js - CI-style guardrail for child_process usage
 * 
 * Scans all JS files for direct child_process imports (bypassing exec_compacted.js)
 * Fails if any unauthorized imports are found.
 * 
 * Usage: node audit_exec_usage.js [--fix] [--strict]
 *   --fix:    Auto-wrap simple exec calls with execCompacted (optional)
 *   --strict: Exit with error code even for warnings
 *   --ci:     CI mode - only outputs JSON result
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE_ROOT = path.join(__dirname, '..', '..');
const EXCLUDED_DIRS = ['node_modules', '.git', '.clawhub', 'logs', 'tool_raw'];
const ALLOWED_FILES = [
  'client/lib/exec_compacted.js',  // The authorized wrapper
  'client/memory/tools/skill_runner.js', // Uses spawn for child process management (legitimate)
];

const DANGEROUS_PATTERNS = [
  { pattern: /require\s*\(\s*['"]child_process['"]\s*\)/, name: 'child_process import', severity: 'ERROR' },
  { pattern: /require\s*\(\s*['"]node:child_process['"]\s*\)/, name: 'node:child_process import', severity: 'ERROR' },
];

const WARNING_PATTERNS = [
  { pattern: /exec\s*\(/, name: 'exec() call', severity: 'WARN' },
  { pattern: /execSync\s*\(/, name: 'execSync() call', severity: 'WARN' },
  { pattern: /execFile\s*\(/, name: 'execFile() call', severity: 'WARN' },
  { pattern: /spawn\s*\(/, name: 'spawn() call', severity: 'INFO' },
];

function findJsFiles(dir, files = []) {
  const items = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const item of items) {
    const fullPath = path.join(dir, item.name);
    const relativePath = path.relative(WORKSPACE_ROOT, fullPath);
    
    if (item.isDirectory()) {
      if (!EXCLUDED_DIRS.includes(item.name) && !item.name.startsWith('.')) {
        findJsFiles(fullPath, files);
      }
    } else if (item.isFile() && item.name.endsWith('.js')) {
      files.push({ fullPath, relativePath });
    }
  }
  
  return files;
}

function analyzeFile(filePath, relativePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const findings = [];
  
  // Skip allowed files for ERROR-level checks
  const isAllowed = ALLOWED_FILES.some(allowed => relativePath.includes(allowed));
  
  lines.forEach((line, index) => {
    // Check for dangerous patterns (imports) - ERROR if not in allowed list
    for (const { pattern, name, severity } of DANGEROUS_PATTERNS) {
      if (pattern.test(line)) {
        // Check if this file is the allowed wrapper
        if (!isAllowed) {
          findings.push({
            line: index + 1,
            column: line.indexOf('require'),
            severity,
            message: `Direct ${name} detected - bypasses exec_compacted.js`,
            code: line.trim(),
            fix: 'Use execCompacted() or execFileCompacted() from client/lib/exec_compacted.js'
          });
        }
      }
    }
    
    // Check for warning patterns (usage) - WARN regardless of file
    for (const { pattern, name, severity } of WARNING_PATTERNS) {
      if (pattern.test(line)) {
        // Don't warn about comments
        if (!line.trim().startsWith('//') && !line.trim().startsWith('*')) {
          findings.push({
            line: index + 1,
            column: line.search(pattern),
            severity,
            message: `${name} detected`,
            code: line.trim(),
            fix: severity === 'WARN' ? 'Verify this uses exec_compacted.js wrapper' : null
          });
        }
      }
    }
  });
  
  return findings;
}

function runAudit(options = {}) {
  const { fix = false, strict = false, ci = false } = options;
  
  const jsFiles = findJsFiles(WORKSPACE_ROOT);
  const results = [];
  let totalErrors = 0;
  let totalWarnings = 0;
  let totalInfo = 0;
  
  for (const { fullPath, relativePath } of jsFiles) {
    const findings = analyzeFile(fullPath, relativePath);
    
    if (findings.length > 0) {
      results.push({ file: relativePath, findings });
      
      for (const f of findings) {
        if (f.severity === 'ERROR') totalErrors++;
        else if (f.severity === 'WARN') totalWarnings++;
        else if (f.severity === 'INFO') totalInfo++;
      }
    }
  }
  
  // Output results
  if (ci) {
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      summary: { errors: totalErrors, warnings: totalWarnings, info: totalInfo, files: results.length },
      results
    }, null, 2));
  } else {
    console.log('╔════════════════════════════════════════════════════════════════╗');
    console.log('║     EXEC USAGE AUDIT RESULTS                                   ║');
    console.log('╚════════════════════════════════════════════════════════════════╝');
    console.log();
    console.log(`Files scanned: ${jsFiles.length}`);
    console.log(`Files with issues: ${results.length}`);
    console.log();
    
    if (results.length === 0) {
      console.log('✅ No direct child_process imports found. All exec calls route through exec_compacted.js');
    } else {
      for (const { file, findings } of results) {
        console.log(`\n📄 ${file}`);
        console.log('─'.repeat(60));
        
        for (const f of findings) {
          const icon = f.severity === 'ERROR' ? '❌' : f.severity === 'WARN' ? '⚠️' : 'ℹ️';
          console.log(`  ${icon} Line ${f.line}: ${f.message}`);
          console.log(`     Code: ${f.code.substring(0, 60)}${f.code.length > 60 ? '...' : ''}`);
          if (f.fix) {
            console.log(`     Fix:  ${f.fix}`);
          }
        }
      }
    }
    
    console.log('\n' + '═'.repeat(60));
    console.log(`Summary: ${totalErrors} errors, ${totalWarnings} warnings, ${totalInfo} info`);
    
    if (totalErrors === 0 && totalWarnings === 0) {
      console.log('✅ AUDIT PASSED');
    } else if (totalErrors === 0) {
      console.log('⚠️  AUDIT PASSED WITH WARNINGS');
    } else {
      console.log('❌ AUDIT FAILED');
    }
  }
  
  // Exit codes: 0 = pass, 1 = fail (errors), 2 = warnings only (strict mode)
  if (totalErrors > 0) {
    process.exit(1);
  } else if (strict && totalWarnings > 0) {
    process.exit(2);
  } else {
    process.exit(0);
  }
}

// CLI entry point
function main() {
  const args = process.argv.slice(2);
  const options = {
    fix: args.includes('--fix'),
    strict: args.includes('--strict'),
    ci: args.includes('--ci')
  };
  
  runAudit(options);
}

if (require.main === module) {
  main();
}

module.exports = { runAudit, analyzeFile, findJsFiles };