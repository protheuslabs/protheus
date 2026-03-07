// SPDX-License-Identifier: Apache-2.0
use conduit::{
    deterministic_receipt_hash, process_command, ConduitPolicy, ConduitSecurityContext,
    EchoCommandHandler, RegistryPolicyGate, TsCommand,
};

fn signed_envelope(policy: &ConduitPolicy, command: TsCommand) -> conduit::CommandEnvelope {
    let security =
        ConduitSecurityContext::from_policy(policy, "msg-k1", "msg-secret", "tok-k1", "tok-secret");
    let request_id = "inv-req";
    let ts_ms = 2;
    let security_metadata =
        security.mint_security_metadata("client-a", request_id, ts_ms, &command, 120_000);

    conduit::CommandEnvelope {
        schema_id: conduit::CONDUIT_SCHEMA_ID.to_string(),
        schema_version: conduit::CONDUIT_SCHEMA_VERSION.to_string(),
        request_id: request_id.to_string(),
        ts_ms,
        command,
        security: security_metadata,
    }
}

fn invariant_policy() -> (ConduitPolicy, tempfile::TempDir) {
    let temp = tempfile::tempdir().expect("tempdir");
    let constitution = temp.path().join("constitution.md");
    let registry = temp.path().join("guard_registry.json");

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

#[test]
fn deterministic_hashes_match_for_equal_envelopes() {
    let (policy, _tmp) = invariant_policy();
    let a = signed_envelope(&policy, TsCommand::ListActiveAgents);
    let b = signed_envelope(&policy, TsCommand::ListActiveAgents);

    assert_eq!(
        deterministic_receipt_hash(&a.command),
        deterministic_receipt_hash(&b.command)
    );
}

#[test]
fn install_extension_validation_is_fail_closed_for_invalid_sha() {
    let (policy, _tmp) = invariant_policy();
    let envelope = signed_envelope(
        &policy,
        TsCommand::InstallExtension {
            extension_id: "ext-1".to_string(),
            wasm_sha256: "deadbeef".to_string(),
            capabilities: vec!["metrics.read".to_string()],
        },
    );

    let gate = RegistryPolicyGate::new(policy.clone());
    let mut security = ConduitSecurityContext::from_policy(
        &policy,
        "msg-k1",
        "msg-secret",
        "tok-k1",
        "tok-secret",
    );
    let mut handler = EchoCommandHandler;
    let response = process_command(&envelope, &gate, &mut security, &mut handler);
    assert!(!response.validation.ok);
    assert!(response.validation.fail_closed);
    assert_eq!(response.validation.reason, "extension_wasm_sha256_invalid");
}

#[test]
fn policy_safe_patch_passes_validation() {
    let (policy, _tmp) = invariant_policy();
    let envelope = signed_envelope(
        &policy,
        TsCommand::ApplyPolicyUpdate {
            patch_id: "constitution_safe/allow-listed-change".to_string(),
            patch: serde_json::json!({"path":"/policy/test","value":true}),
        },
    );

    let gate = RegistryPolicyGate::new(policy.clone());
    let mut security = ConduitSecurityContext::from_policy(
        &policy,
        "msg-k1",
        "msg-secret",
        "tok-k1",
        "tok-secret",
    );
    let mut handler = EchoCommandHandler;
    let response = process_command(&envelope, &gate, &mut security, &mut handler);
    assert!(response.validation.ok);
    assert!(!response.validation.fail_closed);
}
