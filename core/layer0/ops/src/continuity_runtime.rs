// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::continuity_runtime (authoritative)
use crate::{client_state_root, deterministic_receipt_hash, now_iso};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const LANE_ID: &str = "continuity_runtime";

#[derive(Debug, Clone)]
struct ContinuityPolicy {
    max_state_bytes: usize,
    allow_degraded_restore: bool,
    allow_sessionless_resurrection: bool,
    require_vault_encryption: bool,
    vault_key_env: String,
}

#[path = "continuity_runtime_vault.rs"]
mod continuity_runtime_vault;
use continuity_runtime_vault::{vault_get_payload, vault_put_payload, vault_status_payload};

#[cfg(test)]
#[path = "continuity_runtime_tests.rs"]
mod tests;

fn usage() {
    println!("Usage:");
    println!(
        "  protheus-ops continuity-runtime resurrection-protocol <checkpoint|restore|status> [flags]"
    );
    println!("  protheus-ops continuity-runtime session-continuity-vault <put|get|status> [flags]");
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn receipt_hash(v: &Value) -> String {
    deterministic_receipt_hash(v)
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let with_eq = format!("--{key}=");
    let plain = format!("--{key}");
    let mut i = 0usize;
    while i < argv.len() {
        let token = argv[i].trim();
        if let Some(v) = token.strip_prefix(&with_eq) {
            return Some(v.trim().to_string());
        }
        if token == plain {
            if let Some(next) = argv.get(i + 1) {
                if !next.trim_start().starts_with("--") {
                    return Some(next.trim().to_string());
                }
            }
            return Some("true".to_string());
        }
        i += 1;
    }
    None
}

fn parse_bool(raw: Option<&str>, default: bool) -> bool {
    let Some(v) = raw else {
        return default;
    };
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => default,
    }
}

fn clean_id(raw: Option<&str>, fallback: &str) -> String {
    let mut out = String::new();
    if let Some(v) = raw {
        for ch in v.trim().chars() {
            if out.len() >= 96 {
                break;
            }
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.') {
                out.push(ch);
            } else {
                out.push('-');
            }
        }
    }
    let cleaned = out.trim_matches('-');
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned.to_string()
    }
}

fn parse_json(raw: Option<&str>) -> Result<Value, String> {
    let text = raw.ok_or_else(|| "missing_json_payload".to_string())?;
    serde_json::from_str::<Value>(text).map_err(|err| format!("invalid_json_payload:{err}"))
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent).map_err(|err| format!("mkdir_failed:{}:{err}", parent.display()))
}

fn write_json(path: &Path, payload: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let mut encoded =
        serde_json::to_string_pretty(payload).map_err(|err| format!("encode_failed:{err}"))?;
    encoded.push('\n');
    fs::write(path, encoded).map_err(|err| format!("write_failed:{}:{err}", path.display()))
}

fn append_jsonl(path: &Path, row: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let line = serde_json::to_string(row).map_err(|err| format!("encode_failed:{err}"))? + "\n";
    let mut opts = fs::OpenOptions::new();
    opts.create(true).append(true);
    use std::io::Write;
    let mut file = opts
        .open(path)
        .map_err(|err| format!("open_failed:{}:{err}", path.display()))?;
    file.write_all(line.as_bytes())
        .map_err(|err| format!("append_failed:{}:{err}", path.display()))
}

fn read_json(path: &Path) -> Option<Value> {
    let text = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&text).ok()
}

fn continuity_dir(root: &Path) -> PathBuf {
    client_state_root(root).join("continuity")
}

fn checkpoints_dir(root: &Path) -> PathBuf {
    continuity_dir(root).join("checkpoints")
}

fn checkpoint_index_path(root: &Path) -> PathBuf {
    continuity_dir(root).join("checkpoint_index.json")
}

fn continuity_history_path(root: &Path) -> PathBuf {
    continuity_dir(root).join("history.jsonl")
}

fn continuity_restore_path(root: &Path) -> PathBuf {
    continuity_dir(root).join("restored").join("latest.json")
}

fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| path.to_string_lossy().replace('\\', "/"))
}

fn default_policy() -> ContinuityPolicy {
    ContinuityPolicy {
        max_state_bytes: 512 * 1024,
        allow_degraded_restore: false,
        allow_sessionless_resurrection: true,
        require_vault_encryption: true,
        vault_key_env: "PROTHEUS_CONTINUITY_VAULT_KEY".to_string(),
    }
}

fn policy_path(root: &Path) -> PathBuf {
    root.join("client")
        .join("runtime")
        .join("config")
        .join("continuity_policy.json")
}

fn load_policy(root: &Path) -> ContinuityPolicy {
    let mut policy = default_policy();
    let path = policy_path(root);
    if let Some(v) = read_json(&path) {
        policy.max_state_bytes = v
            .get("max_state_bytes")
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .filter(|n| *n >= 256)
            .unwrap_or(policy.max_state_bytes);
        policy.allow_degraded_restore = v
            .get("allow_degraded_restore")
            .and_then(Value::as_bool)
            .unwrap_or(policy.allow_degraded_restore);
        policy.allow_sessionless_resurrection = v
            .get("allow_sessionless_resurrection")
            .and_then(Value::as_bool)
            .unwrap_or(policy.allow_sessionless_resurrection);
        policy.require_vault_encryption = v
            .get("require_vault_encryption")
            .and_then(Value::as_bool)
            .unwrap_or(policy.require_vault_encryption);
        policy.vault_key_env = v
            .get("vault_key_env")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(policy.vault_key_env.as_str())
            .to_string();
    }
    policy
}

fn normalized_state(state: Value) -> Value {
    let mut map = state.as_object().cloned().unwrap_or_default();
    map.entry("attention_queue".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    map.entry("memory_graph".to_string())
        .or_insert_with(|| Value::Object(Map::new()));
    map.entry("active_personas".to_string())
        .or_insert_with(|| Value::Array(Vec::new()));
    Value::Object(map)
}

fn is_degraded_state(state: &Value) -> bool {
    let obj = state.as_object();
    let has_attention = obj
        .and_then(|m| m.get("attention_queue"))
        .and_then(Value::as_array);
    let has_graph = obj
        .and_then(|m| m.get("memory_graph"))
        .and_then(Value::as_object);
    let has_personas = obj
        .and_then(|m| m.get("active_personas"))
        .and_then(Value::as_array);
    has_attention.is_none() || has_graph.is_none() || has_personas.is_none()
}

fn checkpoint_index(root: &Path) -> BTreeMap<String, String> {
    let path = checkpoint_index_path(root);
    let mut out = BTreeMap::new();
    if let Some(v) = read_json(&path).and_then(|row| row.as_object().cloned()) {
        for (k, v) in v {
            if let Some(s) = v.as_str() {
                out.insert(k, s.to_string());
            }
        }
    }
    out
}

fn write_checkpoint_index(root: &Path, index: &BTreeMap<String, String>) -> Result<(), String> {
    let mut map = Map::new();
    for (k, v) in index {
        map.insert(k.clone(), Value::String(v.clone()));
    }
    write_json(&checkpoint_index_path(root), &Value::Object(map))
}

fn checkpoint_payload(
    root: &Path,
    policy: &ContinuityPolicy,
    argv: &[String],
) -> Result<Value, String> {
    let session_id = clean_id(parse_flag(argv, "session-id").as_deref(), "session-default");
    let state_raw = parse_flag(argv, "state-json")
        .map(|raw| parse_json(Some(raw.as_str())))
        .transpose()?
        .unwrap_or_else(|| {
            json!({
                "attention_queue": [],
                "memory_graph": {},
                "active_personas": []
            })
        });
    let state = normalized_state(state_raw);
    let state_encoded =
        serde_json::to_vec(&state).map_err(|err| format!("state_encode_failed:{err}"))?;
    if state_encoded.len() > policy.max_state_bytes {
        return Err(format!(
            "state_too_large:{}>{}",
            state_encoded.len(),
            policy.max_state_bytes
        ));
    }
    let degraded = is_degraded_state(&state);
    let apply = parse_bool(parse_flag(argv, "apply").as_deref(), true);
    let ts = now_iso();
    let checkpoint_name = format!(
        "{}_{}.json",
        session_id,
        ts.replace([':', '.'], "-")
            .replace('T', "_")
            .replace('Z', "")
    );
    let checkpoint_path = checkpoints_dir(root).join(checkpoint_name);
    let state_sha = hex::encode(Sha256::digest(&state_encoded));

    if apply {
        let row = json!({
            "session_id": session_id,
            "ts": ts,
            "state": state,
            "state_sha256": state_sha,
            "degraded": degraded,
            "lane": LANE_ID,
            "type": "continuity_checkpoint"
        });
        write_json(&checkpoint_path, &row)?;

        let mut index = checkpoint_index(root);
        index.insert(
            clean_id(Some(session_id.as_str()), "session-default"),
            rel_path(root, &checkpoint_path),
        );
        write_checkpoint_index(root, &index)?;
        append_jsonl(
            &continuity_history_path(root),
            &json!({
                "type": "continuity_checkpoint",
                "session_id": session_id,
                "path": rel_path(root, &checkpoint_path),
                "ts": ts,
                "state_sha256": state_sha,
                "degraded": degraded
            }),
        )?;
    }

    let mut out = json!({
        "ok": true,
        "type": "resurrection_protocol_checkpoint",
        "lane": LANE_ID,
        "session_id": session_id,
        "apply": apply,
        "degraded": degraded,
        "state_bytes": state_encoded.len(),
        "state_sha256": state_sha,
        "checkpoint_path": rel_path(root, &checkpoint_path),
        "policy": {
            "max_state_bytes": policy.max_state_bytes,
            "allow_degraded_restore": policy.allow_degraded_restore,
            "allow_sessionless_resurrection": policy.allow_sessionless_resurrection
        },
        "claim_evidence": [
            {
                "id": "checkpoint_with_deterministic_receipt",
                "claim": "session_state_is_checkpointed_with_integrity_hash",
                "evidence": {
                    "session_id": session_id,
                    "state_sha256": state_sha,
                    "checkpoint_path": rel_path(root, &checkpoint_path)
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    Ok(out)
}

fn restore_payload(
    root: &Path,
    policy: &ContinuityPolicy,
    argv: &[String],
) -> Result<Value, String> {
    let session_id = clean_id(parse_flag(argv, "session-id").as_deref(), "session-default");
    let allow_degraded = parse_bool(
        parse_flag(argv, "allow-degraded").as_deref(),
        policy.allow_degraded_restore,
    );
    let apply = parse_bool(parse_flag(argv, "apply").as_deref(), true);

    let checkpoint_path = if let Some(raw) = parse_flag(argv, "checkpoint-path") {
        let p = PathBuf::from(raw.trim());
        if p.is_absolute() {
            p
        } else {
            root.join(p)
        }
    } else {
        let index = checkpoint_index(root);
        match index.get(&session_id) {
            Some(rel) => root.join(rel),
            None => {
                if policy.allow_sessionless_resurrection {
                    let mut out = json!({
                        "ok": true,
                        "type": "resurrection_protocol_restore",
                        "lane": LANE_ID,
                        "session_id": session_id,
                        "sessionless": true,
                        "degraded": true,
                        "policy_gate": "allow_sessionless_resurrection",
                        "restored_state": {
                            "attention_queue": [],
                            "memory_graph": {},
                            "active_personas": []
                        }
                    });
                    out["receipt_hash"] = Value::String(receipt_hash(&out));
                    return Ok(out);
                }
                return Err("checkpoint_not_found".to_string());
            }
        }
    };

    let checkpoint = read_json(&checkpoint_path).ok_or_else(|| {
        format!(
            "checkpoint_missing:{}",
            rel_path(root, checkpoint_path.as_path())
        )
    })?;
    let state = checkpoint
        .get("state")
        .cloned()
        .ok_or_else(|| "checkpoint_state_missing".to_string())?;
    let degraded = is_degraded_state(&state);
    if degraded && !allow_degraded {
        return Err("degraded_restore_blocked_by_policy".to_string());
    }

    if apply {
        write_json(
            &continuity_restore_path(root),
            &json!({
                "session_id": session_id,
                "restored_at": now_iso(),
                "checkpoint_path": rel_path(root, &checkpoint_path),
                "degraded": degraded,
                "state": state
            }),
        )?;
    }

    let mut out = json!({
        "ok": true,
        "type": "resurrection_protocol_restore",
        "lane": LANE_ID,
        "session_id": session_id,
        "apply": apply,
        "checkpoint_path": rel_path(root, &checkpoint_path),
        "degraded": degraded,
        "allow_degraded": allow_degraded,
        "restored_state": state,
        "claim_evidence": [
            {
                "id": "restore_with_layer0_gate",
                "claim": "restore_fails_closed_on_degraded_state_unless_policy_allows",
                "evidence": {
                    "allow_degraded": allow_degraded,
                    "degraded": degraded,
                    "checkpoint_path": rel_path(root, &checkpoint_path)
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    Ok(out)
}

fn continuity_status_payload(root: &Path, policy: &ContinuityPolicy) -> Value {
    let index = checkpoint_index(root);
    let latest_restore = read_json(&continuity_restore_path(root));
    let mut out = json!({
        "ok": true,
        "type": "continuity_runtime_status",
        "lane": LANE_ID,
        "checkpoint_sessions": index.len(),
        "checkpoint_index": index,
        "latest_restore": latest_restore,
        "policy": {
            "max_state_bytes": policy.max_state_bytes,
            "allow_degraded_restore": policy.allow_degraded_restore,
            "allow_sessionless_resurrection": policy.allow_sessionless_resurrection,
            "require_vault_encryption": policy.require_vault_encryption,
            "vault_key_env": policy.vault_key_env
        }
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn cli_error(argv: &[String], err: &str, exit_code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "continuity_runtime_cli_error",
        "lane": LANE_ID,
        "ts": now_iso(),
        "argv": argv,
        "error": err,
        "exit_code": exit_code,
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    if argv.is_empty() {
        usage();
        print_json_line(&cli_error(argv, "missing_surface", 2));
        return 2;
    }

    let policy = load_policy(root);
    let surface = argv[0].trim().to_ascii_lowercase();
    let command = argv
        .get(1)
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    let result = match (surface.as_str(), command.as_str()) {
        ("resurrection-protocol", "checkpoint")
        | ("resurrection-protocol", "bundle")
        | ("resurrection-protocol", "run")
        | ("resurrection-protocol", "build") => checkpoint_payload(root, &policy, &argv[2..]),
        ("resurrection-protocol", "restore") => restore_payload(root, &policy, &argv[2..]),
        ("resurrection-protocol", "status") | ("resurrection-protocol", "verify") => {
            Ok(continuity_status_payload(root, &policy))
        }
        ("session-continuity-vault", "put") | ("session-continuity-vault", "archive") => {
            vault_put_payload(root, &policy, &argv[2..])
        }
        ("session-continuity-vault", "get") | ("session-continuity-vault", "restore") => {
            vault_get_payload(root, &policy, &argv[2..])
        }
        ("session-continuity-vault", "status") | ("session-continuity-vault", "verify") => {
            Ok(vault_status_payload(root, &policy))
        }
        _ => Err("unknown_command".to_string()),
    };

    match result {
        Ok(payload) => {
            let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(false);
            print_json_line(&payload);
            if ok {
                0
            } else {
                1
            }
        }
        Err(err) => {
            if err == "unknown_command" {
                usage();
            }
            print_json_line(&cli_error(argv, &err, 2));
            2
        }
    }
}
