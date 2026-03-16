import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const ROOT = process.cwd();
const require = createRequire(import.meta.url);
const isolation = require(path.join(ROOT, 'client/runtime/systems/memory/session_isolation.ts'));

describe('V6-TEST-COVERAGE-001 v6 session isolation client guard', () => {
  test('requires valid session ids and blocks cross-session leakage', () => {
    const statePath = path.join(os.tmpdir(), `memory-session-isolation-${Date.now()}.json`);

    const missing = isolation.validateSessionIsolation(['query-index', '--resource-id=node-1'], { statePath });
    expect(missing.ok).toBe(false);
    expect(missing.reason_code).toBe('missing_session_id');

    const invalid = isolation.validateSessionIsolation(
      ['query-index', '--session-id=**bad**', '--resource-id=node-1'],
      { statePath },
    );
    expect(invalid.ok).toBe(false);
    expect(invalid.reason_code).toBe('invalid_session_id');

    const allowA = isolation.validateSessionIsolation(
      ['query-index', '--session-id=session-a', '--resource-id=node-1'],
      { statePath },
    );
    expect(allowA.ok).toBe(true);

    const allowARepeat = isolation.validateSessionIsolation(
      ['query-index', '--session-id=session-a', '--resource-id=node-1'],
      { statePath },
    );
    expect(allowARepeat.ok).toBe(true);

    const blockedB = isolation.validateSessionIsolation(
      ['query-index', '--session-id=session-b', '--resource-id=node-1'],
      { statePath },
    );
    expect(blockedB.ok).toBe(false);
    expect(blockedB.reason_code).toBe('cross_session_leak_blocked');

    const reject = isolation.sessionFailureResult(blockedB, { stage: 'client_preflight' });
    expect(reject.ok).toBe(false);
    expect(reject.status).toBe(2);
    expect(String(reject.stderr)).toContain('memory_session_isolation_reject:cross_session_leak_blocked');

    if (fs.existsSync(statePath)) {
      fs.unlinkSync(statePath);
    }
  });
});
