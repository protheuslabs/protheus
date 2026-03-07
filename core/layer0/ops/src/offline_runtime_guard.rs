// SPDX-License-Identifier: Apache-2.0
use crate::{clean, deterministic_receipt_hash, now_iso, parse_args};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const POLICY_REL: &str = "client/config/offline_runtime_guard_policy.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Policy {
    schema_id: String,
    schema_version: String,
    offline_marker_files: Vec<String>,
    network_probe_targets: Vec<String>,
    degraded_capabilities: BTreeMap<String, bool>,
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
                "type": "offline_runtime_guard",
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
    let force_offline = parse_bool(parsed.flags.get("force-offline").map(String::as_str), false);
    let network_probe_ok = parse_bool(parsed.flags.get("network-probe-ok").map(String::as_str), true);

    let policy = match load_policy(&policy_path) {
        Ok(value) => value,
        Err(err) => {
            print_json(&error_receipt(&format!("policy_load_failed:{err}")));
            return 1;
        }
    };

    let mut offline_reasons = Vec::new();
    if force_offline {
        offline_reasons.push("forced_by_flag".to_string());
    }
    let env_offline = std::env::var("PROTHEUS_OFFLINE")
        .ok()
        .map(|value| parse_bool(Some(value.as_str()), false))
        .unwrap_or(false);
    if env_offline {
        offline_reasons.push("forced_by_env".to_string());
    }

    let marker_hits = policy
        .offline_marker_files
        .iter()
        .filter_map(|rel| {
            let path = root.join(rel);
            if path.exists() {
                Some(rel.clone())
            } else {
                None
            }
        })
        .collect::<Vec<_>>();
    for marker in &marker_hits {
        offline_reasons.push(format!("offline_marker:{marker}"));
    }

    if !network_probe_ok {
        offline_reasons.push("network_probe_failed".to_string());
    }

    let offline = !offline_reasons.is_empty();
    let mode = if offline { "offline_degraded" } else { "online_full" };

    let capabilities = if offline {
        policy.degraded_capabilities.clone()
    } else {
        policy
            .degraded_capabilities
            .keys()
            .map(|key| (key.clone(), true))
            .collect::<BTreeMap<_, _>>()
    };

    let ts = now_iso();
    let mut receipt = json!({
        "ok": true,
        "type": "offline_runtime_guard",
        "schema_id": "offline_runtime_guard_receipt",
        "schema_version": "1.0",
        "ts": ts,
        "date": ts[..10].to_string(),
        "command": "evaluate",
        "offline": offline,
        "mode": mode,
        "offline_reasons": offline_reasons,
        "network_probe_targets": policy.network_probe_targets,
        "capabilities": capabilities,
        "operator_message": operator_message(mode),
        "policy": {
            "path": policy_path.to_string_lossy().to_string()
        },
        "claim_evidence": [
            {
                "id": "offline_mode_detection_and_degraded_path",
                "claim": "offline_state_is_detected_deterministically_and_runtime_degrades_to_local_only_capabilities",
                "evidence": {
                    "offline": offline,
                    "mode": mode,
                    "marker_hits": marker_hits
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
            "type": "offline_runtime_guard_status",
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
                    "type": "offline_runtime_guard_status",
                    "error": "state_decode_failed"
                })
            });
            value["type"] = Value::String("offline_runtime_guard_status".to_string());
            print_json(&value);
            0
        }
        Err(err) => {
            print_json(&json!({
                "ok": false,
                "type": "offline_runtime_guard_status",
                "error": format!("state_read_failed:{err}")
            }));
            1
        }
    }
}

fn operator_message(mode: &str) -> &'static str {
    match mode {
        "offline_degraded" => {
            "Offline mode active: remote research/assimilation disabled; local memory and local model paths remain available."
        }
        _ => "Online mode active: full capability set available.",
    }
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

fn load_policy(path: &Path) -> Result<Policy, String> {
    let raw = fs::read_to_string(path).map_err(|err| format!("read_failed:{err}"))?;
    serde_json::from_str(&raw).map_err(|err| format!("decode_failed:{err}"))
}

fn write_state(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("mkdir_failed:{err}"))?;
    }
    let encoded = serde_json::to_string_pretty(value).map_err(|err| format!("encode_failed:{err}"))?;
    fs::write(path, format!("{encoded}\n")).map_err(|err| format!("write_failed:{err}"))
}

fn error_receipt(error: &str) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "offline_runtime_guard",
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
            "schema_id": "offline_runtime_guard_policy",
            "schema_version": "1.0",
            "offline_marker_files": ["state/network/OFFLINE_MODE"],
            "network_probe_targets": ["https://example.invalid"],
            "degraded_capabilities": {
                "research_remote_fetch": false,
                "cloud_model_inference": false,
                "assimilation_remote_sync": false,
                "local_memory_retrieval": true,
                "local_model_inference": true
            },
            "state_path": "state/ops/offline_runtime_guard/latest.json"
        });
        let policy_path = root.join("policy.json");
        fs::write(
            &policy_path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&policy).expect("policy encode")
            ),
        )
        .expect("policy write");
        policy_path
    }

    #[test]
    fn evaluate_online_mode_when_no_offline_signals() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        let policy = write_policy(root);
        let args = vec![
            "evaluate".to_string(),
            format!("--policy={}", policy.to_string_lossy()),
            "--force-offline=0".to_string(),
            "--network-probe-ok=1".to_string(),
        ];
        let exit = run(root, &args);
        assert_eq!(exit, 0);

        let state_path = root.join("state/ops/offline_runtime_guard/latest.json");
        let raw = fs::read_to_string(state_path).expect("state");
        let out: Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(out.get("mode").and_then(Value::as_str), Some("online_full"));
    }

    #[test]
    fn evaluate_offline_mode_when_forced() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        let policy = write_policy(root);
        let args = vec![
            "evaluate".to_string(),
            format!("--policy={}", policy.to_string_lossy()),
            "--force-offline=1".to_string(),
        ];
        let exit = run(root, &args);
        assert_eq!(exit, 0);

        let state_path = root.join("state/ops/offline_runtime_guard/latest.json");
        let raw = fs::read_to_string(state_path).expect("state");
        let out: Value = serde_json::from_str(&raw).expect("json");
        assert_eq!(out.get("mode").and_then(Value::as_str), Some("offline_degraded"));
        assert_eq!(out.get("offline").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn evaluate_offline_mode_when_marker_exists() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        let policy = write_policy(root);
        let marker = root.join("state/network/OFFLINE_MODE");
        fs::create_dir_all(marker.parent().expect("parent")).expect("mkdir");
        fs::write(&marker, "1\n").expect("marker");

        let args = vec![
            "evaluate".to_string(),
            format!("--policy={}", policy.to_string_lossy()),
            "--force-offline=0".to_string(),
        ];
        let exit = run(root, &args);
        assert_eq!(exit, 0);

        let state_path = root.join("state/ops/offline_runtime_guard/latest.json");
        let raw = fs::read_to_string(state_path).expect("state");
        let out: Value = serde_json::from_str(&raw).expect("json");
        let reasons = out
            .get("offline_reasons")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter_map(|value| value.as_str().map(|raw| raw.to_string()))
            .collect::<Vec<_>>();
        assert!(reasons.iter().any(|reason| reason.contains("offline_marker")));
    }
}
