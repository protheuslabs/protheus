#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'actuation', 'universal_execution_primitive.js');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(filePath, value) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(args, env = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function parseJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').map((row) => row.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'universal-primitive-'));
  const receiptsRoot = path.join(tmp, 'receipts');
  const outboxRoot = path.join(tmp, 'outbox');
  const fsRoot = path.join(tmp, 'fs');
  const profileRoot = path.join(tmp, 'profiles');
  const synthesisStatePath = path.join(tmp, 'subexec', 'state.json');
  const synthesisReceiptsPath = path.join(tmp, 'subexec', 'receipts.jsonl');
  const synthesisDistillDir = path.join(tmp, 'subexec', 'distilled');
  const hardeningCheckpointsPath = path.join(tmp, 'hardening', 'checkpoints.jsonl');
  const hardeningHandoffPath = path.join(tmp, 'hardening', 'handoffs.jsonl');
  const verificationReceiptsPath = path.join(tmp, 'hardening', 'verification.jsonl');
  const reliabilityMetricsPath = path.join(tmp, 'hardening', 'computer_use_metrics.json');
  ensureDir(receiptsRoot);
  ensureDir(outboxRoot);
  ensureDir(fsRoot);
  ensureDir(profileRoot);
  ensureDir(path.dirname(synthesisStatePath));
  ensureDir(path.dirname(synthesisReceiptsPath));
  ensureDir(synthesisDistillDir);

  const synthesisPolicyPath = path.join(tmp, 'sub_executor_policy.json');
  writeJson(synthesisPolicyPath, {
    version: '1.0',
    enabled: true,
    default_ttl_sec: 7200,
    max_active_candidates: 64,
    allow_high_risk: false,
    dedupe_window_sec: 3600,
    validation: {
      require_nursery_pass: true,
      require_adversarial_pass: true
    },
    state_path: synthesisStatePath,
    receipts_path: synthesisReceiptsPath,
    distill_dir: synthesisDistillDir
  });

  const policyPath = path.join(tmp, 'policy.json');
  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    min_profile_confidence: 0.5,
    default_adapter_kind: 'http_request',
    allowed_adapter_kinds: [],
    profile_roots: [profileRoot],
    source_type_adapter_map: {
      api: 'http_request',
      filesystem: 'filesystem_task'
    },
    intent_adapter_map: {
      write_file: 'filesystem_task'
    },
    sub_executor_synthesis: {
      enabled: true,
      script_path: path.join(ROOT, 'systems', 'actuation', 'sub_executor_synthesis.js'),
      auto_propose_on_errors: ['executor_failed'],
      risk_class_by_error: {
        executor_failed: 'low'
      }
    },
    computer_use_hardening: {
      enabled: true,
      protected_adapter_kinds: ['browser_task'],
      require_session_id: true,
      require_checkpoint_for_apply: true,
      max_recovery_attempts: 1,
      verification_keywords: ['captcha', 'verification_code', '2fa'],
      handoff_required_on_verification: true,
      checkpoints_path: hardeningCheckpointsPath,
      handoff_path: hardeningHandoffPath
    },
    computer_use_execution_verification: {
      enabled: true,
      protected_adapter_kinds: ['filesystem_task'],
      max_verify_attempts: 1,
      fail_closed: true,
      require_success_markers: false,
      success_markers: ['success'],
      failure_markers: ['blocked'],
      expected_outcome_keys: ['expected_outcome'],
      receipts_path: verificationReceiptsPath
    },
    computer_use_reliability_metrics: {
      enabled: true,
      tracked_adapter_kinds: ['browser_task', 'http_request'],
      suite_keys: ['task_suite', 'suite'],
      case_keys: ['case_id', 'task_id'],
      rolling_window: 100,
      target_success_rate: 0.7,
      webarena_aliases: ['webarena'],
      metrics_path: reliabilityMetricsPath
    },
    receipts_path: receiptsRoot
  });

  const apiProfilePath = path.join(profileRoot, 'api_profile.json');
  writeJson(apiProfilePath, {
    profile_id: 'api_profile',
    source: { source_type: 'api' },
    provenance: { confidence: 0.9 }
  });
  const fsProfilePath = path.join(profileRoot, 'fs_profile.json');
  writeJson(fsProfilePath, {
    profile_id: 'fs_profile',
    source: { source_type: 'filesystem' },
    execution: { adapter_kind: 'filesystem_task' },
    provenance: { confidence: 0.95 }
  });
  const browserProfilePath = path.join(profileRoot, 'browser_profile.json');
  writeJson(browserProfilePath, {
    profile_id: 'browser_profile',
    source: { source_type: 'web_ui' },
    execution: { adapter_kind: 'browser_task' },
    provenance: { confidence: 0.92 }
  });

  const env = {
    UNIVERSAL_EXECUTION_POLICY_PATH: policyPath,
    ACTUATION_ADAPTER_OUTBOX_ROOT: outboxRoot,
    ACTUATION_FILESYSTEM_ROOT: fsRoot,
    ACTUATION_RECEIPTS_DIR: path.join(tmp, 'actuation_receipts'),
    SUB_EXECUTOR_SYNTHESIS_POLICY_PATH: synthesisPolicyPath
  };

  const dry = run([
    'run',
    '--profile-id=api_profile',
    '--params={"url":"https://example.com/hook","method":"POST","body":{"ok":true},"task_suite":"webarena","case_id":"wa_001"}',
    '--context={"passport_id":"passport-123"}',
    '--dry-run'
  ], env);
  assert.strictEqual(dry.status, 0, `dry run failed: ${dry.stderr || dry.stdout}`);
  const dryPayload = parseJson(dry.stdout);
  assert.strictEqual(dryPayload.ok, true, 'dry payload not ok');
  assert.strictEqual(dryPayload.adapter_kind, 'http_request', 'api profile should map to http_request');
  assert.strictEqual(dryPayload.row.passport_link_id, 'passport-123', 'passport link should propagate');

  const live = run([
    'run',
    '--profile-id=fs_profile',
    '--intent=write_file',
    '--params={"action":"write_file","path":"notes/universal.txt","content":"universal primitive live write"}'
  ], env);
  assert.strictEqual(live.status, 0, `live run failed: ${live.stderr || live.stdout}`);
  const livePayload = parseJson(live.stdout);
  assert.strictEqual(livePayload.ok, true, 'live payload not ok');
  assert.strictEqual(livePayload.adapter_kind, 'filesystem_task', 'fs profile should map to filesystem adapter');

  const writtenPath = path.join(fsRoot, 'notes', 'universal.txt');
  assert.ok(fs.existsSync(writtenPath), 'filesystem write should execute');
  assert.ok(fs.readFileSync(writtenPath, 'utf8').includes('universal primitive'), 'written file should contain payload');

  const fail = run([
    'run',
    '--profile-id=fs_profile',
    '--intent=write_file',
    '--params={"action":"not_supported","path":"notes/missing_action.txt","content":"unsupported action should fail"}'
  ], env);
  assert.notStrictEqual(fail.status, 0, 'unsupported action should fail through adapter');
  const failPayload = parseJson(fail.stdout);
  assert.strictEqual(failPayload.ok, false, 'failure payload should not be ok');
  assert.ok(
    failPayload.sub_executor_candidate && failPayload.sub_executor_candidate.candidate_id,
    'executor failure should enqueue sub-executor synthesis candidate'
  );

  const verifyFail = run([
    'run',
    '--profile-id=fs_profile',
    '--intent=write_file',
    '--params={"action":"write_file","path":"notes/verification_fail.txt","content":"verification mismatch should fail","expected_outcome":"non_matching_expected_phrase"}'
  ], env);
  assert.notStrictEqual(verifyFail.status, 0, 'verification mismatch should fail closed');
  const verifyFailPayload = parseJson(verifyFail.stdout);
  assert.strictEqual(verifyFailPayload.ok, false, 'verification failure payload should not be ok');
  assert.strictEqual(verifyFailPayload.error, 'execution_verification_failed');
  assert.ok(
    verifyFailPayload.execution_verification
      && Array.isArray(verifyFailPayload.execution_verification.reason_codes)
      && verifyFailPayload.execution_verification.reason_codes.includes('expected_outcome_not_observed'),
    'verification failure should include expected_outcome_not_observed reason'
  );
  assert.ok(fs.existsSync(verificationReceiptsPath), 'verification receipts should be written');

  const synthesisState = JSON.parse(fs.readFileSync(synthesisStatePath, 'utf8'));
  const synthesisCandidates = synthesisState && synthesisState.candidates && typeof synthesisState.candidates === 'object'
    ? Object.values(synthesisState.candidates)
    : [];
  assert.ok(synthesisCandidates.length >= 1, 'synthesis state should contain candidate');

  const hardeningFail = run([
    'run',
    '--profile-id=browser_profile',
    '--params={"action":"navigate","url":"https://example.com/dashboard"}'
  ], env);
  assert.notStrictEqual(hardeningFail.status, 0, 'browser task without session should fail hardening assertion');
  const hardeningFailPayload = parseJson(hardeningFail.stdout);
  assert.strictEqual(hardeningFailPayload.ok, false);
  assert.ok(String(hardeningFailPayload.error || '').includes('computer_use_assertion_failed'));

  const verificationFail = run([
    'run',
    '--profile-id=browser_profile',
    '--params={"action":"navigate","url":"https://example.com/captcha","session_id":"sess_a","task_suite":"webarena","case_id":"wa_002"}'
  ], env);
  assert.notStrictEqual(verificationFail.status, 0, 'captcha-like browser task should require handoff');
  const verificationPayload = parseJson(verificationFail.stdout);
  assert.strictEqual(verificationPayload.ok, false);
  assert.strictEqual(verificationPayload.error, 'verification_handoff_required');
  assert.ok(fs.existsSync(hardeningHandoffPath), 'handoff log should be written');

  const status = run(['status'], env);
  assert.strictEqual(status.status, 0, `status failed: ${status.stderr || status.stdout}`);
  const statusPayload = parseJson(status.stdout);
  assert.strictEqual(statusPayload.ok, true, 'status payload not ok');
  assert.ok(Number(statusPayload.total_runs || 0) >= 2, 'status should count runs');
  assert.strictEqual(Number(statusPayload.profile_only_ratio || 0), 1, 'all runs should be profile-based');
  assert.ok(Number(statusPayload.hardening_protected_runs || 0) >= 1, 'hardening runs should be counted');
  assert.ok(Number(statusPayload.verification_handoff_required_runs || 0) >= 1, 'handoff runs should be counted');
  assert.ok(statusPayload.computer_use_reliability, 'computer-use reliability summary should be present');
  assert.ok(Number(statusPayload.computer_use_reliability.overall_total_runs || 0) >= 1, 'reliability metrics should count tracked runs');
  assert.ok(typeof statusPayload.computer_use_reliability.webarena_like_success_rate === 'number', 'webarena-like success rate should be emitted');
  assert.ok(fs.existsSync(reliabilityMetricsPath), 'reliability metrics state should be written');

  const receiptFile = path.join(receiptsRoot, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const receipts = readJsonl(receiptFile);
  assert.ok(receipts.length >= 2, 'receipts should be written');
  assert.ok(receipts.every((row) => row && row.profile_id), 'receipts should carry profile id');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('universal_execution_primitive.test.js: OK');
} catch (err) {
  console.error(`universal_execution_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
