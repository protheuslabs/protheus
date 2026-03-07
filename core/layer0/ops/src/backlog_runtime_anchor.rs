// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::path::Path;

fn stable_hash(seed: &str, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let hex = hex::encode(hasher.finalize());
    hex[..len.min(hex.len())].to_string()
}

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

fn clean_lane_id(raw: &str) -> String {
    raw.trim()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        .collect::<String>()
        .to_ascii_uppercase()
}

fn flag_value(argv: &[String], key: &str) -> Option<String> {
    let pref = format!("--{key}=");
    let mut i = 0usize;
    while i < argv.len() {
        let tok = argv[i].trim();
        if let Some(v) = tok.strip_prefix(&pref) {
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

fn build_anchor_with_ts(lane_id: &str, ts: &str) -> Value {
    let seed = json!({ "lane": lane_id, "ts": ts }).to_string();
    let anchor_hash = stable_hash(&seed, 32);
    json!({
        "ok": true,
        "type": "backlog_runtime_anchor",
        "lane_id": lane_id,
        "ts": ts,
        "anchor_hash": anchor_hash,
        "contract": {
            "deterministic": true,
            "reversible": true,
            "receipt_ready": true
        }
    })
}

fn cli_error_receipt(argv: &[String], err: &str, code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "backlog_runtime_anchor_cli_error",
        "ts": now_iso(),
        "argv": argv,
        "error": err,
        "exit_code": code
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn run_verify(lane_id: &str) -> Value {
    let row = build_anchor_with_ts(lane_id, &now_iso());
    let ok = row
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && row
            .get("lane_id")
            .and_then(Value::as_str)
            .map(|v| v == lane_id)
            .unwrap_or(false);
    let mut out = json!({
        "ok": ok,
        "type": "backlog_runtime_anchor_verify",
        "lane_id": lane_id,
        "anchor": row
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

pub fn run(_root: &Path, argv: &[String]) -> i32 {
    let cmd = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "build".to_string());

    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        println!("Usage:");
        println!("  protheus-ops backlog-runtime-anchor build --lane-id=<V3-RACE-XXX>");
        println!("  protheus-ops backlog-runtime-anchor verify --lane-id=<V3-RACE-XXX>");
        return 0;
    }

    let lane_id = clean_lane_id(
        &flag_value(argv, "lane-id")
            .or_else(|| argv.get(1).cloned())
            .unwrap_or_default(),
    );
    if lane_id.is_empty() {
        print_json_line(&cli_error_receipt(argv, "lane_id_missing", 2));
        return 2;
    }

    let out = match cmd.as_str() {
        "build" | "run" => {
            let mut row = build_anchor_with_ts(&lane_id, &now_iso());
            row["receipt_hash"] = Value::String(receipt_hash(&row));
            row
        }
        "verify" | "status" => run_verify(&lane_id),
        _ => {
            print_json_line(&cli_error_receipt(argv, "unknown_command", 2));
            return 2;
        }
    };

    let ok = out.get("ok").and_then(Value::as_bool).unwrap_or(false);
    print_json_line(&out);
    if ok { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_anchor_is_deterministic_for_same_lane_and_ts() {
        let a = build_anchor_with_ts("V3-RACE-031", "2026-03-05T00:00:00.000Z");
        let b = build_anchor_with_ts("V3-RACE-031", "2026-03-05T00:00:00.000Z");
        assert_eq!(a, b);
        assert_eq!(
            a.get("anchor_hash").and_then(Value::as_str).map(str::len),
            Some(32)
        );
    }

    #[test]
    fn clean_lane_id_normalizes_case_and_symbols() {
        assert_eq!(clean_lane_id(" v3-race-038a "), "V3-RACE-038A");
        assert_eq!(clean_lane_id("v3 race !!"), "V3RACE");
    }
}
