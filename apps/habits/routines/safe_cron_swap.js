/**
 * Habit: safe_cron_swap
 * Atomic cron job replacement with verification gates
 */

const fs = require('fs');
const path = require('path');

async function run(inputs, ctx) {
  const startTime = Date.now();
  const { old_job_id, new_job_cli, verify_name } = inputs;

  const defaultWorkspaceRoot = path.resolve(__dirname, '..', '..', '..');
  const workspaceRoot =
    ctx.workspace_root ||
    process.env.OPENCLAW_WORKSPACE ||
    process.env.PROTHEUS_WORKSPACE ||
    defaultWorkspaceRoot;
  const configDir = path.join(workspaceRoot, 'config');
  const memoryDir = path.join(workspaceRoot, 'memory');
  
  // Get today's Denver date for SNIP
  const now = new Date();
  const denverDate = now.toLocaleDateString('en-US', { 
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const [m, d, y] = denverDate.split('/');
  const today = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  const todayFile = path.join(memoryDir, `${today}.md`);
  
  // Report structure
  const report = {
    old_id: old_job_id,
    new_id: null,
    added_ok: false,
    verified_ok: false,
    removed_ok: false,
    final_ok: false,
    error: null,
    timestamp: now.toISOString()
  };
  
  ctx.log(`Starting SAFE_SWAP for job: ${old_job_id}`);
  ctx.log(`New job will be named: ${verify_name}`);
  
  // STEP 1: Snapshot current crons
  ctx.log('STEP 1: Snapshotting current crons...');
  const beforeSnapshotPath = path.join(configDir, 'cron_jobs.before.json');
  let beforeSnapshot;
  try {
    const { execSync } = require('child_process');
    const cronList = execSync('openclaw cron list', { encoding: 'utf8', timeout: 10000 });
    beforeSnapshot = JSON.parse(cronList);
    fs.writeFileSync(beforeSnapshotPath, JSON.stringify(beforeSnapshot, null, 2), 'utf8');
    ctx.log(`✓ Snapshot saved to ${beforeSnapshotPath}`);
  } catch (err) {
    report.error = `SNAPSHOT_FAILED: ${err.message}`;
    ctx.log(`✗ ${report.error}`);
    await writeSnip(ctx, todayFile, report, startTime);
    return { status: 'error', report };
  }
  
  // STEP 2: Add new job FIRST
  ctx.log('STEP 2: Adding new job...');
  try {
    ctx.safeExec(new_job_cli);
    ctx.log('✓ New job add command executed');
    report.added_ok = true;
  } catch (err) {
    report.error = `ADD_FAILED: ${err.message}`;
    ctx.log(`✗ ${report.error}`);
    await writeSnip(ctx, todayFile, report, startTime);
    return { status: 'error', report };
  }
  
  // STEP 3: Verify new job exists and extract ID
  ctx.log('STEP 3: Verifying new job exists...');
  let newJobId = null;
  let verificationAttempts = 0;
  const maxAttempts = 5;
  
  while (verificationAttempts < maxAttempts && !newJobId) {
    try {
      const { execSync } = require('child_process');
      const cronList = execSync('openclaw cron list', { encoding: 'utf8', timeout: 10000 });
      const jobs = JSON.parse(cronList).jobs;
      
      const newJob = jobs.find(j => j.name === verify_name);
      if (newJob) {
        newJobId = newJob.id;
        report.new_id = newJobId;
        ctx.log(`✓ New job found: ${newJobId}`);
        
        // STEP 4: Verify nextRunAtMs is sane
        if (!newJob.state || !newJob.state.nextRunAtMs) {
          report.error = 'VERIFICATION_FAILED: new job has no nextRunAtMs';
          ctx.log(`✗ ${report.error}`);
          await writeSnip(ctx, todayFile, report, startTime);
          return { status: 'error', report };
        }
        
        const nextRun = newJob.state.nextRunAtMs;
        const nowMs = Date.now();
        if (nextRun < nowMs - 60000) { // Allow 1 min tolerance
          report.error = `VERIFICATION_FAILED: nextRunAtMs ${nextRun} is in the past`;
          ctx.log(`✗ ${report.error}`);
          await writeSnip(ctx, todayFile, report, startTime);
          return { status: 'error', report };
        }
        
        ctx.log(`✓ nextRunAtMs verified: ${new Date(nextRun).toISOString()}`);
        report.verified_ok = true;
      } else {
        verificationAttempts++;
        ctx.log(`  Attempt ${verificationAttempts}/${maxAttempts}: job not found yet, waiting...`);
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      verificationAttempts++;
      ctx.log(`  Attempt ${verificationAttempts}/${maxAttempts}: error - ${err.message}`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  
  if (!newJobId) {
    report.error = 'VERIFICATION_FAILED: Could not find new job after max attempts';
    ctx.log(`✗ ${report.error}`);
    await writeSnip(ctx, todayFile, report, startTime);
    return { status: 'error', report };
  }
  
  // STEP 5: Remove old job (only after verification succeeded)
  ctx.log(`STEP 5: Removing old job ${old_job_id}...`);
  try {
    const { execSync } = require('child_process');
    execSync(`openclaw cron remove --id ${old_job_id}`, { encoding: 'utf8', timeout: 10000 });
    ctx.log('✓ Old job removed');
    report.removed_ok = true;
  } catch (err) {
    report.error = `REMOVE_FAILED: ${err.message}`;
    ctx.log(`✗ ${report.error}`);
    await writeSnip(ctx, todayFile, report, startTime);
    return { status: 'error', report };
  }
  
  // STEP 6: Verify removal and final state
  ctx.log('STEP 6: Verifying final state...');
  try {
    const { execSync } = require('child_process');
    const cronList = execSync('openclaw cron list', { encoding: 'utf8', timeout: 10000 });
    const jobs = JSON.parse(cronList).jobs;
    
    const oldJobStillPresent = jobs.some(j => j.id === old_job_id);
    const newJobStillPresent = jobs.some(j => j.id === newJobId);
    
    if (oldJobStillPresent) {
      report.error = 'FINAL_VERIFICATION_FAILED: old job still present after removal';
      ctx.log(`✗ ${report.error}`);
      await writeSnip(ctx, todayFile, report, startTime);
      return { status: 'error', report };
    }
    
    if (!newJobStillPresent) {
      report.error = 'FINAL_VERIFICATION_FAILED: new job missing after removal of old';
      ctx.log(`✗ ${report.error}`);
      await writeSnip(ctx, todayFile, report, startTime);
      return { status: 'error', report };
    }
    
    ctx.log('✓ Final state verified: old removed, new present');
    report.final_ok = true;
  } catch (err) {
    report.error = `FINAL_VERIFICATION_FAILED: ${err.message}`;
    ctx.log(`✗ ${report.error}`);
    await writeSnip(ctx, todayFile, report, startTime);
    return { status: 'error', report };
  }
  
  // STEP 7: Write after snapshot
  const afterSnapshotPath = path.join(configDir, 'cron_jobs.after.json');
  try {
    const { execSync } = require('child_process');
    const cronList = execSync('openclaw cron list', { encoding: 'utf8', timeout: 10000 });
    fs.writeFileSync(afterSnapshotPath, cronList, 'utf8');
    ctx.log(`✓ After snapshot saved to ${afterSnapshotPath}`);
  } catch (err) {
    ctx.log(`Warning: Could not save after snapshot: ${err.message}`);
  }
  
  // Success - write SNIP
  const duration = Date.now() - startTime;
  await writeSnip(ctx, todayFile, report, duration);
  
  return {
    status: 'success',
    report,
    duration_ms: duration
  };
}

async function writeSnip(ctx, todayFile, report, duration) {
  const snipContent = `<!-- SNIP: safe-cron-swap-${Date.now()} -->
**Safe Cron Swap** — ${report.timestamp.split('T')[0]}
- Old ID: ${report.old_id}
- New ID: ${report.new_id || 'N/A'}
- Added OK: ${report.added_ok}
- Verified OK: ${report.verified_ok}
- Removed OK: ${report.removed_ok}
- Final OK: ${report.final_ok}
- Status: ${report.final_ok ? 'SUCCESS' : 'FAILED'}
- Error: ${report.error || 'none'}
- Duration: ${duration}ms
`;
  
  if (fs.existsSync(todayFile)) {
    fs.appendFileSync(todayFile, '\n' + snipContent + '\n', 'utf8');
    ctx.log(`SNIP appended to ${todayFile}`);
  } else {
    ctx.log(`Warning: ${todayFile} not found, SNIP not written`);
  }
}

module.exports = { run };
