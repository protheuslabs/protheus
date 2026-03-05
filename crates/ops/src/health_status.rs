use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use std::path::Path;

const LANE_ID: &str = "health_status";
const REPLACEMENT: &str = "protheus-ops health-status";

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
    println!("  protheus-ops health-status status");
    println!("  protheus-ops health-status run");
}

fn status_receipt(root: &Path, cmd: &str, args: &[String]) -> Value {
    let mut out = json!({
        "ok": true,
        "type": "health_status",
        "lane": LANE_ID,
        "ts": now_iso(),
        "command": cmd,
        "argv": args,
        "root": root.to_string_lossy(),
        "replacement": REPLACEMENT,
        "claim_evidence": [
            {
                "id": "native_health_status_lane",
                "claim": "health_status_executes_natively_in_rust",
                "evidence": {
                    "command": cmd,
                    "argv_len": args.len()
                }
            }
        ],
        "persona_lenses": {
            "operator": {
                "mode": "status"
            }
        }
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn cli_error_receipt(args: &[String], err: &str, code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "health_status_cli_error",
        "lane": LANE_ID,
        "ts": now_iso(),
        "argv": args,
        "error": err,
        "exit_code": code,
        "claim_evidence": [
            {
                "id": "health_status_fail_closed_cli",
                "claim": "invalid_health_status_commands_fail_closed",
                "evidence": {
                    "error": err,
                    "argv_len": args.len()
                }
            }
        ]
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
            print_json_line(&status_receipt(root, &cmd, argv));
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
    fn defaults_to_status_and_emits_deterministic_hash() {
        let root = tempfile::tempdir().expect("tempdir");
        let payload = status_receipt(root.path(), "status", &[]);
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
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

    #[test]
    fn unknown_command_fails_closed() {
        let payload = cli_error_receipt(&["nope".to_string()], "unknown_command", 2);
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(payload.get("exit_code").and_then(Value::as_i64), Some(2));
    }
}
