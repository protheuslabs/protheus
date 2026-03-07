// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso, parse_args};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const LANE_ID: &str = "audit_log_export";
const DEFAULT_POLICY_REL: &str = "client/config/audit_log_export_policy.json";

#[derive(Debug, Clone)]
struct Policy {
    strict_default: bool,
    max_events_per_export: usize,
    output_dir: PathBuf,
    latest_path: PathBuf,
    history_path: PathBuf,
    policy_path: PathBuf,
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops audit-log-export export --target=<splunk|elk|datadog> --input=<path> [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops audit-log-export status [--policy=<path>]");
}

fn resolve_path(root: &Path, raw: Option<&str>, fallback: &str) -> PathBuf {
    let token = raw.unwrap_or(fallback).trim();
    if token.is_empty() {
        return root.join(fallback);
    }
    let candidate = PathBuf::from(token);
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

fn ensure_parent(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
}

fn write_text_atomic(path: &Path, text: &str) -> Result<(), String> {
    ensure_parent(path);
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&tmp, text).map_err(|e| format!("write_tmp_failed:{}:{e}", path.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename_tmp_failed:{}:{e}", path.display()))
}

fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path);
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open_jsonl_failed:{}:{e}", path.display()))?;
    let line = serde_json::to_string(value).map_err(|e| format!("encode_jsonl_failed:{e}"))?;
    f.write_all(line.as_bytes())
        .and_then(|_| f.write_all(b"\n"))
        .map_err(|e| format!("append_jsonl_failed:{}:{e}", path.display()))
}

fn load_policy(root: &Path, policy_override: Option<&String>) -> Policy {
    let policy_path = policy_override
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(DEFAULT_POLICY_REL));

    let raw = fs::read_to_string(&policy_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}));

    let outputs = raw.get("outputs").and_then(Value::as_object);
    Policy {
        strict_default: raw
            .get("strict_default")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        max_events_per_export: raw
            .get("max_events_per_export")
            .and_then(Value::as_u64)
            .unwrap_or(5000) as usize,
        output_dir: resolve_path(
            root,
            raw.get("output_dir").and_then(Value::as_str),
            "state/ops/audit_log_export/exports",
        ),
        latest_path: resolve_path(
            root,
            outputs
                .and_then(|o| o.get("latest_path"))
                .and_then(Value::as_str),
            "state/ops/audit_log_export/latest.json",
        ),
        history_path: resolve_path(
            root,
            outputs
                .and_then(|o| o.get("history_path"))
                .and_then(Value::as_str),
            "state/ops/audit_log_export/history.jsonl",
        ),
        policy_path,
    }
}

fn parse_input_events(path: &Path, max_events: usize) -> Result<Vec<Value>, String> {
    let body = fs::read_to_string(path)
        .map_err(|e| format!("read_input_failed:{}:{e}", path.display()))?;
    let mut events = Vec::new();
    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed = serde_json::from_str::<Value>(trimmed)
            .map_err(|e| format!("parse_input_line_failed:{}:{e}", path.display()))?;
        events.push(parsed);
        if events.len() >= max_events {
            break;
        }
    }
    Ok(events)
}

fn sha256_text(text: &str) -> String {
    let mut h = Sha256::new();
    h.update(text.as_bytes());
    format!("{:x}", h.finalize())
}

fn build_payload(target: &str, events: &[Value]) -> Result<Value, String> {
    match target {
        "splunk" => {
            let rows = events
                .iter()
                .map(|event| {
                    json!({
                        "time": now_iso(),
                        "source": "protheus",
                        "sourcetype": "json",
                        "event": event
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({ "records": rows }))
        }
        "elk" => {
            let mut ndjson = String::new();
            for event in events {
                ndjson.push_str("{\"index\":{}}\n");
                ndjson.push_str(
                    &serde_json::to_string(event)
                        .map_err(|e| format!("encode_elk_event_failed:{e}"))?,
                );
                ndjson.push('\n');
            }
            Ok(json!({ "bulk_ndjson": ndjson }))
        }
        "datadog" => {
            let rows = events
                .iter()
                .map(|event| {
                    let mut row = event.clone();
                    if let Some(obj) = row.as_object_mut() {
                        obj.entry("ddsource".to_string())
                            .or_insert_with(|| Value::String("protheus".to_string()));
                    }
                    row
                })
                .collect::<Vec<_>>();
            Ok(json!({ "records": rows }))
        }
        _ => Err(format!("unsupported_target:{target}")),
    }
}

fn export_run(root: &Path, policy: &Policy, flags: &std::collections::HashMap<String, String>) -> Value {
    let target = flags
        .get("target")
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let input_path = resolve_path(
        root,
        flags.get("input").map(String::as_str),
        "state/security/autonomy_human_escalations.jsonl",
    );

    let events = parse_input_events(&input_path, policy.max_events_per_export).unwrap_or_default();

    let mut checks = vec![
        json!({"id":"target_supported","ok": matches!(target.as_str(), "splunk" | "elk" | "datadog"), "target": target}),
        json!({"id":"input_present","ok": input_path.exists(), "input": input_path}),
        json!({"id":"events_present","ok": !events.is_empty(), "event_count": events.len()}),
    ];

    let payload = build_payload(&target, &events).unwrap_or_else(|_| json!({}));

    let payload_string = serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string());
    let export_hash = sha256_text(&payload_string);
    let export_path = policy
        .output_dir
        .join(format!("{}_{}.json", target, &export_hash[..12]));

    let write_ok = write_text_atomic(&export_path, &(payload_string.clone() + "\n")).is_ok();
    checks.push(json!({"id":"export_written","ok": write_ok, "export_path": export_path}));

    let replay_receipt_pointers = events
        .iter()
        .map(|event| {
            let encoded = serde_json::to_string(event).unwrap_or_else(|_| "{}".to_string());
            format!("evt_{}", &sha256_text(&encoded)[..16])
        })
        .collect::<Vec<_>>();

    let blocking = checks
        .iter()
        .filter_map(|row| {
            if row.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                None
            } else {
                row.get("id").and_then(Value::as_str).map(|v| v.to_string())
            }
        })
        .collect::<Vec<_>>();

    json!({
        "ok": blocking.is_empty(),
        "type": "audit_log_export_run",
        "lane": LANE_ID,
        "schema_id": "audit_log_export",
        "schema_version": "1.0",
        "ts": now_iso(),
        "target": target,
        "event_count": events.len(),
        "checks": checks,
        "blocking_checks": blocking,
        "export_path": export_path,
        "export_hash": export_hash,
        "replay_receipt_pointers": replay_receipt_pointers,
        "claim_evidence": [
            {
                "id": "siem_export_contract",
                "claim": "audit_logs_export_to_splunk_elk_datadog_with_replay_safe_receipt_pointers",
                "evidence": {
                    "target": target,
                    "event_count": events.len(),
                    "pointer_count": replay_receipt_pointers.len()
                }
            }
        ]
    })
}

fn status(policy: &Policy) -> Value {
    let latest = fs::read_to_string(&policy.latest_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({ "ok": false, "error": "latest_missing" }));

    let mut out = json!({
        "ok": latest.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "type": "audit_log_export_status",
        "lane": LANE_ID,
        "ts": now_iso(),
        "policy_path": policy.policy_path,
        "latest_path": policy.latest_path,
        "history_path": policy.history_path,
        "latest": latest
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn persist(policy: &Policy, payload: &Value) -> Result<(), String> {
    write_text_atomic(
        &policy.latest_path,
        &format!(
            "{}\n",
            serde_json::to_string_pretty(payload).map_err(|e| format!("encode_latest_failed:{e}"))?
        ),
    )?;
    append_jsonl(&policy.history_path, payload)
}

fn cli_error(argv: &[String], err: &str, code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "audit_log_export_cli_error",
        "lane": LANE_ID,
        "ts": now_iso(),
        "argv": argv,
        "error": err,
        "exit_code": code
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(cmd.as_str(), "--help" | "-h" | "help") {
        usage();
        return 0;
    }

    let policy = load_policy(root, parsed.flags.get("policy"));
    let strict = parsed
        .flags
        .get("strict")
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(policy.strict_default);

    let payload = match cmd.as_str() {
        "export" => export_run(root, &policy, &parsed.flags),
        "status" => {
            let out = status(&policy);
            println!("{}", serde_json::to_string(&out).unwrap_or_else(|_| "{}".to_string()));
            return 0;
        }
        _ => {
            usage();
            let out = cli_error(argv, "unknown_command", 2);
            println!("{}", serde_json::to_string(&out).unwrap_or_else(|_| "{}".to_string()));
            return 2;
        }
    };

    let mut out = payload;
    out["policy_path"] = Value::String(policy.policy_path.to_string_lossy().to_string());
    out["strict"] = Value::Bool(strict);
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));

    if let Err(err) = persist(&policy, &out) {
        let fail = cli_error(argv, &format!("persist_failed:{err}"), 1);
        println!("{}", serde_json::to_string(&fail).unwrap_or_else(|_| "{}".to_string()));
        return 1;
    }

    println!("{}", serde_json::to_string(&out).unwrap_or_else(|_| "{}".to_string()));
    if strict && !out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_text(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("mkdir");
        }
        fs::write(path, body).expect("write");
    }

    fn write_policy(root: &Path) {
        write_text(
            &root.join("client/config/audit_log_export_policy.json"),
            &json!({
                "strict_default": true,
                "max_events_per_export": 100,
                "output_dir": "state/ops/audit_log_export/exports",
                "outputs": {
                    "latest_path": "state/ops/audit_log_export/latest.json",
                    "history_path": "state/ops/audit_log_export/history.jsonl"
                }
            }).to_string(),
        );
    }

    #[test]
    fn export_rejects_unsupported_target() {
        let tmp = tempdir().expect("tmp");
        write_policy(tmp.path());
        write_text(
            &tmp.path().join("state/input.jsonl"),
            "{\"id\":1,\"msg\":\"x\"}\n",
        );
        let code = run(
            tmp.path(),
            &[
                "export".to_string(),
                "--target=unknown".to_string(),
                "--input=state/input.jsonl".to_string(),
                "--strict=1".to_string(),
            ],
        );
        assert_eq!(code, 1);
    }

    #[test]
    fn export_writes_splunk_payload() {
        let tmp = tempdir().expect("tmp");
        write_policy(tmp.path());
        write_text(
            &tmp.path().join("state/input.jsonl"),
            "{\"id\":1,\"msg\":\"x\"}\n{\"id\":2,\"msg\":\"y\"}\n",
        );
        let code = run(
            tmp.path(),
            &[
                "export".to_string(),
                "--target=splunk".to_string(),
                "--input=state/input.jsonl".to_string(),
                "--strict=1".to_string(),
            ],
        );
        assert_eq!(code, 0);
    }
}
