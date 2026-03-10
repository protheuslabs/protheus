/**
 * Habit: rebuild_validate_memory
 * Runs rebuild_exclusive.js and logs violation summary as SNIP
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function run(inputs, ctx) {
  const startTime = Date.now();
  const notes = inputs.notes || '';
  
  ctx.log('Starting rebuild_validate_memory habit...');
  
  // Validate we're in the right directory
  const workspaceRoot = ctx.workspace_root || process.cwd();
  process.chdir(workspaceRoot);
  
  // Run rebuild_exclusive.js
  let rebuildOutput;
  let status = 'success';
  let violations = { format: 0, bloat: 0, registry: 0 };
  let summary = {};
  
  try {
    rebuildOutput = execSync('node client/memory/tools/rebuild_exclusive.js', {
      encoding: 'utf8',
      timeout: 30000,
      maxBuffer: 1024 * 1024
    });
    
    // Parse violations from output
    const formatMatch = rebuildOutput.match(/FORMAT_VIOLATIONS[\s\S]*?Count:\s*(\d+)/);
    const bloatMatch = rebuildOutput.match(/BLOAT_VIOLATIONS[\s\S]*?Count:\s*(\d+)/);
    const registryMatch = rebuildOutput.match(/REGISTRY_WARNINGS[\s\S]*?Count:\s*(\d+)/);
    
    violations.format = formatMatch ? parseInt(formatMatch[1]) : 0;
    violations.bloat = bloatMatch ? parseInt(bloatMatch[1]) : 0;
    violations.registry = registryMatch ? parseInt(registryMatch[1]) : 0;
    
    // Parse summary
    const nodeMatch = rebuildOutput.match(/Valid nodes indexed:\s*(\d+)/);
    const tokenMatch = rebuildOutput.match(/Tokens:\s*(\d+)/);
    const projectsMatch = rebuildOutput.match(/Projects:\s*(\d+)/);
    
    summary = {
      nodes: nodeMatch ? parseInt(nodeMatch[1]) : 0,
      tokens: tokenMatch ? parseInt(tokenMatch[1]) : 0,
      projects: projectsMatch ? parseInt(projectsMatch[1]) : 0,
      violations: violations
    };
    
  } catch (err) {
    status = 'error';
    rebuildOutput = err.stdout || err.message;
    ctx.log('Rebuild failed:', err.message);
  }
  
  const duration = Date.now() - startTime;
  
  // Generate SNIP content using America/Denver timezone
  const now = new Date();
  const denverDate = now.toLocaleDateString('en-US', { 
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  // Format: MM/DD/YYYY -> YYYY-MM-DD
  const [m, d, y] = denverDate.split('/');
  const today = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  
  const todayFile = path.join(workspaceRoot, 'memory', `${today}.md`);
  console.log(`[habit:rebuild_validate_memory] Target file: ${todayFile}`);
  
  const snipContent = `<!-- SNIP: rebuild-validate-${Date.now()} -->
**Rebuild Validation** — ${today}${notes ? ' — ' + notes : ''}
- Nodes: ${summary.nodes} | Tokens: ${summary.tokens} | Projects: ${summary.projects}
- Violations: format=${violations.format}, bloat=${violations.bloat}, registry=${violations.registry}
- Status: ${status} | Duration: ${duration}ms
- Habit: rebuild_validate_memory
`;
  
  // Write SNIP to today's file (only if allowed path)
  if (fs.existsSync(todayFile)) {
    fs.appendFileSync(todayFile, '\n' + snipContent + '\n', 'utf8');
    ctx.log(`SNIP appended to ${todayFile}`);
  } else {
    ctx.log(`Warning: ${todayFile} not found, SNIP not written`);
  }
  
  // Log the run
  ctx.logRun({
    status,
    duration_ms: duration,
    summary,
    violations
  });
  
  return {
    status,
    duration_ms: duration,
    summary,
    violations,
    snip_written: fs.existsSync(todayFile)
  };
}

module.exports = { run };
