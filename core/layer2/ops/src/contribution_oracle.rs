// Layer ownership: core/layer2/ops (authoritative)
// SPDX-License-Identifier: Apache-2.0
use crate::deterministic_receipt_hash;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops contribution-oracle validate [--input-json=<json>] [--strict=1|0]",
    "  protheus-ops contribution-oracle status",
];

fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn usage() {
    for line in USAGE {
        println!("{line}");
    }
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let pref = format!("--{key}=");
    let long = format!("--{key}");
    let mut idx = 0usize;
    while idx < argv.len() {
        let token = argv[idx].trim();
        if let Some(value) = token.strip_prefix(&pref) {
            return Some(value.to_string());
        }
        if token == long && idx + 1 < argv.len() {
            return Some(argv[idx + 1].clone());
        }
        idx += 1;
    }
    None
}

fn clean_text(value: &str, max_len: usize) -> String {
    value
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_len)
        .collect()
}

fn stable_hash(value: &str, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    let hex = hex::encode(hasher.finalize());
    hex.chars().take(len).collect()
}

fn parse_input(argv: &[String]) -> Value {
    parse_flag(argv, "input-json")
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({}))
}

fn validate(input: &Value) -> Value {
    let donor_id = clean_text(
        input
            .get("donor_id")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        120,
    );
    let proof_ref = clean_text(
        input
            .get("proof_ref")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        320,
    );
    let gpu_hours = input
        .get("gpu_hours")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);

    let mut errors = Vec::new();
    if donor_id.is_empty() {
        errors.push("missing_donor_id".to_string());
    }
    if proof_ref.is_empty() {
        errors.push("missing_proof_ref".to_string());
    }
    if !gpu_hours.is_finite() || gpu_hours <= 0.0 {
        errors.push("invalid_gpu_hours".to_string());
    }
    if gpu_hours > 100000.0 {
        errors.push("gpu_hours_out_of_bounds".to_string());
    }
    let ok = errors.is_empty();
    let validated_gpu_hours = if ok {
        ((gpu_hours * 1_000_000.0).round()) / 1_000_000.0
    } else {
        0.0
    };
    let mut out = json!({
        "ok": ok,
        "validated": ok,
        "type": "contribution_oracle_validation",
        "authority": "core/layer2/ops",
        "donor_id": donor_id,
        "proof_ref": proof_ref,
        "validated_gpu_hours": validated_gpu_hours,
        "errors": errors,
        "claim_evidence": [
            {
                "id": "contribution_oracle_rust_authority",
                "claim": "contribution validation executes in core rust authority",
                "evidence": {
                    "layer": "core/layer2/ops"
                }
            }
        ]
    });
    let validation_seed = format!(
        "{}|{}|{:.6}",
        out["donor_id"].as_str().unwrap_or_default(),
        out["proof_ref"].as_str().unwrap_or_default(),
        validated_gpu_hours
    );
    out["validation_id"] = Value::String(format!(
        "val_{}",
        stable_hash(&validation_seed, 16)
    ));
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn status_payload() -> Value {
    let mut out = json!({
        "ok": true,
        "type": "contribution_oracle_status",
        "authority": "core/layer2/ops",
        "claim_evidence": [
            {
                "id": "contribution_oracle_available",
                "claim": "contribution oracle lane is routed through rust authority",
                "evidence": { "available": true }
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run(_root: &Path, argv: &[String]) -> i32 {
    let cmd = argv
        .first()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    match cmd.as_str() {
        "help" | "--help" | "-h" => {
            usage();
            0
        }
        "validate" => {
            let payload = validate(&parse_input(argv));
            let exit = if payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                0
            } else {
                1
            };
            print_json(&payload);
            exit
        }
        "status" => {
            print_json(&status_payload());
            0
        }
        _ => {
            usage();
            let out = json!({"ok":false,"error":format!("unknown_command:{cmd}")});
            print_json(&out);
            1
        }
    }
}
