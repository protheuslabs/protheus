// SPDX-License-Identifier: Apache-2.0
use crate::importance::{band_rank, infer_from_event, to_json as importance_to_json};
use crate::{deterministic_receipt_hash, now_iso};
use base64::Engine;
use chrono::{TimeZone, Utc};
use execution_core::{evaluate_importance_json, prioritize_attention_json};
use serde_json::{json, Value};
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Debug, Clone)]
struct AttentionContract {
    enabled: bool,
    push_attention_queue: bool,
    queue_path: PathBuf,
    receipts_path: PathBuf,
    latest_path: PathBuf,
    cursor_state_path: PathBuf,
    max_queue_depth: usize,
    max_batch_size: usize,
    ttl_hours: i64,
    dedupe_window_hours: i64,
    backpressure_drop_below: String,
    escalate_levels: Vec<String>,
    priority_map: BTreeMap<String, i64>,
    require_layer2_authority: bool,
}

#[derive(Debug, Clone)]
struct Layer2ImportanceDecision {
    score: f64,
    band: String,
    priority: i64,
    front_jump: bool,
    initiative_action: String,
    initiative_repeat_after_sec: i64,
    initiative_max_messages: i64,
}

fn usage() {
    eprintln!("Usage:");
    eprintln!(
        "  protheus-ops attention-queue enqueue --event-json-base64=<base64> [--run-context=<value>]"
    );
    eprintln!("  protheus-ops attention-queue enqueue --event-json=<json> [--run-context=<value>]");
    eprintln!("  protheus-ops attention-queue status");
    eprintln!(
        "  protheus-ops attention-queue next [--consumer=<id>] [--limit=<n>] [--wait-ms=<n>] [--run-context=<value>]"
    );
    eprintln!(
        "  protheus-ops attention-queue ack --consumer=<id> --through-index=<n> --cursor-token=<token> [--run-context=<value>]"
    );
    eprintln!(
        "  protheus-ops attention-queue drain [--consumer=<id>] [--limit=<n>] [--wait-ms=<n>] [--run-context=<value>]"
    );
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            serde_json::from_str::<Value>(trimmed).ok()
        })
        .collect()
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

fn write_jsonl(path: &Path, rows: &[Value]) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let mut out = String::new();
    for row in rows {
        if let Ok(line) = serde_json::to_string(row) {
            out.push_str(&line);
            out.push('\n');
        }
    }
    let _ = fs::write(path, out);
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
            .and_then(|mut file| {
                std::io::Write::write_all(&mut file, format!("{line}\n").as_bytes())
            });
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

fn normalize_consumer_id(raw: Option<&str>) -> String {
    let mut out = String::new();
    for ch in raw.unwrap_or_default().trim().chars() {
        let keep = ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':' | '@');
        if keep {
            out.push(ch.to_ascii_lowercase());
        } else if !out.ends_with('_') {
            out.push('_');
        }
        if out.len() >= 80 {
            break;
        }
    }
    out.trim_matches('_').to_string()
}

fn parse_limit(raw: Option<&String>, fallback: usize, max: usize) -> usize {
    let parsed = raw
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(fallback);
    parsed.clamp(1, max)
}

fn parse_wait_ms(raw: Option<&String>, fallback: u64, max: u64) -> u64 {
    let parsed = raw
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(fallback);
    parsed.clamp(0, max)
}

fn parse_through_index(raw: Option<&String>) -> Option<usize> {
    raw.and_then(|v| v.trim().parse::<usize>().ok())
}

fn severity_rank(raw: &str) -> i64 {
    match raw.trim().to_ascii_lowercase().as_str() {
        "critical" => 3,
        "warn" | "warning" => 2,
        "info" => 1,
        _ => 1,
    }
}

fn attention_lane_rank(raw: &str) -> i64 {
    match raw.trim().to_ascii_lowercase().as_str() {
        "critical" => 3,
        "standard" => 2,
        "background" => 1,
        _ => 2,
    }
}

fn classify_attention_lane(
    source: &str,
    source_type: &str,
    severity: &str,
    summary: &str,
    band: &str,
) -> String {
    let normalized_severity = normalize_severity(Some(severity));
    let normalized_band = band.trim().to_ascii_lowercase();
    let normalized_source = source.trim().to_ascii_lowercase();
    let normalized_source_type = source_type.trim().to_ascii_lowercase();
    let normalized_summary = summary.trim().to_ascii_lowercase();
    let is_critical_summary = normalized_summary.contains("fail")
        || normalized_summary.contains("error")
        || normalized_summary.contains("critical")
        || normalized_summary.contains("degraded")
        || normalized_summary.contains("alert")
        || normalized_summary.contains("benchmark_sanity")
        || normalized_summary.contains("backpressure")
        || normalized_summary.contains("throttle")
        || normalized_summary.contains("stale");
    if normalized_severity == "critical"
        || normalized_severity == "warn"
        || normalized_band == "p0"
        || normalized_band == "p1"
        || is_critical_summary
    {
        return "critical".to_string();
    }
    let background_source = normalized_source_type.contains("receipt")
        || normalized_source_type.contains("audit")
        || normalized_source_type.contains("timeline")
        || normalized_source_type.contains("history")
        || normalized_source_type.contains("log")
        || normalized_source_type.contains("trace")
        || normalized_source.contains("receipt")
        || normalized_source.contains("audit")
        || normalized_source.contains("timeline")
        || normalized_source.contains("history")
        || normalized_source.contains("log")
        || normalized_source.contains("trace");
    let background_band =
        normalized_severity == "info" && (normalized_band == "p3" || normalized_band == "p4");
    if background_source || background_band {
        "background".to_string()
    } else {
        "standard".to_string()
    }
}

fn parse_ts_ms(raw: &str) -> Option<i64> {
    chrono::DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|dt| dt.timestamp_millis())
}

fn ts_ms_to_iso(ts_ms: i64) -> String {
    Utc.timestamp_millis_opt(ts_ms)
        .single()
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
        .unwrap_or_else(now_iso)
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

fn normalize_severity(raw: Option<&str>) -> String {
    match raw.unwrap_or_default().trim().to_ascii_lowercase().as_str() {
        "critical" => "critical".to_string(),
        "warn" | "warning" => "warn".to_string(),
        "info" => "info".to_string(),
        _ => "info".to_string(),
    }
}

fn parse_f64(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .and_then(|n| if n.is_finite() { Some(n) } else { None })
}

fn parse_layer2_importance(raw: &str) -> Option<Layer2ImportanceDecision> {
    let parsed = serde_json::from_str::<Value>(raw).ok()?;
    if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let score = parsed.get("score").and_then(Value::as_f64)?;
    let band = parsed
        .get("band")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| "p4".to_string());
    let priority = parsed
        .get("priority")
        .and_then(Value::as_i64)
        .unwrap_or_else(|| ((score * 1000.0).round() as i64).clamp(1, 1000))
        .clamp(1, 1000);
    let front_jump = parsed
        .get("front_jump")
        .and_then(Value::as_bool)
        .unwrap_or(score >= 0.70);
    let initiative_action = parsed
        .get("initiative_action")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| "silent".to_string());
    let initiative_repeat_after_sec = parsed
        .get("initiative_repeat_after_sec")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    let initiative_max_messages = parsed
        .get("initiative_max_messages")
        .and_then(Value::as_i64)
        .unwrap_or(0)
        .max(0);
    Some(Layer2ImportanceDecision {
        score: score.clamp(0.0, 1.0),
        band,
        priority,
        front_jump,
        initiative_action,
        initiative_repeat_after_sec,
        initiative_max_messages,
    })
}

fn evaluate_importance_via_layer2(
    event: &Value,
    fallback: &crate::importance::ImportanceDecision,
) -> Option<Layer2ImportanceDecision> {
    let payload = json!({
        "criticality": fallback.criticality,
        "urgency": fallback.urgency,
        "impact": fallback.impact,
        "user_relevance": fallback.user_relevance,
        "confidence": fallback.confidence,
        "core_floor": fallback.core_floor,
        "inherited_score": event.pointer("/importance/score").and_then(Value::as_f64).unwrap_or(fallback.score),
        "front_jump_threshold": 0.70
    });
    let encoded = serde_json::to_string(&payload).ok()?;
    let raw = evaluate_importance_json(&encoded).ok()?;
    parse_layer2_importance(&raw)
}

fn prioritize_rows_via_layer2(rows: &[Value]) -> Option<Vec<Value>> {
    let payload = json!({
        "events": rows,
        "front_jump_threshold": 0.70
    });
    let encoded = serde_json::to_string(&payload).ok()?;
    let raw = prioritize_attention_json(&encoded).ok()?;
    let parsed = serde_json::from_str::<Value>(&raw).ok()?;
    if parsed.get("ok").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    parsed
        .get("events")
        .and_then(Value::as_array)
        .map(|arr| arr.to_vec())
}

fn event_score(row: &Value) -> f64 {
    parse_f64(
        row.pointer("/importance/score")
            .or_else(|| row.get("score")),
    )
    .unwrap_or_else(|| {
        let sev = row
            .get("severity")
            .and_then(Value::as_str)
            .unwrap_or("info")
            .trim()
            .to_ascii_lowercase();
        if sev == "critical" {
            0.85
        } else if sev == "warn" {
            0.60
        } else {
            0.35
        }
    })
    .clamp(0.0, 1.0)
}

fn event_band_rank(row: &Value) -> i64 {
    let band = row
        .pointer("/importance/band")
        .and_then(Value::as_str)
        .or_else(|| row.get("band").and_then(Value::as_str))
        .unwrap_or("p4");
    let rank = band_rank(band);
    if rank > 0 {
        rank
    } else {
        let sev = row
            .get("severity")
            .and_then(Value::as_str)
            .unwrap_or("info")
            .trim()
            .to_ascii_lowercase();
        if sev == "critical" {
            band_rank("p1")
        } else if sev == "warn" {
            band_rank("p2")
        } else {
            band_rank("p4")
        }
    }
}

fn event_priority(row: &Value) -> i64 {
    row.get("priority")
        .and_then(Value::as_i64)
        .unwrap_or(20)
        .clamp(1, 1000)
}

fn event_attention_lane_rank(row: &Value) -> i64 {
    let lane = row
        .get("queue_lane")
        .and_then(Value::as_str)
        .unwrap_or("standard");
    attention_lane_rank(lane)
}

fn event_deadline_ts_ms(row: &Value) -> i64 {
    let direct = row
        .get("deadline_at")
        .and_then(Value::as_str)
        .and_then(parse_ts_ms);
    let raw_event = row
        .pointer("/raw_event/deadline_at")
        .and_then(Value::as_str)
        .and_then(parse_ts_ms);
    direct.or(raw_event).unwrap_or(i64::MAX)
}

fn event_ts_ms(row: &Value) -> i64 {
    row.get("ts")
        .and_then(Value::as_str)
        .and_then(parse_ts_ms)
        .unwrap_or(i64::MAX)
}

fn event_attention_key(row: &Value) -> String {
    row.get("attention_key")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
        .unwrap_or_default()
}

fn sort_active_rows(rows: &mut [Value]) {
    rows.sort_by(|a, b| {
        event_attention_lane_rank(b)
            .cmp(&event_attention_lane_rank(a))
            .then_with(|| event_band_rank(b).cmp(&event_band_rank(a)))
            .then_with(|| event_priority(b).cmp(&event_priority(a)))
            .then_with(|| {
                event_score(b)
                    .partial_cmp(&event_score(a))
                    .unwrap_or(Ordering::Equal)
            })
            .then_with(|| event_deadline_ts_ms(a).cmp(&event_deadline_ts_ms(b)))
            .then_with(|| event_ts_ms(a).cmp(&event_ts_ms(b)))
            .then_with(|| event_attention_key(a).cmp(&event_attention_key(b)))
    });
}

fn sort_active_rows_with_authority(rows: &mut Vec<Value>) {
    if let Some(prioritized) = prioritize_rows_via_layer2(rows.as_slice()) {
        *rows = prioritized;
        return;
    }
    sort_active_rows(rows.as_mut_slice());
}

fn default_priority_map() -> BTreeMap<String, i64> {
    let mut out = BTreeMap::new();
    out.insert("critical".to_string(), 100);
    out.insert("warn".to_string(), 60);
    out.insert("info".to_string(), 20);
    out
}

fn load_contract(root: &Path) -> AttentionContract {
    let default_policy = root.join("config").join("mech_suit_mode_policy.json");
    let policy_path = std::env::var("MECH_SUIT_MODE_POLICY_PATH")
        .ok()
        .map(PathBuf::from)
        .map(|p| if p.is_absolute() { p } else { root.join(p) })
        .unwrap_or(default_policy);
    let policy = read_json(&policy_path).unwrap_or_else(|| json!({}));
    let enabled = bool_from_env("MECH_SUIT_MODE_FORCE").unwrap_or_else(|| {
        policy
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true)
    });
    let eyes = policy.get("eyes").and_then(Value::as_object);
    let contract_obj = eyes
        .and_then(|v| v.get("attention_contract"))
        .and_then(Value::as_object);

    let mut priority_map = default_priority_map();
    if let Some(obj) = contract_obj
        .and_then(|v| v.get("priority_map"))
        .and_then(Value::as_object)
    {
        for (k, v) in obj {
            if let Some(n) = v.as_i64() {
                priority_map.insert(k.trim().to_ascii_lowercase(), n.clamp(1, 1000));
            }
        }
    }

    let escalate_levels = contract_obj
        .and_then(|v| v.get("escalate_levels"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|row| row.trim().to_ascii_lowercase())
                .filter(|row| !row.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|rows| !rows.is_empty())
        .unwrap_or_else(|| vec!["critical".to_string()]);
    let allow_layer0_fallback = bool_from_env("PROTHEUS_ATTENTION_ALLOW_LAYER0_FALLBACK")
        .or_else(|| {
            contract_obj
                .and_then(|v| v.get("allow_layer0_importance_fallback"))
                .and_then(Value::as_bool)
        })
        .unwrap_or(false);

    AttentionContract {
        enabled,
        push_attention_queue: eyes
            .and_then(|v| v.get("push_attention_queue"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        queue_path: normalize_path(
            root,
            eyes.and_then(|v| v.get("attention_queue_path")),
            "local/state/attention/queue.jsonl",
        ),
        receipts_path: normalize_path(
            root,
            eyes.and_then(|v| v.get("receipts_path")),
            "local/state/attention/receipts.jsonl",
        ),
        latest_path: normalize_path(
            root,
            eyes.and_then(|v| v.get("latest_path")),
            "local/state/attention/latest.json",
        ),
        cursor_state_path: normalize_path(
            root,
            contract_obj.and_then(|v| v.get("cursor_state_path")),
            "local/state/attention/cursor_state.json",
        ),
        max_queue_depth: contract_obj
            .and_then(|v| v.get("max_queue_depth"))
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(2048)
            .clamp(1, 200_000),
        max_batch_size: contract_obj
            .and_then(|v| v.get("max_batch_size"))
            .and_then(Value::as_u64)
            .map(|n| n as usize)
            .unwrap_or(64)
            .clamp(1, 512),
        ttl_hours: contract_obj
            .and_then(|v| v.get("ttl_hours"))
            .and_then(Value::as_i64)
            .unwrap_or(48)
            .clamp(1, 24 * 90),
        dedupe_window_hours: contract_obj
            .and_then(|v| v.get("dedupe_window_hours"))
            .and_then(Value::as_i64)
            .unwrap_or(24)
            .clamp(1, 24 * 90),
        backpressure_drop_below: contract_obj
            .and_then(|v| v.get("backpressure_drop_below"))
            .and_then(Value::as_str)
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "critical".to_string()),
        escalate_levels,
        priority_map,
        require_layer2_authority: !allow_layer0_fallback,
    }
}

fn parse_event(flags: &BTreeMap<String, String>) -> Result<Value, String> {
    if let Some(raw) = flags.get("event-json-base64") {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(raw.as_bytes())
            .map_err(|err| format!("event_json_base64_invalid:{err}"))?;
        let text =
            String::from_utf8(bytes).map_err(|err| format!("event_json_utf8_invalid:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("event_json_invalid:{err}"));
    }
    if let Some(raw) = flags.get("event-json") {
        return serde_json::from_str::<Value>(raw)
            .map_err(|err| format!("event_json_invalid:{err}"));
    }
    Err("missing_event_json".to_string())
}

fn normalize_event(event: &Value, contract: &AttentionContract) -> Result<Value, String> {
    let ts = clean_text(event.get("ts").and_then(Value::as_str), 64);
    let ts = if ts.is_empty() { now_iso() } else { ts };
    let source = clean_text(event.get("source").and_then(Value::as_str), 80);
    let source = if source.is_empty() {
        "unknown_source".to_string()
    } else {
        source
    };
    let source_type = clean_text(
        event
            .get("source_type")
            .and_then(Value::as_str)
            .or_else(|| event.get("type").and_then(Value::as_str)),
        80,
    );
    let source_type = if source_type.is_empty() {
        "unknown_type".to_string()
    } else {
        source_type
    };
    let severity = normalize_severity(event.get("severity").and_then(Value::as_str));
    let summary = clean_text(event.get("summary").and_then(Value::as_str), 180);
    let summary = if summary.is_empty() {
        format!("{source_type}:{source}")
    } else {
        summary
    };
    let attention_key = clean_text(event.get("attention_key").and_then(Value::as_str), 240);
    let attention_key = if attention_key.is_empty() {
        format!("{source}:{source_type}:{severity}:{summary}")
    } else {
        attention_key
    };
    let importance_fallback = infer_from_event(event, &severity, &contract.priority_map);
    let layer2_decision = evaluate_importance_via_layer2(event, &importance_fallback);
    if layer2_decision.is_none() && contract.require_layer2_authority {
        return Err("layer2_priority_authority_unavailable".to_string());
    }
    let score = layer2_decision
        .as_ref()
        .map(|row| row.score)
        .unwrap_or(importance_fallback.score);
    let band = layer2_decision
        .as_ref()
        .map(|row| row.band.clone())
        .unwrap_or_else(|| importance_fallback.band.clone());
    let priority = layer2_decision
        .as_ref()
        .map(|row| row.priority)
        .unwrap_or(importance_fallback.priority);
    let queue_lane = classify_attention_lane(&source, &source_type, &severity, &summary, &band);
    let ttl_ms = contract.ttl_hours.saturating_mul(60 * 60 * 1000);
    let event_ts_ms = parse_ts_ms(&ts).unwrap_or_else(|| Utc::now().timestamp_millis());
    let expires_at = ts_ms_to_iso(event_ts_ms.saturating_add(ttl_ms));
    let escalate_required_by_policy = contract.escalate_levels.iter().any(|row| row == &severity);
    let escalate_required_by_importance = score >= 0.85;
    let escalate_required = escalate_required_by_policy || escalate_required_by_importance;
    let initiative_action = layer2_decision
        .as_ref()
        .map(|row| row.initiative_action.clone())
        .unwrap_or_else(|| importance_fallback.initiative_action.clone());
    let initiative_repeat_after_sec = layer2_decision
        .as_ref()
        .map(|row| row.initiative_repeat_after_sec)
        .unwrap_or(importance_fallback.initiative_repeat_after_sec);
    let initiative_max_messages = layer2_decision
        .as_ref()
        .map(|row| row.initiative_max_messages)
        .unwrap_or(importance_fallback.initiative_max_messages);
    let queue_front = layer2_decision
        .as_ref()
        .map(|row| row.front_jump)
        .unwrap_or(importance_fallback.queue_front);
    let mut importance_json = importance_to_json(&importance_fallback);
    importance_json["authority"] = Value::String(if layer2_decision.is_some() {
        "core.layer2.execution.initiative".to_string()
    } else {
        "core.layer0.ops.importance_fallback".to_string()
    });
    importance_json["score"] = json!(score);
    importance_json["band"] = json!(band.clone());
    importance_json["priority"] = json!(priority);
    if let Some(decision) = &layer2_decision {
        importance_json["layer2"] = json!({
            "front_jump": decision.front_jump,
            "initiative_action": decision.initiative_action,
            "initiative_repeat_after_sec": decision.initiative_repeat_after_sec,
            "initiative_max_messages": decision.initiative_max_messages
        });
    }
    let mut out = json!({
        "ts": ts,
        "type": "attention_event",
        "source": source,
        "source_type": source_type,
        "severity": severity,
        "priority": priority,
        "score": score,
        "band": band,
        "queue_lane": queue_lane,
        "summary": summary,
        "attention_key": attention_key,
        "ttl_hours": contract.ttl_hours,
        "dedupe_window_hours": contract.dedupe_window_hours,
        "expires_at": expires_at,
        "escalate_required": escalate_required,
        "escalation_authority": "runtime_policy",
        "initiative_action": initiative_action,
        "initiative_repeat_after_sec": initiative_repeat_after_sec,
        "initiative_max_messages": initiative_max_messages,
        "queue_front": queue_front,
        "importance": importance_json,
        "raw_event": event
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    Ok(out)
}

fn dedupe_hit(active_rows: &[Value], candidate: &Value, dedupe_window_hours: i64) -> bool {
    let key = candidate
        .get("attention_key")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if key.trim().is_empty() {
        return false;
    }
    let candidate_ts = candidate
        .get("ts")
        .and_then(Value::as_str)
        .and_then(parse_ts_ms)
        .unwrap_or_else(|| Utc::now().timestamp_millis());
    let window_ms = dedupe_window_hours.saturating_mul(60 * 60 * 1000);
    active_rows.iter().any(|row| {
        let row_key = row
            .get("attention_key")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if row_key != key {
            return false;
        }
        let row_ts = row
            .get("ts")
            .and_then(Value::as_str)
            .and_then(parse_ts_ms)
            .unwrap_or(0);
        candidate_ts.saturating_sub(row_ts).abs() <= window_ms
    })
}

fn prune_expired(rows: Vec<Value>) -> (Vec<Value>, usize) {
    let now_ms = Utc::now().timestamp_millis();
    let mut kept = Vec::with_capacity(rows.len());
    let mut dropped = 0usize;
    for row in rows {
        let expired = row
            .get("expires_at")
            .and_then(Value::as_str)
            .and_then(parse_ts_ms)
            .map(|ts| ts <= now_ms)
            .unwrap_or(false);
        if expired {
            dropped += 1;
        } else {
            kept.push(row);
        }
    }
    (kept, dropped)
}

fn contract_snapshot(contract: &AttentionContract) -> Value {
    json!({
        "enabled": contract.enabled,
        "push_attention_queue": contract.push_attention_queue,
        "queue_path": contract.queue_path.to_string_lossy().to_string(),
        "receipts_path": contract.receipts_path.to_string_lossy().to_string(),
        "latest_path": contract.latest_path.to_string_lossy().to_string(),
        "cursor_state_path": contract.cursor_state_path.to_string_lossy().to_string(),
        "max_queue_depth": contract.max_queue_depth,
        "max_batch_size": contract.max_batch_size,
        "ttl_hours": contract.ttl_hours,
        "dedupe_window_hours": contract.dedupe_window_hours,
        "backpressure_drop_below": contract.backpressure_drop_below,
        "escalate_levels": contract.escalate_levels,
        "priority_map": contract.priority_map,
        "require_layer2_authority": contract.require_layer2_authority
    })
}

fn emit(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value).unwrap_or_else(|_| {
            "{\"ok\":false,\"type\":\"attention_queue_encode_failed\"}".to_string()
        })
    );
}

fn update_latest(
    contract: &AttentionContract,
    action: &str,
    queue_depth: usize,
    event: Option<&Value>,
    expired_pruned: usize,
) -> Value {
    let mut latest = read_json(&contract.latest_path).unwrap_or_else(|| json!({}));
    if !latest.is_object() {
        latest = json!({});
    }
    let ts = now_iso();
    latest["ts"] = Value::String(ts.clone());
    latest["active"] = Value::Bool(true);
    latest["queue_depth"] = Value::Number((queue_depth as u64).into());
    latest["last_action"] = Value::String(action.to_string());
    latest["expired_pruned"] = Value::Number((expired_pruned as u64).into());
    let queued_total = latest
        .get("queued_total")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let deduped_total = latest
        .get("deduped_total")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let dropped_total = latest
        .get("dropped_total")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    match action {
        "admitted" => {
            latest["queued_total"] = Value::Number((queued_total + 1).into());
        }
        "deduped" => {
            latest["deduped_total"] = Value::Number((deduped_total + 1).into());
        }
        "dropped_backpressure" => {
            latest["dropped_total"] = Value::Number((dropped_total + 1).into());
        }
        _ => {}
    }
    if let Some(evt) = event {
        latest["last_event"] = json!({
            "ts": evt.get("ts").and_then(Value::as_str).unwrap_or(&ts),
            "source": evt.get("source").and_then(Value::as_str).unwrap_or("unknown_source"),
            "source_type": evt.get("source_type").and_then(Value::as_str).unwrap_or("unknown_type"),
            "severity": evt.get("severity").and_then(Value::as_str).unwrap_or("info"),
            "summary": evt.get("summary").and_then(Value::as_str).unwrap_or("attention_event"),
            "priority": evt.get("priority").cloned().unwrap_or(Value::Number(20.into())),
            "score": evt.get("score").cloned().unwrap_or(Value::Number(serde_json::Number::from_f64(0.0).unwrap_or(0.into()))),
            "band": evt.get("band").cloned().unwrap_or(Value::String("p4".to_string())),
            "queue_lane": evt.get("queue_lane").cloned().unwrap_or(Value::String("standard".to_string())),
            "initiative_action": evt.get("initiative_action").cloned().unwrap_or(Value::String("silent".to_string()))
        });
    }
    write_json(&contract.latest_path, &latest);
    latest
}

fn load_cursor_state(path: &Path) -> Value {
    let mut state = read_json(path).unwrap_or_else(|| json!({}));
    if !state.is_object() {
        state = json!({});
    }
    if !state
        .get("consumers")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        state["consumers"] = json!({});
    }
    state["schema_id"] = Value::String("attention_queue_cursor_state".to_string());
    state["schema_version"] = Value::String("1.0".to_string());
    state
}

fn persist_cursor_state(path: &Path, state: &Value) {
    write_json(path, state);
}

fn read_consumer_offset(state: &Value, consumer_id: &str) -> usize {
    state
        .pointer(&format!("/consumers/{consumer_id}/offset"))
        .and_then(Value::as_u64)
        .unwrap_or(0) as usize
}

fn write_consumer_offset(
    state: &mut Value,
    consumer_id: &str,
    offset: usize,
    last_token: Option<&str>,
    run_context: &str,
) {
    if !state
        .get("consumers")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        state["consumers"] = json!({});
    }
    state["updated_at"] = Value::String(now_iso());
    state["consumers"][consumer_id] = json!({
        "offset": offset,
        "acked_at": now_iso(),
        "last_cursor_token": last_token,
        "run_context": run_context
    });
}

fn cursor_token_for_event(
    contract: &AttentionContract,
    consumer_id: &str,
    index: usize,
    event: &Value,
) -> String {
    let seed = json!({
        "type": "attention_cursor_token",
        "consumer_id": consumer_id,
        "index": index,
        "queue_path": contract.queue_path.to_string_lossy().to_string(),
        "event_receipt_hash": event.get("receipt_hash").cloned().unwrap_or(Value::Null),
        "attention_key": event.get("attention_key").cloned().unwrap_or(Value::Null),
        "event_ts": event.get("ts").cloned().unwrap_or(Value::Null)
    });
    deterministic_receipt_hash(&seed)
}

fn load_active_queue(contract: &AttentionContract) -> (Vec<Value>, usize) {
    if !(contract.enabled && contract.push_attention_queue) {
        return (Vec::new(), 0);
    }
    let rows = read_jsonl(&contract.queue_path);
    let (mut active, expired_pruned) = prune_expired(rows);
    sort_active_rows_with_authority(&mut active);
    if expired_pruned > 0 {
        write_jsonl(&contract.queue_path, &active);
    }
    (active, expired_pruned)
}

fn next(root: &Path, flags: &BTreeMap<String, String>, auto_ack: bool) -> i32 {
    let contract = load_contract(root);
    let run_context = flags.get("run-context").cloned().unwrap_or_else(|| {
        if auto_ack {
            "drain".to_string()
        } else {
            "next".to_string()
        }
    });
    let consumer_id = normalize_consumer_id(
        flags
            .get("consumer")
            .map(String::as_str)
            .or_else(|| flags.get("consumer-id").map(String::as_str)),
    );
    if consumer_id.is_empty() {
        let mut out = json!({
            "ok": false,
            "type": if auto_ack { "attention_queue_drain_error" } else { "attention_queue_next_error" },
            "ts": now_iso(),
            "reason": "consumer_missing_or_invalid",
            "run_context": run_context,
            "attention_contract": contract_snapshot(&contract)
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        emit(&out);
        return 2;
    }
    let limit = parse_limit(
        flags.get("limit").or_else(|| flags.get("max-events")),
        1,
        contract.max_batch_size,
    );
    let wait_ms = parse_wait_ms(
        flags.get("wait-ms").or_else(|| flags.get("wait_ms")),
        0,
        300_000,
    );
    let wait_started_ms = Utc::now().timestamp_millis();
    let (active_rows, expired_pruned) = loop {
        let (rows, pruned) = load_active_queue(&contract);
        if wait_ms == 0 || !rows.is_empty() {
            break (rows, pruned);
        }
        let elapsed_ms = Utc::now()
            .timestamp_millis()
            .saturating_sub(wait_started_ms)
            .max(0) as u64;
        if elapsed_ms >= wait_ms {
            break (rows, pruned);
        }
        let remaining = wait_ms.saturating_sub(elapsed_ms);
        let sleep_ms = remaining.clamp(25, 250);
        let wait_tick = crossbeam_channel::after(Duration::from_millis(sleep_ms));
        let _ = wait_tick.recv();
    };
    let waited_ms = Utc::now()
        .timestamp_millis()
        .saturating_sub(wait_started_ms)
        .max(0) as u64;

    let mut cursor_state = load_cursor_state(&contract.cursor_state_path);
    let mut cursor_offset = read_consumer_offset(&cursor_state, &consumer_id);
    if cursor_offset > active_rows.len() {
        cursor_offset = active_rows.len();
    }
    let end = active_rows.len().min(cursor_offset.saturating_add(limit));
    let mut events = Vec::new();
    for (idx, event) in active_rows
        .iter()
        .enumerate()
        .skip(cursor_offset)
        .take(end.saturating_sub(cursor_offset))
    {
        events.push(json!({
            "cursor_index": idx,
            "cursor_token": cursor_token_for_event(&contract, &consumer_id, idx, event),
            "event": event
        }));
    }

    let mut acked_through_index = Value::Null;
    if auto_ack && !events.is_empty() {
        let through_index = end.saturating_sub(1);
        let last_token = events
            .last()
            .and_then(|row| row.get("cursor_token"))
            .and_then(Value::as_str);
        write_consumer_offset(
            &mut cursor_state,
            &consumer_id,
            through_index.saturating_add(1),
            last_token,
            &run_context,
        );
        persist_cursor_state(&contract.cursor_state_path, &cursor_state);
        acked_through_index = Value::Number((through_index as u64).into());
    }

    let cursor_after = if auto_ack { end } else { cursor_offset };
    let mut batch_lane_counts: BTreeMap<String, usize> = BTreeMap::new();
    for row in &events {
        let lane = row
            .pointer("/event/queue_lane")
            .and_then(Value::as_str)
            .unwrap_or("standard")
            .trim()
            .to_ascii_lowercase();
        let key = if lane == "critical" || lane == "background" {
            lane
        } else {
            "standard".to_string()
        };
        *batch_lane_counts.entry(key).or_insert(0) += 1;
    }
    let mut out = json!({
        "ok": true,
        "type": if auto_ack { "attention_queue_drain" } else { "attention_queue_next" },
        "ts": now_iso(),
        "run_context": run_context,
        "consumer_id": consumer_id,
        "limit": limit,
        "wait_ms": wait_ms,
        "waited_ms": waited_ms,
        "queue_depth": active_rows.len(),
        "expired_pruned": expired_pruned,
        "cursor_offset": cursor_offset,
        "cursor_offset_after": cursor_after,
        "batch_count": events.len(),
        "batch_lane_counts": batch_lane_counts,
        "acked": auto_ack && !events.is_empty(),
        "acked_through_index": acked_through_index,
        "events": events,
        "attention_contract": contract_snapshot(&contract)
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    append_jsonl(
        &contract.receipts_path,
        &json!({
            "ts": now_iso(),
            "type": if auto_ack { "attention_consumer_drain" } else { "attention_consumer_next" },
            "consumer_id": out.get("consumer_id").cloned().unwrap_or(Value::Null),
            "batch_count": out.get("batch_count").cloned().unwrap_or(Value::Number(0.into())),
            "cursor_offset": out.get("cursor_offset").cloned().unwrap_or(Value::Number(0.into())),
            "cursor_offset_after": out.get("cursor_offset_after").cloned().unwrap_or(Value::Number(0.into())),
            "run_context": out.get("run_context").cloned().unwrap_or(Value::String("unknown".to_string())),
            "receipt_hash": out.get("receipt_hash").cloned().unwrap_or(Value::String("".to_string()))
        }),
    );
    emit(&out);
    0
}

fn ack(root: &Path, flags: &BTreeMap<String, String>) -> i32 {
    let contract = load_contract(root);
    let run_context = flags
        .get("run-context")
        .cloned()
        .unwrap_or_else(|| "ack".to_string());
    let consumer_id = normalize_consumer_id(
        flags
            .get("consumer")
            .map(String::as_str)
            .or_else(|| flags.get("consumer-id").map(String::as_str)),
    );
    if consumer_id.is_empty() {
        let mut out = json!({
            "ok": false,
            "type": "attention_queue_ack_error",
            "ts": now_iso(),
            "reason": "consumer_missing_or_invalid",
            "run_context": run_context,
            "attention_contract": contract_snapshot(&contract)
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        emit(&out);
        return 2;
    }
    let through_index = parse_through_index(
        flags
            .get("through-index")
            .or_else(|| flags.get("through_index"))
            .or_else(|| flags.get("index")),
    );
    let Some(through_index) = through_index else {
        let mut out = json!({
            "ok": false,
            "type": "attention_queue_ack_error",
            "ts": now_iso(),
            "reason": "through_index_missing_or_invalid",
            "run_context": run_context,
            "attention_contract": contract_snapshot(&contract)
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        emit(&out);
        return 2;
    };
    let cursor_token = clean_text(flags.get("cursor-token").map(String::as_str), 200);
    if cursor_token.is_empty() {
        let mut out = json!({
            "ok": false,
            "type": "attention_queue_ack_error",
            "ts": now_iso(),
            "reason": "cursor_token_missing",
            "run_context": run_context,
            "attention_contract": contract_snapshot(&contract)
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        emit(&out);
        return 2;
    }

    let (active_rows, expired_pruned) = load_active_queue(&contract);
    if through_index >= active_rows.len() {
        let mut out = json!({
            "ok": false,
            "type": "attention_queue_ack_error",
            "ts": now_iso(),
            "reason": "through_index_out_of_range",
            "run_context": run_context,
            "consumer_id": consumer_id,
            "through_index": through_index,
            "queue_depth": active_rows.len(),
            "expired_pruned": expired_pruned,
            "attention_contract": contract_snapshot(&contract)
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        emit(&out);
        return 2;
    }

    let mut cursor_state = load_cursor_state(&contract.cursor_state_path);
    let old_offset = read_consumer_offset(&cursor_state, &consumer_id).min(active_rows.len());
    if through_index.saturating_add(1) < old_offset {
        let mut out = json!({
            "ok": false,
            "type": "attention_queue_ack_error",
            "ts": now_iso(),
            "reason": "ack_before_cursor_offset",
            "run_context": run_context,
            "consumer_id": consumer_id,
            "through_index": through_index,
            "cursor_offset": old_offset,
            "attention_contract": contract_snapshot(&contract)
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        emit(&out);
        return 2;
    }

    let expected_token = cursor_token_for_event(
        &contract,
        &consumer_id,
        through_index,
        &active_rows[through_index],
    );
    if expected_token != cursor_token {
        let mut out = json!({
            "ok": false,
            "type": "attention_queue_ack_error",
            "ts": now_iso(),
            "reason": "cursor_token_mismatch",
            "run_context": run_context,
            "consumer_id": consumer_id,
            "through_index": through_index,
            "attention_contract": contract_snapshot(&contract)
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        emit(&out);
        return 2;
    }

    let next_offset = through_index.saturating_add(1);
    write_consumer_offset(
        &mut cursor_state,
        &consumer_id,
        next_offset,
        Some(&cursor_token),
        &run_context,
    );
    persist_cursor_state(&contract.cursor_state_path, &cursor_state);

    let mut out = json!({
        "ok": true,
        "type": "attention_queue_ack",
        "ts": now_iso(),
        "run_context": run_context,
        "consumer_id": consumer_id,
        "through_index": through_index,
        "cursor_offset_before": old_offset,
        "cursor_offset_after": next_offset,
        "acked_count": next_offset.saturating_sub(old_offset),
        "queue_depth": active_rows.len(),
        "expired_pruned": expired_pruned,
        "attention_contract": contract_snapshot(&contract)
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    append_jsonl(
        &contract.receipts_path,
        &json!({
            "ts": now_iso(),
            "type": "attention_consumer_ack",
            "consumer_id": out.get("consumer_id").cloned().unwrap_or(Value::Null),
            "through_index": out.get("through_index").cloned().unwrap_or(Value::Null),
            "cursor_offset_before": out.get("cursor_offset_before").cloned().unwrap_or(Value::Null),
            "cursor_offset_after": out.get("cursor_offset_after").cloned().unwrap_or(Value::Null),
            "run_context": out.get("run_context").cloned().unwrap_or(Value::String("unknown".to_string())),
            "receipt_hash": out.get("receipt_hash").cloned().unwrap_or(Value::String("".to_string()))
        }),
    );
    emit(&out);
    0
}

fn enqueue(root: &Path, flags: &BTreeMap<String, String>) -> i32 {
    let contract = load_contract(root);
    let run_context = flags
        .get("run-context")
        .cloned()
        .unwrap_or_else(|| "unknown".to_string());
    let event_raw = match parse_event(flags) {
        Ok(v) => v,
        Err(reason) => {
            let mut out = json!({
                "ok": false,
                "type": "attention_queue_enqueue_error",
                "ts": now_iso(),
                "reason": reason,
                "run_context": run_context,
                "attention_contract": contract_snapshot(&contract)
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            emit(&out);
            return 2;
        }
    };

    let event = match normalize_event(&event_raw, &contract) {
        Ok(row) => row,
        Err(reason) => {
            let mut out = json!({
                "ok": false,
                "type": "attention_queue_enqueue_error",
                "ts": now_iso(),
                "reason": reason,
                "run_context": run_context,
                "attention_contract": contract_snapshot(&contract)
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            append_jsonl(
                &contract.receipts_path,
                &json!({
                    "ts": now_iso(),
                    "type": "attention_receipt",
                    "decision": "rejected_layer2_authority_unavailable",
                    "queued": false,
                    "run_context": run_context,
                    "reason": out.get("reason").cloned().unwrap_or(Value::String("layer2_priority_authority_unavailable".to_string())),
                    "receipt_hash": out.get("receipt_hash").cloned().unwrap_or(Value::String("".to_string()))
                }),
            );
            emit(&out);
            return 2;
        }
    };
    let queue_depth_before;
    let queue_depth_after;
    let action;
    let queued;

    let mut active_rows = Vec::new();
    let mut expired_pruned = 0usize;
    if contract.enabled && contract.push_attention_queue {
        let rows = read_jsonl(&contract.queue_path);
        let (pruned, dropped) = prune_expired(rows);
        active_rows = pruned;
        expired_pruned = dropped;
    }
    queue_depth_before = active_rows.len();

    let deduped = dedupe_hit(&active_rows, &event, contract.dedupe_window_hours);
    if !contract.enabled || !contract.push_attention_queue {
        action = "disabled".to_string();
        queued = false;
        queue_depth_after = queue_depth_before;
    } else if deduped {
        action = "deduped".to_string();
        queued = false;
        queue_depth_after = queue_depth_before;
    } else {
        let drop_rank = severity_rank(&contract.backpressure_drop_below);
        let severity = event
            .get("severity")
            .and_then(Value::as_str)
            .unwrap_or("info");
        let queue_lane = event
            .get("queue_lane")
            .and_then(Value::as_str)
            .unwrap_or("standard");
        let sev_rank = severity_rank(severity);
        let event_band = event.get("band").and_then(Value::as_str).unwrap_or("p4");
        let high_importance = band_rank(event_band) >= band_rank("p2");
        let at_or_over_cap = queue_depth_before >= contract.max_queue_depth;
        let should_drop_for_backpressure = at_or_over_cap
            && (queue_lane.eq_ignore_ascii_case("background")
                || (sev_rank < drop_rank && !high_importance));
        if should_drop_for_backpressure {
            action = "dropped_backpressure".to_string();
            queued = false;
            queue_depth_after = queue_depth_before;
        } else {
            action = if high_importance {
                "admitted_priority".to_string()
            } else {
                "admitted".to_string()
            };
            queued = true;
            active_rows.push(event.clone());
            sort_active_rows_with_authority(&mut active_rows);
            write_jsonl(&contract.queue_path, &active_rows);
            queue_depth_after = active_rows.len();
        }
    }

    let latest = update_latest(
        &contract,
        &action,
        queue_depth_after,
        if queued { Some(&event) } else { None },
        expired_pruned,
    );

    let mut receipt = json!({
        "ok": true,
        "type": "attention_queue_enqueue",
        "ts": now_iso(),
        "decision": action,
        "queued": queued,
        "run_context": run_context,
        "queue_depth_before": queue_depth_before,
        "queue_depth_after": queue_depth_after,
        "expired_pruned": expired_pruned,
        "attention_contract": contract_snapshot(&contract),
        "event": {
            "source": event.get("source").cloned().unwrap_or(Value::String("unknown_source".to_string())),
            "source_type": event.get("source_type").cloned().unwrap_or(Value::String("unknown_type".to_string())),
            "severity": event.get("severity").cloned().unwrap_or(Value::String("info".to_string())),
            "priority": event.get("priority").cloned().unwrap_or(Value::Number(20.into())),
            "score": event.get("score").cloned().unwrap_or(Value::Number(serde_json::Number::from_f64(0.0).unwrap_or(0.into()))),
            "band": event.get("band").cloned().unwrap_or(Value::String("p4".to_string())),
            "queue_lane": event.get("queue_lane").cloned().unwrap_or(Value::String("standard".to_string())),
            "summary": event.get("summary").cloned().unwrap_or(Value::String("attention_event".to_string())),
            "attention_key": event.get("attention_key").cloned().unwrap_or(Value::String("".to_string())),
            "escalate_required": event.get("escalate_required").cloned().unwrap_or(Value::Bool(false)),
            "initiative_action": event.get("initiative_action").cloned().unwrap_or(Value::String("silent".to_string()))
        },
        "latest": latest
    });
    if queued {
        receipt["queued_event"] = event.clone();
    }
    receipt["receipt_hash"] = Value::String(deterministic_receipt_hash(&receipt));

    append_jsonl(
        &contract.receipts_path,
        &json!({
            "ts": now_iso(),
            "type": "attention_receipt",
            "decision": action,
            "queued": queued,
            "queue_depth_before": queue_depth_before,
            "queue_depth_after": queue_depth_after,
            "expired_pruned": expired_pruned,
            "severity": event.get("severity").cloned().unwrap_or(Value::String("info".to_string())),
            "priority": event.get("priority").cloned().unwrap_or(Value::Number(20.into())),
            "score": event.get("score").cloned().unwrap_or(Value::Number(serde_json::Number::from_f64(0.0).unwrap_or(0.into()))),
            "band": event.get("band").cloned().unwrap_or(Value::String("p4".to_string())),
            "queue_lane": event.get("queue_lane").cloned().unwrap_or(Value::String("standard".to_string())),
            "attention_key": event.get("attention_key").cloned().unwrap_or(Value::String("".to_string())),
            "escalate_required": event.get("escalate_required").cloned().unwrap_or(Value::Bool(false)),
            "initiative_action": event.get("initiative_action").cloned().unwrap_or(Value::String("silent".to_string())),
            "run_context": run_context,
            "receipt_hash": receipt.get("receipt_hash").cloned().unwrap_or(Value::String("".to_string()))
        }),
    );

    emit(&receipt);
    if queued || action == "deduped" || action == "disabled" {
        0
    } else {
        2
    }
}

fn status(root: &Path) -> i32 {
    let contract = load_contract(root);
    let (active_rows, expired_pruned) = load_active_queue(&contract);
    let mut lane_counts: BTreeMap<String, usize> = BTreeMap::new();
    for row in &active_rows {
        let lane = row
            .get("queue_lane")
            .and_then(Value::as_str)
            .unwrap_or("standard")
            .trim()
            .to_ascii_lowercase();
        let key = if lane == "critical" || lane == "background" {
            lane
        } else {
            "standard".to_string()
        };
        *lane_counts.entry(key).or_insert(0) += 1;
    }
    let latest = read_json(&contract.latest_path).unwrap_or_else(|| json!({}));
    let mut out = json!({
        "ok": true,
        "type": "attention_queue_status",
        "ts": now_iso(),
        "queue_depth": active_rows.len(),
        "lane_counts": lane_counts,
        "expired_pruned": expired_pruned,
        "attention_contract": contract_snapshot(&contract),
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
        "enqueue" => enqueue(root, &flags),
        "status" => status(root),
        "next" => next(root, &flags, false),
        "ack" => ack(root, &flags),
        "drain" => next(root, &flags, true),
        _ => {
            usage();
            let mut out = json!({
                "ok": false,
                "type": "attention_queue_cli_error",
                "ts": now_iso(),
                "reason": "unknown_command",
                "command": command
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
    use base64::Engine;
    use tempfile::tempdir;

    fn write_policy(root: &Path, max_queue_depth: usize, drop_below: &str) {
        let policy = json!({
            "enabled": true,
            "eyes": {
                "push_attention_queue": true,
                "attention_queue_path": "local/state/attention/queue.jsonl",
                "receipts_path": "local/state/attention/receipts.jsonl",
                "latest_path": "local/state/attention/latest.json",
                "attention_contract": {
                    "max_queue_depth": max_queue_depth,
                    "ttl_hours": 12,
                    "dedupe_window_hours": 24,
                    "backpressure_drop_below": drop_below,
                    "escalate_levels": ["critical"],
                    "priority_map": {
                        "critical": 100,
                        "warn": 60,
                        "info": 20
                    }
                }
            }
        });
        let path = root.join("config").join("mech_suit_mode_policy.json");
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        write_json(&path, &policy);
    }

    fn enqueue_event(root: &Path, event: &Value) -> i32 {
        let payload = base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_string(event).expect("encode event"));
        run(
            root,
            &[
                "enqueue".to_string(),
                format!("--event-json-base64={payload}"),
            ],
        )
    }

    #[test]
    fn enqueue_dedupes_within_window() {
        let dir = tempdir().expect("tempdir");
        write_policy(dir.path(), 32, "critical");
        let event = json!({
            "ts": now_iso(),
            "source": "external_eyes",
            "source_type": "external_item",
            "severity": "warn",
            "summary": "item one",
            "attention_key": "dup-key"
        });
        let payload = base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_string(&event).expect("encode event"));
        let code_a = run(
            dir.path(),
            &[
                "enqueue".to_string(),
                format!("--event-json-base64={payload}"),
            ],
        );
        assert_eq!(code_a, 0);

        let code_b = run(
            dir.path(),
            &[
                "enqueue".to_string(),
                format!("--event-json-base64={payload}"),
            ],
        );
        assert_eq!(code_b, 0);

        let queue = read_jsonl(&dir.path().join("local/state/attention/queue.jsonl"));
        assert_eq!(queue.len(), 1);
    }

    #[test]
    fn enqueue_drops_info_on_backpressure() {
        let dir = tempdir().expect("tempdir");
        write_policy(dir.path(), 1, "critical");

        let warn_event = json!({
            "ts": now_iso(),
            "source": "external_eyes",
            "source_type": "eye_run_failed",
            "severity": "critical",
            "summary": "critical event",
            "attention_key": "first"
        });
        let warn_payload = base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_string(&warn_event).expect("encode event"));
        let code_a = run(
            dir.path(),
            &[
                "enqueue".to_string(),
                format!("--event-json-base64={warn_payload}"),
            ],
        );
        assert_eq!(code_a, 0);

        let info_event = json!({
            "ts": now_iso(),
            "source": "external_eyes",
            "source_type": "external_item",
            "severity": "info",
            "summary": "informational event",
            "attention_key": "second"
        });
        let info_payload = base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_string(&info_event).expect("encode event"));
        let code_b = run(
            dir.path(),
            &[
                "enqueue".to_string(),
                format!("--event-json-base64={info_payload}"),
            ],
        );
        assert_eq!(code_b, 2);

        let queue = read_jsonl(&dir.path().join("local/state/attention/queue.jsonl"));
        assert_eq!(queue.len(), 1);
        assert_eq!(
            queue[0].get("severity").and_then(Value::as_str),
            Some("critical")
        );
    }

    #[test]
    fn enqueue_orders_queue_by_band_then_priority_then_score() {
        let dir = tempdir().expect("tempdir");
        write_policy(dir.path(), 64, "critical");
        let low = json!({
            "ts": now_iso(),
            "source": "external_eyes",
            "source_type": "external_item",
            "severity": "info",
            "summary": "low priority item",
            "attention_key": "prio-low"
        });
        let mid = json!({
            "ts": now_iso(),
            "source": "memory_ambient",
            "source_type": "memory_event",
            "severity": "warn",
            "summary": "mid priority item",
            "attention_key": "prio-mid",
            "importance": {
                "score": 0.74
            }
        });
        let high = json!({
            "ts": now_iso(),
            "source": "spine",
            "source_type": "infra_outage_state",
            "severity": "critical",
            "summary": "conduit bridge timeout degraded",
            "attention_key": "prio-high"
        });
        assert_eq!(enqueue_event(dir.path(), &low), 0);
        assert_eq!(enqueue_event(dir.path(), &mid), 0);
        assert_eq!(enqueue_event(dir.path(), &high), 0);

        let queue = read_jsonl(&dir.path().join("local/state/attention/queue.jsonl"));
        assert_eq!(queue.len(), 3);
        assert_eq!(
            queue[0].get("attention_key").and_then(Value::as_str),
            Some("prio-high")
        );
        assert_eq!(
            queue[1].get("attention_key").and_then(Value::as_str),
            Some("prio-mid")
        );
        assert_eq!(
            queue[2].get("attention_key").and_then(Value::as_str),
            Some("prio-low")
        );
    }

    #[test]
    fn enqueue_assigns_tiered_queue_lanes() {
        let dir = tempdir().expect("tempdir");
        write_policy(dir.path(), 64, "critical");
        let background = json!({
            "ts": now_iso(),
            "source": "ops_logs",
            "source_type": "receipt_timeline",
            "severity": "info",
            "summary": "routine timeline heartbeat",
            "attention_key": "lane-background"
        });
        let critical = json!({
            "ts": now_iso(),
            "source": "security",
            "source_type": "integrity_fault",
            "severity": "critical",
            "summary": "critical policy failure",
            "attention_key": "lane-critical"
        });
        assert_eq!(enqueue_event(dir.path(), &background), 0);
        assert_eq!(enqueue_event(dir.path(), &critical), 0);
        let queue = read_jsonl(&dir.path().join("local/state/attention/queue.jsonl"));
        assert_eq!(queue.len(), 2);
        assert_eq!(
            queue[0].get("queue_lane").and_then(Value::as_str),
            Some("critical")
        );
        assert_eq!(
            queue[1].get("queue_lane").and_then(Value::as_str),
            Some("background")
        );
    }

    #[test]
    fn enqueue_attaches_importance_and_initiative_metadata() {
        let dir = tempdir().expect("tempdir");
        write_policy(dir.path(), 64, "critical");
        let event = json!({
            "ts": now_iso(),
            "source": "security",
            "source_type": "integrity_fault",
            "severity": "critical",
            "summary": "security_global_gate_failed conduit timeout",
            "attention_key": "importance-meta"
        });
        assert_eq!(enqueue_event(dir.path(), &event), 0);
        let queue = read_jsonl(&dir.path().join("local/state/attention/queue.jsonl"));
        assert_eq!(queue.len(), 1);
        let row = &queue[0];
        let score = row.get("score").and_then(Value::as_f64).unwrap_or(0.0);
        assert!(score >= 0.95);
        assert_eq!(row.get("band").and_then(Value::as_str), Some("p0"));
        assert_eq!(
            row.get("initiative_action").and_then(Value::as_str),
            Some("persistent_until_ack")
        );
        assert!(row.get("importance").map(Value::is_object).unwrap_or(false));
    }

    #[test]
    fn next_ack_and_drain_progress_cursor() {
        let dir = tempdir().expect("tempdir");
        write_policy(dir.path(), 64, "critical");

        let first = json!({
            "ts": now_iso(),
            "source": "external_eyes",
            "source_type": "external_item",
            "severity": "warn",
            "summary": "first",
            "attention_key": "cursor-1"
        });
        let second = json!({
            "ts": now_iso(),
            "source": "external_eyes",
            "source_type": "eye_run_failed",
            "severity": "critical",
            "summary": "second",
            "attention_key": "cursor-2"
        });
        assert_eq!(enqueue_event(dir.path(), &first), 0);
        assert_eq!(enqueue_event(dir.path(), &second), 0);

        let next_code = run(
            dir.path(),
            &[
                "next".to_string(),
                "--consumer=cockpit".to_string(),
                "--limit=1".to_string(),
            ],
        );
        assert_eq!(next_code, 0);

        let contract = load_contract(dir.path());
        let queue = read_jsonl(&contract.queue_path);
        assert_eq!(queue.len(), 2);
        let token = cursor_token_for_event(&contract, "cockpit", 0, &queue[0]);

        let ack_code = run(
            dir.path(),
            &[
                "ack".to_string(),
                "--consumer=cockpit".to_string(),
                "--through-index=0".to_string(),
                format!("--cursor-token={token}"),
            ],
        );
        assert_eq!(ack_code, 0);

        let cursor_state = load_cursor_state(&contract.cursor_state_path);
        assert_eq!(read_consumer_offset(&cursor_state, "cockpit"), 1);

        let drain_code = run(
            dir.path(),
            &[
                "drain".to_string(),
                "--consumer=cockpit".to_string(),
                "--limit=10".to_string(),
            ],
        );
        assert_eq!(drain_code, 0);

        let cursor_state_after = load_cursor_state(&contract.cursor_state_path);
        assert_eq!(read_consumer_offset(&cursor_state_after, "cockpit"), 2);
    }

    #[test]
    fn ack_rejects_bad_token() {
        let dir = tempdir().expect("tempdir");
        write_policy(dir.path(), 64, "critical");
        let event = json!({
            "ts": now_iso(),
            "source": "external_eyes",
            "source_type": "external_item",
            "severity": "warn",
            "summary": "first",
            "attention_key": "cursor-bad-token"
        });
        assert_eq!(enqueue_event(dir.path(), &event), 0);
        let code = run(
            dir.path(),
            &[
                "ack".to_string(),
                "--consumer=cockpit".to_string(),
                "--through-index=0".to_string(),
                "--cursor-token=invalid".to_string(),
            ],
        );
        assert_eq!(code, 2);

        let contract = load_contract(dir.path());
        let cursor_state = load_cursor_state(&contract.cursor_state_path);
        assert_eq!(read_consumer_offset(&cursor_state, "cockpit"), 0);
    }
}
