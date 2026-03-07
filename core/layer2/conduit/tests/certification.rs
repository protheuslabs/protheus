// SPDX-License-Identifier: Apache-2.0
use conduit::{
    process_command, run_stdio_once, CommandEnvelope, ConduitPolicy, ConduitSecurityContext,
    EchoCommandHandler, RegistryPolicyGate, TsCommand,
};
use std::io::{BufReader, Cursor};
use std::time::Instant;

fn policy_fixture() -> (ConduitPolicy, tempfile::TempDir) {
    let temp = tempfile::tempdir().expect("tempdir");
    let constitution = temp.path().join("AGENT-CONSTITUTION.md");
    let registry = temp.path().join("guard_check_registry.json");

    std::fs::write(&constitution, "Mind Sovereignty Covenant\nRSI Guardrails\n")
        .expect("write constitution");
    std::fs::write(
        &registry,
        serde_json::json!({
            "merge_guard": {
                "checks": [
                    {"id":"contract_check"},
                    {"id":"formal_invariant_engine"}
                ]
            }
        })
        .to_string(),
    )
    .expect("write registry");

    let policy = ConduitPolicy {
        constitution_path: constitution.to_string_lossy().to_string(),
        guard_registry_path: registry.to_string_lossy().to_string(),
        ..ConduitPolicy::default()
    };
    (policy, temp)
}

fn signed_envelope(policy: &ConduitPolicy) -> CommandEnvelope {
    let security =
        ConduitSecurityContext::from_policy(policy, "msg-k1", "msg-secret", "tok-k1", "tok-secret");
    let request_id = "cert-req";
    let ts_ms = 100;
    let command = TsCommand::GetSystemStatus;
    let security_metadata =
        security.mint_security_metadata("client-cert", request_id, ts_ms, &command, 120_000);

    CommandEnvelope {
        schema_id: conduit::CONDUIT_SCHEMA_ID.to_string(),
        schema_version: conduit::CONDUIT_SCHEMA_VERSION.to_string(),
        request_id: request_id.to_string(),
        ts_ms,
        command,
        security: security_metadata,
    }
}

#[test]
fn with_and_without_stdio_produce_equivalent_decisions() {
    let (policy, _tmp) = policy_fixture();
    let gate = RegistryPolicyGate::new(policy.clone());

    let envelope = signed_envelope(&policy);
    let mut handler_core = EchoCommandHandler;
    let mut security_core = ConduitSecurityContext::from_policy(
        &policy,
        "msg-k1",
        "msg-secret",
        "tok-k1",
        "tok-secret",
    );
    let direct = process_command(&envelope, &gate, &mut security_core, &mut handler_core);

    let mut payload = serde_json::to_string(&envelope).expect("serialize");
    payload.push('\n');
    let reader = BufReader::new(Cursor::new(payload.into_bytes()));
    let mut writer = Vec::new();
    let mut handler_stdio = EchoCommandHandler;
    let mut security_stdio = ConduitSecurityContext::from_policy(
        &policy,
        "msg-k1",
        "msg-secret",
        "tok-k1",
        "tok-secret",
    );

    let _ = run_stdio_once(
        reader,
        &mut writer,
        &gate,
        &mut security_stdio,
        &mut handler_stdio,
    )
    .expect("stdio");

    let text = String::from_utf8(writer).expect("utf8");
    let via_stdio: conduit::ResponseEnvelope = serde_json::from_str(text.trim()).expect("json");

    assert_eq!(direct.event, via_stdio.event);
    assert_eq!(direct.validation.ok, via_stdio.validation.ok);
    assert_eq!(direct.validation.reason, via_stdio.validation.reason);
}

#[test]
fn hosted_roundtrip_budget_under_5ms() {
    let (policy, _tmp) = policy_fixture();
    let gate = RegistryPolicyGate::new(policy.clone());

    let runs = 30u32;
    let mut total_ms = 0u128;
    for i in 0..runs {
        let mut security = ConduitSecurityContext::from_policy(
            &policy,
            "msg-k1",
            "msg-secret",
            "tok-k1",
            "tok-secret",
        );
        let request_id = format!("latency-{i}");
        let ts_ms = 1_000 + u64::from(i);
        let command = TsCommand::GetSystemStatus;
        let security_metadata =
            security.mint_security_metadata("client-latency", &request_id, ts_ms, &command, 60_000);
        let envelope = CommandEnvelope {
            schema_id: conduit::CONDUIT_SCHEMA_ID.to_string(),
            schema_version: conduit::CONDUIT_SCHEMA_VERSION.to_string(),
            request_id,
            ts_ms,
            command,
            security: security_metadata,
        };
        let mut handler = EchoCommandHandler;
        let start = Instant::now();
        let response = process_command(&envelope, &gate, &mut security, &mut handler);
        total_ms += start.elapsed().as_millis();
        assert!(response.validation.ok);
    }

    let avg_ms = total_ms as f64 / runs as f64;
    assert!(
        avg_ms < 5.0,
        "hosted roundtrip average exceeded 5ms budget: {avg_ms}ms"
    );
}

#[test]
fn embedded_stdio_budget_under_20ms() {
    let (policy, _tmp) = policy_fixture();
    let gate = RegistryPolicyGate::new(policy.clone());

    let request_id = "embedded-latency";
    let ts_ms = 2_000;
    let command = TsCommand::GetSystemStatus;
    let security = ConduitSecurityContext::from_policy(
        &policy,
        "msg-k1",
        "msg-secret",
        "tok-k1",
        "tok-secret",
    );
    let security_metadata =
        security.mint_security_metadata("client-embedded", request_id, ts_ms, &command, 60_000);
    let envelope = CommandEnvelope {
        schema_id: conduit::CONDUIT_SCHEMA_ID.to_string(),
        schema_version: conduit::CONDUIT_SCHEMA_VERSION.to_string(),
        request_id: request_id.to_string(),
        ts_ms,
        command,
        security: security_metadata,
    };

    let mut payload = serde_json::to_string(&envelope).expect("serialize");
    payload.push('\n');
    let reader = BufReader::new(Cursor::new(payload.into_bytes()));
    let mut writer = Vec::new();
    let mut handler = EchoCommandHandler;
    let mut security_runtime = ConduitSecurityContext::from_policy(
        &policy,
        "msg-k1",
        "msg-secret",
        "tok-k1",
        "tok-secret",
    );

    let start = Instant::now();
    let _ = run_stdio_once(
        reader,
        &mut writer,
        &gate,
        &mut security_runtime,
        &mut handler,
    )
    .expect("stdio");
    let elapsed_ms = start.elapsed().as_millis() as f64;

    assert!(
        elapsed_ms < 20.0,
        "embedded stdio roundtrip exceeded 20ms: {elapsed_ms}ms"
    );
}
