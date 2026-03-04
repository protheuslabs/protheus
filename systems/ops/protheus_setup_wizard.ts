#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');

const CLI_SUGGESTION_SCRIPT = path.join(ROOT, 'systems', 'tools', 'cli_suggestion_engine.js');
const DEFAULT_STATE_DIR = process.env.PROTHEUS_SETUP_STATE_DIR
  ? path.resolve(process.env.PROTHEUS_SETUP_STATE_DIR)
  : path.join(ROOT, 'state', 'ops', 'protheus_setup_wizard');

function usage() {
  console.log('Usage:');
  console.log('  protheus setup');
  console.log('  protheus setup run [--skip=1] [--force=1] [--json=1]');
  console.log('  protheus setup status [--json=1]');
  console.log('  protheus setup should-run [--json=1]');
  console.log('');
  console.log('Non-interactive flags (run):');
  console.log('  --covenant-accept=y|n|skip');
  console.log('  --interaction=proactive|silent|1|2');
  console.log('  --notifications=on|off');
  console.log('  --persona-customize=on|off');
  console.log('  --state-dir=<path>');
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 400) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx >= 0) {
      out[token.slice(2, idx)] = token.slice(idx + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function toBool(v: unknown, fallback = false) {
  const raw = cleanText(v, 20).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(raw)) return false;
  return fallback;
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function parseJsonText(raw: unknown): AnyObj | null {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return null;
}

function resolvePaths(args: AnyObj) {
  const stateDir = cleanText(args['state-dir'] ?? args.state_dir ?? DEFAULT_STATE_DIR, 600) || DEFAULT_STATE_DIR;
  return {
    state_dir: path.resolve(stateDir),
    latest_path: path.resolve(stateDir, 'latest.json'),
    history_path: path.resolve(stateDir, 'history.jsonl')
  };
}

function loadLatest(paths: AnyObj) {
  return readJson(paths.latest_path, null);
}

function envBool(name: string, fallback = false) {
  return toBool(process.env[name], fallback);
}

function shouldRun(paths: AnyObj, args: AnyObj) {
  if (toBool(args.skip, false) || envBool('PROTHEUS_SKIP_SETUP', false)) {
    return {
      should_run: false,
      reason: 'skip_requested'
    };
  }
  if (envBool('PROTHEUS_SETUP_DISABLE', false)) {
    return {
      should_run: false,
      reason: 'setup_disabled_by_env'
    };
  }
  if (toBool(args.force, false) || envBool('PROTHEUS_SETUP_FORCE', false)) {
    return {
      should_run: true,
      reason: 'force_requested'
    };
  }
  const latest = loadLatest(paths);
  if (latest && latest.completed === true) {
    return {
      should_run: false,
      reason: 'already_completed'
    };
  }
  return {
    should_run: true,
    reason: 'first_run_or_incomplete'
  };
}

function parseCovenantDecision(raw: unknown) {
  const token = normalizeToken(raw, 20);
  if (['y', 'yes', 'accept', 'accepted', 'true', '1'].includes(token)) return 'accepted';
  if (['n', 'no', 'reject', 'rejected', 'false', '0'].includes(token)) return 'rejected';
  if (['skip', 'later'].includes(token)) return 'skipped';
  return 'unknown';
}

function parseInteractionMode(raw: unknown) {
  const token = normalizeToken(raw, 30);
  if (['1', 'proactive', 'guided', 'suggestions'].includes(token)) return 'proactive';
  if (['2', 'silent', 'quiet'].includes(token)) return 'silent';
  return '';
}

async function askInput(rl: readline.Interface, prompt: string, fallback = '') {
  const label = fallback ? `${prompt} (${fallback}): ` : `${prompt}: `;
  return await new Promise<string>((resolve) => {
    rl.question(label, (value) => {
      const cleaned = cleanText(value, 320);
      resolve(cleaned || fallback);
    });
  });
}

function applyTutorialMode(mode: 'proactive' | 'silent') {
  if (!fs.existsSync(CLI_SUGGESTION_SCRIPT)) {
    return {
      ok: false,
      reason: 'cli_suggestion_engine_missing'
    };
  }
  const sub = mode === 'proactive' ? 'on' : 'off';
  const run = spawnSync(process.execPath, [CLI_SUGGESTION_SCRIPT, 'tutorial', sub, '--json=1'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROTHEUS_RUNTIME_MODE: process.env.PROTHEUS_RUNTIME_MODE || 'source'
    }
  });
  const payload = parseJsonText(run.stdout);
  return {
    ok: Number.isFinite(run.status) && Number(run.status) === 0,
    tutorial_mode: payload && payload.mode ? cleanText(payload.mode, 20) : sub,
    reason: Number.isFinite(run.status) && Number(run.status) === 0
      ? 'ok'
      : cleanText(run.stderr || run.stdout || 'tutorial_toggle_failed', 240)
  };
}

function buildPayload(type: string, body: AnyObj = {}) {
  return {
    ok: true,
    type,
    ts: nowIso(),
    ...body
  };
}

function writeHistory(paths: AnyObj, row: AnyObj) {
  appendJsonl(paths.history_path, {
    ts: row.ts || nowIso(),
    type: row.type || 'protheus_setup_wizard',
    result: row.result || 'unknown',
    completed: row.completed === true,
    interaction_mode: row.settings ? row.settings.interaction_mode : null,
    notifications_enabled: row.settings ? row.settings.notifications_enabled === true : null,
    covenant: row.settings ? row.settings.covenant_acceptance : null
  });
}

function printBanner() {
  process.stdout.write('\nWelcome to Protheus — your sovereign personal intelligence.\n');
  process.stdout.write('This system is designed to never betray you.\n\n');
}

async function cmdRun(args: AnyObj) {
  const paths = resolvePaths(args);
  const gate = shouldRun(paths, args);
  const asJson = toBool(args.json, false);

  if (!gate.should_run) {
    const payload = buildPayload('protheus_setup_wizard', {
      result: gate.reason,
      completed: loadLatest(paths)?.completed === true,
      paths: {
        state_dir: path.relative(ROOT, paths.state_dir).replace(/\\/g, '/'),
        latest_path: path.relative(ROOT, paths.latest_path).replace(/\\/g, '/'),
        history_path: path.relative(ROOT, paths.history_path).replace(/\\/g, '/')
      }
    });
    if (asJson) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }

  const interactive = process.stdin.isTTY && process.stdout.isTTY && !toBool(args['non-interactive'] ?? args.non_interactive, false);
  if (interactive) {
    printBanner();
  }

  let covenantDecision = parseCovenantDecision(args['covenant-accept'] ?? args.covenant_accept);
  let personaCustomize = toBool(args['persona-customize'] ?? args.persona_customize, false);
  let interactionMode = parseInteractionMode(args.interaction);
  let notificationsEnabled = toBool(args.notifications, true);

  if (interactive) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    if (covenantDecision === 'unknown') {
      const answer = await askInput(
        rl,
        'Do you accept the Mind Sovereignty Covenant? (y/n, or type skip)',
        'y'
      );
      covenantDecision = parseCovenantDecision(answer);
    }

    if (covenantDecision === 'accepted') {
      process.stdout.write('\nCore 5 shadows: Vikram, Rohan, Priya, Aarav, Li Wei.\n');
      const customizeAnswer = await askInput(rl, 'Customize persona defaults now? (y/n)', 'n');
      personaCustomize = toBool(customizeAnswer, false);

      process.stdout.write('\nHow would you like to interact?\n');
      process.stdout.write('  1) CLI suggestions & proactive help (recommended)\n');
      process.stdout.write('  2) Silent mode (no proactive suggestions)\n');
      const interactionAnswer = await askInput(rl, 'Choose interaction mode', '1');
      interactionMode = parseInteractionMode(interactionAnswer) || 'proactive';

      const notificationsAnswer = await askInput(rl, 'Enable low-power notifications for important events? (y/n)', 'y');
      notificationsEnabled = toBool(notificationsAnswer, true);
    }

    rl.close();
  }

  if (covenantDecision === 'unknown') {
    covenantDecision = interactive ? 'rejected' : 'skipped';
  }

  if (covenantDecision === 'skipped') {
    const payload = buildPayload('protheus_setup_wizard', {
      result: 'skipped_by_user',
      completed: false,
      note: 'Run `protheus setup` when ready. Use `protheus --skip-setup` to bypass once.'
    });
    writeHistory(paths, payload);
    if (asJson) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stdout.write('Setup skipped. Run `protheus setup` when you are ready.\n');
    }
    return payload;
  }

  if (covenantDecision !== 'accepted') {
    const payload = {
      ok: false,
      type: 'protheus_setup_wizard',
      ts: nowIso(),
      result: 'covenant_rejected_fail_closed',
      completed: false,
      error: 'mind_sovereignty_covenant_not_accepted'
    };
    writeHistory(paths, payload);
    if (asJson) {
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    } else {
      process.stderr.write('Setup stopped: covenant not accepted.\n');
      process.stderr.write('Run `protheus setup` again and accept the covenant to proceed.\n');
    }
    process.exit(1);
  }

  if (!interactionMode) interactionMode = 'proactive';
  const tutorialSync = applyTutorialMode(interactionMode as 'proactive' | 'silent');

  const payload = buildPayload('protheus_setup_wizard', {
    result: 'completed',
    completed: true,
    completed_at: nowIso(),
    settings: {
      covenant_acceptance: 'accepted',
      interaction_mode: interactionMode,
      notifications_enabled: notificationsEnabled === true,
      persona_customize_requested: personaCustomize === true,
      tutorial_mode_sync_ok: tutorialSync.ok === true,
      tutorial_mode_effective: tutorialSync.tutorial_mode || (interactionMode === 'proactive' ? 'on' : 'off')
    },
    paths: {
      state_dir: path.relative(ROOT, paths.state_dir).replace(/\\/g, '/'),
      latest_path: path.relative(ROOT, paths.latest_path).replace(/\\/g, '/'),
      history_path: path.relative(ROOT, paths.history_path).replace(/\\/g, '/')
    },
    next_steps: [
      'protheus list',
      'protheus research "your idea"',
      'protheus assimilate <path|url>'
    ],
    notes: tutorialSync.ok ? [] : [cleanText(`tutorial_mode_sync_warning:${tutorialSync.reason}`, 240)]
  });

  writeJsonAtomic(paths.latest_path, payload);
  writeHistory(paths, payload);

  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write('\nSetup complete.\n');
    if (personaCustomize) {
      process.stdout.write('You can review personas now: `protheus lens --list`\n');
    }
    process.stdout.write('Try `protheus list` to see everything, or `protheus research "your idea"` to start.\n');
  }

  return payload;
}

function cmdStatus(args: AnyObj) {
  const paths = resolvePaths(args);
  const latest = loadLatest(paths);
  const payload = buildPayload('protheus_setup_wizard_status', {
    completed: latest && latest.completed === true,
    latest,
    paths: {
      state_dir: path.relative(ROOT, paths.state_dir).replace(/\\/g, '/'),
      latest_path: path.relative(ROOT, paths.latest_path).replace(/\\/g, '/'),
      history_path: path.relative(ROOT, paths.history_path).replace(/\\/g, '/')
    }
  });

  if (toBool(args.json, false)) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else if (payload.completed) {
    process.stdout.write('Setup status: completed\n');
  } else {
    process.stdout.write('Setup status: not completed\n');
  }
  return payload;
}

function cmdShouldRun(args: AnyObj) {
  const paths = resolvePaths(args);
  const gate = shouldRun(paths, args);
  const payload = buildPayload('protheus_setup_should_run', {
    should_run: gate.should_run === true,
    reason: gate.reason
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'run', 40) || 'run';

  if (args.help || cmd === 'help' || cmd === '-h' || cmd === '--help') {
    usage();
    process.exit(0);
  }

  if (cmd === 'run') {
    await cmdRun(args);
    return;
  }
  if (cmd === 'status') {
    cmdStatus(args);
    return;
  }
  if (cmd === 'should-run') {
    cmdShouldRun(args);
    return;
  }

  process.stderr.write(`${JSON.stringify({ ok: false, type: 'protheus_setup_wizard', error: `unknown_command:${cmd}` }, null, 2)}\n`);
  process.exit(1);
}

if (require.main === module) {
  main().catch((err: any) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      type: 'protheus_setup_wizard',
      error: cleanText(err && err.message ? err.message : err, 260)
    }, null, 2)}\n`);
    process.exit(1);
  });
}

module.exports = {
  shouldRun,
  cmdRun,
  cmdStatus,
  cmdShouldRun,
  resolvePaths
};
