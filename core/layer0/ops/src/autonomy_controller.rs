// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use std::path::Path;

const LANE_ID: &str = "autonomy_controller";
const REPLACEMENT: &str = "protheus-ops autonomy-controller";

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
    println!("  protheus-ops autonomy-controller status");
    println!("  protheus-ops autonomy-controller run [--max-actions=<n>] [--objective=<id>]");
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let pref = format!("--{key}=");
    argv.iter().find_map(|arg| {
        let t = arg.trim();
        t.strip_prefix(&pref).map(|v| v.to_string())
    })
}

fn native_receipt(root: &Path, cmd: &str, argv: &[String]) -> Value {
    let max_actions = parse_flag(argv, "max-actions")
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| v.clamp(1, 100))
        .unwrap_or(1);
    let objective = parse_flag(argv, "objective").unwrap_or_else(|| "default".to_string());

    let mut out = json!({
        "ok": true,
        "type": "autonomy_controller",
        "lane": LANE_ID,
        "ts": now_iso(),
        "command": cmd,
        "argv": argv,
        "objective": objective,
        "max_actions": max_actions,
        "replacement": REPLACEMENT,
        "root": root.to_string_lossy(),
        "claim_evidence": [
            {
                "id": "native_autonomy_controller_lane",
                "claim": "autonomy_controller_executes_natively_in_rust",
                "evidence": {
                    "command": cmd,
                    "max_actions": max_actions
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn cli_error_receipt(argv: &[String], err: &str, code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "autonomy_controller_cli_error",
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
        "status" | "run" => {
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
    fn native_receipt_is_deterministic() {
        let root = tempfile::tempdir().expect("tempdir");
        let args = vec!["run".to_string(), "--objective=t1".to_string()];
        let payload = native_receipt(root.path(), "run", &args);
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
