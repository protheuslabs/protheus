// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::Utc;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::thread::sleep;
use std::time::{Duration, SystemTime};

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};

const WRITE_LOCK_TIMEOUT_MS: u64 = 8_000;
const WRITE_LOCK_RETRY_MS: u64 = 15;
const WRITE_LOCK_STALE_MS: u64 = 30_000;
const MISSING_HASH_SENTINEL: &str = "__missing__";

struct WriteLock {
    #[allow(dead_code)]
    file: fs::File,
    lock_path: PathBuf,
    waited_ms: u64,
}

fn usage() {
    println!("adaptive-layer-store-kernel commands:");
    println!("  protheus-ops adaptive-layer-store-kernel paths [--payload-base64=<json>]");
    println!("  protheus-ops adaptive-layer-store-kernel is-within-root --payload-base64=<json>");
    println!("  protheus-ops adaptive-layer-store-kernel resolve-path --payload-base64=<json>");
    println!("  protheus-ops adaptive-layer-store-kernel read-json --payload-base64=<json>");
    println!("  protheus-ops adaptive-layer-store-kernel ensure-json --payload-base64=<json>");
    println!("  protheus-ops adaptive-layer-store-kernel set-json --payload-base64=<json>");
    println!("  protheus-ops adaptive-layer-store-kernel delete-path --payload-base64=<json>");
}

fn cli_receipt(kind: &str, payload: Value) -> Value {
    let ts = now_iso();
    let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(true);
    let mut out = json!({
        "ok": ok,
        "type": kind,
        "ts": ts,
        "date": ts[..10].to_string(),
        "payload": payload,
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn cli_error(kind: &str, error: &str) -> Value {
    let ts = now_iso();
    let mut out = json!({
        "ok": false,
        "type": kind,
        "ts": ts,
        "date": ts[..10].to_string(),
        "error": error,
        "fail_closed": true,
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn payload_json(argv: &[String]) -> Result<Value, String> {
    if let Some(raw) = lane_utils::parse_flag(argv, "payload", false) {
        return serde_json::from_str::<Value>(&raw)
            .map_err(|err| format!("adaptive_layer_store_kernel_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("adaptive_layer_store_kernel_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("adaptive_layer_store_kernel_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("adaptive_layer_store_kernel_payload_decode_failed:{err}"));
    }
    Ok(json!({}))
}

fn payload_obj<'a>(value: &'a Value) -> &'a Map<String, Value> {
    value.as_object().unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(Map::new)
    })
}

fn as_str(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(v)) => v.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string().trim_matches('"').trim().to_string(),
    }
}

fn clean_text(value: Option<&Value>, max_len: usize) -> String {
    let mut out = as_str(value)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if out.len() > max_len {
        out.truncate(max_len);
    }
    out
}

fn normalize_path_string(raw: &str) -> String {
    raw.replace('\\', "/")
}

fn normalize_adaptive_rel(raw: &str) -> String {
    normalize_path_string(raw)
        .trim_start_matches("./")
        .trim_start_matches('/')
        .trim_start_matches("adaptive/")
        .split('/')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

fn relative_within(root_path: &Path, target_path: &Path) -> Option<String> {
    let rel = target_path
        .strip_prefix(root_path)
        .ok()?
        .to_string_lossy()
        .replace('\\', "/");
    if rel == ".." || rel.starts_with("../") {
        None
    } else {
        Some(rel)
    }
}

fn workspace_root(root: &Path, payload: &Map<String, Value>) -> PathBuf {
    let explicit = clean_text(payload.get("workspace_root"), 520);
    if !explicit.is_empty() {
        return PathBuf::from(explicit);
    }
    if let Ok(raw) = std::env::var("PROTHEUS_WORKSPACE_ROOT") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    root.to_path_buf()
}

fn runtime_root(root: &Path, payload: &Map<String, Value>) -> PathBuf {
    let explicit = clean_text(payload.get("runtime_root"), 520);
    if !explicit.is_empty() {
        return PathBuf::from(explicit);
    }
    if let Ok(raw) = std::env::var("PROTHEUS_RUNTIME_ROOT") {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    let workspace = workspace_root(root, payload);
    let candidate = workspace.join("client").join("runtime");
    if candidate.exists() {
        candidate
    } else {
        workspace
    }
}

fn adaptive_root(root: &Path, payload: &Map<String, Value>) -> PathBuf {
    runtime_root(root, payload).join("adaptive")
}

fn adaptive_runtime_root(root: &Path, payload: &Map<String, Value>) -> PathBuf {
    runtime_root(root, payload).join("local").join("adaptive")
}

fn mutation_log_path(root: &Path, payload: &Map<String, Value>) -> PathBuf {
    runtime_root(root, payload)
        .join("local")
        .join("state")
        .join("security")
        .join("adaptive_mutations.jsonl")
}

fn adaptive_pointers_path(root: &Path, payload: &Map<String, Value>) -> PathBuf {
    runtime_root(root, payload)
        .join("local")
        .join("state")
        .join("memory")
        .join("adaptive_pointers.jsonl")
}

fn adaptive_pointer_index_path(root: &Path, payload: &Map<String, Value>) -> PathBuf {
    runtime_root(root, payload)
        .join("local")
        .join("state")
        .join("memory")
        .join("adaptive_pointer_index.json")
}

fn runtime_adaptive_rel_allowed(rel: &str) -> bool {
    matches!(rel, "sensory/eyes/catalog.json" | "sensory/eyes/focus_triggers.json")
}

fn resolve_adaptive_path(root: &Path, payload: &Map<String, Value>, target_path: &str) -> Result<(PathBuf, String), String> {
    let raw = target_path.trim();
    if raw.is_empty() {
        return Err("adaptive_store: target must be file path under adaptive/".to_string());
    }
    let adaptive_root = adaptive_root(root, payload);
    let adaptive_runtime_root = adaptive_runtime_root(root, payload);
    let target = PathBuf::from(raw);

    if target.is_absolute() {
        let abs_path = target.canonicalize().unwrap_or(target.clone());
        if let Some(source_rel) = relative_within(&adaptive_root, &abs_path) {
            if source_rel.is_empty() {
                return Err("adaptive_store: target must be file path under adaptive/".to_string());
            }
            let rel = normalize_adaptive_rel(&source_rel);
            if runtime_adaptive_rel_allowed(&rel) {
                return Ok((adaptive_runtime_root.join(&rel), rel));
            }
            return Ok((abs_path, rel));
        }
        if let Some(runtime_rel) = relative_within(&adaptive_runtime_root, &abs_path) {
            if runtime_rel.is_empty() {
                return Err(format!("adaptive_store: target outside adaptive roots: {}", abs_path.display()));
            }
            let rel = normalize_adaptive_rel(&runtime_rel);
            if !runtime_adaptive_rel_allowed(&rel) {
                return Err(format!("adaptive_store: runtime path not allowed: {}", abs_path.display()));
            }
            return Ok((abs_path, rel));
        }
        return Err(format!("adaptive_store: target outside adaptive roots: {}", abs_path.display()));
    }

    let rel = normalize_adaptive_rel(raw);
    if rel.is_empty() {
        return Err("adaptive_store: target must be file path under adaptive/".to_string());
    }
    if runtime_adaptive_rel_allowed(&rel) {
        return Ok((adaptive_runtime_root.join(&rel), rel));
    }
    let abs = adaptive_root.join(&rel);
    let source_rel = relative_within(&adaptive_root, &abs)
        .ok_or_else(|| format!("adaptive_store: target outside adaptive root: {}", abs.display()))?;
    if source_rel.is_empty() {
        return Err(format!("adaptive_store: target outside adaptive root: {}", abs.display()));
    }
    Ok((abs, normalize_adaptive_rel(&source_rel)))
}

fn write_json_atomic(file_path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("adaptive_layer_store_kernel_create_dir_failed:{err}"))?;
    }
    let tmp_path = file_path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        Utc::now().timestamp_millis()
    ));
    fs::write(
        &tmp_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(value)
                .map_err(|err| format!("adaptive_layer_store_kernel_encode_failed:{err}"))?
        ),
    )
    .map_err(|err| format!("adaptive_layer_store_kernel_write_failed:{err}"))?;
    fs::rename(&tmp_path, file_path)
        .map_err(|err| format!("adaptive_layer_store_kernel_rename_failed:{err}"))?;
    Ok(())
}

fn lock_path_for(abs_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.write.lock", abs_path.to_string_lossy()))
}

fn acquire_write_lock(abs_path: &Path) -> Result<WriteLock, String> {
    let lock_path = lock_path_for(abs_path);
    if let Some(parent) = lock_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("adaptive_layer_store_kernel_lock_dir_failed:{err}"))?;
    }
    let started = std::time::Instant::now();
    loop {
        match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&lock_path)
        {
            Ok(mut file) => {
                let body = json!({
                    "pid": std::process::id(),
                    "ts": now_iso(),
                    "path": abs_path.to_string_lossy(),
                });
                let _ = file.write_all(format!("{}\n", serde_json::to_string(&body).unwrap_or_else(|_| "{}".to_string())).as_bytes());
                return Ok(WriteLock {
                    file,
                    lock_path,
                    waited_ms: started.elapsed().as_millis() as u64,
                });
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                let stale = fs::metadata(&lock_path)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|modified| SystemTime::now().duration_since(modified).ok())
                    .map(|elapsed| elapsed.as_millis() as u64 > WRITE_LOCK_STALE_MS)
                    .unwrap_or(false);
                if stale {
                    let _ = fs::remove_file(&lock_path);
                    continue;
                }
                if started.elapsed().as_millis() as u64 >= WRITE_LOCK_TIMEOUT_MS {
                    return Err(format!("adaptive_store: write lock timeout for {}", abs_path.display()));
                }
                sleep(Duration::from_millis(WRITE_LOCK_RETRY_MS));
            }
            Err(err) => {
                return Err(format!("adaptive_layer_store_kernel_lock_failed:{err}"));
            }
        }
    }
}

fn release_write_lock(lock: WriteLock) {
    let _ = fs::remove_file(lock.lock_path);
}

fn read_json_value(file_path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(file_path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn read_json_with_hash(file_path: &Path) -> (bool, Value, Option<String>) {
    if !file_path.exists() {
        return (false, Value::Null, None);
    }
    match read_json_value(file_path) {
        Some(value) => {
            let hash = canonical_hash(&value);
            (true, value, Some(hash))
        }
        None => (false, Value::Null, None),
    }
}

fn canonical_hash(value: &Value) -> String {
    let raw = serde_json::to_string(value).unwrap_or_else(|_| "null".to_string());
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn hash16(raw: &str) -> String {
    canonical_hash(&Value::String(raw.to_string()))[..16].to_string()
}

fn is_alnum(raw: &str) -> bool {
    !raw.is_empty() && raw.chars().all(|ch| ch.is_ascii_alphanumeric())
}

fn normalize_tag(raw: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in raw.chars() {
        let lower = ch.to_ascii_lowercase();
        let keep = matches!(lower, 'a'..='z' | '0'..='9' | '_' | '-');
        if keep {
            out.push(lower);
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
        if out.len() >= 32 {
            break;
        }
    }
    out.trim_matches('-').to_string()
}

fn stable_uid(seed: &str, prefix: &str, length: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let digest = hasher.finalize();
    let mut hex = String::new();
    for byte in digest {
        hex.push_str(&format!("{byte:02x}"));
    }
    let mut out = normalize_tag(prefix).replace('-', "");
    let body_len = length.saturating_sub(out.len()).max(8).min(hex.len());
    out.push_str(&hex[..body_len]);
    out.truncate(length.max(8).min(48));
    out
}

fn append_jsonl(file_path: &Path, row: &Value) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("adaptive_layer_store_kernel_create_dir_failed:{err}"))?;
    }
    let mut handle = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file_path)
        .map_err(|err| format!("adaptive_layer_store_kernel_append_open_failed:{err}"))?;
    handle
        .write_all(format!("{}\n", serde_json::to_string(row).unwrap_or_else(|_| "null".to_string())).as_bytes())
        .map_err(|err| format!("adaptive_layer_store_kernel_append_failed:{err}"))?;
    Ok(())
}

fn append_mutation_log(root: &Path, payload: &Map<String, Value>, event: &Value) {
    let path = mutation_log_path(root, payload);
    let _ = append_jsonl(&path, event);
}

fn meta_actor(meta: &Map<String, Value>) -> String {
    let value = clean_text(meta.get("actor"), 80);
    if value.is_empty() {
        std::env::var("USER").unwrap_or_else(|_| "unknown".to_string())
    } else {
        value
    }
}

fn meta_source(meta: &Map<String, Value>) -> String {
    clean_text(meta.get("source"), 120)
}

fn meta_reason(meta: &Map<String, Value>, fallback: &str) -> String {
    let value = clean_text(meta.get("reason"), 160);
    if value.is_empty() {
        fallback.to_string()
    } else {
        value
    }
}

fn pointer_index_load(root: &Path, payload: &Map<String, Value>) -> Value {
    let path = adaptive_pointer_index_path(root, payload);
    let value = read_json_value(&path).unwrap_or_else(|| json!({ "version": "1.0", "pointers": {} }));
    if value.get("pointers").and_then(Value::as_object).is_some() {
        value
    } else {
        json!({ "version": "1.0", "pointers": {} })
    }
}

fn pointer_index_save(root: &Path, payload: &Map<String, Value>, index: &Value) -> Result<(), String> {
    let path = adaptive_pointer_index_path(root, payload);
    write_json_atomic(&path, index)
}

fn append_adaptive_pointer_rows(root: &Path, payload: &Map<String, Value>, rows: &[Value]) -> Result<Value, String> {
    if rows.is_empty() {
        return Ok(json!({ "emitted": 0, "skipped": 0 }));
    }
    let mut index = pointer_index_load(root, payload);
    let pointers = index
        .get_mut("pointers")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "adaptive_layer_store_kernel_invalid_pointer_index".to_string())?;
    let path = adaptive_pointers_path(root, payload);
    let mut emitted = 0_u64;
    let mut skipped = 0_u64;
    for row in rows {
        let kind = clean_text(row.get("kind"), 120);
        let uid = clean_text(row.get("uid"), 120);
        let path_ref = clean_text(row.get("path_ref"), 240);
        let entity_id = clean_text(row.get("entity_id"), 120);
        let key = format!("{kind}|{uid}|{path_ref}|{entity_id}");
        let hash = hash16(
            &serde_json::to_string(&json!({
                "uid": row.get("uid").cloned().unwrap_or(Value::Null),
                "kind": row.get("kind").cloned().unwrap_or(Value::Null),
                "path_ref": row.get("path_ref").cloned().unwrap_or(Value::Null),
                "entity_id": row.get("entity_id").cloned().unwrap_or(Value::Null),
                "tags": row.get("tags").cloned().unwrap_or(Value::Null),
                "summary": row.get("summary").cloned().unwrap_or(Value::Null),
                "status": row.get("status").cloned().unwrap_or(Value::Null),
            }))
            .unwrap_or_else(|_| "{}".to_string()),
        );
        let existing = pointers.get(&key).and_then(Value::as_str).unwrap_or("");
        if existing == hash {
            skipped = skipped.saturating_add(1);
            continue;
        }
        append_jsonl(&path, row)?;
        pointers.insert(key, Value::String(hash));
        emitted = emitted.saturating_add(1);
    }
    let updated = json!({
        "version": "1.0",
        "updated_ts": now_iso(),
        "pointers": Value::Object(pointers.clone()),
    });
    pointer_index_save(root, payload, &updated)?;
    Ok(json!({ "emitted": emitted, "skipped": skipped }))
}

fn project_adaptive_pointers(rel_path: &str, obj: &Value, op: &str, meta: &Map<String, Value>) -> Vec<Value> {
    let ts = now_iso();
    let path_ref = format!("adaptive/{}", rel_path.replace('\\', "/"));
    let actor = meta_actor(meta);
    let source = meta_source(meta);
    let reason = meta_reason(meta, op);
    let mut rows = Vec::new();

    if rel_path == "sensory/eyes/catalog.json" {
        if let Some(eyes) = obj.get("eyes").and_then(Value::as_array) {
            for eye in eyes {
                let Some(eye_obj) = eye.as_object() else {
                    continue;
                };
                let eye_id = clean_text(eye_obj.get("id"), 64);
                let eye_uid_candidate = clean_text(eye_obj.get("uid"), 64);
                let eye_uid = if is_alnum(&eye_uid_candidate) {
                    eye_uid_candidate
                } else {
                    stable_uid(&format!("adaptive_eye|{eye_id}|v1"), "e", 24)
                };
                let topic_tags = eye_obj
                    .get("topics")
                    .and_then(Value::as_array)
                    .map(|rows| {
                        rows.iter()
                            .map(|row| normalize_tag(&clean_text(Some(row), 32)))
                            .filter(|row| !row.is_empty())
                            .take(8)
                            .collect::<Vec<_>>()
                    })
                    .unwrap_or_default();
                let mut tags = vec!["adaptive".to_string(), "sensory".to_string(), "eyes".to_string()];
                let status_tag = normalize_tag(&clean_text(eye_obj.get("status"), 24));
                if !status_tag.is_empty() {
                    tags.push(status_tag);
                }
                tags.extend(topic_tags);
                tags.sort();
                tags.dedup();
                let entity_id = if eye_id.is_empty() {
                    Value::Null
                } else {
                    Value::String(eye_id.clone())
                };
                let status = {
                    let status = clean_text(eye_obj.get("status"), 24);
                    if status.is_empty() {
                        "active".to_string()
                    } else {
                        status
                    }
                };
                let summary = {
                    let summary =
                        clean_text(eye_obj.get("name").or_else(|| eye_obj.get("id")), 160);
                    if summary.is_empty() {
                        "Adaptive eye".to_string()
                    } else {
                        summary
                    }
                };
                let created_ts = {
                    let created = clean_text(eye_obj.get("created_ts"), 40);
                    if created.is_empty() {
                        ts.clone()
                    } else {
                        created
                    }
                };
                rows.push(json!({
                    "ts": ts,
                    "op": op,
                    "source": "adaptive_layer_store",
                    "source_path": if source.is_empty() { Value::Null } else { Value::String(source.clone()) },
                    "reason": if reason.is_empty() { Value::Null } else { Value::String(reason.clone()) },
                    "actor": actor,
                    "kind": "adaptive_eye",
                    "layer": "sensory",
                    "uid": eye_uid,
                    "entity_id": entity_id,
                    "status": status,
                    "tags": tags,
                    "summary": summary,
                    "path_ref": path_ref,
                    "created_ts": created_ts,
                    "updated_ts": ts,
                }));
            }
            return rows;
        }
    }

    if let Some(obj_map) = obj.as_object() {
        let uid_candidate = clean_text(obj_map.get("uid"), 64);
        let uid = if is_alnum(&uid_candidate) {
            uid_candidate
        } else {
            stable_uid(&format!("adaptive_blob|{rel_path}|v1"), "a", 24)
        };
        let segments = rel_path
            .split('/')
            .filter(|segment| !segment.is_empty())
            .collect::<Vec<_>>();
        let layer = segments
            .first()
            .map(|segment| normalize_tag(segment))
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "adaptive".to_string());
        let kind = format!(
            "adaptive_{}",
            normalize_tag(&segments.join("_"))
                .trim_matches('-')
                .to_string()
        );
        rows.push(json!({
            "ts": ts,
            "op": op,
            "source": "adaptive_layer_store",
            "source_path": if source.is_empty() { Value::Null } else { Value::String(source) },
            "reason": if reason.is_empty() { Value::Null } else { Value::String(reason) },
            "actor": actor,
            "kind": if kind == "adaptive_" { "adaptive_blob".to_string() } else { kind },
            "layer": layer,
            "uid": uid,
            "entity_id": Value::Null,
            "status": "active",
            "tags": ["adaptive", layer],
            "summary": clean_text(Some(&Value::String(format!("Adaptive record: {rel_path}"))), 160),
            "path_ref": path_ref,
            "created_ts": ts,
            "updated_ts": ts,
        }));
    }
    rows
}

fn emit_adaptive_pointers(root: &Path, payload: &Map<String, Value>, rel_path: &str, obj: &Value, op: &str, meta: &Map<String, Value>) -> Value {
    let rows = project_adaptive_pointers(rel_path, obj, op, meta);
    append_adaptive_pointer_rows(root, payload, &rows).unwrap_or_else(|_| json!({ "emitted": 0, "skipped": 0 }))
}

fn paths_command(root: &Path, payload: &Map<String, Value>) -> Value {
    let workspace = workspace_root(root, payload);
    let runtime = runtime_root(root, payload);
    json!({
        "ok": true,
        "workspace_root": workspace.to_string_lossy(),
        "runtime_root": runtime.to_string_lossy(),
        "repo_root": runtime.to_string_lossy(),
        "adaptive_root": adaptive_root(root, payload).to_string_lossy(),
        "adaptive_runtime_root": adaptive_runtime_root(root, payload).to_string_lossy(),
        "mutation_log_path": mutation_log_path(root, payload).to_string_lossy(),
        "adaptive_pointers_path": adaptive_pointers_path(root, payload).to_string_lossy(),
        "adaptive_pointer_index_path": adaptive_pointer_index_path(root, payload).to_string_lossy(),
    })
}

fn is_within_root_command(root: &Path, payload: &Map<String, Value>) -> Value {
    let target = clean_text(payload.get("target_path"), 520);
    let within = resolve_adaptive_path(root, payload, &target).is_ok();
    json!({
        "ok": true,
        "target_path": target,
        "within": within,
    })
}

fn resolve_path_command(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let target = clean_text(payload.get("target_path"), 520);
    let (abs, rel) = resolve_adaptive_path(root, payload, &target)?;
    Ok(json!({
        "ok": true,
        "abs": abs.to_string_lossy(),
        "rel": rel,
    }))
}

fn read_json_command(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let fallback = payload.get("fallback").cloned().unwrap_or(Value::Null);
    let target = clean_text(payload.get("target_path"), 520);
    let (abs, rel) = resolve_adaptive_path(root, payload, &target)?;
    let (exists, value, current_hash) = read_json_with_hash(&abs);
    Ok(json!({
        "ok": true,
        "exists": exists,
        "path": abs.to_string_lossy(),
        "rel": rel,
        "value": if exists { value } else { fallback },
        "current_hash": current_hash,
    }))
}

fn ensure_json_command(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let target = clean_text(payload.get("target_path"), 520);
    let default_value = payload.get("default_value").cloned().unwrap_or_else(|| json!({}));
    let meta = payload
        .get("meta")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let (abs, rel) = resolve_adaptive_path(root, payload, &target)?;
    let lock = acquire_write_lock(&abs)?;
    let result = if let Some(existing) = read_json_value(&abs) {
        let current_hash = canonical_hash(&existing);
        json!({
            "ok": true,
            "created": false,
            "value": existing,
            "path": abs.to_string_lossy(),
            "rel": rel,
            "current_hash": current_hash,
            "lock_wait_ms": lock.waited_ms,
        })
    } else {
        write_json_atomic(&abs, &default_value)?;
        append_mutation_log(
            root,
            payload,
            &json!({
                "ts": now_iso(),
                "op": "ensure",
                "rel_path": rel,
                "actor": meta_actor(&meta),
                "source": meta_source(&meta),
                "reason": meta_reason(&meta, "ensure_default"),
                "lock_wait_ms": lock.waited_ms,
                "value_hash": canonical_hash(&default_value),
            }),
        );
        let pointer_stats = emit_adaptive_pointers(root, payload, &rel, &default_value, "ensure", &meta);
        json!({
            "ok": true,
            "created": true,
            "value": default_value,
            "path": abs.to_string_lossy(),
            "rel": rel,
            "current_hash": canonical_hash(&default_value),
            "lock_wait_ms": lock.waited_ms,
            "pointer_stats": pointer_stats,
        })
    };
    release_write_lock(lock);
    Ok(result)
}

fn set_json_command(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let target = clean_text(payload.get("target_path"), 520);
    let value = payload.get("value").cloned().unwrap_or(Value::Null);
    let meta = payload
        .get("meta")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let expected_hash = clean_text(payload.get("expected_hash"), 160);
    let (abs, rel) = resolve_adaptive_path(root, payload, &target)?;
    let lock = acquire_write_lock(&abs)?;
    let (exists, current_value, current_hash) = read_json_with_hash(&abs);

    let expected_missing = expected_hash == MISSING_HASH_SENTINEL;
    if !expected_hash.is_empty() {
        let conflict = if expected_missing {
            exists
        } else {
            current_hash.as_deref() != Some(expected_hash.as_str())
        };
        if conflict {
            let result = json!({
                "ok": true,
                "applied": false,
                "conflict": true,
                "path": abs.to_string_lossy(),
                "rel": rel,
                "current_hash": current_hash,
                "value": if exists { current_value } else { Value::Null },
                "lock_wait_ms": lock.waited_ms,
            });
            release_write_lock(lock);
            return Ok(result);
        }
    }

    write_json_atomic(&abs, &value)?;
    append_mutation_log(
        root,
        payload,
        &json!({
            "ts": now_iso(),
            "op": "set",
            "rel_path": rel,
            "actor": meta_actor(&meta),
            "source": meta_source(&meta),
            "reason": meta_reason(&meta, "mutate"),
            "lock_wait_ms": lock.waited_ms,
            "value_hash": canonical_hash(&value),
        }),
    );
    let pointer_stats = emit_adaptive_pointers(root, payload, &rel, &value, "set", &meta);
    let result = json!({
        "ok": true,
        "applied": true,
        "conflict": false,
        "value": value,
        "path": abs.to_string_lossy(),
        "rel": rel,
        "current_hash": canonical_hash(&read_json_value(&abs).unwrap_or(Value::Null)),
        "lock_wait_ms": lock.waited_ms,
        "pointer_stats": pointer_stats,
    });
    release_write_lock(lock);
    Ok(result)
}

fn delete_path_command(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let target = clean_text(payload.get("target_path"), 520);
    let meta = payload
        .get("meta")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let (abs, rel) = resolve_adaptive_path(root, payload, &target)?;
    let lock = acquire_write_lock(&abs)?;
    let existed = abs.exists();
    if existed {
        fs::remove_file(&abs).map_err(|err| format!("adaptive_layer_store_kernel_delete_failed:{err}"))?;
    }
    append_mutation_log(
        root,
        payload,
        &json!({
            "ts": now_iso(),
            "op": "delete",
            "rel_path": rel,
            "actor": meta_actor(&meta),
            "source": meta_source(&meta),
            "reason": meta_reason(&meta, "delete"),
            "lock_wait_ms": lock.waited_ms,
        }),
    );
    let tombstone = json!({
        "uid": stable_uid(&format!("adaptive_blob|{rel}|v1"), "a", 24),
    });
    let pointer_stats = emit_adaptive_pointers(root, payload, &rel, &tombstone, "delete", &meta);
    let result = json!({
        "ok": true,
        "deleted": existed,
        "path": abs.to_string_lossy(),
        "rel": rel,
        "lock_wait_ms": lock.waited_ms,
        "pointer_stats": pointer_stats,
    });
    release_write_lock(lock);
    Ok(result)
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    if argv
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        usage();
        return 0;
    }

    let command = argv
        .first()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "paths".to_string());
    let payload = match payload_json(argv) {
        Ok(value) => value,
        Err(err) => {
            print_json_line(&cli_error(
                "adaptive_layer_store_kernel_error",
                err.as_str(),
            ));
            return 1;
        }
    };
    let payload = payload_obj(&payload);

    let receipt = match command.as_str() {
        "paths" => cli_receipt("adaptive_layer_store_kernel_paths", paths_command(root, payload)),
        "is-within-root" => cli_receipt(
            "adaptive_layer_store_kernel_is_within_root",
            is_within_root_command(root, payload),
        ),
        "resolve-path" => match resolve_path_command(root, payload) {
            Ok(value) => cli_receipt("adaptive_layer_store_kernel_resolve_path", value),
            Err(err) => cli_error("adaptive_layer_store_kernel_error", err.as_str()),
        },
        "read-json" => match read_json_command(root, payload) {
            Ok(value) => cli_receipt("adaptive_layer_store_kernel_read_json", value),
            Err(err) => cli_error("adaptive_layer_store_kernel_error", err.as_str()),
        },
        "ensure-json" => match ensure_json_command(root, payload) {
            Ok(value) => cli_receipt("adaptive_layer_store_kernel_ensure_json", value),
            Err(err) => cli_error("adaptive_layer_store_kernel_error", err.as_str()),
        },
        "set-json" => match set_json_command(root, payload) {
            Ok(value) => cli_receipt("adaptive_layer_store_kernel_set_json", value),
            Err(err) => cli_error("adaptive_layer_store_kernel_error", err.as_str()),
        },
        "delete-path" => match delete_path_command(root, payload) {
            Ok(value) => cli_receipt("adaptive_layer_store_kernel_delete_path", value),
            Err(err) => cli_error("adaptive_layer_store_kernel_error", err.as_str()),
        },
        _ => {
            usage();
            cli_error(
                "adaptive_layer_store_kernel_error",
                "adaptive_layer_store_kernel_unknown_command",
            )
        }
    };

    let exit_code = if receipt.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        0
    } else {
        1
    };
    print_json_line(&receipt);
    exit_code
}
