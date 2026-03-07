// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso};
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone)]
struct PersonaAmbientPolicy {
    enabled: bool,
    ambient_stance: bool,
    auto_apply: bool,
    full_reload: bool,
    push_attention_queue: bool,
    cache_path: PathBuf,
    latest_path: PathBuf,
    receipts_path: PathBuf,
    max_personas: usize,
    max_patch_bytes: usize,
}

fn usage() {
    eprintln!("Usage:");
    eprintln!(
        "  protheus-ops persona-ambient apply --persona=<id> --stance-json-base64=<base64-json> [--source=<value>] [--reason=<value>] [--run-context=<value>] [--full-reload=1|0]"
    );
    eprintln!("  protheus-ops persona-ambient apply --persona=<id> --stance-json=<json-object> [flags]");
    eprintln!("  protheus-ops persona-ambient status [--persona=<id>]");
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut raw) = serde_json::to_string_pretty(value) {
        raw.push('\n');
        let _ = fs::write(path, raw);
    }
}

fn append_jsonl(path: &Path, row: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(line) = serde_json::to_string(row) {
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| std::io::Write::write_all(&mut file, format!("{line}\n").as_bytes()));
    }
}

fn parse_cli_flags(argv: &[String]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut i = 0usize;
    while i < argv.len() {
        let token = argv[i].trim();
        if !token.starts_with("--") {
            i += 1;
            continue;
        }
        if let Some((k, v)) = token.split_once('=') {
            out.insert(k.trim_start_matches("--").to_string(), v.to_string());
            i += 1;
            continue;
        }
        let key = token.trim_start_matches("--").to_string();
        if let Some(next) = argv.get(i + 1) {
            if !next.starts_with("--") {
                out.insert(key, next.clone());
                i += 2;
                continue;
            }
        }
        out.insert(key, "true".to_string());
        i += 1;
    }
    out
}

fn bool_from_env(name: &str) -> Option<bool> {
    let raw = std::env::var(name).ok()?;
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
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

fn clean_text(value: Option<&str>, max_len: usize) -> String {
    let mut out = String::new();
    if let Some(raw) = value {
        for ch in raw.split_whitespace().collect::<Vec<_>>().join(" ").chars() {
            if out.len() >= max_len {
                break;
            }
            out.push(ch);
        }
    }
    out.trim().to_string()
}

fn sanitize_persona_id(raw: Option<&str>) -> String {
    let mut out = String::new();
    for ch in clean_text(raw, 120).chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.') {
            out.push(ch.to_ascii_lowercase());
        }
    }
    out.trim_matches('_').trim_matches('-').to_string()
}

fn normalize_path(root: &Path, value: Option<&Value>, fallback: &str) -> PathBuf {
    let raw = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback);
    let candidate = PathBuf::from(raw);
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

fn load_policy(root: &Path) -> PersonaAmbientPolicy {
    let default_policy = root.join("config").join("mech_suit_mode_policy.json");
    let policy_path = std::env::var("MECH_SUIT_MODE_POLICY_PATH")
        .ok()
        .map(PathBuf::from)
        .map(|p| if p.is_absolute() { p } else { root.join(p) })
        .unwrap_or(default_policy);
    let policy = read_json(&policy_path).unwrap_or_else(|| json!({}));
    let enabled = bool_from_env("MECH_SUIT_MODE_FORCE")
        .unwrap_or_else(|| policy.get("enabled").and_then(Value::as_bool).unwrap_or(true));
    let personas = policy.get("personas");
    let eyes = policy.get("eyes");

    PersonaAmbientPolicy {
        enabled,
        ambient_stance: personas
            .and_then(|v| v.get("ambient_stance"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        auto_apply: personas
            .and_then(|v| v.get("auto_apply"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        full_reload: personas
            .and_then(|v| v.get("full_reload"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        push_attention_queue: eyes
            .and_then(|v| v.get("push_attention_queue"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        cache_path: normalize_path(
            root,
            personas.and_then(|v| v.get("cache_path")),
            "state/personas/ambient_stance/cache.json",
        ),
        latest_path: normalize_path(
            root,
            personas.and_then(|v| v.get("latest_path")),
            "state/personas/ambient_stance/latest.json",
        ),
        receipts_path: normalize_path(
            root,
            personas.and_then(|v| v.get("receipts_path")),
            "state/personas/ambient_stance/receipts.jsonl",
        ),
        max_personas: personas
            .and_then(|v| v.get("max_personas"))
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(256)
            .clamp(1, 10_000),
        max_patch_bytes: personas
            .and_then(|v| v.get("max_patch_bytes"))
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(64 * 1024)
            .clamp(256, 8 * 1024 * 1024),
    }
}

fn parse_stance(flags: &BTreeMap<String, String>) -> Result<Value, String> {
    if let Some(raw) = flags.get("stance-json-base64") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw.as_bytes())
            .map_err(|err| format!("stance_json_base64_invalid:{err}"))?;
        let text = String::from_utf8(bytes).map_err(|err| format!("stance_json_utf8_invalid:{err}"))?;
        let value = serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("stance_json_invalid:{err}"))?;
        return Ok(value);
    }
    if let Some(raw) = flags.get("stance-json") {
        let value = serde_json::from_str::<Value>(raw)
            .map_err(|err| format!("stance_json_invalid:{err}"))?;
        return Ok(value);
    }
    if let Some(raw) = flags.get("stance-file") {
        let path = PathBuf::from(raw);
        let content = fs::read_to_string(path).map_err(|err| format!("stance_file_read_failed:{err}"))?;
        let value = serde_json::from_str::<Value>(&content)
            .map_err(|err| format!("stance_file_json_invalid:{err}"))?;
        return Ok(value);
    }
    Err("missing_stance_json".to_string())
}

fn default_cache() -> Value {
    json!({
        "schema_id": "persona_ambient_stance_cache",
        "schema_version": "1.0",
        "ts": now_iso(),
        "ambient_mode_active": true,
        "personas": {}
    })
}

fn as_object_mut(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().expect("object")
}

fn load_cache(path: &Path) -> Value {
    let mut cache = read_json(path).unwrap_or_else(default_cache);
    if !cache.is_object() {
        cache = default_cache();
    }
    if !cache
        .get("personas")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        cache["personas"] = Value::Object(Map::new());
    }
    cache
}

fn parse_json_payload(stdout: &str) -> Option<Value> {
    let raw = stdout.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(payload) = serde_json::from_str::<Value>(raw) {
        return Some(payload);
    }
    for line in raw.lines().rev() {
        let trimmed = line.trim();
        if !trimmed.starts_with('{') {
            continue;
        }
        if let Ok(payload) = serde_json::from_str::<Value>(trimmed) {
            return Some(payload);
        }
    }
    None
}

fn repo_root_from_current_dir() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn resolve_protheus_ops_command(root: &PathBuf, domain: &str) -> (String, Vec<String>) {
    let explicit = std::env::var("PROTHEUS_OPS_BIN").ok();
    if let Some(bin) = explicit {
        let trimmed = bin.trim();
        if !trimmed.is_empty() {
            return (trimmed.to_string(), vec![domain.to_string()]);
        }
    }

    let release = root.join("target").join("release").join("protheus-ops");
    if release.exists() {
        return (
            release.to_string_lossy().to_string(),
            vec![domain.to_string()],
        );
    }
    let debug = root.join("target").join("debug").join("protheus-ops");
    if debug.exists() {
        return (debug.to_string_lossy().to_string(), vec![domain.to_string()]);
    }

    (
        "cargo".to_string(),
        vec![
            "run".to_string(),
            "--quiet".to_string(),
            "--manifest-path".to_string(),
            "crates/ops/Cargo.toml".to_string(),
            "--bin".to_string(),
            "protheus-ops".to_string(),
            "--".to_string(),
            domain.to_string(),
        ],
    )
}

fn enqueue_attention(persona: &str, patch_hash: &str, run_context: &str) -> Result<Value, String> {
    let root = repo_root_from_current_dir();
    let event = json!({
        "ts": now_iso(),
        "source": "persona_ambient",
        "source_type": "persona_stance_apply",
        "severity": "info",
        "summary": format!("persona ambient stance apply ({persona})"),
        "attention_key": format!("persona_stance:{persona}:{patch_hash}"),
        "persona": persona,
        "patch_hash": patch_hash
    });

    let payload = serde_json::to_string(&event)
        .map_err(|err| format!("attention_event_encode_failed:{err}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(payload.as_bytes());

    let (command, mut args) = resolve_protheus_ops_command(&root, "attention-queue");
    args.push("enqueue".to_string());
    args.push(format!("--event-json-base64={encoded}"));
    args.push(format!("--run-context={run_context}"));

    let output = Command::new(&command)
        .args(&args)
        .current_dir(&root)
        .env(
            "PROTHEUS_NODE_BINARY",
            std::env::var("PROTHEUS_NODE_BINARY").unwrap_or_else(|_| "node".to_string()),
        )
        .output()
        .map_err(|err| format!("attention_queue_spawn_failed:{err}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(1);
    let mut receipt = parse_json_payload(&stdout).unwrap_or_else(|| {
        json!({
            "ok": false,
            "type": "attention_queue_enqueue_error",
            "reason": "attention_queue_empty_payload",
            "exit_code": exit_code,
            "stderr": clean_text(Some(&stderr), 280)
        })
    });

    if !receipt.is_object() {
        receipt = json!({
            "ok": false,
            "type": "attention_queue_enqueue_error",
            "reason": "attention_queue_invalid_payload",
            "exit_code": exit_code,
            "stderr": clean_text(Some(&stderr), 280)
        });
    }
    receipt["bridge_exit_code"] = Value::Number((exit_code as i64).into());
    if !stderr.trim().is_empty() {
        receipt["bridge_stderr"] = Value::String(clean_text(Some(&stderr), 280));
    }

    let decision = receipt
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let accepted = matches!(decision, "admitted" | "deduped" | "disabled");

    if exit_code != 0 && !accepted {
        return Err(format!("attention_queue_enqueue_failed:{decision}"));
    }
    Ok(receipt)
}

fn policy_snapshot(policy: &PersonaAmbientPolicy) -> Value {
    json!({
        "enabled": policy.enabled,
        "ambient_stance": policy.ambient_stance,
        "auto_apply": policy.auto_apply,
        "full_reload": policy.full_reload,
        "push_attention_queue": policy.push_attention_queue,
        "cache_path": policy.cache_path.to_string_lossy().to_string(),
        "latest_path": policy.latest_path.to_string_lossy().to_string(),
        "receipts_path": policy.receipts_path.to_string_lossy().to_string(),
        "max_personas": policy.max_personas,
        "max_patch_bytes": policy.max_patch_bytes
    })
}

fn emit(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"type\":\"persona_ambient_encode_failed\"}".to_string())
    );
}

fn fail_receipt(
    policy: &PersonaAmbientPolicy,
    command: &str,
    reason: &str,
    detail: Option<Value>,
) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "persona_ambient_error",
        "ts": now_iso(),
        "command": command,
        "reason": reason,
        "ambient_mode_active": policy.enabled && policy.ambient_stance,
        "policy": policy_snapshot(policy)
    });
    if let Some(extra) = detail {
        out["detail"] = extra;
    }
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn stance_diff(
    current: &Map<String, Value>,
    patch: &Map<String, Value>,
    full_reload: bool,
) -> (Map<String, Value>, Vec<String>, Vec<String>) {
    if full_reload {
        let mut changed = Vec::new();
        for (k, v) in patch {
            if current.get(k) != Some(v) {
                changed.push(k.clone());
            }
        }
        let mut removed = Vec::new();
        for key in current.keys() {
            if !patch.contains_key(key) {
                removed.push(key.clone());
            }
        }
        return (patch.clone(), changed, removed);
    }

    let mut next = current.clone();
    let mut changed = Vec::new();
    let mut removed = Vec::new();

    for (key, value) in patch {
        if value.is_null() {
            if next.remove(key).is_some() {
                removed.push(key.clone());
            }
            continue;
        }
        if next.get(key) != Some(value) {
            next.insert(key.clone(), value.clone());
            changed.push(key.clone());
        }
    }

    (next, changed, removed)
}

fn apply(root: &Path, flags: &BTreeMap<String, String>) -> i32 {
    let policy = load_policy(root);
    if !policy.enabled || !policy.ambient_stance {
        let receipt = fail_receipt(
            &policy,
            "apply",
            "ambient_persona_stance_disabled",
            None,
        );
        emit(&receipt);
        return 2;
    }
    if !policy.auto_apply {
        let receipt = fail_receipt(
            &policy,
            "apply",
            "auto_apply_disabled",
            None,
        );
        emit(&receipt);
        return 2;
    }

    let persona = sanitize_persona_id(flags.get("persona").map(String::as_str));
    if persona.is_empty() {
        let receipt = fail_receipt(&policy, "apply", "persona_missing_or_invalid", None);
        emit(&receipt);
        return 2;
    }

    let stance = match parse_stance(flags) {
        Ok(v) => v,
        Err(reason) => {
            let receipt = fail_receipt(&policy, "apply", &reason, None);
            emit(&receipt);
            return 2;
        }
    };
    let Value::Object(patch_map) = stance else {
        let receipt = fail_receipt(
            &policy,
            "apply",
            "stance_patch_must_be_object",
            None,
        );
        emit(&receipt);
        return 2;
    };

    let full_reload_requested = parse_bool(
        flags.get("full-reload").map(String::as_str),
        false,
    );
    if full_reload_requested && !policy.full_reload {
        let receipt = fail_receipt(
            &policy,
            "apply",
            "full_reload_disabled_in_ambient_mode",
            None,
        );
        emit(&receipt);
        return 2;
    }

    let patch_bytes = serde_json::to_string(&Value::Object(patch_map.clone()))
        .map(|v| v.len())
        .unwrap_or(0);
    if patch_bytes > policy.max_patch_bytes {
        let receipt = fail_receipt(
            &policy,
            "apply",
            "stance_patch_exceeds_budget",
            Some(json!({
                "patch_bytes": patch_bytes,
                "max_patch_bytes": policy.max_patch_bytes
            })),
        );
        emit(&receipt);
        return 2;
    }

    let source = clean_text(flags.get("source").map(String::as_str), 80);
    let reason = clean_text(flags.get("reason").map(String::as_str), 180);
    let run_context = clean_text(flags.get("run-context").map(String::as_str), 40);
    let run_context = if run_context.is_empty() {
        "persona_ambient".to_string()
    } else {
        run_context
    };

    let patch_hash = deterministic_receipt_hash(&json!({
        "persona": persona,
        "patch": patch_map
    }));

    let queue_receipt = if policy.push_attention_queue {
        match enqueue_attention(&persona, &patch_hash, &run_context) {
            Ok(v) => v,
            Err(reason) => {
                let receipt = fail_receipt(&policy, "apply", &reason, None);
                emit(&receipt);
                return 2;
            }
        }
    } else {
        json!({
            "ok": true,
            "type": "attention_queue_enqueue",
            "decision": "disabled",
            "queued": false
        })
    };

    let queue_decision = queue_receipt
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let queue_allowed = matches!(queue_decision.as_str(), "admitted" | "deduped" | "disabled");
    if !queue_allowed {
        let receipt = fail_receipt(
            &policy,
            "apply",
            "attention_queue_blocked_stance_apply",
            Some(json!({
                "queue_decision": queue_decision,
                "attention_receipt": queue_receipt
            })),
        );
        emit(&receipt);
        return 2;
    }

    let mut cache = load_cache(&policy.cache_path);
    let personas_value = cache
        .get_mut("personas")
        .expect("personas object missing after load");
    let personas_map = as_object_mut(personas_value);

    let is_new_persona = !personas_map.contains_key(&persona);
    if is_new_persona && personas_map.len() >= policy.max_personas {
        let receipt = fail_receipt(
            &policy,
            "apply",
            "persona_cache_capacity_exceeded",
            Some(json!({
                "max_personas": policy.max_personas
            })),
        );
        emit(&receipt);
        return 2;
    }

    let previous_entry = personas_map
        .get(&persona)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let previous_stance = previous_entry
        .get("stance")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let previous_revision = previous_entry
        .get("revision")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let (next_stance, changed_keys, removed_keys) =
        stance_diff(&previous_stance, &patch_map, full_reload_requested);
    let delta_applied = !changed_keys.is_empty() || !removed_keys.is_empty() || is_new_persona;
    let next_revision = if delta_applied {
        previous_revision + 1
    } else {
        previous_revision
    };

    let ts = now_iso();
    personas_map.insert(
        persona.clone(),
        json!({
            "persona": persona,
            "stance": next_stance,
            "revision": next_revision,
            "last_applied_at": ts,
            "last_source": if source.is_empty() { Value::Null } else { Value::String(source.clone()) },
            "last_reason": if reason.is_empty() { Value::Null } else { Value::String(reason.clone()) },
            "last_attention_decision": queue_decision,
            "last_patch_hash": patch_hash
        }),
    );

    cache["ts"] = Value::String(ts.clone());
    cache["ambient_mode_active"] = Value::Bool(policy.enabled && policy.ambient_stance);
    cache["authoritative_lane"] = Value::String("rust_persona_ambient".to_string());

    write_json(&policy.cache_path, &cache);

    let mut receipt = json!({
        "ok": true,
        "type": "persona_ambient_apply",
        "ts": ts,
        "ambient_mode_active": policy.enabled && policy.ambient_stance,
        "authoritative_lane": "rust_persona_ambient",
        "run_context": run_context,
        "persona": persona,
        "incremental_apply": true,
        "full_reload_requested": full_reload_requested,
        "full_reload_allowed": policy.full_reload,
        "delta_applied": delta_applied,
        "delta": {
            "changed_keys": changed_keys,
            "removed_keys": removed_keys
        },
        "revision": next_revision,
        "stance_key_count": cache
            .pointer(&format!("/personas/{}/stance", sanitize_json_pointer_key(&persona)))
            .and_then(Value::as_object)
            .map(|obj| obj.len())
            .unwrap_or(0),
        "patch_bytes": patch_bytes,
        "attention_queue": queue_receipt,
        "policy": policy_snapshot(&policy)
    });
    receipt["receipt_hash"] = Value::String(deterministic_receipt_hash(&receipt));

    write_json(&policy.latest_path, &receipt);
    append_jsonl(&policy.receipts_path, &receipt);
    emit(&receipt);
    0
}

fn sanitize_json_pointer_key(raw: &str) -> String {
    raw.replace('~', "~0").replace('/', "~1")
}

fn status(root: &Path, flags: &BTreeMap<String, String>) -> i32 {
    let policy = load_policy(root);
    let persona = sanitize_persona_id(flags.get("persona").map(String::as_str));
    let cache = load_cache(&policy.cache_path);
    let latest = read_json(&policy.latest_path).unwrap_or_else(|| json!({}));

    let persona_state = if persona.is_empty() {
        Value::Null
    } else {
        cache
            .pointer(&format!("/personas/{}", sanitize_json_pointer_key(&persona)))
            .cloned()
            .unwrap_or(Value::Null)
    };

    let mut out = json!({
        "ok": true,
        "type": "persona_ambient_status",
        "ts": now_iso(),
        "ambient_mode_active": policy.enabled && policy.ambient_stance,
        "authoritative_lane": "rust_persona_ambient",
        "auto_apply": policy.auto_apply,
        "full_reload_allowed": policy.full_reload,
        "push_attention_queue": policy.push_attention_queue,
        "policy": policy_snapshot(&policy),
        "persona": if persona.is_empty() { Value::Null } else { Value::String(persona) },
        "persona_state": persona_state,
        "cache": {
            "persona_count": cache
                .get("personas")
                .and_then(Value::as_object)
                .map(|obj| obj.len())
                .unwrap_or(0),
            "cache_path": policy.cache_path.to_string_lossy().to_string(),
            "latest_path": policy.latest_path.to_string_lossy().to_string(),
            "receipts_path": policy.receipts_path.to_string_lossy().to_string()
        },
        "latest": latest
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    emit(&out);
    0
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    if argv.is_empty() {
        usage();
        return 2;
    }
    let command = argv[0].trim().to_ascii_lowercase();
    let flags = parse_cli_flags(&argv[1..]);
    match command.as_str() {
        "apply" => apply(root, &flags),
        "status" => status(root, &flags),
        _ => {
            usage();
            let policy = load_policy(root);
            let mut out = json!({
                "ok": false,
                "type": "persona_ambient_error",
                "ts": now_iso(),
                "reason": "unknown_command",
                "command": command,
                "policy": policy_snapshot(&policy)
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            emit(&out);
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_policy(root: &Path, full_reload: bool) {
        let policy = json!({
            "enabled": true,
            "eyes": {
                "push_attention_queue": false
            },
            "personas": {
                "ambient_stance": true,
                "auto_apply": true,
                "full_reload": full_reload,
                "cache_path": "state/personas/ambient_stance/cache.json",
                "latest_path": "state/personas/ambient_stance/latest.json",
                "receipts_path": "state/personas/ambient_stance/receipts.jsonl",
                "max_personas": 8,
                "max_patch_bytes": 8192
            }
        });
        let path = root.join("config").join("mech_suit_mode_policy.json");
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        write_json(&path, &policy);
    }

    #[test]
    fn incremental_apply_merges_without_full_reload() {
        let dir = tempdir().expect("tempdir");
        write_policy(dir.path(), false);

        let first = json!({
            "risk_mode": "strict",
            "temperature": 0.2
        });
        let first_payload = base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_string(&first).expect("encode"));
        let code_a = run(
            dir.path(),
            &[
                "apply".to_string(),
                "--persona=guardian".to_string(),
                format!("--stance-json-base64={first_payload}"),
            ],
        );
        assert_eq!(code_a, 0);

        let second = json!({
            "temperature": 0.4,
            "risk_mode": Value::Null
        });
        let second_payload = base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_string(&second).expect("encode"));
        let code_b = run(
            dir.path(),
            &[
                "apply".to_string(),
                "--persona=guardian".to_string(),
                format!("--stance-json-base64={second_payload}"),
            ],
        );
        assert_eq!(code_b, 0);

        let cache = read_json(
            &dir.path()
                .join("state")
                .join("personas")
                .join("ambient_stance")
                .join("cache.json"),
        )
        .expect("cache exists");
        let stance = cache
            .pointer("/personas/guardian/stance")
            .and_then(Value::as_object)
            .expect("stance object");
        assert_eq!(stance.get("temperature"), Some(&json!(0.4)));
        assert!(stance.get("risk_mode").is_none());
    }

    #[test]
    fn full_reload_is_blocked_when_policy_disallows_it() {
        let dir = tempdir().expect("tempdir");
        write_policy(dir.path(), false);
        let payload = base64::engine::general_purpose::STANDARD.encode("{}");
        let code = run(
            dir.path(),
            &[
                "apply".to_string(),
                "--persona=guardian".to_string(),
                format!("--stance-json-base64={payload}"),
                "--full-reload=1".to_string(),
            ],
        );
        assert_eq!(code, 2);
    }
}
