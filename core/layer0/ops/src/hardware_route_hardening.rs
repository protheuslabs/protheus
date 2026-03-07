// SPDX-License-Identifier: Apache-2.0
use crate::{clean, deterministic_receipt_hash, now_iso, parse_args};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const POLICY_REL: &str = "client/config/hardware_route_hardening_policy.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProfilePolicy {
    micro_task_model: String,
    deep_task_model: String,
    fallback_model: String,
    max_context_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Policy {
    schema_id: String,
    schema_version: String,
    default_profile: String,
    profiles: HashMap<String, ProfilePolicy>,
    state_path: String,
}

pub fn run(root: &Path, args: &[String]) -> i32 {
    let parsed = parse_args(args);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "evaluate".to_string());

    match cmd.as_str() {
        "evaluate" => evaluate(root, &parsed),
        "status" => status(root, &parsed),
        _ => {
            print_json(&json!({
                "ok": false,
                "type": "hardware_route_hardening",
                "error": "unknown_command",
                "command": cmd
            }));
            1
        }
    }
}

fn evaluate(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let policy_path = parsed
        .flags
        .get("policy")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(POLICY_REL));
    let policy = match load_policy(&policy_path) {
        Ok(value) => value,
        Err(err) => {
            print_json(&error_receipt(&format!("policy_load_failed:{err}")));
            return 1;
        }
    };

    let requested_profile = clean(
        parsed
            .flags
            .get("profile")
            .map(String::as_str)
            .unwrap_or(policy.default_profile.as_str()),
        64,
    );
    let task_class = clean(
        parsed
            .flags
            .get("task-class")
            .map(String::as_str)
            .unwrap_or("micro"),
        32,
    )
    .to_ascii_lowercase();
    let requested_tokens = parsed
        .flags
        .get("requested-context-tokens")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let provider_online = parse_bool(parsed.flags.get("provider-online").map(String::as_str), true);

    let resolved_profile = if policy.profiles.contains_key(&requested_profile) {
        requested_profile.clone()
    } else {
        policy.default_profile.clone()
    };
    let profile_policy = match policy.profiles.get(&resolved_profile) {
        Some(profile) => profile,
        None => {
            print_json(&error_receipt("default_profile_missing_in_policy"));
            return 1;
        }
    };

    let preferred_model = if task_class == "deep" {
        profile_policy.deep_task_model.clone()
    } else {
        profile_policy.micro_task_model.clone()
    };

    let mut fallback_reasons = Vec::new();
    if !provider_online {
        fallback_reasons.push("provider_offline".to_string());
    }
    if requested_tokens > profile_policy.max_context_tokens {
        fallback_reasons.push("context_exceeds_profile_limit".to_string());
    }

    let fallback_applied = !fallback_reasons.is_empty();
    let selected_model = if fallback_applied {
        profile_policy.fallback_model.clone()
    } else {
        preferred_model.clone()
    };

    let ts = now_iso();
    let mut receipt = json!({
        "ok": true,
        "type": "hardware_route_hardening",
        "schema_id": "hardware_route_hardening_receipt",
        "schema_version": "1.0",
        "ts": ts,
        "date": ts[..10].to_string(),
        "command": "evaluate",
        "profile": {
            "requested": requested_profile,
            "resolved": resolved_profile
        },
        "task_class": task_class,
        "routing": {
            "provider_online": provider_online,
            "requested_context_tokens": requested_tokens,
            "max_context_tokens": profile_policy.max_context_tokens,
            "preferred_model": preferred_model,
            "fallback_model": profile_policy.fallback_model,
            "selected_model": selected_model,
            "fallback_applied": fallback_applied,
            "fallback_reasons": fallback_reasons
        },
        "operator_message": operator_message(fallback_applied),
        "policy": {
            "path": policy_path.to_string_lossy().to_string()
        },
        "claim_evidence": [
            {
                "id": "hardware_aware_route_hardening",
                "claim": "task_class_routing_uses_hardware_profile_limits_with_deterministic_fallback_reasons",
                "evidence": {
                    "task_class": task_class,
                    "fallback_applied": fallback_applied,
                    "selected_model": selected_model
                }
            }
        ]
    });
    receipt["receipt_hash"] = Value::String(deterministic_receipt_hash(&receipt));
    print_json(&receipt);

    let state_path = root.join(clean(&policy.state_path, 240));
    let _ = write_state(&state_path, &receipt);
    0
}

fn status(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let policy_path = parsed
        .flags
        .get("policy")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(POLICY_REL));
    let policy = match load_policy(&policy_path) {
        Ok(value) => value,
        Err(err) => {
            print_json(&error_receipt(&format!("policy_load_failed:{err}")));
            return 1;
        }
    };
    let state_path = root.join(clean(&policy.state_path, 240));
    if !state_path.exists() {
        print_json(&json!({
            "ok": false,
            "type": "hardware_route_hardening_status",
            "error": "state_missing",
            "state_path": state_path.to_string_lossy().to_string()
        }));
        return 1;
    }
    match fs::read_to_string(&state_path) {
        Ok(raw) => {
            let mut value = serde_json::from_str::<Value>(&raw).unwrap_or_else(|_| {
                json!({
                    "ok": false,
                    "type": "hardware_route_hardening_status",
                    "error": "state_decode_failed"
                })
            });
            value["type"] = Value::String("hardware_route_hardening_status".to_string());
            print_json(&value);
            0
        }
        Err(err) => {
            print_json(&json!({
                "ok": false,
                "type": "hardware_route_hardening_status",
                "error": format!("state_read_failed:{err}")
            }));
            1
        }
    }
}

fn load_policy(path: &Path) -> Result<Policy, String> {
    let raw = fs::read_to_string(path).map_err(|err| format!("read_failed:{err}"))?;
    serde_json::from_str(&raw).map_err(|err| format!("decode_failed:{err}"))
}

fn parse_bool(raw: Option<&str>, fallback: bool) -> bool {
    let Some(value) = raw else {
        return fallback;
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn write_state(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("mkdir_failed:{err}"))?;
    }
    let encoded = serde_json::to_string_pretty(value).map_err(|err| format!("encode_failed:{err}"))?;
    fs::write(path, format!("{encoded}\n")).map_err(|err| format!("write_failed:{err}"))
}

fn operator_message(fallback_applied: bool) -> &'static str {
    if fallback_applied {
        "Fallback model selected due to hardware/profile constraints or provider availability."
    } else {
        "Preferred model selected under current hardware profile and policy constraints."
    }
}

fn error_receipt(error: &str) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "hardware_route_hardening",
        "error": error
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string())
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_policy(root: &Path) -> PathBuf {
        let policy = json!({
            "schema_id": "hardware_route_hardening_policy",
            "schema_version": "1.0",
            "default_profile": "desktop",
            "profiles": {
                "desktop": {
                    "micro_task_model": "tiny-model",
                    "deep_task_model": "big-model",
                    "fallback_model": "fallback-model",
                    "max_context_tokens": 1000
                }
            },
            "state_path": "state/ops/hardware_route_hardening/latest.json"
        });
        let path = root.join("policy.json");
        fs::write(
            &path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&policy).expect("policy encode")
            ),
        )
        .expect("policy write");
        path
    }

    #[test]
    fn picks_preferred_model_when_within_limits() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        let policy = write_policy(root);
        let args = vec![
            "evaluate".to_string(),
            format!("--policy={}", policy.to_string_lossy()),
            "--profile=desktop".to_string(),
            "--task-class=micro".to_string(),
            "--requested-context-tokens=500".to_string(),
            "--provider-online=1".to_string(),
        ];
        let exit = run(root, &args);
        assert_eq!(exit, 0);
    }

    #[test]
    fn falls_back_when_provider_offline() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        let policy = write_policy(root);
        let args = vec![
            "evaluate".to_string(),
            format!("--policy={}", policy.to_string_lossy()),
            "--profile=desktop".to_string(),
            "--task-class=deep".to_string(),
            "--requested-context-tokens=500".to_string(),
            "--provider-online=0".to_string(),
        ];
        let exit = run(root, &args);
        assert_eq!(exit, 0);

        let state_path = root.join("state/ops/hardware_route_hardening/latest.json");
        let raw = fs::read_to_string(state_path).expect("state");
        let out: Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(
            out.pointer("/routing/fallback_applied")
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            out.pointer("/routing/selected_model")
                .and_then(Value::as_str),
            Some("fallback-model")
        );
    }

    #[test]
    fn falls_back_when_context_exceeds_limit() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        let policy = write_policy(root);
        let args = vec![
            "evaluate".to_string(),
            format!("--policy={}", policy.to_string_lossy()),
            "--profile=desktop".to_string(),
            "--task-class=deep".to_string(),
            "--requested-context-tokens=4096".to_string(),
            "--provider-online=1".to_string(),
        ];
        let exit = run(root, &args);
        assert_eq!(exit, 0);

        let state_path = root.join("state/ops/hardware_route_hardening/latest.json");
        let raw = fs::read_to_string(state_path).expect("state");
        let out: Value = serde_json::from_str(&raw).expect("json");
        let reasons = out
            .pointer("/routing/fallback_reasons")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|v| v.as_str().map(|s| s.to_string()))
            .collect::<Vec<_>>();
        assert!(reasons.iter().any(|reason| reason == "context_exceeds_profile_limit"));
    }
}
