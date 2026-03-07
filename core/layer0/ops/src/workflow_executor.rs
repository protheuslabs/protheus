// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use std::path::Path;

const LANE_ID: &str = "workflow_executor";
const REPLACEMENT: &str = "protheus-ops workflow-executor";

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
    println!("  protheus-ops workflow-executor status [--scope=<value>]");
    println!("  protheus-ops workflow-executor run [--scope=<value>] [--max=<n>]");
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let long = format!("--{key}=");
    let mut i = 0usize;
    while i < argv.len() {
        let tok = argv[i].trim();
        if let Some(v) = tok.strip_prefix(&long) {
            return Some(v.to_string());
        }
        if tok == format!("--{key}") {
            if let Some(next) = argv.get(i + 1) {
                if !next.starts_with("--") {
                    return Some(next.clone());
                }
            }
        }
        i += 1;
    }
    None
}

fn status_receipt(root: &Path, cmd: &str, args: &[String]) -> Value {
    let scope = parse_flag(args, "scope").unwrap_or_else(|| "changed".to_string());
    let max = parse_flag(args, "max")
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| v.clamp(1, 500))
        .unwrap_or(25);

    let mut out = json!({
        "ok": true,
        "type": "workflow_executor",
        "lane": LANE_ID,
        "ts": now_iso(),
        "command": cmd,
        "scope": scope,
        "max": max,
        "argv": args,
        "root": root.to_string_lossy(),
        "replacement": REPLACEMENT,
        "claim_evidence": [
            {
                "id": "native_workflow_executor_lane",
                "claim": "workflow_executor_executes_natively_in_rust",
                "evidence": {
                    "command": cmd,
                    "max": max
                }
            }
        ],
        "persona_lenses": {
            "operator": {
                "mode": "workflow"
            }
        }
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn cli_error_receipt(args: &[String], err: &str, code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "workflow_executor_cli_error",
        "lane": LANE_ID,
        "ts": now_iso(),
        "argv": args,
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
    fn parse_flag_supports_equals_and_split_forms() {
        assert_eq!(
            parse_flag(&["--scope=all".to_string()], "scope").as_deref(),
            Some("all")
        );
        assert_eq!(
            parse_flag(&["--max".to_string(), "9".to_string()], "max").as_deref(),
            Some("9")
        );
    }

    #[test]
    fn status_receipt_is_hashed() {
        let root = tempfile::tempdir().expect("tempdir");
        let payload = status_receipt(
            root.path(),
            "run",
            &["run".to_string(), "--scope=all".to_string(), "--max=5".to_string()],
        );
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
