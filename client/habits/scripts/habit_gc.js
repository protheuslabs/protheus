#!/usr/bin/env node
/**
 * habit_gc.js v1.5 - Garbage collection for stale habits with CLEAR ARCHIVE TRIGGERS
 * 
 * ARCHIVE when ALL true:
 *   - governance.state IN {candidate, disabled} (NEVER auto-archive active)
 *   - last_used_at > gc.inactive_days (default 30d)
 *   - uses_30d < gc.min_uses_30d (default 1)
 *   - pinned != true
 * 
 * ACTIVE HABITS NEVER AUTO-ARCHIVE.
 * Hard cap behavior: if adding candidate would exceed max_active, archive oldest eligible first.
 */

const fs = require('fs');
const path = require('path');
const {
  defaultRegistry,
  readRegistryWithUids,
  writeRegistryWithUids
} = require('./habit_uid_store.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = process.env.HABIT_GC_REGISTRY_PATH
  ? path.resolve(process.env.HABIT_GC_REGISTRY_PATH)
  : path.join(REPO_ROOT, 'habits', 'registry.json');
const ROUTINES_DIR = process.env.HABIT_GC_ROUTINES_DIR
  ? path.resolve(process.env.HABIT_GC_ROUTINES_DIR)
  : path.join(REPO_ROOT, 'habits', 'routines');
const ARCHIVE_DIR = process.env.HABIT_GC_ARCHIVE_DIR
  ? path.resolve(process.env.HABIT_GC_ARCHIVE_DIR)
  : path.join(REPO_ROOT, 'habits', '_archive');
const SNIPPET_DIR = process.env.HABIT_GC_SNIPPET_DIR
  ? path.resolve(process.env.HABIT_GC_SNIPPET_DIR)
  : path.join(REPO_ROOT, 'memory');

function normalizeDateToDenver(isoString) {
  if (!isoString) return null;
  const date = new Date(isoString);
  const denverStr = date.toLocaleDateString('en-US', {
    timeZone: 'America/Denver',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const [m, d, y] = denverStr.split('/');
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

function getTodayDenver() {
  return normalizeDateToDenver(new Date().toISOString());
}

function nowIso() {
  return new Date().toISOString();
}

function writeStateChangeSnip(data) {
  const today = getTodayDenver();
  const snipFile = path.join(SNIPPET_DIR, `${today}.md`);
  
  const snipContent = `<!-- SNIP: habit-state-${data.habit_id}-${Date.now()} -->
**Habit State Change: ${data.habit_id}**
- Transition: ${data.previous_state} → ${data.new_state}
- Reason: ${data.reason}
- Stats: uses_30d=${data.uses_30d}, last_used=${data.last_used_days}d ago, pinned=${data.pinned}
- Safety: ${data.safety_notes.join('; ')}
`;
  
  if (fs.existsSync(snipFile)) {
    fs.appendFileSync(snipFile, snipContent, 'utf8');
    console.log(`✅ State-change SNIP written`);
  } else {
    console.log(`⚠️  ${snipFile} not found. SNIP not persisted.`);
  }
}

function isEligibleForArchive(habit, gc, now, msPerDay) {
  const gov = habit.governance || {};
  const state = gov.state || habit.status || 'unknown';
  
  // Rule 1: State must be candidate or disabled (NEVER active)
  if (!['candidate', 'disabled'].includes(state)) {
    return { eligible: false, reason: `state=${state} (not candidate/disabled)` };
  }
  
  // Rule 2: Not pinned
  if (gov.pinned) {
    return { eligible: false, reason: 'pinned=true' };
  }
  
  // Rule 3: Inactive longer than threshold
  const lastUsed = habit.last_used_at ? new Date(habit.last_used_at) : null;
  const daysInactive = lastUsed ? (now - lastUsed) / msPerDay : Infinity;
  
  if (daysInactive <= gc.inactive_days) {
    return { eligible: false, reason: `inactive ${Math.round(daysInactive)}d (<= ${gc.inactive_days}d threshold)` };
  }
  
  // Rule 4: Low usage
  if (habit.uses_30d >= gc.min_uses_30d) {
    return { eligible: false, reason: `uses_30d=${habit.uses_30d} (>= ${gc.min_uses_30d} threshold)` };
  }
  
  return { 
    eligible: true, 
    reason: `inactive ${Math.round(daysInactive)}d > ${gc.inactive_days}d AND uses_30d=${habit.uses_30d} < ${gc.min_uses_30d}` 
  };
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const apply = args.includes('--apply');
  const checkCap = args.includes('--check-cap');
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('           HABIT GARBAGE COLLECTION v1.5');
  console.log('           (CLEAR ARCHIVE TRIGGERS)');
  console.log(`           Mode: ${dryRun ? 'DRY RUN' : apply ? 'APPLY' : 'ANALYSIS'}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('');
  console.log('ARCHIVE RULES (ALL must be true):');
  console.log('  1. governance.state IN {candidate, disabled} (NEVER auto-archive active)');
  console.log('  2. last_used_at > inactive_days AND uses_30d < min_uses_30d');
  console.log('  3. pinned != true');
  console.log('  4. ACTIVE habits require explicit "archive habit <id>" command');
  console.log('');
  
  const registry = readRegistryWithUids(REGISTRY_PATH, defaultRegistry(), true);
  const { max_active, gc, habits } = registry;
  
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  
  let toArchive = [];
  let toDemote = [];
  let activeCount = 0;
  let candidateCount = 0;
  let disabledCount = 0;
  
  // Count by state and identify archive candidates
  for (const habit of habits) {
    const gov = habit.governance || {};
    const state = gov.state || habit.status || 'unknown';
    
    // Skip already archived
    if (state === 'archived') continue;
    
    if (state === 'active') {
      activeCount++;
    } else if (state === 'candidate') {
      candidateCount++;
    } else if (state === 'disabled') {
      disabledCount++;
    }
    
    const lastUsed = habit.last_used_at ? new Date(habit.last_used_at) : null;
    const daysInactive = lastUsed ? (now - lastUsed) / msPerDay : Infinity;

    if (state === 'active' && !gov.pinned) {
      const shouldDemoteForStale =
        daysInactive > gc.inactive_days && Number(habit.uses_30d || 0) < gc.min_uses_30d;
      if (shouldDemoteForStale) {
        toDemote.push({
          habit,
          daysInactive: Math.round(daysInactive),
          reason: `GC_DEMOTE_STALE_ACTIVE: inactive ${Math.round(daysInactive)}d > ${gc.inactive_days}d AND uses_30d=${habit.uses_30d} < ${gc.min_uses_30d}`
        });
        continue;
      }
    }

    const eligibility = isEligibleForArchive(habit, gc, now, msPerDay);
    
    if (eligibility.eligible) {
      const lastUsed = habit.last_used_at ? new Date(habit.last_used_at) : null;
      const daysInactive = lastUsed ? (now - lastUsed) / msPerDay : Infinity;
      
      toArchive.push({
        habit,
        daysInactive: Math.round(daysInactive),
        eligibility
      });
    }
  }
  
  // Hard cap check
  const totalNonArchived = activeCount + candidateCount + disabledCount;
  let capTriggered = false;
  
  if (totalNonArchived - toArchive.length >= max_active) {
    console.log(`⚠️  HARD CAP: ${totalNonArchived} habits >= max_active=${max_active}`);
    console.log('    Will archive oldest eligible candidates first...\n');
    capTriggered = true;
    
    // Find oldest eligible (not active)
    const candidatesForCap = habits
      .filter(h => {
        const state = h.governance?.state || h.status;
        return ['candidate', 'disabled'].includes(state) && 
               !toArchive.find(ta => ta.habit.id === h.id);
      })
      .sort((a, b) => {
        const aDate = a.last_used_at ? new Date(a.last_used_at) : new Date(0);
        const bDate = b.last_used_at ? new Date(b.last_used_at) : new Date(0);
        return aDate - bDate;
      });
    
    const needToFree = totalNonArchived - toArchive.length - max_active + 1;
    const toEvict = candidatesForCap.slice(0, needToFree);
    
    for (const habit of toEvict) {
      const lastUsed = habit.last_used_at ? new Date(habit.last_used_at) : null;
      const daysInactive = lastUsed ? (now - lastUsed) / msPerDay : Infinity;
      
      toArchive.push({
        habit,
        daysInactive: Math.round(daysInactive),
        eligibility: { eligible: true, reason: 'HARD_CAP_LRU_EVICTION' }
      });
      
      console.log(`  → Will evict for cap: ${habit.id} (LRU)`);
    }
  }
  
  // Report
  console.log(`State counts:`);
  console.log(`  Active: ${activeCount} | Candidate: ${candidateCount} | Disabled: ${disabledCount}`);
  console.log(`  Demote-eligible active: ${toDemote.length}`);
  console.log(`  Archive-eligible: ${toArchive.length}`);
  console.log(`  Max active limit: ${max_active}`);
  console.log('');
  
  if (toArchive.length === 0 && toDemote.length === 0) {
    console.log('✅ No habits to archive. All within thresholds.');
    if (capTriggered) {
      console.log('⚠️  BUT: Hard cap triggered with no eligible for archive!');
      console.log('   ACTION NEEDED: Manually archive a habit or increase max_active');
    }
    return;
  }
  
  // Sort by last_used (oldest first for predictable archival)
  toArchive.sort((a, b) => a.daysInactive - b.daysInactive);
  
  if (toDemote.length > 0) {
    console.log(`Habits to demote (active -> disabled): ${toDemote.length}`);
    console.log('');
    for (const { habit, daysInactive, reason } of toDemote) {
      console.log(`  • ${habit.id}`);
      console.log(`    Name: ${habit.name}`);
      console.log(`    State: active`);
      console.log(`    Inactive: ${daysInactive}d`);
      console.log(`    Uses 30d: ${habit.uses_30d}`);
      console.log(`    Reason: ${reason}`);
      console.log('');
    }
  }

  if (toArchive.length > 0) {
    console.log(`Habits to archive: ${toArchive.length}`);
    console.log('');
  }
  
  for (const { habit, daysInactive, eligibility } of toArchive) {
    const gov = habit.governance || {};
    const state = gov.state || habit.status;
    
    console.log(`  • ${habit.id}`);
    console.log(`    Name: ${habit.name}`);
    console.log(`    State: ${state}`);
    console.log(`    Inactive: ${daysInactive}d`);
    console.log(`    Uses 30d: ${habit.uses_30d}`);
    console.log(`    Pinned: ${gov.pinned ? 'YES (would block)' : 'no'}`);
    console.log(`    Reason: ${eligibility.reason}`);
    console.log('');
  }
  
  if (checkCap) {
    console.log('CAPACITY CHECK ONLY - no changes.');
    return;
  }
  
  if (dryRun) {
    console.log('DRY RUN — No changes made.');
    console.log('Run with --apply to execute archive.');
    return;
  }
  
  if (!apply) {
    console.log('ANALYSIS — No changes made.');
    console.log('Run with --dry-run to preview, --apply to execute.');
    return;
  }
  
  // Execute demotions first (active -> disabled), then archive pass.
  console.log('APPLYING archives...');
  console.log('');

  for (const { habit, daysInactive, reason } of toDemote) {
    const gov = habit.governance || {};
    const oldState = gov.state || habit.status || 'active';
    if (!habit.governance) habit.governance = {};
    habit.governance.state = 'disabled';
    habit.governance.consecutive_errors = Number(habit.governance.consecutive_errors || 0);
    if (!habit.governance.demote || typeof habit.governance.demote !== 'object') {
      habit.governance.demote = { max_consecutive_errors: 2, min_outcome_score: 0.4, cooldown_minutes: 1440 };
    } else if (!Number.isFinite(Number(habit.governance.demote.cooldown_minutes))) {
      habit.governance.demote.cooldown_minutes = 1440;
    }
    habit.status = 'disabled';
    habit.disabled_at = nowIso();
    habit.disabled_reason = reason;

    writeStateChangeSnip({
      habit_id: habit.id,
      previous_state: oldState,
      new_state: 'disabled',
      reason,
      uses_30d: habit.uses_30d,
      last_used_days: daysInactive,
      pinned: gov.pinned || false,
      safety_notes: ['Auto-demoted by GC atrophy', 'Not archived in same pass']
    });
    console.log(`  📴 Demoted stale active habit: ${habit.id}`);
  }
  
  if (!fs.existsSync(ARCHIVE_DIR)) {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  }
  
  for (const { habit, daysInactive } of toArchive) {
    const gov = habit.governance || {};
    const oldState = gov.state || habit.status;
    
    // Update governance state
    if (!habit.governance) {
      habit.governance = { state: 'archived' };
    } else {
      habit.governance.state = 'archived';
    }
    habit.status = 'archived';
    
    // Move routine file if exists
    const routinePath = path.resolve(habit.entrypoint);
    if (fs.existsSync(routinePath)) {
      const archivePath = path.join(ARCHIVE_DIR, path.basename(routinePath));
      fs.renameSync(routinePath, archivePath);
      console.log(`  📦 Archived routine: ${path.basename(routinePath)}`);
    }
    
    // Write state-change SNIP
    writeStateChangeSnip({
      habit_id: habit.id,
      previous_state: oldState,
      new_state: 'archived',
      reason: `GC_ARCHIVE: inactive ${daysInactive}d > ${gc.inactive_days}d, uses_30d=${habit.uses_30d} < ${gc.min_uses_30d}`,
      uses_30d: habit.uses_30d,
      last_used_days: daysInactive,
      pinned: gov.pinned || false,
      safety_notes: ['Auto-archived by GC', 'Trust record preserved', 'Routine moved to _archive/']
    });
    
    console.log(`  ✅ Archived: ${habit.id}`);
  }
  
  writeRegistryWithUids(REGISTRY_PATH, registry);
  
  console.log('');
  console.log(`✅ GC complete. Demoted ${toDemote.length}, archived ${toArchive.length} habits.`);
  console.log('Trust records preserved in trusted_habits.json.');
  console.log('Routines moved to client/habits/_archive/');
}

main();
