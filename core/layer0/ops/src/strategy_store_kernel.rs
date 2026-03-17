// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::Utc;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_REL_PATH: &str = "strategy/registry.json";
const POINTER_INDEX_REL: &str = "client/runtime/local/state/memory/adaptive_pointer_index.json";
const POINTERS_REL: &str = "client/runtime/local/state/memory/adaptive_pointers.jsonl";
const GENERATION_MODES: &[&str] = &[
    "normal",
    "narrative",
    "creative",
    "hyper-creative",
    "deep-thinker",
];
const EXECUTION_MODES: &[&str] = &["score_only", "canary_execute", "execute"];

fn usage() {
    println!("strategy-store-kernel commands:");
    println!("  protheus-ops strategy-store-kernel paths [--payload-base64=<json>]");
    println!("  protheus-ops strategy-store-kernel default-state");
    println!("  protheus-ops strategy-store-kernel default-draft [--payload-base64=<json>]");
    println!("  protheus-ops strategy-store-kernel normalize-mode [--payload-base64=<json>]");
    println!("  protheus-ops strategy-store-kernel normalize-execution-mode [--payload-base64=<json>]");
    println!("  protheus-ops strategy-store-kernel normalize-profile --payload-base64=<json>");
    println!("  protheus-ops strategy-store-kernel validate-profile --payload-base64=<json>");
    println!("  protheus-ops strategy-store-kernel normalize-queue-item --payload-base64=<json>");
    println!("  protheus-ops strategy-store-kernel recommend-mode [--payload-base64=<json>]");
    println!("  protheus-ops strategy-store-kernel read-state [--payload-base64=<json>]");
    println!("  protheus-ops strategy-store-kernel ensure-state [--payload-base64=<json>]");
    println!("  protheus-ops strategy-store-kernel set-state --payload-base64=<json>");
    println!("  protheus-ops strategy-store-kernel upsert-profile --payload-base64=<json>");
    println!("  protheus-ops strategy-store-kernel intake-signal --payload-base64=<json>");
    println!("  protheus-ops strategy-store-kernel materialize-from-queue --payload-base64=<json>");
    println!("  protheus-ops strategy-store-kernel touch-profile-usage --payload-base64=<json>");
    println!("  protheus-ops strategy-store-kernel evaluate-gc-candidates [--payload-base64=<json>]");
    println!("  protheus-ops strategy-store-kernel gc-profiles [--payload-base64=<json>]");
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
            .map_err(|err| format!("strategy_store_kernel_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("strategy_store_kernel_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("strategy_store_kernel_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("strategy_store_kernel_payload_decode_failed:{err}"));
    }
    Ok(json!({}))
}

fn payload_obj<'a>(value: &'a Value) -> &'a Map<String, Value> {
    value.as_object().unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(Map::new)
    })
}

fn as_object<'a>(value: Option<&'a Value>) -> Option<&'a Map<String, Value>> {
    value.and_then(Value::as_object)
}

fn as_str(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(v)) => v.trim().to_string(),
        Some(Value::Null) | None => String::new(),
        Some(v) => v.to_string().trim_matches('"').trim().to_string(),
    }
}

fn as_f64(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(v)) => v.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn clamp_number(value: Option<&Value>, lo: f64, hi: f64, fallback: f64) -> f64 {
    let raw = as_f64(value).unwrap_or(fallback);
    if !raw.is_finite() {
        return fallback;
    }
    raw.clamp(lo, hi)
}

fn clamp_i64(value: Option<&Value>, lo: i64, hi: i64, fallback: i64) -> i64 {
    let raw = as_f64(value).unwrap_or(fallback as f64);
    if !raw.is_finite() {
        return fallback;
    }
    raw.floor().clamp(lo as f64, hi as f64) as i64
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

fn normalize_key(raw: &str, max_len: usize) -> String {
    let mut out = String::new();
    let mut prev_us = false;
    for ch in raw.chars() {
        let lower = ch.to_ascii_lowercase();
        let keep = matches!(lower, 'a'..='z' | '0'..='9' | ':' | '_' | '-');
        if keep {
            out.push(lower);
            prev_us = false;
        } else if !prev_us {
            out.push('_');
            prev_us = true;
        }
        if out.len() >= max_len {
            break;
        }
    }
    out.trim_matches('_').to_string()
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

fn is_alnum(raw: &str) -> bool {
    !raw.is_empty() && raw.chars().all(|ch| ch.is_ascii_alphanumeric())
}

fn hash16(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    let digest = hasher.finalize();
    let mut out = String::new();
    for byte in digest.iter().take(8) {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn stable_uid(seed: &str, prefix: &str, length: usize) -> String {
    let body = {
        let mut hasher = Sha256::new();
        hasher.update(seed.as_bytes());
        let digest = hasher.finalize();
        let mut hex = String::new();
        for byte in digest {
            hex.push_str(&format!("{byte:02x}"));
        }
        hex
    };
    let mut out = normalize_tag(prefix).replace('-', "");
    let body_len = length.saturating_sub(out.len()).max(8);
    out.push_str(&body[..body_len.min(body.len())]);
    out.truncate(length.max(8).min(48));
    out
}

fn random_uid(prefix: &str, length: usize) -> String {
    stable_uid(
        &format!("{}:{}:{}", prefix, std::process::id(), Utc::now().timestamp_nanos_opt().unwrap_or_default()),
        prefix,
        length,
    )
}

fn parse_ts_ms(raw: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn json_string(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

fn workspace_root(root: &Path) -> PathBuf {
    if let Ok(raw) = std::env::var("PROTHEUS_WORKSPACE_ROOT") {
        let raw = raw.trim();
        if !raw.is_empty() {
            return PathBuf::from(raw);
        }
    }
    root.to_path_buf()
}

fn runtime_root(root: &Path) -> PathBuf {
    if let Ok(raw) = std::env::var("PROTHEUS_RUNTIME_ROOT") {
        let raw = raw.trim();
        if !raw.is_empty() {
            return PathBuf::from(raw);
        }
    }
    workspace_root(root).join("client").join("runtime")
}

fn default_abs_path(root: &Path) -> PathBuf {
    runtime_root(root).join("adaptive").join(DEFAULT_REL_PATH)
}

fn store_abs_path(root: &Path) -> PathBuf {
    if let Ok(raw) = std::env::var("STRATEGY_STORE_PATH") {
        let raw = raw.trim();
        if !raw.is_empty() {
            let candidate = PathBuf::from(raw);
            if candidate.is_absolute() {
                return candidate;
            }
            return workspace_root(root).join(candidate);
        }
    }
    default_abs_path(root)
}

fn mutation_log_path(root: &Path) -> PathBuf {
    runtime_root(root).join("local/state/security/adaptive_mutations.jsonl")
}

fn pointer_index_path(root: &Path) -> PathBuf {
    workspace_root(root).join(POINTER_INDEX_REL)
}

fn pointers_path(root: &Path) -> PathBuf {
    workspace_root(root).join(POINTERS_REL)
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("strategy_store_kernel_create_dir_failed:{}:{err}", parent.display()))?;
    }
    Ok(())
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let temp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        Utc::now().timestamp_millis()
    ));
    let payload = serde_json::to_string_pretty(value)
        .map_err(|err| format!("strategy_store_kernel_encode_json_failed:{err}"))?;
    let mut file = fs::File::create(&temp)
        .map_err(|err| format!("strategy_store_kernel_create_tmp_failed:{}:{err}", temp.display()))?;
    file.write_all(payload.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|err| format!("strategy_store_kernel_write_tmp_failed:{}:{err}", temp.display()))?;
    fs::rename(&temp, path)
        .map_err(|err| format!("strategy_store_kernel_rename_tmp_failed:{}:{err}", path.display()))
}

fn append_jsonl(path: &Path, row: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("strategy_store_kernel_open_jsonl_failed:{}:{err}", path.display()))?;
    let encoded = serde_json::to_string(row)
        .map_err(|err| format!("strategy_store_kernel_encode_jsonl_failed:{err}"))?;
    file.write_all(encoded.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|err| format!("strategy_store_kernel_append_jsonl_failed:{}:{err}", path.display()))
}

fn read_json(path: &Path) -> Value {
    let Ok(raw) = fs::read_to_string(path) else {
        return Value::Null;
    };
    serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null)
}

fn actor_from_meta(meta: Option<&Map<String, Value>>) -> String {
    let raw = meta
        .and_then(|m| m.get("actor"))
        .map(|v| clean_text(Some(v), 80))
        .unwrap_or_default();
    if !raw.is_empty() {
        return raw;
    }
    std::env::var("USER")
        .ok()
        .map(|v| v.chars().take(80).collect::<String>())
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn source_from_meta(meta: Option<&Map<String, Value>>) -> String {
    meta.and_then(|m| m.get("source"))
        .map(|v| clean_text(Some(v), 120))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "core/layer1/memory_runtime/adaptive/strategy_store.ts".to_string())
}

fn reason_from_meta(meta: Option<&Map<String, Value>>, fallback: &str) -> String {
    meta.and_then(|m| m.get("reason"))
        .map(|v| clean_text(Some(v), 160))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| fallback.to_string())
}

fn append_mutation_log(root: &Path, op: &str, rel_path: &str, value: Option<&Value>, meta: Option<&Map<String, Value>>, reason_fallback: &str) -> Result<(), String> {
    let row = json!({
        "ts": now_iso(),
        "op": op,
        "rel_path": rel_path,
        "actor": actor_from_meta(meta),
        "source": source_from_meta(meta),
        "reason": reason_from_meta(meta, reason_fallback),
        "value_hash": value.map(json_string).map(|v| hash16(&v)).unwrap_or_default(),
    });
    append_jsonl(&mutation_log_path(root), &row)
}

fn pointer_index_load(root: &Path) -> Value {
    let raw = read_json(&pointer_index_path(root));
    if raw.is_object() {
        raw
    } else {
        json!({"version": "1.0", "pointers": {}})
    }
}

fn pointer_index_save(root: &Path, index: &Value) -> Result<(), String> {
    let pointers = index
        .get("pointers")
        .cloned()
        .unwrap_or_else(|| json!({}));
    write_json_atomic(
        &pointer_index_path(root),
        &json!({
            "version": "1.0",
            "updated_ts": now_iso(),
            "pointers": pointers,
        }),
    )
}

fn emit_strategy_pointer(root: &Path, meta: Option<&Map<String, Value>>) -> Result<(), String> {
    let rel = DEFAULT_REL_PATH;
    let uid = stable_uid(&format!("adaptive_blob|{rel}|v1"), "a", 24);
    let row = json!({
        "ts": now_iso(),
        "op": "set",
        "source": "adaptive_layer_store",
        "source_path": source_from_meta(meta),
        "reason": reason_from_meta(meta, "set_strategy_state"),
        "actor": actor_from_meta(meta),
        "kind": "adaptive_strategy_registry-json",
        "layer": "strategy",
        "uid": uid,
        "entity_id": Value::Null,
        "status": "active",
        "tags": ["adaptive", "strategy"],
        "summary": "Adaptive record: strategy/registry.json",
        "path_ref": "adaptive/strategy/registry.json",
        "created_ts": now_iso(),
        "updated_ts": now_iso(),
    });
    let key = format!(
        "{}|{}|{}|{}",
        row.get("kind").and_then(Value::as_str).unwrap_or(""),
        row.get("uid").and_then(Value::as_str).unwrap_or(""),
        row.get("path_ref").and_then(Value::as_str).unwrap_or(""),
        row.get("entity_id").map(json_string).unwrap_or_else(|| "null".to_string()),
    );
    let hash = hash16(&json_string(&json!({
        "uid": row.get("uid").cloned().unwrap_or(Value::Null),
        "kind": row.get("kind").cloned().unwrap_or(Value::Null),
        "path_ref": row.get("path_ref").cloned().unwrap_or(Value::Null),
        "entity_id": row.get("entity_id").cloned().unwrap_or(Value::Null),
        "tags": row.get("tags").cloned().unwrap_or(Value::Null),
        "summary": row.get("summary").cloned().unwrap_or(Value::Null),
        "status": row.get("status").cloned().unwrap_or(Value::Null),
    })));
    let mut index = pointer_index_load(root);
    if !index.get("pointers").map(Value::is_object).unwrap_or(false) {
        index["pointers"] = json!({});
    }
    if index["pointers"].get(&key).and_then(Value::as_str) == Some(hash.as_str()) {
        return Ok(());
    }
    append_jsonl(&pointers_path(root), &row)?;
    index["pointers"][&key] = Value::String(hash);
    pointer_index_save(root, &index)
}

fn default_strategy_draft(seed: Option<&Map<String, Value>>) -> Value {
    let seed = seed.unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(Map::new)
    });
    let base_name = {
        let candidate = clean_text(seed.get("id"), 40);
        if !candidate.is_empty() {
            candidate
        } else {
            let name = clean_text(seed.get("name"), 120);
            if !name.is_empty() {
                name
            } else {
                format!("strategy_{}", random_uid("s", 8))
            }
        }
    };
    let id = {
        let key = normalize_key(&base_name, 40);
        if key.is_empty() {
            format!("strategy_{}", hash16(&now_iso()))
        } else {
            key
        }
    };
    let name = clean_text(seed.get("name"), 120).if_empty_then(&id);
    let objective_primary = if let Some(objective) = as_object(seed.get("objective")) {
        clean_text(objective.get("primary"), 180)
    } else {
        let summary = clean_text(seed.get("summary"), 180);
        if !summary.is_empty() {
            summary
        } else {
            let prompt = clean_text(seed.get("prompt"), 180);
            if !prompt.is_empty() {
                prompt
            } else {
                format!("Improve outcomes for {name}")
            }
        }
    };
    json!({
        "version": "1.0",
        "id": id,
        "name": name,
        "status": "disabled",
        "objective": {
            "primary": objective_primary.if_empty_then(&format!("Improve outcomes for {name}")),
            "secondary": [],
            "fitness_metric": "verified_progress_rate",
            "target_window_days": 14,
        },
        "generation_policy": {
            "mode": normalize_mode(seed.get("generation_mode"), Some("hyper-creative")),
        },
        "risk_policy": {
            "allowed_risks": normalize_allowed_risks(seed.get("risk_policy").and_then(Value::as_object).and_then(|v| v.get("allowed_risks"))),
            "max_risk_per_action": clamp_number(
                seed.get("risk_policy")
                    .and_then(Value::as_object)
                    .and_then(|v| v.get("max_risk_per_action")),
                0.0,
                100.0,
                35.0,
            ),
        },
        "admission_policy": {
            "allowed_types": [],
            "blocked_types": [],
            "max_remediation_depth": 2,
            "duplicate_window_hours": 24,
        },
        "ranking_weights": {
            "composite": 0.35,
            "actionability": 0.2,
            "directive_fit": 0.15,
            "signal_quality": 0.15,
            "expected_value": 0.1,
            "time_to_value": 0.0,
            "risk_penalty": 0.05,
        },
        "budget_policy": {
            "daily_runs_cap": 4,
            "daily_token_cap": 4000,
            "max_tokens_per_action": 1600,
        },
        "exploration_policy": {
            "fraction": 0.25,
            "every_n": 3,
            "min_eligible": 3,
        },
        "stop_policy": {
            "circuit_breakers": {
                "http_429_cooldown_hours": 12,
            }
        },
        "promotion_policy": {
            "min_days": 7,
            "min_attempted": 12,
            "min_verified_rate": 0.5,
            "min_success_criteria_receipts": 2,
            "min_success_criteria_pass_rate": 0.6,
            "min_objective_coverage": 0.25,
            "max_objective_no_progress_rate": 0.9,
            "max_reverted_rate": 0.35,
            "max_stop_ratio": 0.75,
            "min_shipped": 1,
        },
        "execution_policy": {
            "mode": "score_only",
        },
        "threshold_overrides": {},
    })
}

trait StringExt {
    fn if_empty_then(self, fallback: &str) -> String;
}

impl StringExt for String {
    fn if_empty_then(self, fallback: &str) -> String {
        if self.trim().is_empty() {
            fallback.to_string()
        } else {
            self
        }
    }
}

fn normalize_mode(value: Option<&Value>, fallback: Option<&str>) -> String {
    let raw = as_str(value).to_ascii_lowercase();
    if GENERATION_MODES.contains(&raw.as_str()) {
        raw
    } else {
        fallback.unwrap_or("hyper-creative").to_string()
    }
}

fn normalize_execution_mode(value: Option<&Value>, fallback: Option<&str>) -> String {
    let raw = as_str(value).to_ascii_lowercase();
    if EXECUTION_MODES.contains(&raw.as_str()) {
        raw
    } else {
        fallback.unwrap_or("score_only").to_string()
    }
}

fn normalize_allowed_risks(raw: Option<&Value>) -> Value {
    let mut out = Vec::new();
    if let Some(rows) = raw.and_then(Value::as_array) {
        for row in rows {
            let value = as_str(Some(row)).to_ascii_lowercase();
            if !matches!(value.as_str(), "low" | "medium" | "high") {
                continue;
            }
            if !out.iter().any(|existing| existing == &value) {
                out.push(value);
            }
        }
    }
    if out.is_empty() {
        out.push("low".to_string());
    }
    Value::Array(out.into_iter().map(Value::String).collect())
}

fn default_strategy_state() -> Value {
    json!({
        "version": "1.0",
        "policy": {
            "max_profiles": 64,
            "max_queue": 64,
            "queue_ttl_hours": 72,
            "queue_max_attempts": 3,
            "queue_min_evidence_refs": 1,
            "queue_min_trust_score": 35,
            "gc_inactive_days": 21,
            "gc_min_uses_30d": 1,
            "gc_protect_new_days": 3,
        },
        "profiles": [],
        "intake_queue": [],
        "metrics": {
            "total_intakes": 0,
            "total_profiles_created": 0,
            "total_profiles_updated": 0,
            "total_queue_consumed": 0,
            "total_gc_deleted": 0,
            "last_gc_ts": Value::Null,
            "last_usage_sync_ts": Value::Null,
        }
    })
}

fn normalize_policy(raw: Option<&Map<String, Value>>) -> Value {
    let raw = raw.unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(Map::new)
    });
    let defaults = default_strategy_state();
    let base = defaults.get("policy").and_then(Value::as_object).unwrap();
    json!({
        "max_profiles": clamp_i64(raw.get("max_profiles"), 4, 512, base.get("max_profiles").and_then(Value::as_i64).unwrap_or(64)),
        "max_queue": clamp_i64(raw.get("max_queue"), 4, 512, base.get("max_queue").and_then(Value::as_i64).unwrap_or(64)),
        "queue_ttl_hours": clamp_i64(raw.get("queue_ttl_hours"), 1, 24 * 30, base.get("queue_ttl_hours").and_then(Value::as_i64).unwrap_or(72)),
        "queue_max_attempts": clamp_i64(raw.get("queue_max_attempts"), 1, 100, base.get("queue_max_attempts").and_then(Value::as_i64).unwrap_or(3)),
        "queue_min_evidence_refs": clamp_i64(raw.get("queue_min_evidence_refs"), 0, 32, base.get("queue_min_evidence_refs").and_then(Value::as_i64).unwrap_or(1)),
        "queue_min_trust_score": clamp_i64(raw.get("queue_min_trust_score"), 0, 100, base.get("queue_min_trust_score").and_then(Value::as_i64).unwrap_or(35)),
        "gc_inactive_days": clamp_i64(raw.get("gc_inactive_days"), 1, 365, base.get("gc_inactive_days").and_then(Value::as_i64).unwrap_or(21)),
        "gc_min_uses_30d": clamp_i64(raw.get("gc_min_uses_30d"), 0, 1000, base.get("gc_min_uses_30d").and_then(Value::as_i64).unwrap_or(1)),
        "gc_protect_new_days": clamp_i64(raw.get("gc_protect_new_days"), 0, 90, base.get("gc_protect_new_days").and_then(Value::as_i64).unwrap_or(3)),
    })
}

fn normalize_usage(raw: Option<&Map<String, Value>>, now_ts: &str) -> Value {
    let raw = raw.unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(Map::new)
    });
    let mut events = raw
        .get("use_events")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .map(|row| as_str(Some(row)))
                .filter(|row| parse_ts_ms(row).is_some())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    events.sort();
    if events.len() > 256 {
        events = events.split_off(events.len() - 256);
    }
    let cutoff = Utc::now().timestamp_millis() - (30_i64 * 24 * 60 * 60 * 1000);
    let uses_30 = events
        .iter()
        .filter(|ts| parse_ts_ms(ts).map(|ms| ms >= cutoff).unwrap_or(false))
        .count() as i64;
    json!({
        "uses_total": clamp_i64(raw.get("uses_total"), 0, 100_000_000, events.len() as i64),
        "uses_30d": clamp_i64(raw.get("uses_30d"), 0, 100_000_000, uses_30),
        "use_events": events,
        "last_used_ts": raw.get("last_used_ts").filter(|v| parse_ts_ms(&as_str(Some(v))).is_some()).cloned().unwrap_or(Value::Null),
        "last_usage_sync_ts": raw.get("last_usage_sync_ts").filter(|v| parse_ts_ms(&as_str(Some(v))).is_some()).cloned().unwrap_or_else(|| Value::String(now_ts.to_string())),
    })
}

fn ensure_work_packet(item: &Value) -> Value {
    let mode = normalize_mode(item.get("recommended_generation_mode").or_else(|| item.get("generation_mode")), Some("hyper-creative"));
    json!({
        "mode_hint": mode,
        "allowed_modes": ["hyper-creative", "deep-thinker"],
        "objective": "Turn this intake signal into a structured strategy profile draft.",
        "input_summary": clean_text(item.get("summary"), 220),
        "output_contract": {
            "format": "strategy_profile_json",
            "required_keys": [
                "id",
                "name",
                "objective.primary",
                "risk_policy.allowed_risks",
                "execution_policy.mode"
            ],
            "notes": "Keep output strategy-agnostic and deterministic; prefer score_only at first."
        }
    })
}

fn recommend_mode(summary: &str, raw_text: &str) -> String {
    let text = format!("{} {}", summary, raw_text).to_ascii_lowercase();
    if text.len() > 900
        || [
            "tradeoff",
            "architecture",
            "uncertain",
            "counterfactual",
            "conflict",
            "multi-step",
            "nonlinear",
            "portfolio",
            "long horizon",
            "long-horizon",
        ]
        .iter()
        .any(|needle| text.contains(needle))
    {
        "deep-thinker".to_string()
    } else {
        "hyper-creative".to_string()
    }
}

fn compute_trust_score(item: &Value) -> i64 {
    let source = as_str(item.get("source")).to_ascii_lowercase();
    let evidence = item.get("evidence_refs").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0) as i64;
    let summary_len = as_str(item.get("summary")).len() as i64;
    let text_len = as_str(item.get("text")).len() as i64;
    let mut score = 20_i64;
    score += (evidence * 10).min(40);
    score += (summary_len / 20).min(20);
    score += (text_len / 300).min(10);
    if source.contains("outcome_fitness") || source.contains("strategy_scorecards") {
        score += 12;
    }
    if source.contains("cross_signal") || source.contains("sensory_trends") {
        score += 8;
    }
    if source == "manual" {
        score += 5;
    }
    score.clamp(0, 100)
}

fn queue_drop_reasons(item: &Value, policy: &Value, now_ms: i64) -> Vec<String> {
    let created_ms = item
        .get("created_ts")
        .and_then(|v| parse_ts_ms(&as_str(Some(v))));
    let ttl_hours = clamp_i64(policy.get("queue_ttl_hours"), 1, 24 * 30, 72);
    let max_attempts = clamp_i64(policy.get("queue_max_attempts"), 1, 100, 3);
    let min_evidence = clamp_i64(policy.get("queue_min_evidence_refs"), 0, 32, 1);
    let min_trust = clamp_i64(policy.get("queue_min_trust_score"), 0, 100, 35);
    let mut reasons = Vec::new();
    if created_ms
        .map(|ms| now_ms - ms > ttl_hours * 60 * 60 * 1000)
        .unwrap_or(false)
    {
        reasons.push("queue_ttl_expired".to_string());
    }
    if clamp_i64(item.get("attempts"), 0, 1000, 0) >= max_attempts {
        reasons.push("queue_max_attempts_exceeded".to_string());
    }
    let evidence_len = item.get("evidence_refs").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0) as i64;
    if evidence_len < min_evidence {
        reasons.push("evidence_missing".to_string());
    }
    if clamp_i64(item.get("trust_score"), 0, 100, 0) < min_trust {
        reasons.push("trust_score_low".to_string());
    }
    if as_str(item.get("summary")).len() < 16 {
        reasons.push("summary_too_short".to_string());
    }
    reasons
}

fn normalize_queue_item(raw: Option<&Map<String, Value>>, now_ts: &str) -> Value {
    let raw = raw.unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(Map::new)
    });
    let summary = {
        let value = clean_text(raw.get("summary"), 220);
        if !value.is_empty() {
            value
        } else {
            let text = clean_text(raw.get("text"), 220);
            if !text.is_empty() {
                text
            } else {
                clean_text(raw.get("payload"), 220).if_empty_then("strategy intake")
            }
        }
    };
    let text = as_str(raw.get("text")).if_empty_then(&as_str(raw.get("payload")));
    let text = text.chars().take(6000).collect::<String>();
    let evidence_refs = raw
        .get("evidence_refs")
        .and_then(Value::as_array)
        .map(|rows| {
            let mut uniq = Vec::<String>::new();
            for row in rows {
                let cleaned = clean_text(Some(row), 200);
                if cleaned.is_empty() || uniq.iter().any(|existing| existing == &cleaned) {
                    continue;
                }
                uniq.push(cleaned);
                if uniq.len() >= 24 {
                    break;
                }
            }
            uniq
        })
        .unwrap_or_default();
    let recommended_generation_mode = normalize_mode(
        raw.get("recommended_generation_mode")
            .or_else(|| raw.get("generation_mode"))
            .or_else(|| raw.get("mode")),
        Some(&recommend_mode(&summary, &text)),
    );
    let uid_candidate = clean_text(raw.get("uid"), 64);
    let uid = if is_alnum(&uid_candidate) {
        uid_candidate
    } else {
        random_uid("si", 24)
    };
    let fingerprint = {
        let raw_fingerprint = clean_text(raw.get("fingerprint"), 40);
        if !raw_fingerprint.is_empty() {
            raw_fingerprint
        } else {
            hash16(&json_string(&json!({
                "source": clean_text(raw.get("source"), 60).if_empty_then("unknown"),
                "kind": clean_text(raw.get("kind"), 40).if_empty_then("signal"),
                "summary": summary,
                "text": text,
                "evidence": evidence_refs,
            })))
        }
    };
    let status_raw = as_str(raw.get("status")).to_ascii_lowercase();
    let status = if matches!(status_raw.as_str(), "consumed" | "dropped") {
        status_raw
    } else {
        "queued".to_string()
    };
    let linked_strategy_id = {
        let value = clean_text(raw.get("linked_strategy_id"), 64);
        if value.is_empty() {
            Value::Null
        } else {
            Value::String(value)
        }
    };
    let mut item = json!({
        "uid": uid,
        "fingerprint": fingerprint,
        "source": clean_text(raw.get("source"), 80).if_empty_then("unknown"),
        "kind": clean_text(raw.get("kind"), 60).if_empty_then("signal"),
        "summary": summary,
        "text": text,
        "evidence_refs": evidence_refs,
        "recommended_generation_mode": recommended_generation_mode,
        "status": status,
        "attempts": clamp_i64(raw.get("attempts"), 0, 1000, 0),
        "created_ts": raw.get("created_ts").filter(|v| parse_ts_ms(&as_str(Some(v))).is_some()).cloned().unwrap_or_else(|| Value::String(now_ts.to_string())),
        "updated_ts": raw.get("updated_ts").filter(|v| parse_ts_ms(&as_str(Some(v))).is_some()).cloned().unwrap_or_else(|| Value::String(now_ts.to_string())),
        "consumed_ts": raw.get("consumed_ts").filter(|v| parse_ts_ms(&as_str(Some(v))).is_some()).cloned().unwrap_or(Value::Null),
        "linked_strategy_id": linked_strategy_id,
    });
    let trust_score = clamp_i64(raw.get("trust_score"), 0, 100, compute_trust_score(&item));
    item["trust_score"] = Value::from(trust_score);
    item["drop_reason"] = {
        let value = clean_text(raw.get("drop_reason"), 200);
        if value.is_empty() { Value::Null } else { Value::String(value) }
    };
    item["work_packet"] = ensure_work_packet(&item);
    item
}

fn normalize_profile(raw: Option<&Map<String, Value>>, now_ts: &str) -> Value {
    let raw = raw.unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(Map::new)
    });
    let draft_src = as_object(raw.get("draft")).unwrap_or(raw);
    let mut draft = default_strategy_draft(Some(draft_src));
    let draft_id = clean_text(draft.get("id"), 40);
    let draft_name = clean_text(draft.get("name"), 120);
    let id = normalize_key(
        &clean_text(raw.get("id"), 40).if_empty_then(&draft_id.clone().if_empty_then(&draft_name)),
        40,
    )
    .if_empty_then(&draft_id.clone().if_empty_then("strategy"));
    draft["id"] = Value::String(id.clone());
    draft["name"] = Value::String(clean_text(raw.get("name"), 120).if_empty_then(&draft_name.if_empty_then(&id)));
    let objective_primary = {
        let current = as_object(draft.get("objective")).and_then(|v| v.get("primary"));
        clean_text(current.or_else(|| raw.get("objective_primary")), 220)
            .if_empty_then(&format!("Improve outcomes for {}", clean_text(draft.get("name"), 120).if_empty_then(&id)))
    };
    draft["objective"] = json!({
        "primary": objective_primary,
        "secondary": draft.pointer("/objective/secondary").cloned().unwrap_or_else(|| json!([])),
        "fitness_metric": draft.pointer("/objective/fitness_metric").cloned().unwrap_or_else(|| Value::String("verified_progress_rate".to_string())),
        "target_window_days": clamp_i64(draft.pointer("/objective/target_window_days"), 1, 365, 14),
    });
    draft["risk_policy"] = json!({
        "allowed_risks": normalize_allowed_risks(draft.pointer("/risk_policy/allowed_risks")),
        "max_risk_per_action": clamp_number(draft.pointer("/risk_policy/max_risk_per_action"), 0.0, 100.0, 35.0),
    });
    let requested_execution_mode = normalize_execution_mode(
        raw.get("execution_mode")
            .or_else(|| raw.get("execution_policy").and_then(Value::as_object).and_then(|v| v.get("mode")))
            .or_else(|| draft.pointer("/execution_policy/mode")),
        Some("score_only"),
    );
    let allow_elevated_mode = raw.get("allow_elevated_mode").and_then(Value::as_bool) == Some(true);
    draft["execution_policy"] = json!({
        "mode": if allow_elevated_mode { requested_execution_mode.clone() } else { "score_only".to_string() },
    });
    draft["generation_policy"] = json!({
        "mode": normalize_mode(
            raw.get("generation_mode")
                .or_else(|| raw.get("generation_policy").and_then(Value::as_object).and_then(|v| v.get("mode")))
                .or_else(|| draft.pointer("/generation_policy/mode")),
            Some("hyper-creative"),
        )
    });
    let uid_candidate = clean_text(raw.get("uid"), 64);
    let uid = if is_alnum(&uid_candidate) {
        uid_candidate
    } else {
        stable_uid(&format!("adaptive_strategy_profile|{id}|v1"), "stp", 24)
    };
    let stage_raw = as_str(raw.get("stage")).to_ascii_lowercase();
    let stage = if matches!(stage_raw.as_str(), "trial" | "validated" | "scaled") {
        stage_raw
    } else {
        "theory".to_string()
    };
    let status_raw = as_str(raw.get("status")).to_ascii_lowercase();
    let status = if matches!(status_raw.as_str(), "disabled" | "archived") {
        status_raw
    } else {
        "active".to_string()
    };
    let tags = raw
        .get("tags")
        .and_then(Value::as_array)
        .map(|rows| {
            let mut uniq = Vec::<String>::new();
            for row in rows {
                let tag = normalize_key(&as_str(Some(row)), 32);
                if tag.is_empty() || uniq.iter().any(|existing| existing == &tag) {
                    continue;
                }
                uniq.push(tag);
                if uniq.len() >= 16 {
                    break;
                }
            }
            uniq
        })
        .unwrap_or_default();
    let queue_ref = {
        let value = clean_text(raw.get("queue_ref"), 64);
        if value.is_empty() {
            Value::Null
        } else {
            Value::String(value)
        }
    };
    json!({
        "uid": uid,
        "id": id,
        "name": clean_text(raw.get("name"), 120).if_empty_then(&clean_text(draft.get("name"), 120).if_empty_then("strategy")),
        "stage": stage,
        "status": status,
        "source": clean_text(raw.get("source"), 80).if_empty_then("adaptive_intake"),
        "queue_ref": queue_ref,
        "generated_mode": normalize_mode(
            raw.get("generated_mode")
                .or_else(|| raw.get("generation_mode"))
                .or_else(|| draft.pointer("/generation_policy/mode")),
            Some("hyper-creative"),
        ),
        "requested_execution_mode": requested_execution_mode,
        "elevated_mode_forced_down": !allow_elevated_mode && requested_execution_mode != "score_only",
        "tags": tags,
        "draft": draft,
        "usage": normalize_usage(raw.get("usage").and_then(Value::as_object), now_ts),
        "created_ts": raw.get("created_ts").filter(|v| parse_ts_ms(&as_str(Some(v))).is_some()).cloned().unwrap_or_else(|| Value::String(now_ts.to_string())),
        "updated_ts": raw.get("updated_ts").filter(|v| parse_ts_ms(&as_str(Some(v))).is_some()).cloned().unwrap_or_else(|| Value::String(now_ts.to_string())),
    })
}

fn validate_profile_input(raw_profile: Option<&Map<String, Value>>, allow_elevated_mode: bool) -> Result<Value, String> {
    let normalized = normalize_profile(raw_profile, &now_iso());
    let mut errors = Vec::new();
    if as_str(normalized.get("id")).is_empty() {
        errors.push("id_required");
    }
    if !normalized.get("draft").map(Value::is_object).unwrap_or(false) {
        errors.push("draft_required");
    }
    if clean_text(normalized.pointer("/draft/objective/primary"), 220).is_empty() {
        errors.push("objective_primary_required");
    }
    if normalized
        .pointer("/draft/risk_policy/allowed_risks")
        .and_then(Value::as_array)
        .map(|rows| rows.is_empty())
        .unwrap_or(true)
    {
        errors.push("risk_policy_allowed_risks_required");
    }
    let mode = normalize_execution_mode(normalized.pointer("/draft/execution_policy/mode"), Some("score_only"));
    if !EXECUTION_MODES.contains(&mode.as_str()) {
        errors.push("execution_mode_invalid");
    }
    if !allow_elevated_mode && mode != "score_only" {
        errors.push("execution_mode_requires_explicit_override");
    }
    if errors.is_empty() {
        Ok(normalized)
    } else {
        Err(format!("strategy_store: validation_failed:{}", errors.join(",")))
    }
}

fn normalize_state(raw: Option<&Value>, fallback: Option<&Value>) -> Value {
    let now_ts = now_iso();
    let base = default_strategy_state();
    let src = raw.filter(|v| v.is_object()).unwrap_or_else(|| fallback.unwrap_or(&base));
    let src_obj = payload_obj(src);
    let policy = normalize_policy(as_object(src_obj.get("policy")));
    let max_profiles = policy.get("max_profiles").and_then(Value::as_i64).unwrap_or(64) as usize;
    let max_queue = policy.get("max_queue").and_then(Value::as_i64).unwrap_or(64) as usize;

    let mut profiles_by_id: BTreeMap<String, Value> = BTreeMap::new();
    for profile in src_obj
        .get("profiles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let normalized = normalize_profile(profile.as_object(), &now_ts);
        let id = as_str(normalized.get("id"));
        if id.is_empty() {
            continue;
        }
        let should_replace = profiles_by_id
            .get(&id)
            .map(|existing| {
                parse_ts_ms(&as_str(normalized.get("updated_ts"))).unwrap_or(0)
                    >= parse_ts_ms(&as_str(existing.get("updated_ts"))).unwrap_or(0)
            })
            .unwrap_or(true);
        if should_replace {
            profiles_by_id.insert(id, normalized);
        }
    }
    let mut profiles = profiles_by_id.into_values().collect::<Vec<_>>();
    profiles.sort_by(|a, b| as_str(a.get("id")).cmp(&as_str(b.get("id"))));
    if profiles.len() > max_profiles {
        profiles.truncate(max_profiles);
    }

    let mut queue_by_uid: BTreeMap<String, Value> = BTreeMap::new();
    let now_ms = Utc::now().timestamp_millis();
    for item in src_obj
        .get("intake_queue")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
    {
        let mut normalized = normalize_queue_item(item.as_object(), &now_ts);
        if as_str(normalized.get("status")) == "queued" {
            let drops = queue_drop_reasons(&normalized, &policy, now_ms);
            if !drops.is_empty() {
                normalized["status"] = Value::String("dropped".to_string());
                normalized["drop_reason"] = Value::String(drops.join(","));
                normalized["updated_ts"] = Value::String(now_ts.clone());
            }
        }
        let uid = as_str(normalized.get("uid"));
        if uid.is_empty() {
            continue;
        }
        let should_replace = queue_by_uid
            .get(&uid)
            .map(|existing| {
                parse_ts_ms(&as_str(normalized.get("updated_ts"))).unwrap_or(0)
                    >= parse_ts_ms(&as_str(existing.get("updated_ts"))).unwrap_or(0)
            })
            .unwrap_or(true);
        if should_replace {
            queue_by_uid.insert(uid, normalized);
        }
    }
    let mut intake_queue = queue_by_uid.into_values().collect::<Vec<_>>();
    intake_queue.sort_by(|a, b| {
        parse_ts_ms(&as_str(a.get("created_ts"))).unwrap_or(0)
            .cmp(&parse_ts_ms(&as_str(b.get("created_ts"))).unwrap_or(0))
    });
    if intake_queue.len() > max_queue {
        intake_queue = intake_queue.split_off(intake_queue.len() - max_queue);
    }

    let metrics_obj = as_object(src_obj.get("metrics"));
    json!({
        "version": clean_text(src_obj.get("version"), 40).if_empty_then("1.0"),
        "policy": policy,
        "profiles": profiles,
        "intake_queue": intake_queue,
        "metrics": {
            "total_intakes": clamp_i64(metrics_obj.and_then(|m| m.get("total_intakes")), 0, 100_000_000, 0),
            "total_profiles_created": clamp_i64(metrics_obj.and_then(|m| m.get("total_profiles_created")), 0, 100_000_000, 0),
            "total_profiles_updated": clamp_i64(metrics_obj.and_then(|m| m.get("total_profiles_updated")), 0, 100_000_000, 0),
            "total_queue_consumed": clamp_i64(metrics_obj.and_then(|m| m.get("total_queue_consumed")), 0, 100_000_000, 0),
            "total_gc_deleted": clamp_i64(metrics_obj.and_then(|m| m.get("total_gc_deleted")), 0, 100_000_000, 0),
            "last_gc_ts": metrics_obj.and_then(|m| m.get("last_gc_ts")).filter(|v| parse_ts_ms(&as_str(Some(v))).is_some()).cloned().unwrap_or(Value::Null),
            "last_usage_sync_ts": metrics_obj.and_then(|m| m.get("last_usage_sync_ts")).filter(|v| parse_ts_ms(&as_str(Some(v))).is_some()).cloned().unwrap_or(Value::Null),
        }
    })
}

fn resolve_requested_path(root: &Path, raw: &str) -> PathBuf {
    let candidate = PathBuf::from(raw.trim());
    if candidate.is_absolute() {
        candidate
    } else {
        workspace_root(root).join(candidate)
    }
}

fn as_store_path(root: &Path, payload: &Map<String, Value>) -> Result<PathBuf, String> {
    let canonical = store_abs_path(root);
    let raw = as_str(payload.get("file_path"));
    if raw.is_empty() {
        return Ok(canonical);
    }
    let requested = resolve_requested_path(root, &raw);
    if requested != canonical {
        return Err(format!(
            "strategy_store: path override denied (requested={})",
            requested.display()
        ));
    }
    Ok(canonical)
}

fn read_state(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let path = as_store_path(root, payload)?;
    let raw = read_json(&path);
    let fallback = payload
        .get("fallback")
        .cloned()
        .unwrap_or_else(default_strategy_state);
    Ok(normalize_state(Some(&raw), Some(&fallback)))
}

fn ensure_state(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let path = as_store_path(root, payload)?;
    if path.exists() {
        let raw = read_json(&path);
        if raw.is_object() {
            return Ok(normalize_state(Some(&raw), Some(&default_strategy_state())));
        }
    }
    let next = default_strategy_state();
    write_json_atomic(&path, &next)?;
    let meta = as_object(payload.get("meta"));
    append_mutation_log(root, "ensure", DEFAULT_REL_PATH, Some(&next), meta, "ensure_strategy_state")?;
    emit_strategy_pointer(root, meta)?;
    Ok(normalize_state(Some(&next), Some(&default_strategy_state())))
}

fn set_state(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let path = as_store_path(root, payload)?;
    let state = payload.get("state").cloned().unwrap_or_else(|| Value::Object(payload.clone()));
    let normalized = normalize_state(Some(&state), Some(&default_strategy_state()));
    write_json_atomic(&path, &normalized)?;
    let meta = as_object(payload.get("meta"));
    append_mutation_log(root, "set", DEFAULT_REL_PATH, Some(&normalized), meta, "set_strategy_state")?;
    emit_strategy_pointer(root, meta)?;
    Ok(normalized)
}

fn mutate_state(root: &Path, payload: &Map<String, Value>, reason: &str, mutator: impl FnOnce(&mut Value) -> Result<(), String>) -> Result<Value, String> {
    let path = as_store_path(root, payload)?;
    let raw = read_json(&path);
    let mut state = normalize_state(Some(&raw), Some(&default_strategy_state()));
    mutator(&mut state)?;
    let normalized = normalize_state(Some(&state), Some(&default_strategy_state()));
    write_json_atomic(&path, &normalized)?;
    let meta = as_object(payload.get("meta"));
    append_mutation_log(root, "set", DEFAULT_REL_PATH, Some(&normalized), meta, reason)?;
    emit_strategy_pointer(root, meta)?;
    Ok(normalized)
}

fn upsert_profile(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let mut action = "none".to_string();
    let mut profile_out = Value::Null;
    let state = mutate_state(root, payload, "upsert_profile", |state| {
        let ts = now_iso();
        let allow_elevated = payload
            .get("meta")
            .and_then(Value::as_object)
            .and_then(|m| m.get("allow_elevated_mode"))
            .and_then(Value::as_bool)
            == Some(true);
        let incoming = validate_profile_input(payload.get("profile").and_then(Value::as_object), allow_elevated)?;
        let incoming_id = as_str(incoming.get("id"));
        let max_profiles = state.pointer("/policy/max_profiles").and_then(Value::as_i64).unwrap_or(64) as usize;
        let mut updated_metric = 0_i64;
        let mut created_metric = 0_i64;
        {
            let profiles = state["profiles"]
                .as_array_mut()
                .ok_or_else(|| "strategy_store: profiles_missing".to_string())?;
            if let Some(idx) = profiles.iter().position(|row| as_str(row.get("id")) == incoming_id) {
                let existing = normalize_profile(profiles[idx].as_object(), &ts);
                let mut merged = incoming.clone();
                merged["usage"] = if existing.get("usage").map(Value::is_object).unwrap_or(false) {
                    let mut usage = existing.get("usage").cloned().unwrap_or_else(|| json!({}));
                    if let Some(incoming_usage) = incoming.get("usage").and_then(Value::as_object) {
                        for (key, value) in incoming_usage {
                            usage[key] = value.clone();
                        }
                    }
                    usage
                } else {
                    incoming.get("usage").cloned().unwrap_or_else(|| json!({}))
                };
                merged["created_ts"] = existing
                    .get("created_ts")
                    .cloned()
                    .unwrap_or_else(|| Value::String(ts.clone()));
                merged["updated_ts"] = Value::String(ts.clone());
                profiles[idx] = normalize_profile(merged.as_object(), &ts);
                action = "updated".to_string();
                profile_out = profiles[idx].clone();
                updated_metric = 1;
            } else {
                let mut created_map = incoming.as_object().cloned().unwrap_or_default();
                created_map.insert("created_ts".to_string(), Value::String(ts.clone()));
                created_map.insert("updated_ts".to_string(), Value::String(ts.clone()));
                let created = normalize_profile(Some(&created_map), &ts);
                profiles.push(created.clone());
                action = "created".to_string();
                profile_out = created;
                created_metric = 1;
            }
            if profiles.len() > max_profiles {
                profiles.sort_by(|a, b| {
                    parse_ts_ms(&as_str(a.get("updated_ts")))
                        .unwrap_or(0)
                        .cmp(&parse_ts_ms(&as_str(b.get("updated_ts"))).unwrap_or(0))
                });
                let keep_from = profiles.len() - max_profiles;
                profiles.drain(0..keep_from);
            }
            profiles.sort_by(|a, b| as_str(a.get("id")).cmp(&as_str(b.get("id"))));
        }
        if updated_metric > 0 {
            state["metrics"]["total_profiles_updated"] = Value::from(
                clamp_i64(state.pointer("/metrics/total_profiles_updated"), 0, 100_000_000, 0) + updated_metric,
            );
        }
        if created_metric > 0 {
            state["metrics"]["total_profiles_created"] = Value::from(
                clamp_i64(state.pointer("/metrics/total_profiles_created"), 0, 100_000_000, 0) + created_metric,
            );
        }
        Ok(())
    })?;
    Ok(json!({"state": state, "action": action, "profile": profile_out}))
}

fn intake_signal(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let mut action = "none".to_string();
    let mut queue_item = Value::Null;
    let state = mutate_state(root, payload, "intake_signal", |state| {
        let ts = now_iso();
        let mut intake_map = payload
            .get("intake")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_else(|| payload.clone());
        intake_map.insert("created_ts".to_string(), Value::String(ts.clone()));
        intake_map.insert("updated_ts".to_string(), Value::String(ts.clone()));
        let mut item = normalize_queue_item(Some(&intake_map), &ts);
        let drops = queue_drop_reasons(&item, &state["policy"], Utc::now().timestamp_millis());
        if !drops.is_empty() {
            item["status"] = Value::String("dropped".to_string());
            item["drop_reason"] = Value::String(drops.join(","));
        }
        let max_queue = state.pointer("/policy/max_queue").and_then(Value::as_i64).unwrap_or(64) as usize;
        let intake_recorded = {
            let queue = state["intake_queue"]
                .as_array_mut()
                .ok_or_else(|| "strategy_store: intake_queue_missing".to_string())?;
            if let Some(existing) = queue.iter().find(|row| {
                as_str(row.get("fingerprint")) == as_str(item.get("fingerprint"))
                    && as_str(row.get("status")) == "queued"
            }) {
                action = "deduped".to_string();
                queue_item = existing.clone();
                return Ok(());
            }
            queue.push(item.clone());
            queue.sort_by(|a, b| {
                parse_ts_ms(&as_str(a.get("created_ts")))
                    .unwrap_or(0)
                    .cmp(&parse_ts_ms(&as_str(b.get("created_ts"))).unwrap_or(0))
            });
            if queue.len() > max_queue {
                let drop_count = queue.len() - max_queue;
                queue.drain(0..drop_count);
            }
            true
        };
        if intake_recorded {
            state["metrics"]["total_intakes"] = Value::from(
                clamp_i64(state.pointer("/metrics/total_intakes"), 0, 100_000_000, 0) + 1,
            );
        }
        action = if as_str(item.get("status")) == "dropped" { "dropped".to_string() } else { "queued".to_string() };
        queue_item = item;
        Ok(())
    })?;
    Ok(json!({"state": state, "action": action, "queue_item": queue_item}))
}

fn materialize_from_queue(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let qid = as_str(payload.get("queue_uid"));
    if qid.is_empty() {
        return Err("strategy_store: queue_uid_required".to_string());
    }
    let mut action = "none".to_string();
    let mut profile_out = Value::Null;
    let mut queue_out = Value::Null;
    let state = mutate_state(root, payload, "materialize_from_queue", |state| {
        let ts = now_iso();
        let queue_item = {
            let queue = state["intake_queue"]
                .as_array_mut()
                .ok_or_else(|| "strategy_store: intake_queue_missing".to_string())?;
            let idx = queue
                .iter()
                .position(|row| as_str(row.get("uid")) == qid)
                .ok_or_else(|| format!("strategy_store: queue_item_not_found:{qid}"))?;
            normalize_queue_item(queue[idx].as_object(), &ts)
        };
        if as_str(queue_item.get("status")) != "queued" {
            return Err(format!("strategy_store: queue_item_not_queued:{qid}"));
        }
        let mut draft_input = payload
            .get("draft")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        draft_input.insert(
            "source".to_string(),
            Value::String(clean_text(draft_input.get("source"), 80).if_empty_then(&clean_text(queue_item.get("source"), 80).if_empty_then("adaptive_intake"))),
        );
        draft_input.insert("queue_ref".to_string(), Value::String(qid.clone()));
        draft_input.insert(
            "generated_mode".to_string(),
            Value::String(normalize_mode(
                draft_input.get("generated_mode")
                    .or_else(|| draft_input.get("generation_mode"))
                    .or_else(|| queue_item.get("recommended_generation_mode")),
                Some("hyper-creative"),
            )),
        );
        let mut tags = draft_input
            .get("tags")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        tags.push(Value::String("adaptive".to_string()));
        tags.push(Value::String("strategy".to_string()));
        draft_input.insert("tags".to_string(), Value::Array(tags));
        if payload
            .get("meta")
            .and_then(Value::as_object)
            .and_then(|m| m.get("allow_elevated_mode"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            draft_input.insert("allow_elevated_mode".to_string(), Value::Bool(true));
        }
        draft_input.insert("created_ts".to_string(), Value::String(ts.clone()));
        draft_input.insert("updated_ts".to_string(), Value::String(ts.clone()));
        let allow_elevated_mode = payload
            .get("meta")
            .and_then(Value::as_object)
            .and_then(|m| m.get("allow_elevated_mode"))
            .and_then(Value::as_bool)
            == Some(true);
        let upsert = validate_profile_input(Some(&draft_input), allow_elevated_mode)?;
        let upsert_id = as_str(upsert.get("id"));
        let mut created_metric = 0_i64;
        let mut updated_metric = 0_i64;
        {
            let profiles = state["profiles"]
                .as_array_mut()
                .ok_or_else(|| "strategy_store: profiles_missing".to_string())?;
            if let Some(existing_idx) = profiles.iter().position(|row| as_str(row.get("id")) == upsert_id) {
                let prev = normalize_profile(profiles[existing_idx].as_object(), &ts);
                let mut merged = upsert.as_object().cloned().unwrap_or_default();
                merged.insert(
                    "created_ts".to_string(),
                    prev.get("created_ts")
                        .cloned()
                        .unwrap_or_else(|| Value::String(ts.clone())),
                );
                merged.insert(
                    "usage".to_string(),
                    prev.get("usage").cloned().unwrap_or_else(|| json!({})),
                );
                profiles[existing_idx] = normalize_profile(Some(&merged), &ts);
                action = "updated".to_string();
                profile_out = profiles[existing_idx].clone();
                updated_metric = 1;
            } else {
                profiles.push(upsert.clone());
                action = "created".to_string();
                profile_out = upsert.clone();
                created_metric = 1;
            }
            profiles.sort_by(|a, b| as_str(a.get("id")).cmp(&as_str(b.get("id"))));
        }
        let mut consumed = queue_item.clone();
        consumed["status"] = Value::String("consumed".to_string());
        consumed["updated_ts"] = Value::String(ts.clone());
        consumed["consumed_ts"] = Value::String(ts.clone());
        consumed["linked_strategy_id"] = profile_out.get("id").cloned().unwrap_or(Value::Null);
        consumed["attempts"] = Value::from(clamp_i64(queue_item.get("attempts"), 0, 1000, 0) + 1);
        consumed["work_packet"] = ensure_work_packet(&consumed);
        {
            let queue = state["intake_queue"]
                .as_array_mut()
                .ok_or_else(|| "strategy_store: intake_queue_missing".to_string())?;
            let idx = queue
                .iter()
                .position(|row| as_str(row.get("uid")) == qid)
                .ok_or_else(|| format!("strategy_store: queue_item_not_found:{qid}"))?;
            queue[idx] = consumed.clone();
        }
        if updated_metric > 0 {
            state["metrics"]["total_profiles_updated"] = Value::from(
                clamp_i64(state.pointer("/metrics/total_profiles_updated"), 0, 100_000_000, 0)
                    + updated_metric,
            );
        }
        if created_metric > 0 {
            state["metrics"]["total_profiles_created"] = Value::from(
                clamp_i64(state.pointer("/metrics/total_profiles_created"), 0, 100_000_000, 0)
                    + created_metric,
            );
        }
        state["metrics"]["total_queue_consumed"] = Value::from(
            clamp_i64(state.pointer("/metrics/total_queue_consumed"), 0, 100_000_000, 0) + 1,
        );
        queue_out = consumed;
        Ok(())
    })?;
    Ok(json!({"state": state, "action": action, "profile": profile_out, "queue_item": queue_out}))
}

fn touch_profile_usage(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let sid = normalize_key(&as_str(payload.get("strategy_id")), 40);
    if sid.is_empty() {
        return Err("strategy_store: strategy_id_required".to_string());
    }
    let touch_ts = payload
        .get("ts")
        .and_then(|v| parse_ts_ms(&as_str(Some(v))).map(|_| as_str(Some(v))))
        .unwrap_or_else(now_iso);
    let mut profile_out = Value::Null;
    let state = mutate_state(root, payload, "touch_profile_usage", |state| {
        let profiles = state["profiles"].as_array_mut().ok_or_else(|| "strategy_store: profiles_missing".to_string())?;
        let idx = profiles.iter().position(|row| as_str(row.get("id")) == sid).ok_or_else(|| format!("strategy_store: strategy_not_found:{sid}"))?;
        let mut profile = normalize_profile(profiles[idx].as_object(), &touch_ts);
        let mut usage = normalize_usage(profile.get("usage").and_then(Value::as_object), &touch_ts);
        let mut events = usage.get("use_events").and_then(Value::as_array).cloned().unwrap_or_default();
        events.push(Value::String(touch_ts.clone()));
        if events.len() > 256 {
            events = events.split_off(events.len() - 256);
        }
        let cutoff = parse_ts_ms(&touch_ts).unwrap_or(0) - (30_i64 * 24 * 60 * 60 * 1000);
        let uses_30 = events.iter().filter(|row| parse_ts_ms(&as_str(Some(row))).map(|ms| ms >= cutoff).unwrap_or(false)).count() as i64;
        usage["use_events"] = Value::Array(events);
        usage["uses_total"] = Value::from(clamp_i64(usage.get("uses_total"), 0, 100_000_000, 0) + 1);
        usage["uses_30d"] = Value::from(uses_30);
        usage["last_used_ts"] = Value::String(touch_ts.clone());
        usage["last_usage_sync_ts"] = Value::String(touch_ts.clone());
        profile["usage"] = usage;
        profile["updated_ts"] = Value::String(touch_ts.clone());
        profiles[idx] = profile.clone();
        profile_out = profile;
        Ok(())
    })?;
    Ok(json!({"state": state, "profile": profile_out}))
}

fn evaluate_gc_candidates_value(state: &Value, opts: Option<&Map<String, Value>>) -> Value {
    let policy = state.get("policy").cloned().unwrap_or_else(|| default_strategy_state()["policy"].clone());
    let opts = opts.unwrap_or_else(|| {
        static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
        EMPTY.get_or_init(Map::new)
    });
    let now_ms = Utc::now().timestamp_millis();
    let inactive_days = clamp_i64(opts.get("inactive_days"), 1, 365, clamp_i64(policy.get("gc_inactive_days"), 1, 365, 21));
    let min_uses_30d = clamp_i64(opts.get("min_uses_30d"), 0, 1000, clamp_i64(policy.get("gc_min_uses_30d"), 0, 1000, 1));
    let protect_new_days = clamp_i64(opts.get("protect_new_days"), 0, 90, clamp_i64(policy.get("gc_protect_new_days"), 0, 90, 3));
    let mut candidates = Vec::new();
    let mut keepers = Vec::new();
    for profile in state.get("profiles").and_then(Value::as_array).cloned().unwrap_or_default() {
        let profile = normalize_profile(profile.as_object(), &now_iso());
        let usage = profile.get("usage").cloned().unwrap_or_else(|| json!({}));
        let last_used = usage.get("last_used_ts").and_then(|v| parse_ts_ms(&as_str(Some(v))));
        let created = profile.get("created_ts").and_then(|v| parse_ts_ms(&as_str(Some(v))));
        let age_days = last_used.map(|ms| (now_ms - ms) as f64 / (24.0 * 60.0 * 60.0 * 1000.0));
        let new_age_days = created.map(|ms| (now_ms - ms) as f64 / (24.0 * 60.0 * 60.0 * 1000.0));
        let uses_30 = clamp_i64(usage.get("uses_30d"), 0, 1000, 0);
        let stale = age_days.map(|days| days > inactive_days as f64).unwrap_or(true);
        let low_use = uses_30 < min_uses_30d;
        let protected_new = new_age_days.map(|days| days < protect_new_days as f64).unwrap_or(false);
        let removable = stale && low_use && !protected_new && as_str(profile.get("status")) != "active";
        let row = json!({
            "id": profile.get("id").cloned().unwrap_or(Value::Null),
            "uid": profile.get("uid").cloned().unwrap_or(Value::Null),
            "status": profile.get("status").cloned().unwrap_or(Value::Null),
            "stage": profile.get("stage").cloned().unwrap_or(Value::Null),
            "age_days_since_last_use": age_days.map(|days| (days * 1000.0).round() / 1000.0),
            "age_days_since_created": new_age_days.map(|days| (days * 1000.0).round() / 1000.0),
            "uses_30d": uses_30,
            "removable": removable,
            "reason": if removable {
                format!("stale>{inactive_days}d and uses_30d<{min_uses_30d}")
            } else if protected_new {
                format!("protected_new<{protect_new_days}d")
            } else if stale {
                format!("uses_30d>={min_uses_30d}")
            } else {
                format!("last_used<={inactive_days}d")
            }
        });
        if removable {
            candidates.push(row);
        } else {
            keepers.push(row);
        }
    }
    json!({
        "policy": {
            "inactive_days": inactive_days,
            "min_uses_30d": min_uses_30d,
            "protect_new_days": protect_new_days,
        },
        "candidates": candidates,
        "keepers": keepers,
    })
}

fn gc_profiles(root: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let apply = payload.get("apply").and_then(Value::as_bool) == Some(true);
    let mut summary = Value::Null;
    let state = mutate_state(root, payload, if apply { "gc_profiles_apply" } else { "gc_profiles_preview" }, |state| {
        let evals = evaluate_gc_candidates_value(state, payload.get("opts").and_then(Value::as_object).or_else(|| as_object(payload.get("gc_opts"))).or_else(|| as_object(payload.get("options"))).or_else(|| as_object(payload.get("payload"))));
        summary = evals.clone();
        if !apply {
            return Ok(());
        }
        let remove_ids = evals
            .get("candidates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .map(|row| as_str(row.get("id")))
            .collect::<Vec<_>>();
        if remove_ids.is_empty() {
            return Ok(());
        }
        let profiles = state["profiles"].as_array_mut().ok_or_else(|| "strategy_store: profiles_missing".to_string())?;
        profiles.retain(|row| !remove_ids.iter().any(|id| id == &as_str(row.get("id"))));
        state["metrics"]["total_gc_deleted"] = Value::from(clamp_i64(state.pointer("/metrics/total_gc_deleted"), 0, 100_000_000, 0) + remove_ids.len() as i64);
        state["metrics"]["last_gc_ts"] = Value::String(now_iso());
        Ok(())
    })?;
    Ok(json!({
        "state": state,
        "apply": apply,
        "policy": summary.get("policy").cloned().unwrap_or(Value::Null),
        "removed": summary.get("candidates").cloned().unwrap_or_else(|| json!([])),
        "kept": summary.get("keepers").cloned().unwrap_or_else(|| json!([])),
    }))
}

fn run_command(root: &Path, command: &str, payload: &Map<String, Value>) -> Result<Value, String> {
    match command {
        "paths" => Ok(json!({
            "default_rel_path": DEFAULT_REL_PATH,
            "default_abs_path": default_abs_path(root).to_string_lossy(),
            "store_abs_path": store_abs_path(root).to_string_lossy(),
        })),
        "default-state" => Ok(default_strategy_state()),
        "default-draft" => Ok(default_strategy_draft(payload.get("seed").and_then(Value::as_object).or_else(|| Some(payload)))),
        "normalize-mode" => Ok(json!({"mode": normalize_mode(payload.get("value").or_else(|| payload.get("mode")), Some(&as_str(payload.get("fallback")).if_empty_then("hyper-creative")))})),
        "normalize-execution-mode" => Ok(json!({"mode": normalize_execution_mode(payload.get("value").or_else(|| payload.get("mode")), Some(&as_str(payload.get("fallback")).if_empty_then("score_only")))})),
        "normalize-profile" => {
            let now_ts = payload
                .get("now_ts")
                .and_then(|v| parse_ts_ms(&as_str(Some(v))).map(|_| as_str(Some(v))))
                .unwrap_or_else(now_iso);
            Ok(normalize_profile(
                payload.get("profile").and_then(Value::as_object).or_else(|| Some(payload)),
                &now_ts,
            ))
        }
        "validate-profile" => validate_profile_input(
            payload.get("profile").and_then(Value::as_object).or_else(|| Some(payload)),
            payload.get("allow_elevated_mode").and_then(Value::as_bool).unwrap_or(false),
        ),
        "normalize-queue-item" => {
            let now_ts = payload
                .get("now_ts")
                .and_then(|v| parse_ts_ms(&as_str(Some(v))).map(|_| as_str(Some(v))))
                .unwrap_or_else(now_iso);
            Ok(normalize_queue_item(
                payload.get("item").and_then(Value::as_object).or_else(|| Some(payload)),
                &now_ts,
            ))
        }
        "recommend-mode" => Ok(json!({"mode": recommend_mode(&clean_text(payload.get("summary"), 220), &clean_text(payload.get("text"), 6000))})),
        "read-state" => read_state(root, payload),
        "ensure-state" => ensure_state(root, payload),
        "set-state" => set_state(root, payload),
        "upsert-profile" => upsert_profile(root, payload),
        "intake-signal" => intake_signal(root, payload),
        "materialize-from-queue" => materialize_from_queue(root, payload),
        "touch-profile-usage" => touch_profile_usage(root, payload),
        "evaluate-gc-candidates" => {
            let state = if let Some(raw_state) = payload.get("state") {
                normalize_state(Some(raw_state), Some(&default_strategy_state()))
            } else {
                let path = as_store_path(root, payload)?;
                let raw = read_json(&path);
                normalize_state(Some(&raw), Some(&default_strategy_state()))
            };
            Ok(evaluate_gc_candidates_value(
                &state,
                payload
                    .get("opts")
                    .and_then(Value::as_object)
                    .or_else(|| Some(payload)),
            ))
        }
        "gc-profiles" => gc_profiles(root, payload),
        _ => Err("strategy_store_kernel_unknown_command".to_string()),
    }
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let Some(command) = argv.first().map(|v| v.as_str()) else {
        usage();
        return 1;
    };
    if matches!(command, "help" | "--help" | "-h") {
        usage();
        return 0;
    }
    let payload = match payload_json(argv) {
        Ok(value) => value,
        Err(err) => {
            print_json_line(&cli_error("strategy_store_kernel", &err));
            return 1;
        }
    };
    let payload = payload_obj(&payload).clone();
    match run_command(root, command, &payload) {
        Ok(out) => {
            print_json_line(&cli_receipt("strategy_store_kernel", out));
            0
        }
        Err(err) => {
            print_json_line(&cli_error("strategy_store_kernel", &err));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "strategy-store-kernel-{}-{}-{}",
            name,
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn normalize_profile_forces_score_only_without_override() {
        let normalized = normalize_profile(
            Some(payload_obj(&json!({
                "id": "ship_it",
                "execution_mode": "execute",
                "draft": {"objective": {"primary": "Ship it"}}
            }))),
            &now_iso(),
        );
        assert_eq!(normalized.pointer("/draft/execution_policy/mode").and_then(Value::as_str), Some("score_only"));
        assert_eq!(normalized.get("elevated_mode_forced_down").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn intake_materialize_touch_and_gc_round_trip() {
        let root = temp_root("roundtrip");
        let intake = run_command(
            &root,
            "intake-signal",
            payload_obj(&json!({
                "intake": {
                    "source": "manual",
                    "kind": "signal",
                    "summary": "Investigate durable execution for strategy queue",
                    "text": "Need a durable strategy queue with clear ownership.",
                    "evidence_refs": ["doc://proof"]
                }
            })),
        ).unwrap();
        assert_eq!(intake.get("action").and_then(Value::as_str), Some("queued"));
        let qid = intake.pointer("/queue_item/uid").and_then(Value::as_str).unwrap().to_string();

        let materialized = run_command(
            &root,
            "materialize-from-queue",
            payload_obj(&json!({
                "queue_uid": qid,
                "draft": {
                    "id": "durable_queue",
                    "name": "Durable Queue",
                    "draft": {"objective": {"primary": "Ship durable queue"}}
                }
            })),
        ).unwrap();
        assert_eq!(materialized.get("action").and_then(Value::as_str), Some("created"));
        let strategy_id = materialized.pointer("/profile/id").and_then(Value::as_str).unwrap().to_string();

        let touched = run_command(
            &root,
            "touch-profile-usage",
            payload_obj(&json!({"strategy_id": strategy_id, "ts": "2026-03-17T12:00:00Z"})),
        ).unwrap();
        assert_eq!(touched.pointer("/profile/usage/uses_total").and_then(Value::as_i64), Some(1));

        let gc = run_command(&root, "evaluate-gc-candidates", payload_obj(&json!({}))).unwrap();
        assert_eq!(gc.get("candidates").and_then(Value::as_array).map(|rows| rows.len()), Some(0));
    }

    #[test]
    fn ensure_state_writes_mutation_artifacts() {
        let root = temp_root("ensure");
        let state = run_command(&root, "ensure-state", payload_obj(&json!({}))).unwrap();
        assert!(state.get("policy").is_some());
        assert!(mutation_log_path(&root).exists());
        assert!(pointers_path(&root).exists());
        assert!(pointer_index_path(&root).exists());
    }
}
