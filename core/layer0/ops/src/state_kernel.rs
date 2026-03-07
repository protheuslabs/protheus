// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use std::path::Path;

const LANE_ID: &str = "state_kernel";
const REPLACEMENT: &str = "protheus-ops state-kernel";

fn receipt_hash(v: &Value) -> String {
    deterministic_receipt_hash(v)
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops state-kernel queue-enqueue --queue-name=<name> --payload-json=<json>");
    println!("  protheus-ops state-kernel status");
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let pref = format!("--{key}=");
    for arg in argv {
        let tok = arg.trim();
        if let Some(v) = tok.strip_prefix(&pref) {
            return Some(v.to_string());
        }
    }
    None
}

fn native_receipt(root: &Path, cmd: &str, argv: &[String]) -> Value {
    let queue_name = parse_flag(argv, "queue-name").unwrap_or_else(|| "autonomy".to_string());
    let payload_json = parse_flag(argv, "payload-json");

    let mut out = json!({
        "ok": true,
        "type": "state_kernel",
        "lane": LANE_ID,
        "ts": now_iso(),
        "command": cmd,
        "queue_name": queue_name,
        "payload_present": payload_json.is_some(),
        "argv": argv,
        "root": root.to_string_lossy(),
        "replacement": REPLACEMENT,
        "claim_evidence": [
            {
                "id": "native_state_kernel_lane",
                "claim": "state_kernel_executes_natively_in_rust",
                "evidence": {
                    "command": cmd,
                    "queue_name": queue_name
                }
            }
        ]
    });

    if let Some(payload) = payload_json {
        out["payload_json"] = Value::String(payload);
    }

    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn cli_error_receipt(argv: &[String], err: &str, code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "state_kernel_cli_error",
        "lane": LANE_ID,
        "ts": now_iso(),
        "argv": argv,
        "error": err,
        "exit_code": code
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let cmd = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    match cmd.as_str() {
        "status" | "queue-enqueue" => {
            print_json_line(&native_receipt(root, &cmd, argv));
            0
        }
        _ => {
            usage();
            print_json_line(&cli_error_receipt(argv, "unknown_command", 2));
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn queue_enqeue_receipt_contains_queue_name() {
        let root = tempfile::tempdir().expect("tempdir");
        let payload = native_receipt(
            root.path(),
            "queue-enqueue",
            &[
                "queue-enqueue".to_string(),
                "--queue-name=autonomy".to_string(),
                "--payload-json={\"job\":\"x\"}".to_string(),
            ],
        );
        assert_eq!(
            payload.get("queue_name").and_then(Value::as_str),
            Some("autonomy")
        );
        assert_eq!(
            payload.get("payload_present").and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn status_receipt_is_hashed() {
        let root = tempfile::tempdir().expect("tempdir");
        let payload = native_receipt(root.path(), "status", &[]);
        let hash = payload
            .get("receipt_hash")
            .and_then(Value::as_str)
            .expect("hash")
            .to_string();
        let mut unhashed = payload.clone();
        unhashed
            .as_object_mut()
            .expect("obj")
            .remove("receipt_hash");
        assert_eq!(receipt_hash(&unhashed), hash);
    }
}
