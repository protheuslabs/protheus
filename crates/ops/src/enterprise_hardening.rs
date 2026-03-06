use crate::{deterministic_receipt_hash, now_iso, parse_args};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

const DEFAULT_POLICY_REL: &str = "config/f100_enterprise_hardening_policy.json";
const ALLOWED_DELIVERY_CHANNELS: &[&str] = &[
    "last",
    "main",
    "inbox",
    "discord",
    "slack",
    "email",
    "pagerduty",
    "stdout",
    "stderr",
    "sms",
];

fn usage() {
    println!("Usage:");
    println!("  protheus-ops enterprise-hardening run [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops enterprise-hardening status [--policy=<path>]");
}

fn bool_flag(raw: Option<&str>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("read_json_failed:{}:{err}", path.display()))?;
    serde_json::from_str::<Value>(&raw)
        .map_err(|err| format!("parse_json_failed:{}:{err}", path.display()))
}

fn resolve_json_path<'a>(value: &'a Value, dotted_path: &str) -> Option<&'a Value> {
    let mut cur = value;
    for part in dotted_path.split('.') {
        if part.trim().is_empty() {
            return None;
        }
        cur = cur.get(part)?;
    }
    Some(cur)
}

fn file_contains_all(path: &Path, required_tokens: &[String]) -> Result<Vec<String>, String> {
    let body = fs::read_to_string(path)
        .map_err(|err| format!("read_text_failed:{}:{err}", path.display()))?;
    let missing = required_tokens
        .iter()
        .filter(|token| !body.contains(token.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    Ok(missing)
}

fn check_cron_delivery_integrity(root: &Path, path_rel: &str) -> Result<(bool, Value), String> {
    let path = root.join(path_rel);
    let payload = read_json(&path)?;
    let jobs = payload
        .get("jobs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut issues = Vec::<Value>::new();
    let mut enabled_jobs = 0usize;
    for job in jobs {
        let enabled = job.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        if !enabled {
            continue;
        }
        enabled_jobs += 1;
        let name = job
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        let id = job.get("id").and_then(Value::as_str).unwrap_or("unknown");
        let target = job
            .get("sessionTarget")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let delivery = job.get("delivery").and_then(Value::as_object);

        if delivery.is_none() {
            issues.push(json!({
                "id": id,
                "name": name,
                "reason": "missing_delivery_for_enabled_job",
                "session_target": target
            }));
            continue;
        }

        let Some(delivery) = delivery else {
            continue;
        };

        let mode = delivery
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let channel = delivery
            .get("channel")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();

        if mode == "none" {
            issues.push(json!({
                "id": id,
                "name": name,
                "reason": "delivery_mode_none_forbidden"
            }));
            continue;
        }

        if mode == "announce" {
            if channel.is_empty() {
                issues.push(json!({
                    "id": id,
                    "name": name,
                    "reason": "announce_channel_missing"
                }));
                continue;
            }
            if !ALLOWED_DELIVERY_CHANNELS.contains(&channel.as_str()) {
                issues.push(json!({
                    "id": id,
                    "name": name,
                    "reason": "announce_channel_invalid",
                    "channel": channel
                }));
            }
        }

        if target == "isolated" && mode != "announce" {
            issues.push(json!({
                "id": id,
                "name": name,
                "reason": "isolated_requires_announce"
            }));
        }
    }

    Ok((
        issues.is_empty(),
        json!({
            "enabled_jobs": enabled_jobs,
            "issues": issues,
            "allowed_channels": ALLOWED_DELIVERY_CHANNELS
        }),
    ))
}

fn run_control(root: &Path, control: &serde_json::Map<String, Value>) -> Value {
    let id = control
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let title = control
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("untitled")
        .to_string();
    let kind = control
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("path_exists")
        .to_string();
    let rel_path = control
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if rel_path.trim().is_empty() {
        return json!({
            "id": id,
            "title": title,
            "ok": false,
            "reason": "missing_path"
        });
    }

    let path = root.join(&rel_path);
    match kind.as_str() {
        "path_exists" => {
            let ok = path.exists();
            json!({
                "id": id,
                "title": title,
                "type": kind,
                "ok": ok,
                "path": rel_path,
                "reason": if ok { Value::Null } else { Value::String("path_missing".to_string()) }
            })
        }
        "file_contains_all" => {
            let required_tokens = control
                .get("required_tokens")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(Value::as_str)
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if required_tokens.is_empty() {
                return json!({
                    "id": id,
                    "title": title,
                    "type": kind,
                    "ok": false,
                    "path": rel_path,
                    "reason": "required_tokens_missing"
                });
            }
            match file_contains_all(&path, &required_tokens) {
                Ok(missing) => json!({
                    "id": id,
                    "title": title,
                    "type": kind,
                    "ok": missing.is_empty(),
                    "path": rel_path,
                    "required_tokens": required_tokens.len(),
                    "missing_tokens": missing
                }),
                Err(err) => json!({
                    "id": id,
                    "title": title,
                    "type": kind,
                    "ok": false,
                    "path": rel_path,
                    "reason": err
                }),
            }
        }
        "json_fields" => {
            let required_fields = control
                .get("required_fields")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(Value::as_str)
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if required_fields.is_empty() {
                return json!({
                    "id": id,
                    "title": title,
                    "type": kind,
                    "ok": false,
                    "path": rel_path,
                    "reason": "required_fields_missing"
                });
            }
            match read_json(&path) {
                Ok(payload) => {
                    let missing_fields = required_fields
                        .iter()
                        .filter(|field| resolve_json_path(&payload, field).is_none())
                        .cloned()
                        .collect::<Vec<_>>();
                    json!({
                        "id": id,
                        "title": title,
                        "type": kind,
                        "ok": missing_fields.is_empty(),
                        "path": rel_path,
                        "required_fields": required_fields,
                        "missing_fields": missing_fields
                    })
                }
                Err(err) => json!({
                    "id": id,
                    "title": title,
                    "type": kind,
                    "ok": false,
                    "path": rel_path,
                    "reason": err
                }),
            }
        }
        "cron_delivery_integrity" => match check_cron_delivery_integrity(root, &rel_path) {
            Ok((ok, details)) => json!({
                "id": id,
                "title": title,
                "type": kind,
                "ok": ok,
                "path": rel_path,
                "details": details
            }),
            Err(err) => json!({
                "id": id,
                "title": title,
                "type": kind,
                "ok": false,
                "path": rel_path,
                "reason": err
            }),
        },
        _ => json!({
            "id": id,
            "title": title,
            "type": kind,
            "ok": false,
            "path": rel_path,
            "reason": format!("unknown_control_type:{kind}")
        }),
    }
}

fn run_with_policy(root: &Path, cmd: &str, strict: bool, policy_path_rel: &str) -> Result<Value, String> {
    let policy_path = root.join(policy_path_rel);
    let policy = read_json(&policy_path)?;
    let controls = policy
        .get("controls")
        .and_then(Value::as_array)
        .ok_or_else(|| "enterprise_policy_missing_controls".to_string())?;

    let mut results = Vec::<Value>::new();
    for control in controls {
        let Some(section) = control.as_object() else {
            results.push(json!({
                "id": "unknown",
                "ok": false,
                "reason": "invalid_control_entry"
            }));
            continue;
        };
        results.push(run_control(root, section));
    }

    let passed = results
        .iter()
        .filter(|row| row.get("ok").and_then(Value::as_bool).unwrap_or(false))
        .count();
    let failed = results.len().saturating_sub(passed);
    let ok = if strict { failed == 0 } else { true };

    let mut out = json!({
        "ok": ok,
        "type": "enterprise_hardening",
        "lane": "enterprise_hardening",
        "mode": cmd,
        "strict": strict,
        "ts": now_iso(),
        "policy_path": policy_path_rel,
        "controls_total": results.len(),
        "controls_passed": passed,
        "controls_failed": failed,
        "controls": results,
        "claim_evidence": [
            {
                "id": "f100_controls_gate",
                "claim": "fortune_100_control_contract_is_enforced_before_release",
                "evidence": {
                    "controls_total": controls.len(),
                    "strict": strict,
                    "failed": failed
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    Ok(out)
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    if argv
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h" | "help"))
    {
        usage();
        return 0;
    }

    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "run".to_string());

    let strict_default = cmd == "run";
    let strict = bool_flag(parsed.flags.get("strict").map(String::as_str), strict_default);
    let policy_path = parsed
        .flags
        .get("policy")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_POLICY_REL.to_string());

    match cmd.as_str() {
        "run" | "status" => match run_with_policy(root, &cmd, strict, &policy_path) {
            Ok(out) => {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&out)
                        .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
                );
                if strict && !out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                    1
                } else {
                    0
                }
            }
            Err(err) => {
                let mut out = json!({
                    "ok": false,
                    "type": "enterprise_hardening",
                    "lane": "enterprise_hardening",
                    "mode": cmd,
                    "strict": strict,
                    "ts": now_iso(),
                    "policy_path": policy_path,
                    "error": err
                });
                out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
                println!(
                    "{}",
                    serde_json::to_string_pretty(&out)
                        .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
                );
                1
            }
        },
        _ => {
            usage();
            let mut out = json!({
                "ok": false,
                "type": "enterprise_hardening_cli_error",
                "lane": "enterprise_hardening",
                "ts": now_iso(),
                "error": "unknown_command",
                "command": cmd
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            println!(
                "{}",
                serde_json::to_string_pretty(&out)
                    .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
            );
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_text(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).expect("mkdir");
        }
        fs::write(p, body).expect("write");
    }

    #[test]
    fn cron_integrity_rejects_none_delivery_mode() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_text(
            tmp.path(),
            "config/cron_jobs.json",
            r#"{"jobs":[{"id":"j1","name":"x","enabled":true,"sessionTarget":"isolated","delivery":{"mode":"none","channel":"last"}}]}"#,
        );
        let (ok, details) = check_cron_delivery_integrity(tmp.path(), "config/cron_jobs.json")
            .expect("audit");
        assert!(!ok);
        assert!(details.to_string().contains("delivery_mode_none_forbidden"));
    }

    #[test]
    fn cron_integrity_rejects_missing_delivery_for_enabled_jobs() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_text(
            tmp.path(),
            "config/cron_jobs.json",
            r#"{"jobs":[{"id":"j1","name":"x","enabled":true,"sessionTarget":"main"}]}"#,
        );
        let (ok, details) = check_cron_delivery_integrity(tmp.path(), "config/cron_jobs.json")
            .expect("audit");
        assert!(!ok);
        assert!(details
            .to_string()
            .contains("missing_delivery_for_enabled_job"));
    }

    #[test]
    fn run_control_json_fields_detects_missing_field() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_text(tmp.path(), "config/x.json", r#"{"a":{"b":1}}"#);
        let control = json!({
            "id": "c1",
            "title": "json",
            "type": "json_fields",
            "path": "config/x.json",
            "required_fields": ["a.b", "a.c"]
        });
        let out = run_control(tmp.path(), control.as_object().expect("obj"));
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
        assert!(out.to_string().contains("a.c"));
    }
}
