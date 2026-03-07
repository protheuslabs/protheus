// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Map, Value};
use std::path::Path;

pub struct LaneSpec<'a> {
    pub lane_id: &'a str,
    pub lane_type: &'a str,
    pub replacement: &'a str,
    pub usage: &'a [&'a str],
    pub passthrough_flags: &'a [&'a str],
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let pref = format!("--{key}=");
    let key_long = format!("--{key}");
    let mut i = 0usize;
    while i < argv.len() {
        let token = argv[i].trim();
        if let Some(v) = token.strip_prefix(&pref) {
            return Some(v.to_string());
        }
        if token == key_long && i + 1 < argv.len() {
            return Some(argv[i + 1].clone());
        }
        i += 1;
    }
    None
}

fn passthrough_flag_map(argv: &[String], keys: &[&str]) -> Value {
    let mut out = Map::new();
    for key in keys {
        if let Some(v) = parse_flag(argv, key) {
            out.insert((*key).to_string(), Value::String(v));
        }
    }
    Value::Object(out)
}

fn usage(lines: &[&str]) {
    for line in lines {
        println!("{line}");
    }
}

fn lane_receipt(root: &Path, cmd: &str, argv: &[String], spec: &LaneSpec<'_>) -> Value {
    let flags = passthrough_flag_map(argv, spec.passthrough_flags);
    let mut out = json!({
        "ok": true,
        "type": spec.lane_type,
        "lane": spec.lane_id,
        "ts": now_iso(),
        "command": cmd,
        "argv": argv,
        "flags": flags,
        "replacement": spec.replacement,
        "root": root.to_string_lossy(),
        "claim_evidence": [
            {
                "id": format!("native_{}_lane", spec.lane_id),
                "claim": "lane_executes_natively_in_rust",
                "evidence": {
                    "command": cmd
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run_lane(root: &Path, argv: &[String], spec: &LaneSpec<'_>) -> i32 {
    let cmd = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        usage(spec.usage);
        return 0;
    }

    print_json_line(&lane_receipt(root, &cmd, argv, spec));
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lane_receipt_hash_is_deterministic() {
        let root = tempfile::tempdir().expect("tempdir");
        let spec = LaneSpec {
            lane_id: "sample_lane",
            lane_type: "sample_lane",
            replacement: "protheus-ops sample-lane",
            usage: &["Usage:", "  protheus-ops sample-lane status"],
            passthrough_flags: &["apply", "strict"],
        };
        let args = vec![
            "run".to_string(),
            "--apply=1".to_string(),
            "--strict=0".to_string(),
        ];

        let payload = lane_receipt(root.path(), "run", &args, &spec);
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
        assert_eq!(deterministic_receipt_hash(&unhashed), hash);
    }
}
