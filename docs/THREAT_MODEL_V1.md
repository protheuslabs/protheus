# V1 Threat Model (Autopilot Hardening)

Scope: unattended autonomy with adaptive mutation, outbound network access, and secret-mediated integrations.

## Priority Abuse Paths

1. Prompt-injection / forged-request ingress
- Risk: remote input bypasses intent checks and triggers unsafe execution.
- Primary controls: request envelope validation, remote gate signature checks, directive gate deny rules.
- Regression tests: `memory/tools/tests/request_envelope.test.js`, `memory/tools/tests/guard_remote_gate.test.js`, `memory/tools/tests/directive_gate.test.js`.

2. Unauthorized mutation of protected adaptive/memory/system paths
- Risk: model or tool writes outside controller channels and silently corrupts policy/state.
- Primary controls: adaptive boundary guard, memory/workspace dump guards, integrity kernel.
- Regression tests: `memory/tools/tests/adaptive_layer_boundary_guards.test.js`, `memory/tools/tests/security_integrity.test.js`.

3. Egress bypass / unsanctioned outbound calls
- Risk: data exfiltration or uncontrolled API spend outside policy.
- Primary controls: egress gateway allowlist, chokepoint guard.
- Regression tests: `memory/tools/tests/egress_gateway.test.js`, `memory/tools/tests/egress_chokepoint_guard.test.js`.

4. Secret exfiltration / raw credential reads
- Risk: direct secret access by high-capability lanes.
- Primary controls: secret broker handles, secret isolation guard.
- Regression tests: `memory/tools/tests/secret_broker.test.js`, `memory/tools/tests/secret_broker_isolation_guard.test.js`.

5. Policy-root lease misuse / unauthorized self-change escalation
- Risk: self-change starts without lease-backed authorization.
- Primary controls: policy-root lease requirement, capability lease consume-on-use.
- Regression tests: `memory/tools/tests/policy_rootd_lease.test.js`, `memory/tools/tests/improvement_controller_policy_root.test.js`.

6. Integrity/policy tamper before startup
- Risk: modified security files execute without detection.
- Primary controls: integrity kernel, startup attestation verification.
- Regression tests: `memory/tools/tests/startup_attestation.test.js`, `memory/tools/tests/startup_attestation_auto_issue.test.js`, `memory/tools/tests/action_receipts_integrity.test.js`.

## Gate Rule

All threat-path regression tests above must pass in CI before merge.

