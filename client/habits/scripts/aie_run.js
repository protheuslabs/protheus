#!/usr/bin/env node
/**
 * aie_run.js - Auto-capture test runs for AIE v1.0.2
 * 
 * Executes commands, captures output to log files, and auto-logs test_run events.
 * Reduces cherry-picking by making capture automatic.
 * 
 * Usage:
 *   node client/habits/scripts/aie_run.js --repo=/path/to/repo -- command arg1 arg2
 * 
 * Example:
 *   node client/habits/scripts/aie_run.js --repo=~/.openclaw/workspace -- node client/memory/tools/tests/aie.test.js
 * 
 * NO autonomy - just captures what actually happened.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');

const AIE_DIR = path.join(__dirname, '..', '..', 'state', 'aie');
const TEST_RUNS_DIR = path.join(AIE_DIR, 'test_runs');

// Ensure directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Generate safe filename from command
function safeName(command) {
  return command.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
}

// Compute SHA256 of file
function computeHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

// Auto-log via aie_logger
function logTestRun(command, exitCode, logPath, logHash, repoRoot) {
  const loggerPath = path.join(__dirname, 'aie_logger.js');
  
  // Build arguments for logger (as array to avoid shell escaping issues)
  const args = [
    loggerPath,
    'log', 'test_run',
    `command=${command}`,
    `exit_code=${exitCode}`,
    `test_log_path=${logPath}`,
    `test_log_sha256=${logHash}`
  ];
  
  if (repoRoot) {
    args.push(`repo_root=${repoRoot}`);
  }
  
  // Execute logger synchronously using spawnSync (no shell escaping issues)
  const { spawnSync } = require('child_process');
  const result = spawnSync('node', args, {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8'
  });
  
  if (result.status === 0) {
    return { success: true, output: result.stdout.trim() };
  } else {
    return { success: false, error: result.stderr || 'spawn failed' };
  }
}

// Main execution wrapper
function main() {
  const args = process.argv.slice(2);
  
  // Parse --repo flag
  let repoRoot = null;
  let cmdStart = -1;
  
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--repo=')) {
      repoRoot = args[i].replace('--repo=', '');
      // Expand ~ to home
      if (repoRoot.startsWith('~')) {
        repoRoot = path.join(process.env.HOME, repoRoot.slice(1));
      }
    } else if (args[i] === '--') {
      cmdStart = i + 1;
      break;
    }
  }
  
  if (cmdStart === -1 || cmdStart >= args.length) {
    console.error('Usage: node client/habits/scripts/aie_run.js --repo=/path/to/repo -- command arg1 arg2');
    process.exit(1);
  }
  
  const cmd = args[cmdStart];
  const cmdArgs = args.slice(cmdStart + 1);
  const fullCommand = [cmd, ...cmdArgs].join(' ');
  
  // Setup log directory
  const today = new Date().toISOString().slice(0, 10);
  const todayDir = path.join(TEST_RUNS_DIR, today);
  ensureDir(todayDir);
  
  // Generate log filename
  const ts = Date.now();
  const safeCmd = safeName(path.basename(cmd));
  const logFile = path.join(todayDir, `${safeCmd}_${ts}.log`);
  
  console.log(`🧪 Running: ${fullCommand}`);
  console.log(`📝 Log: ${logFile}`);
  
  // Spawn command
  const child = spawn(cmd, cmdArgs, {
    stdio: ['inherit', 'pipe', 'pipe'],
    cwd: repoRoot || process.cwd()
  });
  
  const stdoutChunks = [];
  const stderrChunks = [];
  
  child.stdout.on('data', (data) => {
    stdoutChunks.push(data);
    process.stdout.write(data);
  });
  
  child.stderr.on('data', (data) => {
    stderrChunks.push(data);
    process.stderr.write(data);
  });
  
  child.on('close', (exitCode) => {
    // Write log file
    const logContent = Buffer.concat([
      Buffer.from(`=== COMMAND ===\n${fullCommand}\n\n`),
      Buffer.from(`=== EXIT CODE ===\n${exitCode}\n\n`),
      Buffer.from(`=== STDOUT ===\n`),
      Buffer.concat(stdoutChunks),
      Buffer.from(`\n\n=== STDERR ===\n`),
      Buffer.concat(stderrChunks)
    ]);
    
    fs.writeFileSync(logFile, logContent);
    
    // Compute hash
    const logHash = computeHash(logFile);
    
    // Auto-log event
    const logResult = logTestRun(fullCommand, exitCode, logFile, logHash, repoRoot);
    
    if (logResult.success) {
      const points = exitCode === 0 ? '+6' : '-6';
      console.log(`\n✅ Captured test_run event (${points} points)`);
      console.log(`   Log hash: ${logHash.slice(0, 16)}...`);
    } else {
      console.error(`\n⚠️  Command ran but event logging failed: ${logResult.error}`);
    }
    
    // Exit with original code
    process.exit(exitCode);
  });
  
  child.on('error', (err) => {
    console.error(`\n❌ Failed to spawn command: ${err.message}`);
    process.exit(127);
  });
}

// Run if called directly
if (require.main === module) {
  main();
}

module.exports = { main, safeName, computeHash };
