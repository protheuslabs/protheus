use conduit::{
    deterministic_receipt_hash, process_command, AllowAllPolicy, CommandEnvelope, EchoCommandHandler,
    TsCommand,
};

#[test]
fn deterministic_hashes_match_for_equal_envelopes() {
    let a = CommandEnvelope {
        schema_id: conduit::CONDUIT_SCHEMA_ID.to_string(),
        schema_version: conduit::CONDUIT_SCHEMA_VERSION.to_string(),
        request_id: "inv-1".to_string(),
        ts_ms: 1,
        command: TsCommand::ListActiveAgents,
    };
    let b = CommandEnvelope {
        schema_id: conduit::CONDUIT_SCHEMA_ID.to_string(),
        schema_version: conduit::CONDUIT_SCHEMA_VERSION.to_string(),
        request_id: "inv-1".to_string(),
        ts_ms: 1,
        command: TsCommand::ListActiveAgents,
    };

    assert_eq!(deterministic_receipt_hash(&a), deterministic_receipt_hash(&b));
}

#[test]
fn install_extension_validation_is_fail_closed_for_invalid_sha() {
    let envelope = CommandEnvelope {
        schema_id: conduit::CONDUIT_SCHEMA_ID.to_string(),
        schema_version: conduit::CONDUIT_SCHEMA_VERSION.to_string(),
        request_id: "inv-2".to_string(),
        ts_ms: 2,
        command: TsCommand::InstallExtension {
            extension_id: "ext-1".to_string(),
            wasm_sha256: "deadbeef".to_string(),
            capabilities: vec!["metrics.read".to_string()],
        },
    };

    let mut handler = EchoCommandHandler;
    let response = process_command(&envelope, &AllowAllPolicy, &mut handler);
    assert!(!response.validation.ok);
    assert!(response.validation.fail_closed);
    assert_eq!(response.validation.reason, "extension_wasm_sha256_invalid");
}

#[test]
fn policy_safe_patch_passes_validation() {
    let envelope = CommandEnvelope {
        schema_id: conduit::CONDUIT_SCHEMA_ID.to_string(),
        schema_version: conduit::CONDUIT_SCHEMA_VERSION.to_string(),
        request_id: "inv-3".to_string(),
        ts_ms: 3,
        command: TsCommand::ApplyPolicyUpdate {
            patch_id: "constitution_safe/allow-listed-change".to_string(),
            patch: serde_json::json!({"path":"/policy/test","value":true}),
        },
    };

    let mut handler = EchoCommandHandler;
    let response = process_command(&envelope, &AllowAllPolicy, &mut handler);
    assert!(response.validation.ok);
    assert!(!response.validation.fail_closed);
}
