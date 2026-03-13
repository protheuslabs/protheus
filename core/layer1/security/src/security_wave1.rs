// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer1/security (authoritative)

use chrono::{SecondsFormat, Utc};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn clean_text(v: impl ToString, max_len: usize) -> String {
    v.to_string()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_len)
        .collect::<String>()
        .trim()
        .to_string()
}

fn normalize_token(v: impl ToString, max_len: usize) -> String {
    clean_text(v, max_len)
        .to_ascii_lowercase()
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '/' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .split('_')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("_")
}

fn normalize_rel_path(v: impl ToString) -> String {
    v.to_string()
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string()
}

fn runtime_root(repo_root: &Path) -> PathBuf {
    repo_root.join("client").join("runtime")
}

fn runtime_config_path(repo_root: &Path, file_name: &str) -> PathBuf {
    runtime_root(repo_root).join("config").join(file_name)
}

fn runtime_state_root(repo_root: &Path) -> PathBuf {
    runtime_root(repo_root).join("state")
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create_dir_failed:{}:{err}", parent.display()))?;
    }
    Ok(())
}

fn read_json_or(path: &Path, fallback: Value) -> Value {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or(fallback),
        Err(_) => fallback,
    }
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        Utc::now().timestamp_millis()
    ));
    let payload = serde_json::to_vec_pretty(value)
        .map_err(|err| format!("encode_json_failed:{}:{err}", path.display()))?;
    fs::write(&tmp, payload).map_err(|err| format!("write_tmp_failed:{}:{err}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|err| {
        format!(
            "rename_tmp_failed:{}:{}:{err}",
            tmp.display(),
            path.display()
        )
    })
}

fn append_jsonl(path: &Path, row: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let encoded = serde_json::to_string(row)
        .map_err(|err| format!("encode_jsonl_failed:{}:{err}", path.display()))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("open_jsonl_failed:{}:{err}", path.display()))?;
    writeln!(file, "{encoded}")
        .map_err(|err| format!("append_jsonl_failed:{}:{err}", path.display()))
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    let raw = match fs::read_to_string(path) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    raw.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>()
}

fn stable_json_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(v) => {
            if *v {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(rows) => format!(
            "[{}]",
            rows.iter()
                .map(stable_json_string)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys = map.keys().collect::<Vec<_>>();
            keys.sort();
            let mut out = String::from("{");
            for (idx, key) in keys.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()));
                out.push(':');
                out.push_str(&stable_json_string(map.get(*key).unwrap_or(&Value::Null)));
            }
            out.push('}');
            out
        }
    }
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

fn parse_json_from_stdout(raw: &str) -> Option<Value> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(parsed) = serde_json::from_str::<Value>(trimmed) {
        return Some(parsed);
    }
    for line in trimmed.lines().rev() {
        let candidate = line.trim();
        if !candidate.starts_with('{') {
            continue;
        }
        if let Ok(parsed) = serde_json::from_str::<Value>(candidate) {
            return Some(parsed);
        }
    }
    None
}

#[derive(Debug, Clone, Default)]
struct CliArgs {
    positional: Vec<String>,
    flags: HashMap<String, String>,
}

fn parse_cli_args(argv: &[String]) -> CliArgs {
    let mut out = CliArgs::default();
    let mut i = 0usize;
    while i < argv.len() {
        let token = argv[i].trim().to_string();
        if !token.starts_with("--") {
            out.positional.push(token);
            i += 1;
            continue;
        }
        if let Some((k, v)) = token.split_once('=') {
            out.flags
                .insert(k.trim_start_matches("--").to_string(), v.to_string());
            i += 1;
            continue;
        }
        let key = token.trim_start_matches("--").to_string();
        if let Some(next) = argv.get(i + 1) {
            if !next.starts_with("--") {
                out.flags.insert(key, next.clone());
                i += 2;
                continue;
            }
        }
        out.flags.insert(key, "true".to_string());
        i += 1;
    }
    out
}

fn bool_from_str(v: Option<&str>, fallback: bool) -> bool {
    match v {
        Some(raw) => match raw.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "yes" | "on" => true,
            "0" | "false" | "no" | "off" => false,
            _ => fallback,
        },
        None => fallback,
    }
}

fn bool_state(v: Option<&str>) -> Option<bool> {
    v.and_then(|raw| match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" | "enable" | "enabled" => Some(true),
        "0" | "false" | "no" | "off" | "disable" | "disabled" => Some(false),
        _ => None,
    })
}

fn number_i64(v: Option<&Value>, fallback: i64, lo: i64, hi: i64) -> i64 {
    let parsed = v.and_then(Value::as_i64).unwrap_or(fallback);
    parsed.clamp(lo, hi)
}

fn number_f64(v: Option<&Value>, fallback: f64, lo: f64, hi: f64) -> f64 {
    let parsed = v.and_then(Value::as_f64).unwrap_or(fallback);
    parsed.clamp(lo, hi)
}

// -------------------------------------------------------------------------------------------------
// Capability Switchboard
// -------------------------------------------------------------------------------------------------

fn capability_switchboard_paths(repo_root: &Path) -> (PathBuf, PathBuf, PathBuf, PathBuf, PathBuf) {
    let policy_path = std::env::var("CAPABILITY_SWITCHBOARD_POLICY_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_config_path(repo_root, "capability_switchboard_policy.json"));
    let state_path = std::env::var("CAPABILITY_SWITCHBOARD_STATE_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            runtime_state_root(repo_root)
                .join("security")
                .join("capability_switchboard_state.json")
        });
    let audit_path = std::env::var("CAPABILITY_SWITCHBOARD_AUDIT_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            runtime_state_root(repo_root)
                .join("security")
                .join("capability_switchboard_audit.jsonl")
        });
    let policy_root_script = std::env::var("CAPABILITY_SWITCHBOARD_POLICY_ROOT_SCRIPT")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            runtime_root(repo_root)
                .join("systems")
                .join("security")
                .join("policy_rootd.js")
        });
    let chain_path = std::env::var("CAPABILITY_SWITCHBOARD_CHAIN_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            runtime_state_root(repo_root)
                .join("security")
                .join("capability_switchboard_chain.jsonl")
        });
    (
        policy_path,
        state_path,
        audit_path,
        policy_root_script,
        chain_path,
    )
}

fn capability_switchboard_default_policy() -> Value {
    json!({
        "version": "1.0",
        "require_dual_control": true,
        "dual_control_min_note_len": 12,
        "policy_root": {
            "required": true,
            "scope": "capability_switchboard_toggle"
        },
        "switches": {
            "autonomy": { "default_enabled": true, "security_locked": false, "require_policy_root": true, "description": "Core autonomy execution lane" },
            "reflex": { "default_enabled": true, "security_locked": false, "require_policy_root": true, "description": "Reflex execution lane" },
            "dreams": { "default_enabled": true, "security_locked": false, "require_policy_root": true, "description": "Dream/idle synthesis lane" },
            "sensory_depth": { "default_enabled": true, "security_locked": false, "require_policy_root": true, "description": "Deep sensory collection lane" },
            "routing_modes": { "default_enabled": true, "security_locked": false, "require_policy_root": true, "description": "Routing/model mode lane" },
            "external_actuation": { "default_enabled": true, "security_locked": false, "require_policy_root": true, "description": "External actuation lane" },
            "security": { "default_enabled": true, "security_locked": true, "require_policy_root": true, "description": "Security controls (non-deactivatable)" },
            "integrity": { "default_enabled": true, "security_locked": true, "require_policy_root": true, "description": "Integrity controls (non-deactivatable)" }
        }
    })
}

fn capability_switchboard_load_policy(policy_path: &Path) -> Value {
    let fallback = capability_switchboard_default_policy();
    let raw = read_json_or(policy_path, json!({}));
    let mut merged = fallback;

    if let Some(version) = raw.get("version").and_then(Value::as_str) {
        merged["version"] = Value::String(clean_text(version, 40));
    }
    if let Some(req_dual) = raw.get("require_dual_control").and_then(Value::as_bool) {
        merged["require_dual_control"] = Value::Bool(req_dual);
    }
    if raw.get("dual_control_min_note_len").is_some() {
        let n = number_i64(raw.get("dual_control_min_note_len"), 12, 8, 1024);
        merged["dual_control_min_note_len"] = Value::Number(n.into());
    }
    if let Some(raw_policy_root) = raw.get("policy_root").and_then(Value::as_object) {
        if let Some(v) = raw_policy_root.get("required").and_then(Value::as_bool) {
            merged["policy_root"]["required"] = Value::Bool(v);
        }
        if let Some(scope) = raw_policy_root.get("scope").and_then(Value::as_str) {
            merged["policy_root"]["scope"] = Value::String(clean_text(scope, 160));
        }
    }

    let mut switches_map = merged
        .get("switches")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if let Some(raw_switches) = raw.get("switches").and_then(Value::as_object) {
        for (raw_id, spec) in raw_switches {
            let id = normalize_token(raw_id, 120);
            if id.is_empty() {
                continue;
            }
            let mut row = switches_map.get(&id).cloned().unwrap_or_else(|| json!({}));
            if let Some(default_enabled) = spec.get("default_enabled").and_then(Value::as_bool) {
                row["default_enabled"] = Value::Bool(default_enabled);
            }
            if let Some(security_locked) = spec.get("security_locked").and_then(Value::as_bool) {
                row["security_locked"] = Value::Bool(security_locked);
            }
            if let Some(require_policy_root) =
                spec.get("require_policy_root").and_then(Value::as_bool)
            {
                row["require_policy_root"] = Value::Bool(require_policy_root);
            }
            if let Some(description) = spec.get("description").and_then(Value::as_str) {
                row["description"] = Value::String(clean_text(description, 200));
            }
            switches_map.insert(id, row);
        }
    }
    merged["switches"] = Value::Object(switches_map);
    merged
}

fn capability_switchboard_load_state(state_path: &Path) -> Value {
    let raw = read_json_or(state_path, json!({}));
    let switches = raw
        .get("switches")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    json!({
        "schema_id": "capability_switchboard_state",
        "schema_version": "1.0",
        "updated_at": raw.get("updated_at").cloned().unwrap_or(Value::Null),
        "switches": switches
    })
}

fn capability_switchboard_effective_switches(policy: &Value, state: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let switches = policy
        .get("switches")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let state_switches = state
        .get("switches")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut ids = switches.keys().cloned().collect::<Vec<_>>();
    ids.sort();
    for id in ids {
        let policy_row = switches.get(&id).cloned().unwrap_or_else(|| json!({}));
        let state_row = state_switches
            .get(&id)
            .cloned()
            .unwrap_or_else(|| json!({}));
        let enabled = state_row
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or_else(|| {
                policy_row
                    .get("default_enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true)
            });
        out.push(json!({
            "id": id,
            "enabled": enabled,
            "default_enabled": policy_row.get("default_enabled").and_then(Value::as_bool).unwrap_or(true),
            "security_locked": policy_row.get("security_locked").and_then(Value::as_bool).unwrap_or(false),
            "require_policy_root": policy_row.get("require_policy_root").and_then(Value::as_bool).unwrap_or(true),
            "description": policy_row.get("description").cloned().unwrap_or(Value::Null),
            "updated_at": state_row.get("updated_at").cloned().unwrap_or(Value::Null),
            "updated_by": state_row.get("updated_by").cloned().unwrap_or(Value::Null),
            "reason": state_row.get("reason").cloned().unwrap_or(Value::Null)
        }));
    }
    out
}

fn capability_switchboard_chain_rows(chain_path: &Path) -> Vec<Value> {
    read_jsonl(chain_path)
        .into_iter()
        .filter(|row| {
            row.get("type")
                .and_then(Value::as_str)
                .map(|v| v == "capability_switchboard_chain_event")
                .unwrap_or(false)
        })
        .collect::<Vec<_>>()
}

fn capability_switchboard_chain_tip(chain_path: &Path) -> String {
    capability_switchboard_chain_rows(chain_path)
        .last()
        .and_then(|row| row.get("hash"))
        .and_then(Value::as_str)
        .map(|v| clean_text(v, 140))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "GENESIS".to_string())
}

fn capability_switchboard_verify_chain(chain_path: &Path) -> Value {
    let rows = capability_switchboard_chain_rows(chain_path);
    let mut prev_hash = "GENESIS".to_string();
    for (index, row) in rows.iter().enumerate() {
        let expected_prev = row
            .get("prev_hash")
            .and_then(Value::as_str)
            .map(|v| clean_text(v, 140))
            .unwrap_or_else(|| "GENESIS".to_string());
        if expected_prev != prev_hash {
            return json!({
                "ok": false,
                "entries": rows.len(),
                "error": "chain_prev_hash_mismatch",
                "index": index,
                "expected_prev_hash": prev_hash,
                "actual_prev_hash": expected_prev
            });
        }
        let mut payload = row.clone();
        if let Some(obj) = payload.as_object_mut() {
            obj.remove("hash");
        }
        let calc = sha256_hex(&stable_json_string(&payload));
        let stored = row
            .get("hash")
            .and_then(Value::as_str)
            .map(|v| clean_text(v, 140))
            .unwrap_or_default();
        if calc != stored {
            return json!({
                "ok": false,
                "entries": rows.len(),
                "error": "chain_hash_mismatch",
                "index": index,
                "expected_hash": calc,
                "actual_hash": stored
            });
        }
        prev_hash = stored;
    }
    json!({
        "ok": true,
        "entries": rows.len(),
        "tip_hash": prev_hash
    })
}

fn capability_switchboard_run_policy_root(
    script_path: &Path,
    scope: &str,
    target: &str,
    approval_note: &str,
    lease_token: Option<&str>,
    source: &str,
) -> Value {
    if !script_path.exists() {
        return json!({
            "ok": false,
            "decision": "DENY",
            "reason": "policy_root_script_missing"
        });
    }

    let node = std::env::var("PROTHEUS_NODE_BINARY")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "node".to_string());
    let mut args = vec![
        script_path.to_string_lossy().to_string(),
        "authorize".to_string(),
        format!("--scope={}", clean_text(scope, 160)),
        format!("--target={}", clean_text(target, 160)),
        format!("--approval-note={}", clean_text(approval_note, 360)),
        format!("--source={}", clean_text(source, 120)),
    ];
    if let Some(token) = lease_token {
        let clean = clean_text(token, 260);
        if !clean.is_empty() {
            args.push(format!("--lease-token={clean}"));
        }
    }

    let run = Command::new(node)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();
    let output = match run {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "decision": "DENY",
                "reason": format!("policy_root_spawn_failed:{err}")
            })
        }
    };

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let payload = parse_json_from_stdout(&stdout).unwrap_or_else(|| {
        json!({
            "ok": false,
            "decision": "DENY",
            "reason": "policy_root_invalid_payload"
        })
    });
    let ok = output.status.success()
        && payload.get("ok").and_then(Value::as_bool).unwrap_or(false)
        && payload
            .get("decision")
            .and_then(Value::as_str)
            .unwrap_or("")
            == "ALLOW";
    json!({
        "ok": ok,
        "decision": payload.get("decision").cloned().unwrap_or(Value::String("DENY".to_string())),
        "raw": payload,
        "code": output.status.code().unwrap_or(1),
        "stderr": clean_text(stderr, 320)
    })
}

pub fn run_capability_switchboard(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let args = parse_cli_args(argv);
    let cmd = args
        .positional
        .first()
        .map(|v| normalize_token(v, 80))
        .unwrap_or_else(|| "status".to_string());
    let (policy_path, state_path, audit_path, policy_root_script, chain_path) =
        capability_switchboard_paths(repo_root);
    let policy = capability_switchboard_load_policy(&policy_path);
    let state = capability_switchboard_load_state(&state_path);
    let effective = capability_switchboard_effective_switches(&policy, &state);

    if cmd == "status" {
        let chain = capability_switchboard_verify_chain(&chain_path);
        return (
            json!({
                "ok": true,
                "type": "capability_switchboard_status",
                "ts": now_iso(),
                "policy_version": policy.get("version").cloned().unwrap_or(Value::String("1.0".to_string())),
                "switches": effective,
                "hash_chain": chain
            }),
            0,
        );
    }

    if cmd == "verify-chain" {
        let chain = capability_switchboard_verify_chain(&chain_path);
        let ok = chain.get("ok").and_then(Value::as_bool).unwrap_or(false);
        return (
            json!({
                "ok": ok,
                "type": "capability_switchboard_chain_verify",
                "ts": now_iso(),
                "chain_path": normalize_rel_path(chain_path.display().to_string()),
                "chain": chain
            }),
            if ok { 0 } else { 1 },
        );
    }

    if cmd == "evaluate" {
        let switch_id = normalize_token(args.flags.get("switch").cloned().unwrap_or_default(), 120);
        if switch_id.is_empty() {
            return (
                json!({
                    "ok": false,
                    "type": "capability_switchboard_evaluate",
                    "reason": "missing_switch"
                }),
                2,
            );
        }
        let switch_row = effective
            .iter()
            .find(|row| {
                row.get("id")
                    .and_then(Value::as_str)
                    .map(|v| v == switch_id)
                    .unwrap_or(false)
            })
            .cloned();
        match switch_row {
            Some(row) => (
                json!({
                    "ok": true,
                    "type": "capability_switchboard_evaluate",
                    "switch": switch_id,
                    "enabled": row.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                    "switch_row": row
                }),
                0,
            ),
            None => (
                json!({
                    "ok": false,
                    "type": "capability_switchboard_evaluate",
                    "switch": switch_id,
                    "reason": "unknown_switch"
                }),
                1,
            ),
        }
    } else if cmd == "set" {
        let switch_id = normalize_token(args.flags.get("switch").cloned().unwrap_or_default(), 120);
        if switch_id.is_empty() {
            return (
                json!({
                    "ok": false,
                    "type": "capability_switchboard_set",
                    "reason": "missing_switch"
                }),
                2,
            );
        }
        let requested_state = bool_state(args.flags.get("state").map(String::as_str));
        if requested_state.is_none() {
            return (
                json!({
                    "ok": false,
                    "type": "capability_switchboard_set",
                    "switch": switch_id,
                    "reason": "invalid_state"
                }),
                2,
            );
        }
        let target_enabled = requested_state.unwrap_or(true);

        let switch_policy = policy
            .get("switches")
            .and_then(Value::as_object)
            .and_then(|rows| rows.get(&switch_id))
            .cloned();
        if switch_policy.is_none() {
            return (
                json!({
                    "ok": false,
                    "type": "capability_switchboard_set",
                    "switch": switch_id,
                    "reason": "unknown_switch"
                }),
                1,
            );
        }
        let switch_policy = switch_policy.unwrap_or_else(|| json!({}));
        let security_locked = switch_policy
            .get("security_locked")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if security_locked && !target_enabled {
            return (
                json!({
                    "ok": false,
                    "type": "capability_switchboard_set",
                    "switch": switch_id,
                    "reason": "security_locked_non_deactivatable"
                }),
                1,
            );
        }

        let require_dual = policy
            .get("require_dual_control")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let min_note = number_i64(policy.get("dual_control_min_note_len"), 12, 8, 4096) as usize;
        let approver_id = normalize_token(
            args.flags.get("approver-id").cloned().unwrap_or_default(),
            120,
        );
        let second_approver_id = normalize_token(
            args.flags
                .get("second-approver-id")
                .cloned()
                .unwrap_or_default(),
            120,
        );
        let approval_note = clean_text(
            args.flags.get("approval-note").cloned().unwrap_or_default(),
            720,
        );
        let second_approval_note = clean_text(
            args.flags
                .get("second-approval-note")
                .cloned()
                .unwrap_or_default(),
            720,
        );
        if require_dual {
            if approver_id.is_empty() || second_approver_id.is_empty() {
                return (
                    json!({
                        "ok": false,
                        "type": "capability_switchboard_set",
                        "switch": switch_id,
                        "reason": "dual_control_approver_missing"
                    }),
                    1,
                );
            }
            if approver_id == second_approver_id {
                return (
                    json!({
                        "ok": false,
                        "type": "capability_switchboard_set",
                        "switch": switch_id,
                        "reason": "dual_control_approver_must_differ"
                    }),
                    1,
                );
            }
            if approval_note.len() < min_note || second_approval_note.len() < min_note {
                return (
                    json!({
                        "ok": false,
                        "type": "capability_switchboard_set",
                        "switch": switch_id,
                        "reason": "approval_note_too_short"
                    }),
                    1,
                );
            }
        }

        let require_policy_root = switch_policy
            .get("require_policy_root")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let policy_root_required = policy
            .get("policy_root")
            .and_then(|row| row.get("required"))
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let policy_root = if require_policy_root || policy_root_required {
            let scope = policy
                .get("policy_root")
                .and_then(|row| row.get("scope"))
                .and_then(Value::as_str)
                .unwrap_or("capability_switchboard_toggle");
            let lease_token = args.flags.get("lease-token").map(String::as_str);
            let source = args
                .flags
                .get("source")
                .map(String::as_str)
                .unwrap_or("capability_switchboard");
            capability_switchboard_run_policy_root(
                &policy_root_script,
                scope,
                &switch_id,
                &approval_note,
                lease_token,
                source,
            )
        } else {
            json!({
                "ok": true,
                "decision": "ALLOW",
                "reason": "policy_root_not_required"
            })
        };
        if !policy_root
            .get("ok")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            return (
                json!({
                    "ok": false,
                    "type": "capability_switchboard_set",
                    "switch": switch_id,
                    "reason": "policy_root_denied",
                    "policy_root": policy_root
                }),
                1,
            );
        }

        let mut next_state = capability_switchboard_load_state(&state_path);
        let mut switches = next_state
            .get("switches")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        switches.insert(
            switch_id.clone(),
            json!({
                "enabled": target_enabled,
                "updated_at": now_iso(),
                "updated_by": approver_id,
                "reason": approval_note
            }),
        );
        next_state["switches"] = Value::Object(switches);
        next_state["updated_at"] = Value::String(now_iso());
        if let Err(err) = write_json_atomic(&state_path, &next_state) {
            return (
                json!({
                    "ok": false,
                    "type": "capability_switchboard_set",
                    "switch": switch_id,
                    "reason": format!("state_write_failed:{err}")
                }),
                1,
            );
        }

        let audit_row = json!({
            "ts": now_iso(),
            "type": "capability_switchboard_set",
            "switch": switch_id.clone(),
            "enabled": target_enabled,
            "approver_id": approver_id.clone(),
            "second_approver_id": second_approver_id.clone(),
            "reason": approval_note.clone(),
            "policy_root": policy_root
        });
        let _ = append_jsonl(&audit_path, &audit_row);

        let prev_hash = capability_switchboard_chain_tip(&chain_path);
        let mut chain_row = json!({
            "ts": now_iso(),
            "type": "capability_switchboard_chain_event",
            "action": if target_enabled { "grant" } else { "revoke" },
            "switch": switch_id.clone(),
            "enabled": target_enabled,
            "approver_id": approver_id.clone(),
            "second_approver_id": second_approver_id.clone(),
            "reason": approval_note.clone(),
            "policy_scope": policy
                .get("policy_root")
                .and_then(|row| row.get("scope"))
                .and_then(Value::as_str)
                .unwrap_or("capability_switchboard_toggle"),
            "prev_hash": prev_hash
        });
        let hash = sha256_hex(&stable_json_string(&chain_row));
        chain_row["hash"] = Value::String(hash.clone());
        if let Err(err) = append_jsonl(&chain_path, &chain_row) {
            return (
                json!({
                    "ok": false,
                    "type": "capability_switchboard_set",
                    "switch": switch_id,
                    "reason": format!("hash_chain_append_failed:{err}")
                }),
                1,
            );
        }

        (
            json!({
                "ok": true,
                "type": "capability_switchboard_set",
                "switch": switch_id,
                "enabled": target_enabled,
                "policy_root": policy_root,
                "hash_chain": {
                    "path": normalize_rel_path(chain_path.display().to_string()),
                    "last_hash": hash
                }
            }),
            0,
        )
    } else {
        (
            json!({
                "ok": false,
                "type": "capability_switchboard_error",
                "reason": format!("unknown_command:{cmd}"),
                "usage": [
                    "protheus-ops security-plane capability-switchboard status",
                    "protheus-ops security-plane capability-switchboard verify-chain",
                    "protheus-ops security-plane capability-switchboard evaluate --switch=<id>",
                    "protheus-ops security-plane capability-switchboard set --switch=<id> --state=on|off --approver-id=<id> --approval-note=... --second-approver-id=<id> --second-approval-note=..."
                ]
            }),
            2,
        )
    }
}

// -------------------------------------------------------------------------------------------------
// Black Box Ledger
// -------------------------------------------------------------------------------------------------

fn black_box_paths(repo_root: &Path) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    let ledger_dir = std::env::var("BLACK_BOX_LEDGER_DIR")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            runtime_state_root(repo_root)
                .join("security")
                .join("black_box_ledger")
        });
    let spine_runs = std::env::var("BLACK_BOX_SPINE_RUNS_DIR")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_state_root(repo_root).join("spine").join("runs"));
    let autonomy_runs = std::env::var("BLACK_BOX_AUTONOMY_RUNS_DIR")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_state_root(repo_root).join("autonomy").join("runs"));
    let attest_dir = std::env::var("BLACK_BOX_EXTERNAL_ATTESTATION_DIR")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| ledger_dir.join("attestations"));
    (ledger_dir, spine_runs, autonomy_runs, attest_dir)
}

fn date_arg_or_today(v: Option<&String>) -> String {
    if let Some(raw) = v {
        let txt = clean_text(raw, 32);
        if txt.chars().count() == 10
            && txt.chars().nth(4) == Some('-')
            && txt.chars().nth(7) == Some('-')
        {
            return txt;
        }
    }
    now_iso().chars().take(10).collect::<String>()
}

fn allowed_spine_type(v: &str) -> bool {
    v == "spine_run_started"
        || v == "spine_run_completed"
        || v.contains("spine_trit_shadow")
        || v.contains("spine_alignment_oracle")
        || v.contains("spine_suggestion_lane")
        || v.contains("spine_self_documentation")
        || v.contains("spine_router_budget_calibration")
        || v.contains("spine_ops_dashboard")
        || v.contains("spine_integrity")
        || v.contains("spine_state_backup")
        || v.contains("spine_backup_integrity")
}

fn allowed_autonomy_type(v: &str) -> bool {
    v == "autonomy_run" || v == "autonomy_candidate_audit"
}

fn allowed_attestation_type(v: &str) -> bool {
    let lower = v.to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "external_boundary_attestation"
            | "boundary_attestation"
            | "cross_runtime_attestation"
            | "cross_service_attestation"
    )
}

fn compact_event(row: &Value, source: &str) -> Value {
    json!({
        "ts": row.get("ts").and_then(Value::as_str).map(|v| clean_text(v, 64)),
        "source": source,
        "type": row.get("type").and_then(Value::as_str).map(|v| clean_text(v, 120)),
        "proposal_id": row.get("proposal_id").and_then(Value::as_str).map(|v| clean_text(v, 120)),
        "result": row.get("result").and_then(Value::as_str).map(|v| clean_text(v, 120)),
        "outcome": row.get("outcome").and_then(Value::as_str).map(|v| clean_text(v, 120)),
        "objective_id": row
            .get("objective_id")
            .or_else(|| row.get("directive_pulse").and_then(|v| v.get("objective_id")))
            .or_else(|| row.get("objective_binding").and_then(|v| v.get("objective_id")))
            .and_then(Value::as_str)
            .map(|v| clean_text(v, 120)),
        "risk": row.get("risk").and_then(Value::as_str).map(|v| clean_text(v, 80)),
        "ok": row.get("ok").and_then(Value::as_bool),
        "reason": row.get("reason").and_then(Value::as_str).map(|v| clean_text(v, 220))
    })
}

fn compact_attestation(row: &Value) -> Value {
    json!({
        "ts": row.get("ts").or_else(|| row.get("timestamp")).and_then(Value::as_str).map(|v| clean_text(v, 64)),
        "source": "boundary_attestation",
        "type": "external_boundary_attestation",
        "proposal_id": Value::Null,
        "result": Value::Null,
        "outcome": Value::Null,
        "objective_id": row.get("objective_id").and_then(Value::as_str).map(|v| clean_text(v, 120)),
        "risk": Value::Null,
        "ok": row.get("ok").and_then(Value::as_bool),
        "reason": row.get("boundary").or_else(|| row.get("scope")).and_then(Value::as_str).map(|v| clean_text(v, 120)),
        "external_attestation": {
            "system": row.get("system").or_else(|| row.get("source_system")).or_else(|| row.get("attestor")).and_then(Value::as_str).map(|v| clean_text(v, 120)),
            "boundary": row.get("boundary").or_else(|| row.get("scope")).and_then(Value::as_str).map(|v| clean_text(v, 120)),
            "chain_hash": row.get("chain_hash").or_else(|| row.get("receipt_hash")).or_else(|| row.get("hash")).and_then(Value::as_str).map(|v| clean_text(v, 180)),
            "signature": row.get("signature").or_else(|| row.get("sig")).and_then(Value::as_str).map(|v| clean_text(v, 220)),
            "signer": row.get("signer").or_else(|| row.get("attestor")).and_then(Value::as_str).map(|v| clean_text(v, 120))
        }
    })
}

fn load_critical_events(
    date: &str,
    spine_dir: &Path,
    autonomy_dir: &Path,
    attest_dir: &Path,
) -> (Vec<Value>, usize, usize, usize) {
    let spine_rows = read_jsonl(&spine_dir.join(format!("{date}.jsonl")))
        .into_iter()
        .filter(|row| {
            row.get("type")
                .and_then(Value::as_str)
                .map(allowed_spine_type)
                .unwrap_or(false)
        })
        .map(|row| compact_event(&row, "spine"))
        .collect::<Vec<_>>();
    let autonomy_rows = read_jsonl(&autonomy_dir.join(format!("{date}.jsonl")))
        .into_iter()
        .filter(|row| {
            row.get("type")
                .and_then(Value::as_str)
                .map(allowed_autonomy_type)
                .unwrap_or(false)
        })
        .map(|row| compact_event(&row, "autonomy"))
        .collect::<Vec<_>>();
    let att_rows = read_jsonl(&attest_dir.join(format!("{date}.jsonl")))
        .into_iter()
        .filter(|row| {
            row.get("type")
                .and_then(Value::as_str)
                .map(allowed_attestation_type)
                .unwrap_or(false)
        })
        .map(|row| compact_attestation(&row))
        .filter(|row| {
            row.get("external_attestation")
                .and_then(|v| v.get("chain_hash"))
                .and_then(Value::as_str)
                .map(|v| !v.is_empty())
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();

    let mut all = Vec::new();
    all.extend(spine_rows.clone());
    all.extend(autonomy_rows.clone());
    all.extend(att_rows.clone());
    all.sort_by(|a, b| {
        let ta = a
            .get("ts")
            .and_then(Value::as_str)
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            .map(|v| v.timestamp_millis())
            .unwrap_or(0);
        let tb = b
            .get("ts")
            .and_then(Value::as_str)
            .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
            .map(|v| v.timestamp_millis())
            .unwrap_or(0);
        ta.cmp(&tb)
    });
    (all, spine_rows.len(), autonomy_rows.len(), att_rows.len())
}

fn black_box_chain_path(ledger_dir: &Path) -> PathBuf {
    ledger_dir.join("chain.jsonl")
}

fn black_box_detail_path(ledger_dir: &Path, date: &str, seq: usize) -> PathBuf {
    if seq <= 1 {
        ledger_dir.join(format!("{date}.jsonl"))
    } else {
        ledger_dir.join(format!("{date}.{seq}.jsonl"))
    }
}

fn next_rollup_seq(chain_rows: &[Value], date: &str) -> usize {
    let mut max_seq = 0usize;
    for row in chain_rows {
        if row.get("date").and_then(Value::as_str).unwrap_or("") != date {
            continue;
        }
        let seq = row.get("rollup_seq").and_then(Value::as_u64).unwrap_or(1) as usize;
        max_seq = max_seq.max(seq);
    }
    max_seq.saturating_add(1)
}

fn write_jsonl_rows(path: &Path, rows: &[Value]) -> Result<(), String> {
    ensure_parent(path)?;
    let mut body = String::new();
    for row in rows {
        let encoded = serde_json::to_string(row)
            .map_err(|err| format!("encode_jsonl_failed:{}:{err}", path.display()))?;
        body.push_str(&encoded);
        body.push('\n');
    }
    fs::write(path, body).map_err(|err| format!("write_jsonl_failed:{}:{err}", path.display()))
}

fn black_box_write_detail(
    date: &str,
    events: &[Value],
    detail_path: &Path,
) -> Result<(Vec<Value>, String), String> {
    let mut rows = Vec::new();
    let mut prev_hash = "GENESIS".to_string();
    for (idx, event) in events.iter().enumerate() {
        let payload = json!({
            "schema_id": "black_box_event",
            "schema_version": "1.0.0",
            "date": date,
            "index": idx,
            "event": event,
            "prev_hash": prev_hash
        });
        let hash = sha256_hex(&stable_json_string(&payload));
        let mut row = payload;
        row["hash"] = Value::String(hash.clone());
        prev_hash = hash;
        rows.push(row);
    }
    write_jsonl_rows(detail_path, &rows)?;
    let digest = rows
        .last()
        .and_then(|row| row.get("hash"))
        .and_then(Value::as_str)
        .map(|v| v.to_string())
        .unwrap_or_else(|| sha256_hex(&stable_json_string(&json!({"date": date, "empty": true}))));
    Ok((rows, digest))
}

pub fn run_black_box_ledger(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let args = parse_cli_args(argv);
    let cmd = args
        .positional
        .first()
        .map(|v| normalize_token(v, 80))
        .unwrap_or_else(|| "status".to_string());
    let (ledger_dir, spine_dir, autonomy_dir, attest_dir) = black_box_paths(repo_root);
    let chain_path = black_box_chain_path(&ledger_dir);

    if cmd == "rollup" {
        let date = date_arg_or_today(args.positional.get(1));
        let mode = clean_text(
            args.flags
                .get("mode")
                .cloned()
                .unwrap_or_else(|| "daily".to_string()),
            40,
        );
        let chain_rows = read_jsonl(&chain_path);
        let seq = next_rollup_seq(&chain_rows, &date);
        let detail_path = black_box_detail_path(&ledger_dir, &date, seq);
        let (events, spine_count, autonomy_count, external_count) =
            load_critical_events(&date, &spine_dir, &autonomy_dir, &attest_dir);
        let (_detail_rows, digest) = match black_box_write_detail(&date, &events, &detail_path) {
            Ok(v) => v,
            Err(err) => {
                return (
                    json!({
                        "ok": false,
                        "type": "black_box_ledger_rollup",
                        "error": format!("detail_write_failed:{err}")
                    }),
                    1,
                );
            }
        };

        let prev_hash = chain_rows
            .last()
            .and_then(|row| row.get("hash"))
            .and_then(Value::as_str)
            .unwrap_or("GENESIS")
            .to_string();
        let mut chain_row = json!({
            "ts": now_iso(),
            "date": date,
            "mode": mode,
            "rollup_seq": seq,
            "detail_file": detail_path.file_name().and_then(|v| v.to_str()).unwrap_or_default(),
            "digest": digest,
            "spine_events": spine_count,
            "autonomy_events": autonomy_count,
            "external_events": external_count,
            "total_events": events.len(),
            "prev_hash": prev_hash
        });
        let hash = sha256_hex(&stable_json_string(&chain_row));
        chain_row["hash"] = Value::String(hash);

        let mut next_chain = chain_rows;
        next_chain.push(chain_row.clone());
        if let Err(err) = write_jsonl_rows(&chain_path, &next_chain) {
            return (
                json!({
                    "ok": false,
                    "type": "black_box_ledger_rollup",
                    "error": format!("chain_write_failed:{err}")
                }),
                1,
            );
        }

        (
            json!({
                "ok": true,
                "type": "black_box_ledger_rollup",
                "date": date,
                "mode": mode,
                "rollup_seq": seq,
                "spine_events": spine_count,
                "autonomy_events": autonomy_count,
                "external_events": external_count,
                "total_events": events.len(),
                "detail_path": normalize_rel_path(detail_path.to_string_lossy()),
                "digest": chain_row.get("digest").cloned().unwrap_or(Value::Null)
            }),
            0,
        )
    } else if cmd == "verify" {
        let chain_rows = read_jsonl(&chain_path);
        if chain_rows.is_empty() {
            return (
                json!({
                    "ok": false,
                    "type": "black_box_ledger_verify",
                    "error": "chain_empty"
                }),
                1,
            );
        }
        let mut prev_hash = "GENESIS".to_string();
        for (idx, row) in chain_rows.iter().enumerate() {
            let expected_prev = row
                .get("prev_hash")
                .and_then(Value::as_str)
                .unwrap_or("GENESIS")
                .to_string();
            if expected_prev != prev_hash {
                return (
                    json!({
                        "ok": false,
                        "type": "black_box_ledger_verify",
                        "error": "chain_prev_hash_mismatch",
                        "index": idx
                    }),
                    1,
                );
            }
            let mut payload = row.clone();
            payload.as_object_mut().map(|m| {
                m.remove("hash");
            });
            let calc = sha256_hex(&stable_json_string(&payload));
            let stored = row.get("hash").and_then(Value::as_str).unwrap_or("");
            if calc != stored {
                return (
                    json!({
                        "ok": false,
                        "type": "black_box_ledger_verify",
                        "error": "chain_hash_mismatch",
                        "index": idx
                    }),
                    1,
                );
            }
            let date = row.get("date").and_then(Value::as_str).unwrap_or("");
            let seq = row.get("rollup_seq").and_then(Value::as_u64).unwrap_or(1) as usize;
            let detail_path = black_box_detail_path(&ledger_dir, date, seq);
            let detail_rows = read_jsonl(&detail_path);
            let mut detail_prev = "GENESIS".to_string();
            for (detail_idx, detail_row) in detail_rows.iter().enumerate() {
                let dprev = detail_row
                    .get("prev_hash")
                    .and_then(Value::as_str)
                    .unwrap_or("GENESIS")
                    .to_string();
                if dprev != detail_prev {
                    return (
                        json!({
                            "ok": false,
                            "type": "black_box_ledger_verify",
                            "error": "detail_prev_hash_mismatch",
                            "date": date,
                            "index": detail_idx
                        }),
                        1,
                    );
                }
                let mut detail_payload = detail_row.clone();
                detail_payload.as_object_mut().map(|m| {
                    m.remove("hash");
                });
                let dcalc = sha256_hex(&stable_json_string(&detail_payload));
                let dstored = detail_row.get("hash").and_then(Value::as_str).unwrap_or("");
                if dcalc != dstored {
                    return (
                        json!({
                            "ok": false,
                            "type": "black_box_ledger_verify",
                            "error": "detail_hash_mismatch",
                            "date": date,
                            "index": detail_idx
                        }),
                        1,
                    );
                }
                detail_prev = dstored.to_string();
            }
            let detail_digest = detail_rows
                .last()
                .and_then(|v| v.get("hash"))
                .and_then(Value::as_str)
                .map(|v| v.to_string())
                .unwrap_or_else(|| {
                    sha256_hex(&stable_json_string(&json!({"date": date, "empty": true})))
                });
            let row_digest = row.get("digest").and_then(Value::as_str).unwrap_or("");
            if detail_digest != row_digest {
                return (
                    json!({
                        "ok": false,
                        "type": "black_box_ledger_verify",
                        "error": "digest_mismatch",
                        "date": date
                    }),
                    1,
                );
            }
            prev_hash = stored.to_string();
        }
        (
            json!({
                "ok": true,
                "type": "black_box_ledger_verify",
                "valid": true,
                "chain_length": chain_rows.len()
            }),
            0,
        )
    } else if cmd == "status" {
        let chain_rows = read_jsonl(&chain_path);
        if chain_rows.is_empty() {
            return (
                json!({
                    "ok": false,
                    "type": "black_box_ledger_status",
                    "error": "chain_empty"
                }),
                1,
            );
        }
        let last = chain_rows.last().cloned().unwrap_or_else(|| json!({}));
        (
            json!({
                "ok": true,
                "type": "black_box_ledger_status",
                "chain_length": chain_rows.len(),
                "last_date": last.get("date").cloned().unwrap_or(Value::Null),
                "last_digest": last.get("digest").cloned().unwrap_or(Value::Null),
                "last_rollup_seq": last.get("rollup_seq").cloned().unwrap_or(Value::Null)
            }),
            0,
        )
    } else {
        (
            json!({
                "ok": false,
                "type": "black_box_ledger_error",
                "error": format!("unknown_command:{cmd}")
            }),
            2,
        )
    }
}

// -------------------------------------------------------------------------------------------------
// Goal Preservation Kernel
// -------------------------------------------------------------------------------------------------

fn goal_preservation_policy_path(repo_root: &Path, args: &CliArgs) -> PathBuf {
    if let Some(v) = args.flags.get("policy") {
        let p = PathBuf::from(v);
        if p.is_absolute() {
            return p;
        }
        return repo_root.join(p);
    }
    std::env::var("GOAL_PRESERVATION_POLICY_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_config_path(repo_root, "goal_preservation_policy.json"))
}

fn goal_preservation_default_policy() -> Value {
    json!({
        "version": "1.0",
        "strict_mode": true,
        "constitution_path": "docs/workspace/AGENT-CONSTITUTION.md",
        "protected_axiom_markers": [
            "to be a hero",
            "to test the limits",
            "to create at will",
            "to win my freedom",
            "user sovereignty",
            "root constitution"
        ],
        "blocked_mutation_paths": [
            "^AGENT-CONSTITUTION\\.md$",
            "^SOUL\\.md$",
            "^USER\\.md$",
            "^client/runtime/systems/security/guard\\.(ts|js)$",
            "^client/runtime/systems/security/policy_rootd\\.(ts|js)$"
        ],
        "symbiosis_recursion_gate": {
            "enabled": true,
            "shadow_only": true,
            "signal_policy_path": "client/runtime/config/symbiosis_coherence_policy.json"
        },
        "output": {
            "state_path": "state/security/goal_preservation/latest.json",
            "receipts_path": "state/security/goal_preservation/receipts.jsonl"
        }
    })
}

fn goal_preservation_load_policy(policy_path: &Path) -> Value {
    let raw = read_json_or(policy_path, json!({}));
    let mut policy = goal_preservation_default_policy();
    if let Some(version) = raw.get("version").and_then(Value::as_str) {
        policy["version"] = Value::String(clean_text(version, 40));
    }
    if let Some(strict) = raw.get("strict_mode").and_then(Value::as_bool) {
        policy["strict_mode"] = Value::Bool(strict);
    }
    if let Some(path) = raw.get("constitution_path").and_then(Value::as_str) {
        policy["constitution_path"] = Value::String(clean_text(path, 320));
    }
    if let Some(markers) = raw.get("protected_axiom_markers").and_then(Value::as_array) {
        policy["protected_axiom_markers"] = Value::Array(
            markers
                .iter()
                .filter_map(Value::as_str)
                .map(|v| Value::String(clean_text(v, 240).to_ascii_lowercase()))
                .collect::<Vec<_>>(),
        );
    }
    if let Some(blocked) = raw.get("blocked_mutation_paths").and_then(Value::as_array) {
        policy["blocked_mutation_paths"] = Value::Array(
            blocked
                .iter()
                .filter_map(Value::as_str)
                .map(|v| Value::String(clean_text(v, 260)))
                .collect::<Vec<_>>(),
        );
    }
    if let Some(gate) = raw
        .get("symbiosis_recursion_gate")
        .and_then(Value::as_object)
    {
        if let Some(enabled) = gate.get("enabled").and_then(Value::as_bool) {
            policy["symbiosis_recursion_gate"]["enabled"] = Value::Bool(enabled);
        }
        if let Some(shadow_only) = gate.get("shadow_only").and_then(Value::as_bool) {
            policy["symbiosis_recursion_gate"]["shadow_only"] = Value::Bool(shadow_only);
        }
        if let Some(path) = gate.get("signal_policy_path").and_then(Value::as_str) {
            policy["symbiosis_recursion_gate"]["signal_policy_path"] =
                Value::String(clean_text(path, 320));
        }
    }
    if let Some(out) = raw.get("output").and_then(Value::as_object) {
        if let Some(path) = out.get("state_path").and_then(Value::as_str) {
            policy["output"]["state_path"] = Value::String(clean_text(path, 320));
        }
        if let Some(path) = out.get("receipts_path").and_then(Value::as_str) {
            policy["output"]["receipts_path"] = Value::String(clean_text(path, 320));
        }
    }
    policy
}

fn parse_blocked_pattern_match(path: &str, pattern: &str) -> bool {
    let norm = path.to_ascii_lowercase();
    let mut pat = pattern.trim().to_ascii_lowercase();
    pat = pat
        .trim_start_matches('^')
        .trim_end_matches('$')
        .replace("\\.", ".")
        .replace("\\(", "(")
        .replace("\\)", ")")
        .replace("(ts|js)", "ts|js");
    if pat.contains("ts|js") {
        let lhs = pat.replace("ts|js", "ts");
        let rhs = pat.replace("ts|js", "js");
        return norm == lhs || norm == rhs;
    }
    norm == pat || norm.contains(&pat.replace(".*", ""))
}

fn proposal_touches_recursive_self_improvement(
    row: &Value,
    mutation_paths: &[String],
    summary: &str,
) -> bool {
    if row.get("recursion_depth").is_some() || row.get("recursion_mode").is_some() {
        return true;
    }
    if row.get("recursion").is_some() {
        return true;
    }
    let target = row
        .get("target_system")
        .or_else(|| row.get("target"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    if target.contains("self_improvement")
        || target.contains("self-improvement")
        || target.contains("recursive")
        || target.contains("recursion")
    {
        return true;
    }
    if mutation_paths.iter().any(|v| {
        let lower = v.to_ascii_lowercase();
        lower.contains("self_improvement")
            || lower.contains("self-improvement")
            || lower.contains("self_code_evolution")
            || lower.contains("redteam")
    }) {
        return true;
    }
    summary.contains("recursive self-improvement")
        || summary.contains("unbounded recursion")
        || summary.contains("recursion depth")
        || summary.contains("self-improvement depth")
}

fn evaluate_symbiosis_gate(repo_root: &Path, policy: &Value) -> Value {
    let gate = policy
        .get("symbiosis_recursion_gate")
        .cloned()
        .unwrap_or_else(|| json!({}));
    if !gate.get("enabled").and_then(Value::as_bool).unwrap_or(true) {
        return json!({
            "enabled": false,
            "evaluated": false,
            "allowed": true,
            "reason": "gate_disabled"
        });
    }
    let signal_policy_rel = gate
        .get("signal_policy_path")
        .and_then(Value::as_str)
        .unwrap_or("client/runtime/config/symbiosis_coherence_policy.json");
    let signal_policy_path = {
        let p = PathBuf::from(signal_policy_rel);
        if p.is_absolute() {
            p
        } else {
            repo_root.join(p)
        }
    };
    let signal_policy = read_json_or(&signal_policy_path, json!({}));
    let paths = signal_policy
        .get("paths")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let resolve = |key: &str, fallback: &str| -> PathBuf {
        let raw = paths
            .get(key)
            .and_then(Value::as_str)
            .map(|v| v.to_string())
            .unwrap_or_else(|| fallback.to_string());
        let p = PathBuf::from(raw);
        if p.is_absolute() {
            p
        } else {
            repo_root.join(p)
        }
    };

    let identity_latest = read_json_or(
        &resolve(
            "identity_latest_path",
            "client/runtime/state/autonomy/identity_anchor/latest.json",
        ),
        json!({}),
    );
    let pre_neural_state = read_json_or(
        &resolve(
            "pre_neuralink_state_path",
            "client/runtime/state/symbiosis/pre_neuralink_interface/state.json",
        ),
        json!({}),
    );
    let observer_latest = read_json_or(
        &resolve(
            "observer_mirror_latest_path",
            "client/runtime/state/autonomy/observer_mirror/latest.json",
        ),
        json!({}),
    );

    let identity_drift = identity_latest
        .get("max_identity_drift_score")
        .or_else(|| identity_latest.get("identity_drift_score"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let consent_state = pre_neural_state
        .get("consent_state")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_ascii_lowercase();
    let hold_rate = observer_latest
        .get("summary")
        .and_then(|v| v.get("rates"))
        .and_then(|v| v.get("hold_rate"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);

    let identity_clear = identity_drift <= 0.5;
    let consent_granted = matches!(consent_state.as_str(), "granted" | "active" | "approved");
    let hold_ok = hold_rate <= 0.65;
    let allowed = identity_clear && consent_granted && hold_ok;

    json!({
        "enabled": true,
        "evaluated": true,
        "allowed": allowed,
        "identity_drift_score": identity_drift,
        "consent_state": consent_state,
        "hold_rate": hold_rate,
        "identity_clear": identity_clear,
        "consent_granted": consent_granted,
        "hold_ok": hold_ok
    })
}

fn goal_preservation_load_proposal(repo_root: &Path, args: &CliArgs) -> Option<Value> {
    if let Some(raw) = args
        .flags
        .get("proposal-json")
        .or_else(|| args.flags.get("proposal_json"))
    {
        if let Ok(parsed) = serde_json::from_str::<Value>(raw) {
            return Some(parsed);
        }
    }
    if let Some(raw) = args
        .flags
        .get("proposal-file")
        .or_else(|| args.flags.get("proposal_file"))
    {
        let path = {
            let p = PathBuf::from(raw);
            if p.is_absolute() {
                p
            } else {
                repo_root.join(p)
            }
        };
        return Some(read_json_or(&path, Value::Null));
    }
    None
}

pub fn run_goal_preservation_kernel(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let args = parse_cli_args(argv);
    let cmd = args
        .positional
        .first()
        .map(|v| normalize_token(v, 80))
        .unwrap_or_else(|| "status".to_string());
    let policy_path = goal_preservation_policy_path(repo_root, &args);
    let policy = goal_preservation_load_policy(&policy_path);
    let state_path = {
        let raw = policy
            .get("output")
            .and_then(|v| v.get("state_path"))
            .and_then(Value::as_str)
            .unwrap_or("state/security/goal_preservation/latest.json");
        let p = PathBuf::from(raw);
        if p.is_absolute() {
            p
        } else {
            runtime_root(repo_root).join(raw)
        }
    };
    let receipts_path = {
        let raw = policy
            .get("output")
            .and_then(|v| v.get("receipts_path"))
            .and_then(Value::as_str)
            .unwrap_or("state/security/goal_preservation/receipts.jsonl");
        let p = PathBuf::from(raw);
        if p.is_absolute() {
            p
        } else {
            runtime_root(repo_root).join(raw)
        }
    };

    if cmd == "status" {
        let latest = read_json_or(&state_path, json!({}));
        return (
            json!({
                "ok": true,
                "type": "goal_preservation_status",
                "policy_version": policy.get("version").cloned().unwrap_or(Value::String("1.0".to_string())),
                "latest": latest
            }),
            0,
        );
    }

    if cmd != "evaluate" {
        return (
            json!({
                "ok": false,
                "type": "goal_preservation_error",
                "reason": format!("unknown_command:{cmd}")
            }),
            2,
        );
    }

    let proposal = goal_preservation_load_proposal(repo_root, &args).unwrap_or(Value::Null);
    if !proposal.is_object() {
        return (
            json!({
                "ok": false,
                "type": "goal_preservation_evaluate",
                "reason": "proposal_missing_or_invalid"
            }),
            1,
        );
    }
    let proposal_obj = proposal.as_object().cloned().unwrap_or_default();
    let mutation_paths = proposal_obj
        .get("mutation_paths")
        .or_else(|| proposal_obj.get("files"))
        .or_else(|| proposal_obj.get("paths"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(normalize_rel_path)
        .collect::<Vec<_>>();
    let summary = clean_text(
        proposal_obj
            .get("summary")
            .or_else(|| proposal_obj.get("patch_summary"))
            .or_else(|| proposal_obj.get("description"))
            .and_then(Value::as_str)
            .unwrap_or(""),
        4000,
    )
    .to_ascii_lowercase();
    let mut reasons = Vec::<String>::new();
    let mut advisories = Vec::<String>::new();

    let blocked_patterns = policy
        .get("blocked_mutation_paths")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|v| v.to_string())
        .collect::<Vec<_>>();
    let mut blocked_hits = Vec::new();
    for pat in &blocked_patterns {
        for path in &mutation_paths {
            if parse_blocked_pattern_match(path, pat) {
                blocked_hits.push(path.clone());
            }
        }
    }
    if !blocked_hits.is_empty() {
        reasons.push("blocked_mutation_path".to_string());
    }

    let marker_hits = policy
        .get("protected_axiom_markers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .filter(|marker| summary.contains(&marker.to_ascii_lowercase()))
        .map(|v| v.to_string())
        .collect::<Vec<_>>();
    if !marker_hits.is_empty() {
        reasons.push("protected_axiom_marker_touched".to_string());
    }

    let constitution_path = {
        let raw = policy
            .get("constitution_path")
            .and_then(Value::as_str)
            .unwrap_or("docs/workspace/AGENT-CONSTITUTION.md");
        let p = PathBuf::from(raw);
        if p.is_absolute() {
            p
        } else {
            repo_root.join(p)
        }
    };
    let constitution_hash = fs::read(&constitution_path)
        .ok()
        .map(|bytes| sha256_hex(&String::from_utf8_lossy(&bytes)));
    let expected_hash = proposal_obj
        .get("expected_constitution_hash")
        .and_then(Value::as_str)
        .map(|v| v.trim().to_ascii_lowercase());
    if let (Some(expected), Some(actual)) = (expected_hash, constitution_hash.clone()) {
        if expected != actual {
            reasons.push("constitution_hash_mismatch".to_string());
        }
    }

    let strict_keywords = [
        "disable constitution",
        "rewrite constitution",
        "bypass user veto",
        "remove user control",
        "disable guard",
        "turn off integrity",
    ];
    if strict_keywords.iter().any(|v| summary.contains(v)) {
        reasons.push("alignment_keyword_violation".to_string());
    }

    let recursive_touch =
        proposal_touches_recursive_self_improvement(&proposal, &mutation_paths, &summary);
    let symbiosis_gate = if recursive_touch {
        evaluate_symbiosis_gate(repo_root, &policy)
    } else {
        json!({
            "enabled": policy
                .get("symbiosis_recursion_gate")
                .and_then(|v| v.get("enabled"))
                .and_then(Value::as_bool)
                .unwrap_or(true),
            "evaluated": false,
            "allowed": true,
            "reason": "not_recursive_proposal"
        })
    };
    if recursive_touch
        && symbiosis_gate
            .get("allowed")
            .and_then(Value::as_bool)
            .unwrap_or(false)
            == false
    {
        reasons.push("symbiosis_recursion_gate_blocked".to_string());
    }

    if recursive_touch {
        advisories.push("recursive_change_detected".to_string());
    }
    let allowed = reasons.is_empty();
    let out = json!({
        "ok": true,
        "type": "goal_preservation_evaluate",
        "ts": now_iso(),
        "allowed": allowed,
        "strict_mode": policy.get("strict_mode").and_then(Value::as_bool).unwrap_or(true),
        "proposal_id": proposal_obj.get("proposal_id").cloned().unwrap_or(Value::Null),
        "mutation_paths": mutation_paths,
        "reasons": reasons,
        "advisories": advisories,
        "marker_hits": marker_hits,
        "blocked_path_hits": blocked_hits,
        "constitution_hash": constitution_hash,
        "symbiosis_recursion_gate": symbiosis_gate
    });
    let _ = write_json_atomic(&state_path, &out);
    let _ = append_jsonl(&receipts_path, &out);
    (out, 0)
}

// -------------------------------------------------------------------------------------------------
// Dream Warden Guard
// -------------------------------------------------------------------------------------------------

fn dream_warden_policy_path(repo_root: &Path, args: &CliArgs) -> PathBuf {
    if let Some(v) = args.flags.get("policy") {
        let p = PathBuf::from(v);
        if p.is_absolute() {
            return p;
        }
        return repo_root.join(p);
    }
    std::env::var("DREAM_WARDEN_POLICY_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_config_path(repo_root, "dream_warden_policy.json"))
}

fn dream_warden_default_policy() -> Value {
    json!({
        "version": "1.0",
        "enabled": true,
        "shadow_only": true,
        "passive_only": true,
        "activation": {
            "min_successful_self_improvement_cycles": 5,
            "min_symbiosis_score": 0.82,
            "min_hours_between_runs": 1
        },
        "thresholds": {
            "critical_fail_cases_trigger": 1,
            "red_team_fail_rate_trigger": 0.15,
            "mirror_hold_rate_trigger": 0.4,
            "low_symbiosis_score_trigger": 0.75,
            "max_patch_candidates": 6
        },
        "signals": {
            "collective_shadow_latest_path": "state/autonomy/collective_shadow/latest.json",
            "observer_mirror_latest_path": "state/autonomy/observer_mirror/latest.json",
            "red_team_latest_path": "state/security/red_team/latest.json",
            "symbiosis_latest_path": "state/symbiosis/coherence/latest.json",
            "gated_self_improvement_state_path": "state/autonomy/gated_self_improvement/state.json"
        },
        "outputs": {
            "latest_path": "state/security/dream_warden/latest.json",
            "history_path": "state/security/dream_warden/history.jsonl",
            "receipts_path": "state/security/dream_warden/receipts.jsonl",
            "patch_proposals_path": "state/security/dream_warden/patch_proposals.jsonl",
            "ide_events_path": "state/security/dream_warden/ide_events.jsonl"
        }
    })
}

fn resolve_runtime_path(repo_root: &Path, raw: &str) -> PathBuf {
    let p = PathBuf::from(raw);
    if p.is_absolute() {
        p
    } else {
        runtime_root(repo_root).join(raw)
    }
}

fn dream_warden_load_policy(repo_root: &Path, policy_path: &Path) -> Value {
    let raw = read_json_or(policy_path, json!({}));
    let mut policy = dream_warden_default_policy();
    if let Some(version) = raw.get("version").and_then(Value::as_str) {
        policy["version"] = Value::String(clean_text(version, 40));
    }
    for key in ["enabled", "shadow_only", "passive_only"] {
        if let Some(v) = raw.get(key).and_then(Value::as_bool) {
            policy[key] = Value::Bool(v);
        }
    }
    if let Some(activation) = raw.get("activation").and_then(Value::as_object) {
        if activation
            .get("min_successful_self_improvement_cycles")
            .is_some()
        {
            let n = number_i64(
                activation.get("min_successful_self_improvement_cycles"),
                5,
                0,
                100_000,
            );
            policy["activation"]["min_successful_self_improvement_cycles"] =
                Value::Number(n.into());
        }
        if activation.get("min_symbiosis_score").is_some() {
            let n = number_f64(activation.get("min_symbiosis_score"), 0.82, 0.0, 1.0);
            policy["activation"]["min_symbiosis_score"] = json!(n);
        }
        if activation.get("min_hours_between_runs").is_some() {
            let n = number_i64(activation.get("min_hours_between_runs"), 1, 0, 720);
            policy["activation"]["min_hours_between_runs"] = Value::Number(n.into());
        }
    }
    if let Some(thresholds) = raw.get("thresholds").and_then(Value::as_object) {
        for (key, fallback, lo, hi) in [
            ("critical_fail_cases_trigger", 1.0, 0.0, 100_000.0),
            ("red_team_fail_rate_trigger", 0.15, 0.0, 1.0),
            ("mirror_hold_rate_trigger", 0.4, 0.0, 1.0),
            ("low_symbiosis_score_trigger", 0.75, 0.0, 1.0),
            ("max_patch_candidates", 6.0, 1.0, 64.0),
        ] {
            if let Some(v) = thresholds.get(key) {
                if key == "critical_fail_cases_trigger" || key == "max_patch_candidates" {
                    let n = number_i64(Some(v), fallback as i64, lo as i64, hi as i64);
                    policy["thresholds"][key] = Value::Number(n.into());
                } else {
                    let n = number_f64(Some(v), fallback, lo, hi);
                    policy["thresholds"][key] = json!(n);
                }
            }
        }
    }
    if let Some(signals) = raw.get("signals").and_then(Value::as_object) {
        for key in [
            "collective_shadow_latest_path",
            "observer_mirror_latest_path",
            "red_team_latest_path",
            "symbiosis_latest_path",
            "gated_self_improvement_state_path",
        ] {
            if let Some(v) = signals.get(key).and_then(Value::as_str) {
                policy["signals"][key] = Value::String(
                    resolve_runtime_path(repo_root, v)
                        .to_string_lossy()
                        .to_string(),
                );
            } else {
                let fallback = policy["signals"][key]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                policy["signals"][key] = Value::String(
                    resolve_runtime_path(repo_root, &fallback)
                        .to_string_lossy()
                        .to_string(),
                );
            }
        }
    }
    if let Some(outputs) = raw.get("outputs").and_then(Value::as_object) {
        for key in [
            "latest_path",
            "history_path",
            "receipts_path",
            "patch_proposals_path",
            "ide_events_path",
        ] {
            if let Some(v) = outputs.get(key).and_then(Value::as_str) {
                policy["outputs"][key] = Value::String(
                    resolve_runtime_path(repo_root, v)
                        .to_string_lossy()
                        .to_string(),
                );
            } else {
                let fallback = policy["outputs"][key]
                    .as_str()
                    .unwrap_or_default()
                    .to_string();
                policy["outputs"][key] = Value::String(
                    resolve_runtime_path(repo_root, &fallback)
                        .to_string_lossy()
                        .to_string(),
                );
            }
        }
    }
    policy
}

fn dream_warden_count_successful_cycles(gsi_state: &Value) -> i64 {
    let mut count = 0_i64;
    let proposals = gsi_state
        .get("proposals")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    for row in proposals.values() {
        let status = row
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        if matches!(status.as_str(), "gated_pass" | "live_ready" | "live_merged") {
            count += 1;
        }
    }
    count
}

fn dream_warden_last_run_info(history_path: &Path) -> (Option<String>, Option<f64>) {
    let rows = read_jsonl(history_path);
    let last = rows.last().cloned().unwrap_or_else(|| json!({}));
    let last_ts = last
        .get("ts")
        .and_then(Value::as_str)
        .map(|v| v.to_string());
    let hours_since = last_ts
        .as_deref()
        .and_then(|v| chrono::DateTime::parse_from_rfc3339(v).ok())
        .map(|v| {
            let now = Utc::now().timestamp_millis() as f64;
            let then = v.timestamp_millis() as f64;
            (now - then) / 3_600_000.0
        });
    (last_ts, hours_since)
}

fn dream_warden_patch_proposals(policy: &Value, signals: &Value, run_id: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let max = number_i64(
        policy
            .get("thresholds")
            .and_then(|v| v.get("max_patch_candidates")),
        6,
        1,
        64,
    ) as usize;
    let critical_fail = signals
        .get("collective_shadow")
        .and_then(|v| v.get("red_team"))
        .and_then(|v| v.get("critical_fail_cases"))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    let red_fail = signals
        .get("red_team")
        .and_then(|v| v.get("summary"))
        .and_then(|v| v.get("fail_rate"))
        .and_then(Value::as_f64)
        .or_else(|| {
            signals
                .get("collective_shadow")
                .and_then(|v| v.get("red_team"))
                .and_then(|v| v.get("fail_rate"))
                .and_then(Value::as_f64)
        })
        .unwrap_or(0.0);
    let hold_rate = signals
        .get("observer_mirror")
        .and_then(|v| v.get("summary"))
        .and_then(|v| v.get("rates"))
        .and_then(|v| v.get("hold_rate"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let coherence = signals
        .get("symbiosis")
        .and_then(|v| v.get("coherence_score"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);

    let critical_trigger = number_i64(
        policy
            .get("thresholds")
            .and_then(|v| v.get("critical_fail_cases_trigger")),
        1,
        0,
        100_000,
    );
    if critical_fail >= critical_trigger {
        out.push(json!({
            "run_id": run_id,
            "proposal_type": "critical_fail_case_containment",
            "summary": "Strengthen containment around failing red-team surfaces.",
            "priority": "high"
        }));
    }
    let red_trigger = number_f64(
        policy
            .get("thresholds")
            .and_then(|v| v.get("red_team_fail_rate_trigger")),
        0.15,
        0.0,
        1.0,
    );
    if red_fail >= red_trigger {
        out.push(json!({
            "run_id": run_id,
            "proposal_type": "red_team_fail_rate_hardening",
            "summary": "Reduce red-team fail-rate via targeted controls and retries.",
            "priority": "high"
        }));
    }
    let hold_trigger = number_f64(
        policy
            .get("thresholds")
            .and_then(|v| v.get("mirror_hold_rate_trigger")),
        0.4,
        0.0,
        1.0,
    );
    if hold_rate >= hold_trigger {
        out.push(json!({
            "run_id": run_id,
            "proposal_type": "mirror_hold_rate_relief",
            "summary": "Investigate high hold-rate and reduce unnecessary holds.",
            "priority": "medium"
        }));
    }
    let low_sym_trigger = number_f64(
        policy
            .get("thresholds")
            .and_then(|v| v.get("low_symbiosis_score_trigger")),
        0.75,
        0.0,
        1.0,
    );
    if coherence < low_sym_trigger {
        out.push(json!({
            "run_id": run_id,
            "proposal_type": "symbiosis_recovery",
            "summary": "Recover symbiosis coherence before risky adaptations.",
            "priority": "medium"
        }));
    }
    out.truncate(max);
    out
}

pub fn run_dream_warden_guard(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let args = parse_cli_args(argv);
    let cmd = args
        .positional
        .first()
        .map(|v| normalize_token(v, 80))
        .unwrap_or_else(|| "status".to_string());
    let policy_path = dream_warden_policy_path(repo_root, &args);
    let policy = dream_warden_load_policy(repo_root, &policy_path);
    let outputs = policy
        .get("outputs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let latest_path = PathBuf::from(
        outputs
            .get("latest_path")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let history_path = PathBuf::from(
        outputs
            .get("history_path")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let receipts_path = PathBuf::from(
        outputs
            .get("receipts_path")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let patch_path = PathBuf::from(
        outputs
            .get("patch_proposals_path")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );
    let ide_path = PathBuf::from(
        outputs
            .get("ide_events_path")
            .and_then(Value::as_str)
            .unwrap_or(""),
    );

    if cmd == "status" {
        let latest = read_json_or(&latest_path, json!({}));
        return (
            json!({
                "ok": true,
                "type": "dream_warden_status",
                "latest": latest,
                "activation_ready": latest.get("activation_ready").and_then(Value::as_bool).unwrap_or(false),
                "run_id": latest.get("run_id").cloned().unwrap_or(Value::Null)
            }),
            0,
        );
    }
    if cmd != "run" {
        return (
            json!({
                "ok": false,
                "type": "dream_warden_error",
                "error": format!("unknown_command:{cmd}")
            }),
            2,
        );
    }

    let apply_requested = bool_from_str(args.flags.get("apply").map(String::as_str), false);
    let passive_only = policy
        .get("passive_only")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if apply_requested && passive_only {
        let out = json!({
            "ok": false,
            "type": "dream_warden_run",
            "error": "passive_mode_violation_apply_requested",
            "stasis_recommendation": true,
            "passive_only": true
        });
        let _ = write_json_atomic(&latest_path, &out);
        let _ = append_jsonl(&history_path, &out);
        let _ = append_jsonl(&receipts_path, &out);
        return (out, 1);
    }

    let date = date_arg_or_today(args.positional.get(1));
    let run_id = format!(
        "dwd_{}_{}",
        Utc::now().timestamp_millis().to_string(),
        std::process::id()
    );

    let signals = policy
        .get("signals")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let collective_shadow = read_json_or(
        &PathBuf::from(
            signals
                .get("collective_shadow_latest_path")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ),
        json!({}),
    );
    let observer_mirror = read_json_or(
        &PathBuf::from(
            signals
                .get("observer_mirror_latest_path")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ),
        json!({}),
    );
    let red_team = read_json_or(
        &PathBuf::from(
            signals
                .get("red_team_latest_path")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ),
        json!({}),
    );
    let symbiosis = read_json_or(
        &PathBuf::from(
            signals
                .get("symbiosis_latest_path")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ),
        json!({}),
    );
    let gsi_state = read_json_or(
        &PathBuf::from(
            signals
                .get("gated_self_improvement_state_path")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ),
        json!({}),
    );
    let successful_cycles = dream_warden_count_successful_cycles(&gsi_state);
    let min_cycles = number_i64(
        policy
            .get("activation")
            .and_then(|v| v.get("min_successful_self_improvement_cycles")),
        5,
        0,
        100_000,
    );
    let coherence_score = symbiosis
        .get("coherence_score")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let min_symbiosis = number_f64(
        policy
            .get("activation")
            .and_then(|v| v.get("min_symbiosis_score")),
        0.82,
        0.0,
        1.0,
    );
    let min_hours = number_i64(
        policy
            .get("activation")
            .and_then(|v| v.get("min_hours_between_runs")),
        1,
        0,
        720,
    ) as f64;
    let (_last_ts, hours_since_last) = dream_warden_last_run_info(&history_path);
    let throttled = hours_since_last.map(|v| v < min_hours).unwrap_or(false);
    let activation_ready =
        successful_cycles >= min_cycles && coherence_score >= min_symbiosis && !throttled;

    let merged_signals = json!({
        "collective_shadow": collective_shadow,
        "observer_mirror": observer_mirror,
        "red_team": red_team,
        "symbiosis": symbiosis
    });
    let patch_proposals = dream_warden_patch_proposals(&policy, &merged_signals, &run_id);
    let out = json!({
        "ok": true,
        "type": "dream_warden_run",
        "date": date,
        "ts": now_iso(),
        "run_id": run_id,
        "mode": "active_shadow_observer",
        "shadow_only": policy.get("shadow_only").and_then(Value::as_bool).unwrap_or(true),
        "passive_only": passive_only,
        "apply_requested": apply_requested,
        "apply_executed": false,
        "activation_ready": activation_ready,
        "activation": {
            "successful_cycles": successful_cycles,
            "min_successful_cycles": min_cycles,
            "coherence_score": coherence_score,
            "min_symbiosis_score": min_symbiosis,
            "hours_since_last_run": hours_since_last,
            "min_hours_between_runs": min_hours,
            "throttled": throttled
        },
        "patch_proposals_count": patch_proposals.len(),
        "patch_proposals": patch_proposals
    });

    let _ = write_json_atomic(&latest_path, &out);
    let _ = append_jsonl(&history_path, &out);
    let _ = append_jsonl(&receipts_path, &out);
    for row in out
        .get("patch_proposals")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let _ = append_jsonl(&patch_path, &row);
        let ide = json!({
            "ts": now_iso(),
            "type": "dream_warden_patch_proposal",
            "run_id": out.get("run_id").cloned().unwrap_or(Value::Null),
            "proposal": row
        });
        let _ = append_jsonl(&ide_path, &ide);
    }

    (out, 0)
}

// -------------------------------------------------------------------------------------------------
// Directive Hierarchy Controller
// -------------------------------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct ActiveDirectiveRow {
    id: String,
    tier: i64,
    status: String,
    reason: String,
    auto_generated: bool,
    parent_directive_id: String,
}

fn directive_hierarchy_paths(repo_root: &Path) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    let directives_dir = runtime_config_path(repo_root, "directives");
    let active_path = directives_dir.join("ACTIVE.yaml");
    let strategies_dir = runtime_config_path(repo_root, "strategies");
    let audit_path = runtime_state_root(repo_root)
        .join("security")
        .join("directive_hierarchy_audit.jsonl");
    (directives_dir, active_path, strategies_dir, audit_path)
}

fn directive_tier_from_id(id: &str) -> i64 {
    let clean = id.trim();
    if !clean.starts_with('T') {
        return 99;
    }
    let rest = &clean[1..];
    let mut digits = String::new();
    for ch in rest.chars() {
        if ch.is_ascii_digit() {
            digits.push(ch);
        } else {
            break;
        }
    }
    digits.parse::<i64>().unwrap_or(99)
}

fn normalize_directive_id(v: &str) -> String {
    let text = clean_text(v, 160);
    let mut chars = text.chars();
    if chars.next() != Some('T') {
        return String::new();
    }
    let mut seen_underscore = false;
    for ch in text.chars().skip(1) {
        if ch == '_' {
            seen_underscore = true;
            continue;
        }
        let ok = ch.is_ascii_alphanumeric() || ch == '_';
        if !ok {
            return String::new();
        }
    }
    if !seen_underscore {
        return String::new();
    }
    text
}

fn parse_active_yaml(path: &Path) -> Vec<ActiveDirectiveRow> {
    let raw = match fs::read_to_string(path) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut rows = Vec::<ActiveDirectiveRow>::new();
    let mut cur: Option<ActiveDirectiveRow> = None;
    for line in raw.lines() {
        let t = line.trim();
        if let Some(value) = t.strip_prefix("- id:") {
            if let Some(prev) = cur.take() {
                rows.push(prev);
            }
            cur = Some(ActiveDirectiveRow {
                id: normalize_directive_id(value.trim().trim_matches('"').trim_matches('\'')),
                tier: 0,
                status: "active".to_string(),
                reason: String::new(),
                auto_generated: false,
                parent_directive_id: String::new(),
            });
            continue;
        }
        if !t.starts_with(|c: char| c.is_ascii_alphabetic()) {
            continue;
        }
        if let Some(row) = cur.as_mut() {
            if let Some(v) = t.strip_prefix("id:") {
                row.id = normalize_directive_id(v.trim().trim_matches('"').trim_matches('\''));
            } else if let Some(v) = t.strip_prefix("tier:") {
                row.tier = v
                    .trim()
                    .parse::<i64>()
                    .unwrap_or_else(|_| directive_tier_from_id(&row.id));
            } else if let Some(v) = t.strip_prefix("status:") {
                row.status = normalize_token(v, 40);
            } else if let Some(v) = t.strip_prefix("reason:") {
                row.reason = clean_text(v.trim().trim_matches('"').trim_matches('\''), 280);
            } else if let Some(v) = t.strip_prefix("auto_generated:") {
                row.auto_generated = bool_from_str(Some(v.trim()), false);
            } else if let Some(v) = t.strip_prefix("parent_directive_id:") {
                row.parent_directive_id =
                    normalize_directive_id(v.trim().trim_matches('"').trim_matches('\''));
            }
        }
    }
    if let Some(prev) = cur.take() {
        rows.push(prev);
    }
    rows.into_iter()
        .filter(|row| !row.id.is_empty())
        .map(|mut row| {
            if row.tier <= 0 {
                row.tier = directive_tier_from_id(&row.id);
            }
            if row.status.is_empty() {
                row.status = "active".to_string();
            }
            row
        })
        .collect::<Vec<_>>()
}

fn render_active_yaml(rows: &[ActiveDirectiveRow]) -> String {
    let mut out = Vec::new();
    out.push("metadata:".to_string());
    out.push(format!("  updated_at: \"{}\"", now_iso()));
    out.push("active_directives:".to_string());
    for row in rows {
        out.push(format!("  - id: {}", row.id));
        out.push(format!("    tier: {}", row.tier));
        out.push(format!(
            "    status: {}",
            if row.status.is_empty() {
                "active"
            } else {
                &row.status
            }
        ));
        if !row.reason.is_empty() {
            out.push(format!("    reason: \"{}\"", row.reason.replace('"', "'")));
        }
        if row.auto_generated {
            out.push("    auto_generated: true".to_string());
        }
        if !row.parent_directive_id.is_empty() {
            out.push(format!(
                "    parent_directive_id: {}",
                row.parent_directive_id
            ));
        }
    }
    out.push(String::new());
    out.join("\n")
}

fn directive_child_id(
    parent_id: &str,
    tier: i64,
    kind: &str,
    existing: &HashSet<String>,
) -> String {
    let base = parent_id
        .split_once('_')
        .map(|(_, b)| b.to_string())
        .unwrap_or_else(|| "parent".to_string());
    let stem = normalize_token(base, 120);
    let mut candidate = format!("T{}_{}_{}_auto", tier, stem, kind);
    if !existing.contains(&candidate) {
        return candidate;
    }
    let mut i = 2_u64;
    loop {
        let next = format!("{candidate}_{i}");
        if !existing.contains(&next) {
            return next;
        }
        i += 1;
    }
}

fn write_child_directive_file(
    path: &Path,
    child_id: &str,
    parent_id: &str,
    kind: &str,
) -> Result<(), String> {
    ensure_parent(path)?;
    let body = format!(
        "id: {child_id}\n\
tier: {}\n\
status: active\n\
metadata:\n\
  parent_directive_id: {parent_id}\n\
  decomposition_kind: {kind}\n\
  auto_generated: true\n\
  created_at: \"{}\"\n\
summary: \"Auto-generated child directive ({kind}) from {parent_id}.\"\n\
risk_limits:\n\
  max_cost_usd: 100\n\
  max_token_usage: 1500\n\
success_criteria:\n\
  - \"Demonstrate measurable progress toward parent objective\"\n\
",
        directive_tier_from_id(child_id),
        now_iso()
    );
    fs::write(path, body)
        .map_err(|err| format!("write_child_directive_failed:{}:{err}", path.display()))
}

fn load_strategy_conflicts(strategies_dir: &Path, parent_id: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let entries = match fs::read_dir(strategies_dir) {
        Ok(v) => v,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let row = read_json_or(&p, json!({}));
        if row
            .get("status")
            .and_then(Value::as_str)
            .map(|v| v.eq_ignore_ascii_case("active"))
            .unwrap_or(true)
            == false
        {
            continue;
        }
        let blocked = row
            .get("admission_policy")
            .and_then(|v| v.get("blocked_types"))
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .map(|v| v.to_ascii_lowercase())
            .collect::<Vec<_>>();
        if blocked.iter().any(|v| v == "directive_decomposition") {
            out.push(json!({
                "strategy_id": row.get("id").cloned().unwrap_or(Value::String(
                    p.file_stem().and_then(|v| v.to_str()).unwrap_or("unknown").to_string()
                )),
                "reason": "strategy_blocks_directive_decomposition",
                "directive_id": parent_id
            }));
        }
    }
    out
}

pub fn run_directive_hierarchy_controller(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let args = parse_cli_args(argv);
    let cmd = args
        .positional
        .first()
        .map(|v| normalize_token(v, 80))
        .unwrap_or_else(|| "status".to_string());
    let (directives_dir, active_path, strategies_dir, audit_path) =
        directive_hierarchy_paths(repo_root);
    let rows = parse_active_yaml(&active_path);

    if cmd == "status" {
        let filter_id = args
            .flags
            .get("id")
            .map(|v| normalize_directive_id(v))
            .unwrap_or_default();
        let records = if filter_id.is_empty() {
            rows.clone()
        } else {
            rows.into_iter()
                .filter(|row| row.id == filter_id || row.parent_directive_id == filter_id)
                .collect::<Vec<_>>()
        };
        return (
            json!({
                "ok": true,
                "type": "directive_hierarchy_status",
                "ts": now_iso(),
                "count": records.len(),
                "records": records
                    .iter()
                    .map(|row| {
                        json!({
                            "id": row.id,
                            "tier": row.tier,
                            "status": row.status,
                            "reason": row.reason,
                            "auto_generated": row.auto_generated,
                            "parent_directive_id": row.parent_directive_id
                        })
                    })
                    .collect::<Vec<_>>()
            }),
            0,
        );
    }

    if cmd != "decompose" {
        return (
            json!({
                "ok": false,
                "type": "directive_hierarchy_error",
                "reason": format!("unknown_command:{cmd}")
            }),
            2,
        );
    }

    let parent_id = args
        .flags
        .get("id")
        .map(|v| normalize_directive_id(v))
        .unwrap_or_default();
    if parent_id.is_empty() {
        return (
            json!({
                "ok": false,
                "type": "directive_hierarchy_decompose",
                "reason": "missing_or_invalid_parent_id"
            }),
            2,
        );
    }
    let apply = bool_from_str(args.flags.get("apply").map(String::as_str), false);
    let dry_run = bool_from_str(args.flags.get("dry-run").map(String::as_str), false);

    let parent = rows
        .iter()
        .find(|row| row.id == parent_id && row.status == "active")
        .cloned();
    if parent.is_none() {
        return (
            json!({
                "ok": false,
                "type": "directive_hierarchy_decompose",
                "reason": "parent_not_active_or_missing",
                "parent_id": parent_id
            }),
            1,
        );
    }
    let parent = parent.unwrap_or(ActiveDirectiveRow {
        id: parent_id.clone(),
        tier: 1,
        status: "active".to_string(),
        reason: String::new(),
        auto_generated: false,
        parent_directive_id: String::new(),
    });
    let min_tier = std::env::var("DIRECTIVE_DECOMPOSE_PARENT_MIN_TIER")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1);
    let max_tier = std::env::var("DIRECTIVE_DECOMPOSE_PARENT_MAX_TIER")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(1);
    if parent.tier < min_tier || parent.tier > max_tier {
        return (
            json!({
                "ok": false,
                "type": "directive_hierarchy_decompose",
                "reason": "parent_tier_out_of_bounds",
                "parent_tier": parent.tier
            }),
            1,
        );
    }

    let conflicts = load_strategy_conflicts(&strategies_dir, &parent_id);
    if !conflicts.is_empty() {
        return (
            json!({
                "ok": false,
                "type": "directive_hierarchy_decompose",
                "reason": "campaign_conflict",
                "conflicts": conflicts
            }),
            1,
        );
    }

    let mut existing_ids = rows
        .iter()
        .map(|row| row.id.clone())
        .collect::<HashSet<_>>();
    let active_children = rows
        .iter()
        .filter(|row| row.parent_directive_id == parent_id && row.status == "active")
        .cloned()
        .collect::<Vec<_>>();
    let has_plan = active_children.iter().any(|row| row.id.contains("_plan_"));
    let has_execute = active_children
        .iter()
        .any(|row| row.id.contains("_execute_") || row.id.contains("_execution_"));

    let child_tier = parent.tier + 1;
    let mut generated = Vec::<Value>::new();
    if !has_plan {
        let id = directive_child_id(&parent_id, child_tier, "plan", &existing_ids);
        existing_ids.insert(id.clone());
        generated.push(json!({
            "id": id,
            "kind": "plan"
        }));
    }
    if !has_execute {
        let id = directive_child_id(&parent_id, child_tier, "execute", &existing_ids);
        existing_ids.insert(id.clone());
        generated.push(json!({
            "id": id,
            "kind": "execute"
        }));
    }

    let mut next_rows = rows.clone();
    if apply && !dry_run {
        for row in &generated {
            let child_id = row.get("id").and_then(Value::as_str).unwrap_or("");
            let kind = row.get("kind").and_then(Value::as_str).unwrap_or("plan");
            if child_id.is_empty() {
                continue;
            }
            let file_path = directives_dir.join(format!("{child_id}.yaml"));
            if let Err(err) = write_child_directive_file(&file_path, child_id, &parent_id, kind) {
                return (
                    json!({
                        "ok": false,
                        "type": "directive_hierarchy_decompose",
                        "reason": format!("write_child_failed:{err}")
                    }),
                    1,
                );
            }
            next_rows.push(ActiveDirectiveRow {
                id: child_id.to_string(),
                tier: child_tier,
                status: "active".to_string(),
                reason: format!("auto_decomposed_from:{parent_id}"),
                auto_generated: true,
                parent_directive_id: parent_id.clone(),
            });
        }
        let rendered = render_active_yaml(&next_rows);
        if let Err(err) = ensure_parent(&active_path).and_then(|_| {
            fs::write(&active_path, rendered)
                .map_err(|e| format!("write_active_yaml_failed:{}:{e}", active_path.display()))
        }) {
            return (
                json!({
                    "ok": false,
                    "type": "directive_hierarchy_decompose",
                    "reason": err
                }),
                1,
            );
        }
    }

    let out = json!({
        "ok": true,
        "type": "directive_hierarchy_decompose",
        "ts": now_iso(),
        "parent_id": parent_id,
        "dry_run": dry_run,
        "applied": apply && !dry_run,
        "generated": generated,
        "generated_count": generated.len(),
        "existing_children_count": active_children.len(),
        "result": if generated.is_empty() { "no_change" } else { "decomposed" }
    });
    let _ = append_jsonl(&audit_path, &out);
    (out, 0)
}

// -------------------------------------------------------------------------------------------------
// Truth-Seeking Rule Gate
// -------------------------------------------------------------------------------------------------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct TruthGateIdentityBinding {
    required: bool,
}

impl Default for TruthGateIdentityBinding {
    fn default() -> Self {
        Self { required: true }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct TruthGateRule {
    id: String,
    trigger_tokens: Vec<String>,
    require_evidence: bool,
    min_evidence_items: usize,
    deny_reason: String,
}

impl Default for TruthGateRule {
    fn default() -> Self {
        Self {
            id: "default_unverified_agreement".to_string(),
            trigger_tokens: vec!["agree".to_string(), "approved".to_string()],
            require_evidence: true,
            min_evidence_items: 1,
            deny_reason: "agreement_without_verification_denied".to_string(),
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(default)]
struct TruthGatePolicy {
    version: String,
    enabled: bool,
    identity_binding: TruthGateIdentityBinding,
    deny_without_evidence: bool,
    min_evidence_items: usize,
    agreement_tokens: Vec<String>,
    rules: Vec<TruthGateRule>,
}

impl Default for TruthGatePolicy {
    fn default() -> Self {
        Self {
            version: "1.0".to_string(),
            enabled: true,
            identity_binding: TruthGateIdentityBinding::default(),
            deny_without_evidence: true,
            min_evidence_items: 1,
            agreement_tokens: vec![
                "agree".to_string(),
                "agreed".to_string(),
                "approved".to_string(),
                "sounds good".to_string(),
                "yes".to_string(),
            ],
            rules: vec![TruthGateRule::default()],
        }
    }
}

fn abac_paths(repo_root: &Path) -> (PathBuf, PathBuf, PathBuf, PathBuf) {
    let policy_path = std::env::var("ABAC_POLICY_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_config_path(repo_root, "abac_policy_plane.json"));
    let latest_path = std::env::var("ABAC_LATEST_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            runtime_state_root(repo_root)
                .join("security")
                .join("abac_policy_plane_latest.json")
        });
    let history_path = std::env::var("ABAC_HISTORY_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            runtime_state_root(repo_root)
                .join("security")
                .join("abac_policy_plane_history.jsonl")
        });
    let flight_recorder_path = std::env::var("ABAC_FLIGHT_RECORDER_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            runtime_state_root(repo_root)
                .join("security")
                .join("abac_flight_recorder.jsonl")
        });
    (policy_path, latest_path, history_path, flight_recorder_path)
}

fn parse_object_map(raw: Option<&String>) -> Result<Map<String, Value>, String> {
    let text = match raw {
        Some(v) => v.trim(),
        None => return Ok(Map::new()),
    };
    if text.is_empty() {
        return Ok(Map::new());
    }
    let parsed = serde_json::from_str::<Value>(text)
        .map_err(|err| format!("invalid_json_object_payload:{err}"))?;
    parsed
        .as_object()
        .cloned()
        .ok_or_else(|| "json_object_payload_must_be_object".to_string())
}

fn normalized_value(raw: Option<&str>) -> Option<String> {
    raw.map(|v| clean_text(v, 160).to_ascii_lowercase())
        .filter(|v| !v.is_empty())
}

fn rule_dimension_allows(scope: Option<&Value>, fields: &Map<String, Value>) -> bool {
    let Some(scope_obj) = scope.and_then(Value::as_object) else {
        return true;
    };
    for (key, expected) in scope_obj {
        let actual = fields
            .get(key)
            .and_then(Value::as_str)
            .map(|v| v.to_ascii_lowercase())
            .unwrap_or_default();
        let expected_values = expected
            .as_array()
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|v| v.as_str().map(|x| x.to_ascii_lowercase()))
            .collect::<Vec<_>>();
        if expected_values.is_empty() {
            continue;
        }
        if !expected_values
            .iter()
            .any(|v| v == "*" || (!actual.is_empty() && v == &actual))
        {
            return false;
        }
    }
    true
}

fn abac_trace_hash(payload: &Value) -> String {
    let mut basis = payload.clone();
    if let Some(obj) = basis.as_object_mut() {
        obj.remove("hash");
        obj.remove("receipt_hash");
    }
    sha256_hex(&stable_json_string(&basis))
}

pub fn run_abac_policy_plane(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let args = parse_cli_args(argv);
    let cmd = args
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let (policy_path, latest_path, history_path, flight_path) = abac_paths(repo_root);
    let policy_json = read_json_or(
        &policy_path,
        json!({
            "version": "v1",
            "kind": "abac_policy_plane",
            "default_effect": "deny",
            "rules": [],
            "flight_recorder": {
                "immutable": true,
                "hash_chain": true,
                "redact_subject_fields": []
            }
        }),
    );
    let rules = policy_json
        .get("rules")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let default_effect = policy_json
        .get("default_effect")
        .and_then(Value::as_str)
        .unwrap_or("deny")
        .to_ascii_lowercase();
    let redact_fields = policy_json
        .get("flight_recorder")
        .and_then(|v| v.get("redact_subject_fields"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.as_str().map(|x| x.to_ascii_lowercase()))
        .collect::<HashSet<_>>();

    if cmd == "status" {
        let latest = read_json_or(&latest_path, Value::Null);
        let mut out = json!({
            "ok": true,
            "type": "abac_policy_plane_status",
            "ts": now_iso(),
            "policy_path": normalize_rel_path(policy_path.display().to_string()),
            "latest_path": normalize_rel_path(latest_path.display().to_string()),
            "history_path": normalize_rel_path(history_path.display().to_string()),
            "flight_recorder_path": normalize_rel_path(flight_path.display().to_string()),
            "rules_count": rules.len(),
            "latest": latest
        });
        out["receipt_hash"] = Value::String(abac_trace_hash(&out));
        return (out, 0);
    }

    if cmd != "evaluate" {
        return (
            json!({
                "ok": false,
                "type": "abac_policy_plane_error",
                "reason": format!("unknown_command:{cmd}")
            }),
            2,
        );
    }

    let mut subject = match parse_object_map(args.flags.get("subject-json")) {
        Ok(v) => v,
        Err(err) => {
            return (
                json!({
                    "ok": false,
                    "type": "abac_policy_plane_evaluate",
                    "reason": err
                }),
                2,
            )
        }
    };
    if let Some(role) = normalized_value(args.flags.get("subject-role").map(String::as_str)) {
        subject.insert("role".to_string(), Value::String(role));
    }
    if let Some(id) = normalized_value(args.flags.get("subject-id").map(String::as_str)) {
        subject.insert("id".to_string(), Value::String(id));
    }

    let mut object = match parse_object_map(args.flags.get("object-json")) {
        Ok(v) => v,
        Err(err) => {
            return (
                json!({
                    "ok": false,
                    "type": "abac_policy_plane_evaluate",
                    "reason": err
                }),
                2,
            )
        }
    };
    if let Some(classification) =
        normalized_value(args.flags.get("object-classification").map(String::as_str))
    {
        object.insert("classification".to_string(), Value::String(classification));
    }
    if let Some(id) = normalized_value(args.flags.get("object-id").map(String::as_str)) {
        object.insert("id".to_string(), Value::String(id));
    }

    let mut context = match parse_object_map(args.flags.get("context-json")) {
        Ok(v) => v,
        Err(err) => {
            return (
                json!({
                    "ok": false,
                    "type": "abac_policy_plane_evaluate",
                    "reason": err
                }),
                2,
            )
        }
    };
    if let Some(env) = normalized_value(args.flags.get("context-env").map(String::as_str)) {
        context.insert("env".to_string(), Value::String(env));
    }
    if let Some(trust) = normalized_value(args.flags.get("context-trust").map(String::as_str)) {
        context.insert("trust".to_string(), Value::String(trust));
    }
    let action = normalized_value(args.flags.get("action").map(String::as_str)).unwrap_or_default();
    if action.is_empty() {
        return (
            json!({
                "ok": false,
                "type": "abac_policy_plane_evaluate",
                "reason": "missing_action"
            }),
            2,
        );
    }

    let subject_value = Value::Object(subject.clone());
    let object_value = Value::Object(object.clone());
    let context_value = Value::Object(context.clone());

    let mut decision_effect = default_effect.clone();
    let mut matched_rule_id = Value::Null;
    for rule in &rules {
        let action_ok = rule
            .get("action")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|v| v.as_str().map(|x| x.to_ascii_lowercase()))
            .any(|v| v == "*" || v == action);
        if !action_ok {
            continue;
        }
        if !rule_dimension_allows(rule.get("subject"), &subject) {
            continue;
        }
        if !rule_dimension_allows(rule.get("object"), &object) {
            continue;
        }
        if !rule_dimension_allows(rule.get("context"), &context) {
            continue;
        }
        decision_effect = rule
            .get("effect")
            .and_then(Value::as_str)
            .unwrap_or("deny")
            .to_ascii_lowercase();
        matched_rule_id = rule
            .get("id")
            .and_then(Value::as_str)
            .map(|v| Value::String(v.to_string()))
            .unwrap_or(Value::Null);
        break;
    }

    let allowed = decision_effect == "allow";
    let mut redacted_subject = subject.clone();
    for key in &redact_fields {
        if redacted_subject.contains_key(key) {
            redacted_subject.insert(key.clone(), Value::String("***".to_string()));
        }
    }

    let previous_hash = read_jsonl(&flight_path)
        .last()
        .and_then(|v| v.get("hash").and_then(Value::as_str))
        .map(ToString::to_string)
        .unwrap_or_else(|| "GENESIS".to_string());
    let mut flight_row = json!({
        "type": "abac_flight_recorder_event",
        "ts": now_iso(),
        "subject": redacted_subject,
        "object": object,
        "context": context,
        "action": action,
        "decision": if allowed { "allow" } else { "deny" },
        "matched_rule_id": matched_rule_id,
        "prev_hash": previous_hash
    });
    let hash = abac_trace_hash(&flight_row);
    flight_row["hash"] = Value::String(hash.clone());
    let _ = append_jsonl(&flight_path, &flight_row);

    let mut out = json!({
        "ok": allowed,
        "type": "abac_policy_plane_evaluate",
        "ts": now_iso(),
        "subject": subject_value,
        "object": object_value,
        "context": context_value,
        "action": action,
        "decision": if allowed { "allow" } else { "deny" },
        "matched_rule_id": matched_rule_id,
        "policy_path": normalize_rel_path(policy_path.display().to_string()),
        "flight_recorder_path": normalize_rel_path(flight_path.display().to_string()),
        "flight_recorder_hash": hash,
        "claim_evidence": [
            {
                "id": "V7-ASM-006",
                "claim": "abac_evaluation_emits_immutable_flight_recorder_trace",
                "evidence": {
                    "matched_rule_id": matched_rule_id,
                    "decision": if allowed { "allow" } else { "deny" }
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(abac_trace_hash(&out));
    let _ = append_jsonl(&history_path, &out);
    let _ = write_json_atomic(&latest_path, &out);
    (out, if allowed { 0 } else { 1 })
}

fn truth_gate_paths(repo_root: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let policy_path = std::env::var("TRUTH_GATE_POLICY_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_config_path(repo_root, "truth_gate_policy.json"));
    let latest_path = std::env::var("TRUTH_GATE_LATEST_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            runtime_state_root(repo_root)
                .join("security")
                .join("truth_gate_latest.json")
        });
    let history_path = std::env::var("TRUTH_GATE_HISTORY_PATH")
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            runtime_state_root(repo_root)
                .join("security")
                .join("truth_gate_history.jsonl")
        });
    (policy_path, latest_path, history_path)
}

fn normalize_tokens_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|part| clean_text(part, 120).to_ascii_lowercase())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
}

fn truth_gate_receipt_hash(payload: &Value) -> String {
    let mut basis = payload.clone();
    if let Some(obj) = basis.as_object_mut() {
        obj.remove("receipt_hash");
    }
    sha256_hex(&stable_json_string(&basis))
}

fn claim_has_token(claim_lc: &str, tokens: &[String]) -> bool {
    tokens.iter().any(|token| {
        let clean_token = clean_text(token, 120).to_ascii_lowercase();
        !clean_token.is_empty() && claim_lc.contains(&clean_token)
    })
}

pub fn run_truth_seeking_gate(repo_root: &Path, argv: &[String]) -> (Value, i32) {
    let args = parse_cli_args(argv);
    let cmd = args
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let (policy_path, latest_path, history_path) = truth_gate_paths(repo_root);
    let policy_json = read_json_or(&policy_path, json!(TruthGatePolicy::default()));
    let policy: TruthGatePolicy = serde_json::from_value(policy_json.clone()).unwrap_or_default();

    if cmd == "status" {
        let latest = read_json_or(&latest_path, json!(null));
        let mut out = json!({
            "ok": true,
            "type": "truth_seeking_gate_status",
            "ts": now_iso(),
            "policy_path": normalize_rel_path(policy_path.display().to_string()),
            "latest_path": normalize_rel_path(latest_path.display().to_string()),
            "history_path": normalize_rel_path(history_path.display().to_string()),
            "policy": policy_json,
            "latest": latest
        });
        out["receipt_hash"] = Value::String(truth_gate_receipt_hash(&out));
        return (out, 0);
    }

    if cmd == "ingest-rule" || cmd == "ingest_rule" {
        let rule_id = normalize_token(args.flags.get("rule-id").cloned().unwrap_or_default(), 120);
        if rule_id.is_empty() {
            return (
                json!({
                    "ok": false,
                    "type": "truth_seeking_gate_ingest_rule",
                    "reason": "missing_rule_id"
                }),
                2,
            );
        }
        let trigger_tokens = normalize_tokens_csv(
            args.flags
                .get("trigger-tokens")
                .map(String::as_str)
                .unwrap_or(""),
        );
        if trigger_tokens.is_empty() {
            return (
                json!({
                    "ok": false,
                    "type": "truth_seeking_gate_ingest_rule",
                    "reason": "missing_trigger_tokens"
                }),
                2,
            );
        }
        let min_evidence_items = args
            .flags
            .get("min-evidence-items")
            .and_then(|v| v.parse::<usize>().ok())
            .unwrap_or(1)
            .clamp(0, 20);
        let require_evidence =
            bool_from_str(args.flags.get("require-evidence").map(String::as_str), true);
        let deny_reason = clean_text(
            args.flags.get("deny-reason").cloned().unwrap_or_default(),
            120,
        )
        .to_ascii_lowercase();

        let mut next_policy = policy.clone();
        next_policy.rules.retain(|rule| rule.id != rule_id);
        next_policy.rules.push(TruthGateRule {
            id: rule_id.clone(),
            trigger_tokens,
            require_evidence,
            min_evidence_items,
            deny_reason: if deny_reason.is_empty() {
                "truth_gate_rule_denied".to_string()
            } else {
                deny_reason
            },
        });
        let next_json = serde_json::to_value(&next_policy)
            .unwrap_or_else(|_| json!(TruthGatePolicy::default()));
        if let Err(err) = write_json_atomic(&policy_path, &next_json) {
            return (
                json!({
                    "ok": false,
                    "type": "truth_seeking_gate_ingest_rule",
                    "reason": err
                }),
                1,
            );
        }
        let mut out = json!({
            "ok": true,
            "type": "truth_seeking_gate_ingest_rule",
            "ts": now_iso(),
            "rule_id": rule_id,
            "rules_count": next_policy.rules.len(),
            "policy_path": normalize_rel_path(policy_path.display().to_string())
        });
        out["receipt_hash"] = Value::String(truth_gate_receipt_hash(&out));
        let _ = append_jsonl(&history_path, &out);
        let _ = write_json_atomic(&latest_path, &out);
        return (out, 0);
    }

    if cmd != "evaluate" {
        return (
            json!({
                "ok": false,
                "type": "truth_seeking_gate_error",
                "reason": format!("unknown_command:{cmd}")
            }),
            2,
        );
    }

    let claim = clean_text(args.flags.get("claim").cloned().unwrap_or_default(), 600);
    if claim.is_empty() {
        return (
            json!({
                "ok": false,
                "type": "truth_seeking_gate_evaluate",
                "reason": "missing_claim"
            }),
            2,
        );
    }
    let claim_lc = claim.to_ascii_lowercase();
    let claim_id = normalize_token(
        args.flags
            .get("claim-id")
            .cloned()
            .unwrap_or_else(|| format!("claim_{}", Utc::now().timestamp_millis())),
        120,
    );
    let persona_id = normalize_token(
        args.flags
            .get("persona-id")
            .cloned()
            .or_else(|| args.flags.get("persona_id").cloned())
            .unwrap_or_default(),
        120,
    );
    let evidence_items =
        normalize_tokens_csv(args.flags.get("evidence").map(String::as_str).unwrap_or(""));
    let evidence_count = evidence_items.len();

    let mut deny_reasons = Vec::<String>::new();
    if policy.enabled && policy.identity_binding.required && persona_id.is_empty() {
        deny_reasons.push("missing_identity_binding".to_string());
    }

    let agreement_signal = claim_has_token(&claim_lc, &policy.agreement_tokens);
    if policy.enabled
        && policy.deny_without_evidence
        && agreement_signal
        && evidence_count < policy.min_evidence_items
    {
        deny_reasons.push("agreement_without_verification_denied".to_string());
    }

    if policy.enabled {
        for rule in &policy.rules {
            if !claim_has_token(&claim_lc, &rule.trigger_tokens) {
                continue;
            }
            if rule.require_evidence && evidence_count < rule.min_evidence_items {
                deny_reasons.push(if rule.deny_reason.is_empty() {
                    format!("rule_denied:{}", rule.id)
                } else {
                    rule.deny_reason.clone()
                });
            }
        }
    }

    deny_reasons.sort();
    deny_reasons.dedup();
    let allowed = deny_reasons.is_empty();

    let mut out = json!({
        "ok": allowed,
        "type": "truth_seeking_gate_evaluate",
        "ts": now_iso(),
        "claim_id": claim_id,
        "claim": claim,
        "persona_id": if persona_id.is_empty() { Value::Null } else { Value::String(persona_id.clone()) },
        "evidence": evidence_items,
        "evidence_count": evidence_count,
        "agreement_signal": agreement_signal,
        "policy_enabled": policy.enabled,
        "decision": if allowed { "allow" } else { "deny" },
        "deny_reasons": deny_reasons,
        "policy_path": normalize_rel_path(policy_path.display().to_string()),
        "latest_path": normalize_rel_path(latest_path.display().to_string()),
        "history_path": normalize_rel_path(history_path.display().to_string())
    });
    out["receipt_hash"] = Value::String(truth_gate_receipt_hash(&out));
    let _ = append_jsonl(&history_path, &out);
    let _ = write_json_atomic(&latest_path, &out);
    (out, if allowed { 0 } else { 1 })
}

#[cfg(test)]
mod capability_switchboard_tests {
    use super::*;
    use tempfile::tempdir;

    fn write_json(path: &Path, value: &Value) {
        write_json_atomic(path, value).expect("write json");
    }

    #[test]
    fn capability_switchboard_emits_grant_revoke_hash_chain() {
        let tmp = tempdir().expect("tempdir");
        let policy_path = tmp.path().join("policy.json");
        let state_path = tmp.path().join("state.json");
        let audit_path = tmp.path().join("audit.jsonl");
        let chain_path = tmp.path().join("chain.jsonl");

        write_json(
            &policy_path,
            &json!({
                "version": "1.0",
                "require_dual_control": false,
                "policy_root": {"required": false, "scope": "capability_switchboard_toggle"},
                "switches": {
                    "autonomy": {
                        "default_enabled": true,
                        "security_locked": false,
                        "require_policy_root": false,
                        "description": "Autonomy lane"
                    }
                }
            }),
        );

        std::env::set_var("CAPABILITY_SWITCHBOARD_POLICY_PATH", &policy_path);
        std::env::set_var("CAPABILITY_SWITCHBOARD_STATE_PATH", &state_path);
        std::env::set_var("CAPABILITY_SWITCHBOARD_AUDIT_PATH", &audit_path);
        std::env::set_var("CAPABILITY_SWITCHBOARD_CHAIN_PATH", &chain_path);

        let (_, code_revoke) = run_capability_switchboard(
            tmp.path(),
            &[
                "set".to_string(),
                "--switch=autonomy".to_string(),
                "--state=off".to_string(),
                "--approver-id=op1".to_string(),
                "--approval-note=disable autonomy for maintenance".to_string(),
            ],
        );
        assert_eq!(code_revoke, 0);

        let (_, code_grant) = run_capability_switchboard(
            tmp.path(),
            &[
                "set".to_string(),
                "--switch=autonomy".to_string(),
                "--state=on".to_string(),
                "--approver-id=op1".to_string(),
                "--approval-note=re-enable autonomy after checks".to_string(),
            ],
        );
        assert_eq!(code_grant, 0);

        let (verify, verify_code) =
            run_capability_switchboard(tmp.path(), &["verify-chain".to_string()]);
        assert_eq!(verify_code, 0);
        assert_eq!(verify.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            verify
                .get("chain")
                .and_then(|v| v.get("entries"))
                .and_then(Value::as_u64),
            Some(2)
        );

        std::env::remove_var("CAPABILITY_SWITCHBOARD_POLICY_PATH");
        std::env::remove_var("CAPABILITY_SWITCHBOARD_STATE_PATH");
        std::env::remove_var("CAPABILITY_SWITCHBOARD_AUDIT_PATH");
        std::env::remove_var("CAPABILITY_SWITCHBOARD_CHAIN_PATH");
    }

    #[test]
    fn capability_switchboard_verify_chain_detects_tamper() {
        let tmp = tempdir().expect("tempdir");
        let chain_path = tmp.path().join("chain.jsonl");
        append_jsonl(
            &chain_path,
            &json!({
                "type": "capability_switchboard_chain_event",
                "ts": "2026-03-13T00:00:00Z",
                "action": "grant",
                "switch": "autonomy",
                "enabled": true,
                "approver_id": "op1",
                "second_approver_id": "",
                "reason": "ok",
                "policy_scope": "capability_switchboard_toggle",
                "prev_hash": "GENESIS",
                "hash": "tampered"
            }),
        )
        .expect("append");
        let verify = capability_switchboard_verify_chain(&chain_path);
        assert_eq!(verify.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            verify.get("error").and_then(Value::as_str),
            Some("chain_hash_mismatch")
        );
    }
}

#[cfg(test)]
mod truth_gate_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn truth_gate_denies_unverified_agreement() {
        let root = tempdir().expect("tempdir");
        let policy_path = root
            .path()
            .join("client")
            .join("runtime")
            .join("config")
            .join("truth_gate_policy.json");
        ensure_parent(&policy_path).expect("policy parent");
        write_json_atomic(
            &policy_path,
            &json!({
              "version": "1.0",
              "enabled": true,
              "identity_binding": { "required": true },
              "deny_without_evidence": true,
              "min_evidence_items": 1,
              "agreement_tokens": ["agree","approved"],
              "rules": []
            }),
        )
        .expect("write policy");

        let (out, code) = run_truth_seeking_gate(
            root.path(),
            &[
                "evaluate".to_string(),
                "--claim=I agree with the proposal".to_string(),
                "--persona-id=core_guardian".to_string(),
                "--evidence=".to_string(),
            ],
        );
        assert_eq!(code, 1);
        assert_eq!(out.get("decision").and_then(Value::as_str), Some("deny"));
        let deny_rows = out
            .get("deny_reasons")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(deny_rows.iter().any(|row| {
            row.as_str()
                .map(|v| v == "agreement_without_verification_denied")
                .unwrap_or(false)
        }));
    }

    #[test]
    fn truth_gate_allows_when_evidence_present() {
        let root = tempdir().expect("tempdir");
        let (out, code) = run_truth_seeking_gate(
            root.path(),
            &[
                "evaluate".to_string(),
                "--claim=I agree based on logs".to_string(),
                "--persona-id=security_warden".to_string(),
                "--evidence=receipt:abc123".to_string(),
            ],
        );
        assert_eq!(code, 0);
        assert_eq!(out.get("decision").and_then(Value::as_str), Some("allow"));
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
    }
}

#[cfg(test)]
mod abac_policy_plane_tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn abac_denies_when_no_rule_matches() {
        let root = tempdir().expect("tempdir");
        let policy_path = root
            .path()
            .join("client")
            .join("runtime")
            .join("config")
            .join("abac_policy_plane.json");
        ensure_parent(&policy_path).expect("policy parent");
        write_json_atomic(
            &policy_path,
            &json!({
                "version": "v1",
                "kind": "abac_policy_plane",
                "default_effect": "deny",
                "rules": [],
                "flight_recorder": {
                    "immutable": true,
                    "hash_chain": true,
                    "redact_subject_fields": ["id"]
                }
            }),
        )
        .expect("write policy");

        let (out, code) = run_abac_policy_plane(
            root.path(),
            &[
                "evaluate".to_string(),
                "--action=write".to_string(),
                "--subject-role=observer".to_string(),
                "--subject-id=user-123".to_string(),
                "--object-classification=internal".to_string(),
                "--context-env=dev".to_string(),
            ],
        );
        assert_eq!(code, 1);
        assert_eq!(out.get("decision").and_then(Value::as_str), Some("deny"));
        assert_eq!(
            out.get("type").and_then(Value::as_str),
            Some("abac_policy_plane_evaluate")
        );

        let flight_path = root
            .path()
            .join("client")
            .join("runtime")
            .join("state")
            .join("security")
            .join("abac_flight_recorder.jsonl");
        let rows = read_jsonl(&flight_path);
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0]
                .get("subject")
                .and_then(|v| v.get("id"))
                .and_then(Value::as_str),
            Some("***")
        );
    }

    #[test]
    fn abac_allows_and_writes_hash_chain() {
        let root = tempdir().expect("tempdir");
        let policy_path = root
            .path()
            .join("client")
            .join("runtime")
            .join("config")
            .join("abac_policy_plane.json");
        ensure_parent(&policy_path).expect("policy parent");
        write_json_atomic(
            &policy_path,
            &json!({
                "version": "v1",
                "kind": "abac_policy_plane",
                "default_effect": "deny",
                "rules": [
                    {
                        "id": "allow_read_public",
                        "effect": "allow",
                        "action": ["read"],
                        "subject": {"role": ["operator"]},
                        "object": {"classification": ["public"]},
                        "context": {"env": ["prod"]}
                    }
                ],
                "flight_recorder": {
                    "immutable": true,
                    "hash_chain": true,
                    "redact_subject_fields": []
                }
            }),
        )
        .expect("write policy");

        let first = run_abac_policy_plane(
            root.path(),
            &[
                "evaluate".to_string(),
                "--action=read".to_string(),
                "--subject-role=operator".to_string(),
                "--subject-id=op-1".to_string(),
                "--object-classification=public".to_string(),
                "--context-env=prod".to_string(),
            ],
        );
        assert_eq!(first.1, 0);
        assert_eq!(
            first.0.get("decision").and_then(Value::as_str),
            Some("allow")
        );

        let second = run_abac_policy_plane(
            root.path(),
            &[
                "evaluate".to_string(),
                "--action=read".to_string(),
                "--subject-role=operator".to_string(),
                "--subject-id=op-2".to_string(),
                "--object-classification=public".to_string(),
                "--context-env=prod".to_string(),
            ],
        );
        assert_eq!(second.1, 0);

        let flight_path = root
            .path()
            .join("client")
            .join("runtime")
            .join("state")
            .join("security")
            .join("abac_flight_recorder.jsonl");
        let rows = read_jsonl(&flight_path);
        assert_eq!(rows.len(), 2);
        let first_hash = rows[0]
            .get("hash")
            .and_then(Value::as_str)
            .expect("first hash");
        assert_eq!(
            rows[1]
                .get("prev_hash")
                .and_then(Value::as_str)
                .unwrap_or(""),
            first_hash
        );
    }
}
