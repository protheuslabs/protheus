// SPDX-License-Identifier: Apache-2.0
use conduit::{CommandEnvelope, ConduitPolicy, ConduitSecurityContext, ResponseEnvelope, TsCommand};
use std::io::Write;
use std::process::{Command, Stdio};

fn policy_fixture() -> (ConduitPolicy, tempfile::TempDir) {
    let temp = tempfile::tempdir().expect("tempdir");
    let constitution = temp.path().join("docs/workspace/AGENT-CONSTITUTION.md");
    let registry = temp.path().join("guard_check_registry.json");
    if let Some(parent) = constitution.parent() {
        std::fs::create_dir_all(parent).expect("create constitution dir");
    }

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

fn write_policy_file(
    temp: &tempfile::TempDir,
    mut policy: ConduitPolicy,
    bridge_budget: usize,
) -> std::path::PathBuf {
    policy.bridge_message_budget_max = bridge_budget;
    let policy_path = temp.path().join("policy.json");
    std::fs::write(
        &policy_path,
        serde_json::to_string(&policy).expect("serialize policy"),
    )
    .expect("write policy");
    policy_path
}

fn signed_envelope(policy: &ConduitPolicy, request_id: &str) -> CommandEnvelope {
    let security = ConduitSecurityContext::from_policy(
        policy,
        "msg-k1",
        "msg-secret",
        "tok-k1",
        "tok-secret",
    );
    let ts_ms = 1_732_000_000_000;
    let command = TsCommand::GetSystemStatus;
    let metadata = security.mint_security_metadata("daemon-it", request_id, ts_ms, &command, 60_000);
    CommandEnvelope {
        schema_id: conduit::CONDUIT_SCHEMA_ID.to_string(),
        schema_version: conduit::CONDUIT_SCHEMA_VERSION.to_string(),
        request_id: request_id.to_string(),
        ts_ms,
        command,
        security: metadata,
    }
}

fn retarget_command(
    policy: &ConduitPolicy,
    envelope: &mut CommandEnvelope,
    command: TsCommand,
    client_id: &str,
) {
    envelope.command = command;
    envelope.security = ConduitSecurityContext::from_policy(
        policy,
        "msg-k1",
        "msg-secret",
        "tok-k1",
        "tok-secret",
    )
    .mint_security_metadata(
        client_id,
        &envelope.request_id,
        envelope.ts_ms,
        &envelope.command,
        60_000,
    );
}

fn spawn_daemon(policy_path: &std::path::Path) -> std::process::Child {
    Command::new(env!("CARGO_BIN_EXE_conduit_daemon"))
        .env("CONDUIT_POLICY_PATH", policy_path)
        .env("CONDUIT_SIGNING_KEY_ID", "msg-k1")
        .env("CONDUIT_SIGNING_SECRET", "msg-secret")
        .env("CONDUIT_TOKEN_KEY_ID", "tok-k1")
        .env("CONDUIT_TOKEN_SECRET", "tok-secret")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn conduit_daemon")
}

fn run_daemon_with_envelope(
    policy_path: &std::path::Path,
    envelope: &CommandEnvelope,
) -> (std::process::Output, ResponseEnvelope) {
    let mut child = spawn_daemon(policy_path);
    {
        let stdin = child.stdin.as_mut().expect("stdin");
        let mut payload = serde_json::to_string(envelope).expect("serialize envelope");
        payload.push('\n');
        stdin
            .write_all(payload.as_bytes())
            .expect("write envelope payload");
    }
    drop(child.stdin.take());

    let output = child.wait_with_output().expect("wait output");
    let stdout = String::from_utf8(output.stdout.clone()).expect("utf8 stdout");
    let line = stdout.lines().next().expect("response line");
    let response: ResponseEnvelope = serde_json::from_str(line).expect("response json");
    (output, response)
}

#[test]
fn conduit_daemon_processes_signed_stdio_request() {
    let (policy, temp) = policy_fixture();
    let policy_path = write_policy_file(&temp, policy.clone(), conduit::MAX_CONDUIT_MESSAGE_TYPES);
    let envelope = signed_envelope(&policy, "daemon-success");

    let (output, response) = run_daemon_with_envelope(&policy_path, &envelope);
    assert!(
        output.status.success(),
        "daemon failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    assert!(response.validation.ok);
    assert_eq!(response.validation.reason, "validated");
    assert_eq!(response.request_id, "daemon-success");
}

#[test]
fn conduit_daemon_fail_closed_response_for_bad_signature() {
    let (policy, temp) = policy_fixture();
    let policy_path = write_policy_file(&temp, policy.clone(), conduit::MAX_CONDUIT_MESSAGE_TYPES);
    let mut envelope = signed_envelope(&policy, "daemon-bad-signature");
    envelope.security.signature = "tampered-signature".to_string();

    let (output, response) = run_daemon_with_envelope(&policy_path, &envelope);
    assert!(output.status.success());
    assert!(!response.validation.ok);
    assert_eq!(response.validation.reason, "message_signature_invalid");
}

#[test]
fn conduit_daemon_exits_nonzero_when_policy_budget_is_invalid() {
    let (policy, temp) = policy_fixture();
    let policy_path = write_policy_file(&temp, policy, 0);

    let output = Command::new(env!("CARGO_BIN_EXE_conduit_daemon"))
        .env("CONDUIT_POLICY_PATH", policy_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .expect("run conduit_daemon");

    assert!(!output.status.success());
    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(
        stderr.contains("conduit_daemon_error"),
        "unexpected stderr: {stderr}"
    );
    assert!(
        stderr.contains("conduit_message_budget_invalid_zero"),
        "unexpected stderr: {stderr}"
    );
}

#[test]
fn conduit_daemon_routes_edge_status_bridge_contract() {
    let (policy, temp) = policy_fixture();
    let policy_path = write_policy_file(&temp, policy.clone(), conduit::MAX_CONDUIT_MESSAGE_TYPES);
    let mut envelope = signed_envelope(&policy, "daemon-edge-status");
    retarget_command(
        &policy,
        &mut envelope,
        TsCommand::StartAgent {
            agent_id: "edge_status".to_string(),
        },
        "daemon-it",
    );

    let (output, response) = run_daemon_with_envelope(&policy_path, &envelope);
    assert!(output.status.success());
    assert!(response.validation.ok);
    match response.event {
        conduit::RustEvent::SystemFeedback { status, .. } => {
            assert_eq!(status, "edge_status");
        }
        other => panic!("unexpected event: {other:?}"),
    }
}

#[test]
fn conduit_daemon_fail_closes_invalid_edge_json_bridge_payload() {
    let (policy, temp) = policy_fixture();
    let policy_path = write_policy_file(&temp, policy.clone(), conduit::MAX_CONDUIT_MESSAGE_TYPES);
    let mut envelope = signed_envelope(&policy, "daemon-edge-json-invalid");
    retarget_command(
        &policy,
        &mut envelope,
        TsCommand::StartAgent {
            agent_id: "edge_json:{bad".to_string(),
        },
        "daemon-it",
    );

    let (output, response) = run_daemon_with_envelope(&policy_path, &envelope);
    assert!(output.status.success());
    assert!(response.validation.ok);
    match response.event {
        conduit::RustEvent::SystemFeedback {
            status,
            violation_reason,
            ..
        } => {
            assert_eq!(status, "edge_bridge_error");
            assert_eq!(violation_reason.as_deref(), Some("edge_bridge_parse_failed"));
        }
        other => panic!("unexpected event: {other:?}"),
    }
}

#[test]
fn conduit_daemon_emits_legacy_lane_receipt_for_lane_prefixed_agent() {
    let (policy, temp) = policy_fixture();
    let policy_path = write_policy_file(&temp, policy.clone(), conduit::MAX_CONDUIT_MESSAGE_TYPES);
    let mut envelope = signed_envelope(&policy, "daemon-legacy-lane");
    retarget_command(
        &policy,
        &mut envelope,
        TsCommand::StartAgent {
            agent_id: "lane:  lane-42.alpha ".to_string(),
        },
        "daemon-it",
    );

    let (output, response) = run_daemon_with_envelope(&policy_path, &envelope);
    assert!(output.status.success());
    assert!(response.validation.ok);
    match response.event {
        conduit::RustEvent::SystemFeedback { status, detail, .. } => {
            assert_eq!(status, "legacy_lane_receipt");
            assert_eq!(
                detail
                    .get("lane_receipt")
                    .and_then(|v| v.get("ok"))
                    .and_then(serde_json::Value::as_bool),
                Some(true)
            );
        }
        other => panic!("unexpected event: {other:?}"),
    }
}

#[test]
fn conduit_daemon_routes_edge_inference_prefix_to_backend_contract() {
    let (policy, temp) = policy_fixture();
    let policy_path = write_policy_file(&temp, policy.clone(), conduit::MAX_CONDUIT_MESSAGE_TYPES);
    let mut envelope = signed_envelope(&policy, "daemon-edge-inference");
    retarget_command(
        &policy,
        &mut envelope,
        TsCommand::StartAgent {
            agent_id: "edge_inference:hello tiny edge world".to_string(),
        },
        "daemon-it",
    );

    let (output, response) = run_daemon_with_envelope(&policy_path, &envelope);
    assert!(output.status.success());
    assert!(response.validation.ok);
    match response.event {
        conduit::RustEvent::SystemFeedback {
            status,
            violation_reason,
            ..
        } => {
            assert_eq!(status, "edge_backend_unavailable");
            assert_eq!(violation_reason.as_deref(), Some("edge_feature_disabled"));
        }
        other => panic!("unexpected event: {other:?}"),
    }
}

#[test]
fn conduit_daemon_returns_legacy_lane_error_for_invalid_lane_identifier() {
    let (policy, temp) = policy_fixture();
    let policy_path = write_policy_file(&temp, policy.clone(), conduit::MAX_CONDUIT_MESSAGE_TYPES);
    let mut envelope = signed_envelope(&policy, "daemon-legacy-lane-invalid");
    retarget_command(
        &policy,
        &mut envelope,
        TsCommand::StartAgent {
            agent_id: "lane: !!!".to_string(),
        },
        "daemon-it",
    );

    let (output, response) = run_daemon_with_envelope(&policy_path, &envelope);
    assert!(output.status.success());
    assert!(response.validation.ok);
    match response.event {
        conduit::RustEvent::SystemFeedback { status, detail, .. } => {
            assert_eq!(status, "legacy_lane_error");
            assert_eq!(
                detail
                    .get("lane_receipt")
                    .and_then(|v| v.get("ok"))
                    .and_then(serde_json::Value::as_bool),
                Some(false)
            );
            assert_eq!(
                detail
                    .get("lane_receipt")
                    .and_then(|v| v.get("error"))
                    .and_then(serde_json::Value::as_str),
                Some("lane_id_missing_or_invalid")
            );
        }
        other => panic!("unexpected event: {other:?}"),
    }
}

#[test]
fn conduit_daemon_falls_back_to_agent_lifecycle_for_standard_start_agent() {
    let (policy, temp) = policy_fixture();
    let policy_path = write_policy_file(&temp, policy.clone(), conduit::MAX_CONDUIT_MESSAGE_TYPES);
    let mut envelope = signed_envelope(&policy, "daemon-start-agent-fallback");
    retarget_command(
        &policy,
        &mut envelope,
        TsCommand::StartAgent {
            agent_id: "agent-standard-42".to_string(),
        },
        "daemon-it",
    );

    let (output, response) = run_daemon_with_envelope(&policy_path, &envelope);
    assert!(output.status.success());
    assert!(response.validation.ok);
    match response.event {
        conduit::RustEvent::AgentLifecycle { state, agent_id } => {
            assert_eq!(state, conduit::AgentLifecycleState::Started);
            assert_eq!(agent_id, "agent-standard-42");
        }
        other => panic!("unexpected event: {other:?}"),
    }
}
