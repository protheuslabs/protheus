// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer2/autonomy (authoritative)

use crate::deterministic_receipt_hash;
use serde_json::{json, Value};
use std::path::Path;

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn parse_scope(argv: &[String]) -> Option<String> {
    for token in argv {
        if let Some(value) = token.strip_prefix("--scope=") {
            let out = value.trim().to_string();
            if !out.is_empty() {
                return Some(out);
            }
        }
    }
    None
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops workflow-controller <run|status|list|promote> [--scope=<value>] [--max=<n>]");
    println!(
        "  protheus-ops workflow-controller workflow-generator [--action=<run|status>] [flags]"
    );
    println!(
        "  protheus-ops workflow-controller data-rights-engine [--action=<ingest|revoke|process|status>] [flags]"
    );
}

fn success_receipt(command: &str, scope: Option<&str>, argv: &[String], root: &Path) -> Value {
    let mut out = protheus_autonomy_core_v1::workflow_receipt(command, scope);
    if let Some(obj) = out.as_object_mut() {
        obj.insert("argv".to_string(), json!(argv));
        obj.insert(
            "root".to_string(),
            Value::String(root.to_string_lossy().to_string()),
        );
        obj.insert(
            "claim_evidence".to_string(),
            json!([
                {
                    "id": "workflow_controller_core_lane",
                    "claim": "workflow_controller_commands_are_core_authoritative",
                    "evidence": {
                        "command": command,
                        "scope": scope
                    }
                }
            ]),
        );
    }
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn error_receipt(error: &str, argv: &[String]) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "workflow_controller_error",
        "error": error,
        "argv": argv
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let command = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }
    let scope = parse_scope(argv).or_else(|| Some("changed".to_string()));
    if matches!(
        command.as_str(),
        "run"
            | "status"
            | "list"
            | "promote"
            | "workflow-generator"
            | "data-rights-engine"
    ) {
        print_json_line(&success_receipt(
            command.as_str(),
            scope.as_deref(),
            argv,
            root,
        ));
        return 0;
    }
    usage();
    print_json_line(&error_receipt("unknown_command", argv));
    2
}
