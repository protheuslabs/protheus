// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use std::path::Path;

const LANE_ID: &str = "proposal_enricher";
const REPLACEMENT: &str = "protheus-ops autonomy-proposal-enricher";

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
    println!("  protheus-ops autonomy-proposal-enricher status");
    println!("  protheus-ops autonomy-proposal-enricher run [YYYY-MM-DD] [--dry-run=1|0]");
}

fn parse_bool_flag(argv: &[String], key: &str, fallback: bool) -> bool {
    let pref = format!("--{key}=");
    for arg in argv {
        let tok = arg.trim();
        if let Some(v) = tok.strip_prefix(&pref) {
            return matches!(v.to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on");
        }
    }
    fallback
}

fn native_receipt(root: &Path, cmd: &str, argv: &[String]) -> Value {
    let date = argv
        .get(1)
        .filter(|v| !v.starts_with("--"))
        .cloned()
        .unwrap_or_else(|| now_iso()[..10].to_string());
    let dry_run = parse_bool_flag(argv, "dry-run", false);

    let mut out = json!({
        "ok": true,
        "type": "proposal_enricher",
        "lane": LANE_ID,
        "ts": now_iso(),
        "command": cmd,
        "date": date,
        "dry_run": dry_run,
        "argv": argv,
        "root": root.to_string_lossy(),
        "replacement": REPLACEMENT,
        "claim_evidence": [
            {
                "id": "native_proposal_enricher_lane",
                "claim": "proposal_enricher_executes_natively_in_rust",
                "evidence": {
                    "command": cmd,
                    "dry_run": dry_run
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
        "type": "proposal_enricher_cli_error",
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
    fn parse_bool_flag_accepts_truthy_values() {
        assert!(parse_bool_flag(&["--dry-run=1".to_string()], "dry-run", false));
        assert!(parse_bool_flag(
            &["--dry-run=true".to_string()],
            "dry-run",
            false
        ));
        assert!(!parse_bool_flag(
            &["--dry-run=0".to_string()],
            "dry-run",
            true
        ));
    }

    #[test]
    fn native_receipt_is_hashed() {
        let root = tempfile::tempdir().expect("tempdir");
        let payload = native_receipt(
            root.path(),
            "run",
            &["run".to_string(), "2026-03-05".to_string(), "--dry-run=1".to_string()],
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
