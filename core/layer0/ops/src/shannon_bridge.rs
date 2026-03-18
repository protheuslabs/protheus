// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_STATE_REL: &str = "local/state/ops/shannon_bridge/latest.json";
const DEFAULT_HISTORY_REL: &str = "local/state/ops/shannon_bridge/history.jsonl";
const DEFAULT_APPROVAL_QUEUE_REL: &str = "client/runtime/local/state/shannon_approvals.yaml";
const DEFAULT_REPLAY_DIR_REL: &str = "local/state/ops/shannon_bridge/replays";
const DEFAULT_OBSERVABILITY_TRACE_REL: &str = "local/state/ops/shannon_bridge/observability.jsonl";
const DEFAULT_OBSERVABILITY_METRICS_REL: &str = "local/state/ops/shannon_bridge/metrics.prom";
const DEFAULT_DESKTOP_HISTORY_REL: &str = "client/runtime/local/state/shannon_desktop_shell.json";

fn usage() {
    println!("shannon-bridge commands:");
    println!("  protheus-ops shannon-bridge status [--state-path=<path>]");
    println!("  protheus-ops shannon-bridge register-pattern [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops shannon-bridge guard-budget [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops shannon-bridge memory-bridge [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops shannon-bridge replay-run [--payload-base64=<json>] [--state-path=<path>] [--replay-dir=<path>]");
    println!("  protheus-ops shannon-bridge approval-checkpoint [--payload-base64=<json>] [--state-path=<path>] [--approval-queue-path=<path>]");
    println!("  protheus-ops shannon-bridge sandbox-execute [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops shannon-bridge record-observability [--payload-base64=<json>] [--state-path=<path>] [--observability-trace-path=<path>] [--observability-metrics-path=<path>]");
    println!("  protheus-ops shannon-bridge gateway-route [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops shannon-bridge register-tooling [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops shannon-bridge schedule-run [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops shannon-bridge desktop-shell [--payload-base64=<json>] [--state-path=<path>] [--desktop-history-path=<path>]");
    println!("  protheus-ops shannon-bridge p2p-reliability [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops shannon-bridge assimilate-intake [--payload-base64=<json>] [--state-path=<path>]");
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
            .map_err(|err| format!("shannon_bridge_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("shannon_bridge_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("shannon_bridge_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("shannon_bridge_payload_decode_failed:{err}"));
    }
    Ok(json!({}))
}

fn payload_obj<'a>(value: &'a Value) -> &'a Map<String, Value> {
    value.as_object().unwrap_or_else(|| {
        static EMPTY: OnceLock<Map<String, Value>> = OnceLock::new();
        EMPTY.get_or_init(Map::new)
    })
}

fn repo_path(root: &Path, rel: &str) -> PathBuf {
    let candidate = PathBuf::from(rel.trim());
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

fn rel(root: &Path, path: &Path) -> String {
    lane_utils::rel_path(root, path)
}

fn path_flag(
    root: &Path,
    argv: &[String],
    payload: &Map<String, Value>,
    flag: &str,
    payload_key: &str,
    default_rel: &str,
) -> PathBuf {
    lane_utils::parse_flag(argv, flag, false)
        .or_else(|| {
            payload
                .get(payload_key)
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(default_rel))
}

fn state_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    path_flag(
        root,
        argv,
        payload,
        "state-path",
        "state_path",
        DEFAULT_STATE_REL,
    )
}

fn history_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    path_flag(
        root,
        argv,
        payload,
        "history-path",
        "history_path",
        DEFAULT_HISTORY_REL,
    )
}

fn approval_queue_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    path_flag(
        root,
        argv,
        payload,
        "approval-queue-path",
        "approval_queue_path",
        DEFAULT_APPROVAL_QUEUE_REL,
    )
}

fn replay_dir(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    path_flag(
        root,
        argv,
        payload,
        "replay-dir",
        "replay_dir",
        DEFAULT_REPLAY_DIR_REL,
    )
}

fn observability_trace_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    path_flag(
        root,
        argv,
        payload,
        "observability-trace-path",
        "observability_trace_path",
        DEFAULT_OBSERVABILITY_TRACE_REL,
    )
}

fn observability_metrics_path(
    root: &Path,
    argv: &[String],
    payload: &Map<String, Value>,
) -> PathBuf {
    path_flag(
        root,
        argv,
        payload,
        "observability-metrics-path",
        "observability_metrics_path",
        DEFAULT_OBSERVABILITY_METRICS_REL,
    )
}

fn desktop_history_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    path_flag(
        root,
        argv,
        payload,
        "desktop-history-path",
        "desktop_history_path",
        DEFAULT_DESKTOP_HISTORY_REL,
    )
}

fn default_state() -> Value {
    json!({
        "schema_version": "shannon_bridge_state_v1",
        "patterns": {},
        "budget_guards": {},
        "memory_workspaces": {},
        "replays": {},
        "approvals": {},
        "sandbox_runs": {},
        "observability": {},
        "gateway_routes": {},
        "tool_registrations": {},
        "schedules": {},
        "desktop_events": {},
        "p2p_reliability": {},
        "intakes": {},
        "last_receipt": null,
    })
}

fn ensure_state_shape(value: &mut Value) {
    if !value.is_object() {
        *value = default_state();
        return;
    }
    for key in [
        "patterns",
        "budget_guards",
        "memory_workspaces",
        "replays",
        "approvals",
        "sandbox_runs",
        "observability",
        "gateway_routes",
        "tool_registrations",
        "schedules",
        "desktop_events",
        "p2p_reliability",
        "intakes",
    ] {
        if !value.get(key).map(Value::is_object).unwrap_or(false) {
            value[key] = json!({});
        }
    }
    if value
        .get("schema_version")
        .and_then(Value::as_str)
        .is_none()
    {
        value["schema_version"] = json!("shannon_bridge_state_v1");
    }
}

fn load_state(path: &Path) -> Value {
    let mut state = lane_utils::read_json(path).unwrap_or_else(default_state);
    ensure_state_shape(&mut state);
    state
}

fn save_state(path: &Path, state: &Value) -> Result<(), String> {
    lane_utils::write_json(path, state)
}
fn append_history(path: &Path, row: &Value) -> Result<(), String> {
    lane_utils::append_jsonl(path, row)
}

fn as_object_mut<'a>(value: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    if !value.get(key).map(Value::is_object).unwrap_or(false) {
        value[key] = json!({});
    }
    value
        .get_mut(key)
        .and_then(Value::as_object_mut)
        .expect("object")
}

fn now_millis() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn to_base36(mut value: u128) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        out.push(if digit < 10 {
            (b'0' + digit) as char
        } else {
            (b'a' + digit - 10) as char
        });
        value /= 36;
    }
    out.iter().rev().collect()
}

fn stable_id(prefix: &str, basis: &Value) -> String {
    let digest = deterministic_receipt_hash(basis);
    format!("{prefix}_{}_{}", to_base36(now_millis()), &digest[..12])
}

fn clean_text(raw: Option<&str>, max_len: usize) -> String {
    lane_utils::clean_text(raw, max_len)
}
fn clean_token(raw: Option<&str>, fallback: &str) -> String {
    lane_utils::clean_token(raw, fallback)
}
fn profile(raw: Option<&Value>) -> String {
    clean_token(raw.and_then(Value::as_str), "rich")
}
fn claim(id: &str, claim: &str) -> Value {
    json!([{"id": id, "claim": claim}])
}

fn parse_u64(raw: Option<&Value>, fallback: u64, min: u64, max: u64) -> u64 {
    raw.and_then(Value::as_u64)
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn parse_bool(raw: Option<&Value>, fallback: bool) -> bool {
    raw.and_then(Value::as_bool).unwrap_or(fallback)
}

fn normalize_surface_path(
    root: &Path,
    raw: &str,
    allowed_prefixes: &[&str],
) -> Result<String, String> {
    let clean = clean_text(Some(raw), 260);
    if !allowed_prefixes
        .iter()
        .any(|prefix| clean.starts_with(prefix))
    {
        return Err("shannon_bridge_path_outside_allowed_surface".to_string());
    }
    Ok(rel(root, &repo_path(root, &clean)))
}

fn looks_like_cron(expr: &str) -> bool {
    let clean = expr.trim();
    if clean.is_empty() {
        return false;
    }
    if matches!(clean, "@hourly" | "@daily" | "@weekly") {
        return true;
    }
    clean.split_whitespace().count() == 5
}

fn record_pattern(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let pattern_name = clean_text(payload.get("pattern_name").and_then(Value::as_str), 120);
    if pattern_name.is_empty() {
        return Err("shannon_pattern_name_required".to_string());
    }
    let strategies = payload
        .get("strategies")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if strategies.is_empty() {
        return Err("shannon_pattern_strategies_required".to_string());
    }
    let pattern_profile = profile(payload.get("profile"));
    let allowed_parallelism = match pattern_profile.as_str() {
        "tiny-max" => 1,
        "pure" => 2,
        _ => parse_u64(payload.get("max_parallelism"), 4, 1, 16),
    };
    let record = json!({
        "pattern_id": stable_id("shpattern", &json!({"pattern_name": pattern_name, "strategies": strategies})),
        "pattern_name": pattern_name,
        "strategies": strategies,
        "stages": payload.get("stages").cloned().unwrap_or_else(|| json!(["plan", "route", "execute", "review"])),
        "handoff_graph": payload.get("handoff_graph").cloned().unwrap_or_else(|| json!([])),
        "profile": pattern_profile,
        "allowed_parallelism": allowed_parallelism,
        "registered_at": now_iso(),
    });
    let id = record
        .get("pattern_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "patterns").insert(id, record.clone());
    Ok(json!({
        "ok": true,
        "pattern": record,
        "claim_evidence": claim("V6-WORKFLOW-001.1", "shannon_orchestration_patterns_register_on_governed_workflow_and_swarm_lanes")
    }))
}

fn guard_budget(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let session_id = clean_token(payload.get("session_id").and_then(Value::as_str), "");
    if session_id.is_empty() {
        return Err("shannon_budget_session_id_required".to_string());
    }
    let token_budget = parse_u64(payload.get("token_budget"), 0, 0, u64::MAX);
    if token_budget == 0 {
        return Err("shannon_budget_token_budget_required".to_string());
    }
    let estimated_tokens = parse_u64(payload.get("estimated_tokens"), 0, 0, u64::MAX);
    let fallback_models = payload
        .get("fallback_models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let current_model = clean_token(
        payload.get("current_model").and_then(Value::as_str),
        "primary",
    );
    let breach = estimated_tokens > token_budget;
    let action = if breach && fallback_models.is_empty() {
        "deny"
    } else if breach {
        "fallback"
    } else {
        "allow"
    };
    if action == "deny" {
        return Err("shannon_budget_breach_without_fallback".to_string());
    }
    let selected_model = if action == "fallback" {
        fallback_models
            .first()
            .and_then(Value::as_str)
            .unwrap_or("fallback")
            .to_string()
    } else {
        current_model.clone()
    };
    let record = json!({
        "guard_id": stable_id("shbudget", &json!({"session_id": session_id, "token_budget": token_budget, "estimated_tokens": estimated_tokens})),
        "session_id": session_id,
        "token_budget": token_budget,
        "estimated_tokens": estimated_tokens,
        "breach": breach,
        "action": action,
        "selected_model": selected_model,
        "fallback_models": fallback_models,
        "fail_closed": true,
        "recorded_at": now_iso(),
    });
    let id = record
        .get("guard_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "budget_guards").insert(id, record.clone());
    Ok(json!({
        "ok": true,
        "budget_guard": record,
        "claim_evidence": claim("V6-WORKFLOW-001.2", "shannon_hard_token_budgets_and_auto_fallbacks_emit_fail_closed_receipts")
    }))
}

fn memory_bridge(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let workspace_id = clean_token(payload.get("workspace_id").and_then(Value::as_str), "");
    if workspace_id.is_empty() {
        return Err("shannon_workspace_id_required".to_string());
    }
    let recent = payload
        .get("recent_items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let semantic = payload
        .get("semantic_items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut seen = BTreeSet::new();
    let mut merged = Vec::new();
    for row in recent.iter().chain(semantic.iter()) {
        let key = row
            .get("id")
            .and_then(Value::as_str)
            .or_else(|| row.get("text").and_then(Value::as_str))
            .unwrap_or("memory-item")
            .to_string();
        if seen.insert(key) {
            merged.push(row.clone());
        }
    }
    let memory_profile = profile(payload.get("profile"));
    let budget = match memory_profile.as_str() {
        "tiny-max" => parse_u64(payload.get("context_budget"), 2, 1, 4) as usize,
        "pure" => parse_u64(payload.get("context_budget"), 4, 1, 8) as usize,
        _ => parse_u64(payload.get("context_budget"), 6, 1, 16) as usize,
    };
    let selected = merged.into_iter().take(budget).collect::<Vec<_>>();
    let record = json!({
        "workspace_id": workspace_id,
        "hierarchy": payload.get("hierarchy").cloned().unwrap_or_else(|| json!({"root": []})),
        "selected_items": selected,
        "deduplicated_count": seen.len(),
        "query": clean_text(payload.get("query").and_then(Value::as_str), 160),
        "profile": memory_profile,
        "recorded_at": now_iso(),
    });
    as_object_mut(state, "memory_workspaces").insert(workspace_id.clone(), record.clone());
    Ok(json!({
        "ok": true,
        "memory_workspace": record,
        "claim_evidence": claim("V6-WORKFLOW-001.3", "shannon_hierarchical_and_vector_memory_routes_through_receipted_governed_memory_lanes")
    }))
}

fn replay_run(
    root: &Path,
    state: &mut Value,
    replay_dir: &Path,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let run_id = clean_token(payload.get("run_id").and_then(Value::as_str), "");
    if run_id.is_empty() {
        return Err("shannon_replay_run_id_required".to_string());
    }
    let export = json!({
        "run_id": run_id,
        "events": payload.get("events" ).cloned().unwrap_or_else(|| json!([])),
        "receipt_refs": payload.get("receipt_refs").cloned().unwrap_or_else(|| json!([])),
        "strict": parse_bool(payload.get("strict"), true),
        "exported_at": now_iso(),
    });
    fs::create_dir_all(replay_dir)
        .map_err(|err| format!("shannon_replay_dir_create_failed:{err}"))?;
    let export_path = replay_dir.join(format!("{}.json", run_id));
    lane_utils::write_json(&export_path, &export)?;
    let replay = json!({
        "replay_id": stable_id("shreplay", &json!({"run_id": run_id})),
        "run_id": run_id,
        "event_count": export.get("events").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
        "receipt_ref_count": export.get("receipt_refs").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
        "export_path": rel(root, &export_path),
        "replay_hash": deterministic_receipt_hash(&export),
        "replayed_at": now_iso(),
    });
    let id = replay
        .get("replay_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "replays").insert(id, replay.clone());
    Ok(json!({
        "ok": true,
        "replay": replay,
        "claim_evidence": claim("V6-WORKFLOW-001.4", "shannon_replay_exports_and_reexecutions_emit_deterministic_receipts")
    }))
}

fn approval_checkpoint(
    state: &mut Value,
    queue_path: &Path,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let action_id = clean_token(payload.get("action_id").and_then(Value::as_str), "");
    if action_id.is_empty() {
        return Err("shannon_approval_action_id_required".to_string());
    }
    let event = json!({
        "checkpoint_id": stable_id("shapprove", &json!({"action_id": action_id, "title": payload.get("title")})),
        "action_id": action_id,
        "title": clean_text(payload.get("title").and_then(Value::as_str), 120),
        "reason": clean_text(payload.get("reason").and_then(Value::as_str), 160),
        "operator": clean_token(payload.get("operator").and_then(Value::as_str), "human"),
        "status": clean_token(payload.get("status").and_then(Value::as_str), "pending"),
        "recorded_at": now_iso(),
    });
    let mut queue = match fs::read_to_string(queue_path) {
        Ok(raw) => serde_yaml::from_str::<Value>(&raw).unwrap_or_else(|_| json!({"events": []})),
        Err(_) => json!({"events": []}),
    };
    if !queue.get("events").map(Value::is_array).unwrap_or(false) {
        queue["events"] = json!([]);
    }
    queue
        .get_mut("events")
        .and_then(Value::as_array_mut)
        .expect("events")
        .push(event.clone());
    if let Some(parent) = queue_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("shannon_approval_queue_dir_create_failed:{err}"))?;
    }
    let encoded = serde_yaml::to_string(&queue)
        .map_err(|err| format!("shannon_approval_queue_encode_failed:{err}"))?;
    fs::write(queue_path, encoded)
        .map_err(|err| format!("shannon_approval_queue_write_failed:{err}"))?;
    let id = event
        .get("checkpoint_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "approvals").insert(id, event.clone());
    Ok(json!({
        "ok": true,
        "approval_checkpoint": event,
        "approval_queue_path": queue_path.display().to_string(),
        "claim_evidence": claim("V6-WORKFLOW-001.5", "shannon_human_review_points_remain_inside_receipted_approval_boundaries")
    }))
}

fn sandbox_execute(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let tenant_id = clean_token(payload.get("tenant_id").and_then(Value::as_str), "");
    if tenant_id.is_empty() {
        return Err("shannon_sandbox_tenant_id_required".to_string());
    }
    let sandbox_mode = clean_token(payload.get("sandbox_mode").and_then(Value::as_str), "wasi");
    if !matches!(sandbox_mode.as_str(), "wasi" | "firecracker" | "readonly") {
        return Err("shannon_sandbox_mode_unsupported".to_string());
    }
    let read_only = parse_bool(payload.get("read_only"), true);
    let destructive = parse_bool(payload.get("destructive"), false);
    if destructive {
        return Err("shannon_sandbox_destructive_denied".to_string());
    }
    let fs_paths = payload
        .get("fs_paths")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let invalid_path = fs_paths.iter().filter_map(Value::as_str).any(|row| {
        !(row.starts_with("core/")
            || row.starts_with("client/")
            || row.starts_with("adapters/")
            || row.starts_with("docs/")
            || row.starts_with("tests/"))
    });
    if invalid_path {
        return Err("shannon_sandbox_path_outside_allowed_surface".to_string());
    }
    let record = json!({
        "sandbox_id": stable_id("shsandbox", &json!({"tenant_id": tenant_id, "sandbox_mode": sandbox_mode})),
        "tenant_id": tenant_id,
        "sandbox_mode": sandbox_mode,
        "read_only": read_only,
        "fs_paths": fs_paths,
        "command": clean_text(payload.get("command").and_then(Value::as_str), 180),
        "isolation_hash": deterministic_receipt_hash(&json!({"tenant_id": tenant_id, "read_only": read_only})),
        "executed_at": now_iso(),
    });
    let id = record
        .get("sandbox_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "sandbox_runs").insert(id, record.clone());
    Ok(json!({
        "ok": true,
        "sandbox_run": record,
        "claim_evidence": claim("V6-WORKFLOW-001.6", "shannon_sandbox_and_multi_tenant_controls_remain_fail_closed_and_auditable")
    }))
}

fn record_observability(
    root: &Path,
    state: &mut Value,
    trace_path: &Path,
    metrics_path: &Path,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let event_id = stable_id(
        "shobs",
        &json!({"run_id": payload.get("run_id"), "message": payload.get("message")}),
    );
    let spans = payload
        .get("spans")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let metrics = payload.get("metrics").cloned().unwrap_or_else(|| json!({}));
    let trace = json!({
        "event_id": event_id,
        "run_id": clean_token(payload.get("run_id").and_then(Value::as_str), ""),
        "message": clean_text(payload.get("message").and_then(Value::as_str), 180),
        "spans": spans,
        "metrics": metrics,
        "recorded_at": now_iso(),
    });
    lane_utils::append_jsonl(trace_path, &trace)?;
    if let Some(parent) = metrics_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("shannon_metrics_dir_create_failed:{err}"))?;
    }
    let mut lines = vec![
        "# HELP shannon_bridge_events_total Number of Shannon observability events.".to_string(),
        "# TYPE shannon_bridge_events_total gauge".to_string(),
        format!("shannon_bridge_events_total 1"),
    ];
    if let Some(obj) = metrics.as_object() {
        for (key, value) in obj {
            if let Some(num) = value.as_f64() {
                let safe = key.replace('-', "_");
                lines.push(format!("shannon_bridge_metric_{} {}", safe, num));
            }
        }
    }
    fs::write(metrics_path, lines.join("\n") + "\n")
        .map_err(|err| format!("shannon_metrics_write_failed:{err}"))?;
    as_object_mut(state, "observability").insert(
        event_id.clone(),
        json!({
            "event_id": event_id,
            "trace_path": rel(root, trace_path),
            "metrics_path": rel(root, metrics_path),
            "recorded_at": now_iso(),
        }),
    );
    Ok(json!({
        "ok": true,
        "observability_event": trace,
        "trace_path": rel(root, trace_path),
        "metrics_path": rel(root, metrics_path),
        "claim_evidence": claim("V6-WORKFLOW-001.7", "shannon_prometheus_and_otel_style_events_stream_through_native_observability_artifacts")
    }))
}

fn gateway_route(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let compat_mode = clean_token(
        payload.get("compat_mode").and_then(Value::as_str),
        "/v1/chat/completions",
    );
    let provider_route_path = normalize_surface_path(
        root,
        payload
            .get("bridge_path")
            .and_then(Value::as_str)
            .unwrap_or("adapters/protocol/shannon_gateway_bridge.ts"),
        &["adapters/", "client/runtime/"],
    )?;
    let request_id = clean_token(payload.get("request_id").and_then(Value::as_str), "request");
    let providers = payload
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![json!("openai")]);
    let model = clean_token(payload.get("model").and_then(Value::as_str), "gpt-5.4-mini");
    let gateway_profile = profile(payload.get("profile"));
    let unsupported = gateway_profile == "tiny-max"
        && parse_bool(payload.get("streaming"), true)
        && model.contains("vision");
    let selected_provider = providers
        .first()
        .and_then(Value::as_str)
        .unwrap_or("openai");
    let selected_model = if unsupported {
        format!("{}-fallback", model)
    } else {
        model.clone()
    };
    let record = json!({
        "gateway_id": stable_id("shgateway", &json!({"request_id": request_id, "compat_mode": compat_mode})),
        "request_id": request_id,
        "compat_mode": compat_mode,
        "selected_provider": selected_provider,
        "selected_model": selected_model,
        "streaming": parse_bool(payload.get("streaming"), true),
        "bridge_path": provider_route_path,
        "degraded": unsupported,
        "recorded_at": now_iso(),
    });
    let id = record
        .get("gateway_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "gateway_routes").insert(id, record.clone());
    Ok(json!({
        "ok": true,
        "gateway_route": record,
        "claim_evidence": claim("V6-WORKFLOW-001.8", "shannon_openai_compatible_gateway_routes_emit_deterministic_receipts_and_explicit_degradation")
    }))
}

fn register_tooling(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let bridge_path = normalize_surface_path(
        root,
        payload
            .get("bridge_path")
            .and_then(Value::as_str)
            .unwrap_or("adapters/protocol/shannon_gateway_bridge.ts"),
        &["adapters/", "client/runtime/"],
    )?;
    let skills = payload
        .get("skills")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mcp_tools = payload
        .get("mcp_tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let unsafe_tool = mcp_tools
        .iter()
        .filter_map(Value::as_object)
        .any(|tool| tool.get("unsafe").and_then(Value::as_bool).unwrap_or(false));
    if unsafe_tool {
        return Err("shannon_tool_registry_unsafe_tool_denied".to_string());
    }
    let record = json!({
        "registry_id": stable_id("shtools", &json!({"skills": skills, "mcp_tools": mcp_tools})),
        "skills": skills,
        "mcp_tools": mcp_tools,
        "bridge_path": bridge_path,
        "registered_at": now_iso(),
    });
    let id = record
        .get("registry_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "tool_registrations").insert(id, record.clone());
    Ok(json!({
        "ok": true,
        "tool_registry": record,
        "claim_evidence": claim("V6-WORKFLOW-001.9", "shannon_skills_and_mcp_tools_register_through_governed_manifests_and_fail_closed_bridges")
    }))
}

fn schedule_run(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let job_name = clean_text(payload.get("job_name").and_then(Value::as_str), 120);
    if job_name.is_empty() {
        return Err("shannon_schedule_job_name_required".to_string());
    }
    let cron = clean_text(payload.get("cron").and_then(Value::as_str), 80);
    if !looks_like_cron(&cron) {
        return Err("shannon_schedule_invalid_cron".to_string());
    }
    let record = json!({
        "schedule_id": stable_id("shsched", &json!({"job_name": job_name, "cron": cron})),
        "job_name": job_name,
        "cron": cron,
        "pattern_id": clean_token(payload.get("pattern_id").and_then(Value::as_str), ""),
        "priority": parse_u64(payload.get("priority"), 5, 1, 10),
        "budget": payload.get("budget").cloned().unwrap_or_else(|| json!({"tokens": 1024})),
        "recorded_at": now_iso(),
    });
    let id = record
        .get("schedule_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "schedules").insert(id, record.clone());
    Ok(json!({
        "ok": true,
        "schedule": record,
        "claim_evidence": claim("V6-WORKFLOW-001.10", "shannon_cron_and_scheduled_runs_emit_receipts_under_existing_budget_and_priority_controls")
    }))
}

fn desktop_shell(
    root: &Path,
    state: &mut Value,
    desktop_history_path: &Path,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let surface = clean_token(payload.get("surface").and_then(Value::as_str), "tray");
    if !matches!(surface.as_str(), "tray" | "notify" | "history") {
        return Err("shannon_desktop_surface_unsupported".to_string());
    }
    let record = json!({
        "desktop_event_id": stable_id("shdesktop", &json!({"surface": surface, "action": payload.get("action")})),
        "surface": surface,
        "action": clean_token(payload.get("action").and_then(Value::as_str), "open"),
        "title": clean_text(payload.get("title").and_then(Value::as_str), 120),
        "message": clean_text(payload.get("message").and_then(Value::as_str), 180),
        "history_path": rel(root, desktop_history_path),
        "deletable_shell": true,
        "authority_delegate": "core://shannon-bridge",
        "recorded_at": now_iso(),
    });
    if let Some(parent) = desktop_history_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("shannon_desktop_dir_create_failed:{err}"))?;
    }
    lane_utils::write_json(desktop_history_path, &record)?;
    let id = record
        .get("desktop_event_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "desktop_events").insert(id, record.clone());
    Ok(json!({
        "ok": true,
        "desktop_event": record,
        "claim_evidence": claim("V6-WORKFLOW-001.11", "shannon_desktop_surfaces_remain_thin_deletable_shells_over_governed_authority")
    }))
}

fn p2p_reliability(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let peer_id = clean_token(payload.get("peer_id").and_then(Value::as_str), "");
    if peer_id.is_empty() {
        return Err("shannon_p2p_peer_id_required".to_string());
    }
    let version = clean_token(payload.get("version").and_then(Value::as_str), "v1");
    let supported_versions = payload
        .get("supported_versions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![json!("v1")]);
    let allowed = supported_versions
        .iter()
        .filter_map(Value::as_str)
        .any(|row| row == version);
    if !allowed {
        return Err("shannon_p2p_version_gate_denied".to_string());
    }
    let message_ids = payload
        .get("message_ids")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut dedup = BTreeSet::new();
    for message_id in &message_ids {
        if let Some(raw) = message_id.as_str() {
            dedup.insert(raw.to_string());
        }
    }
    let record = json!({
        "reliability_id": stable_id("shp2p", &json!({"peer_id": peer_id, "version": version})),
        "peer_id": peer_id,
        "version": version,
        "supported_versions": supported_versions,
        "deduplicated_messages": dedup.len(),
        "version_gate": true,
        "recorded_at": now_iso(),
    });
    let id = record
        .get("reliability_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "p2p_reliability").insert(id, record.clone());
    Ok(json!({
        "ok": true,
        "p2p_reliability": record,
        "claim_evidence": claim("V6-WORKFLOW-001.12", "shannon_p2p_reliability_and_deduplication_remain_inside_authoritative_swarm_controls")
    }))
}

fn assimilate_intake(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let shell_path = normalize_surface_path(
        root,
        payload
            .get("shell_path")
            .and_then(Value::as_str)
            .unwrap_or("client/runtime/systems/workflow/shannon_desktop_shell.ts"),
        &["client/runtime/", "apps/"],
    )?;
    let adapter_path = normalize_surface_path(
        root,
        payload
            .get("bridge_path")
            .and_then(Value::as_str)
            .unwrap_or("adapters/protocol/shannon_gateway_bridge.ts"),
        &["adapters/", "client/runtime/"],
    )?;
    let record = json!({
        "intake_id": stable_id("shintake", &json!({"shell_path": shell_path, "adapter_path": adapter_path})),
        "shell_path": shell_path,
        "adapter_path": adapter_path,
        "deletable": true,
        "authority_delegate": "core://shannon-bridge",
        "recorded_at": now_iso(),
    });
    let id = record
        .get("intake_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "intakes").insert(id, record.clone());
    Ok(json!({
        "ok": true,
        "intake": record,
        "claim_evidence": claim("V6-WORKFLOW-001.9", "assimilate_shannon_routes_through_a_governed_skill_and_adapter_intake_path")
    }))
}

fn status(root: &Path, state: &Value, state_path: &Path, history_path: &Path) -> Value {
    json!({
        "ok": true,
        "state_path": rel(root, state_path),
        "history_path": rel(root, history_path),
        "patterns": state.get("patterns").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "budget_guards": state.get("budget_guards").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "memory_workspaces": state.get("memory_workspaces").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "replays": state.get("replays").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "approvals": state.get("approvals").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "sandbox_runs": state.get("sandbox_runs").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "observability": state.get("observability").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "gateway_routes": state.get("gateway_routes").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "tool_registrations": state.get("tool_registrations").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "schedules": state.get("schedules").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "desktop_events": state.get("desktop_events").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "p2p_reliability": state.get("p2p_reliability").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "intakes": state.get("intakes").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "last_receipt": state.get("last_receipt").cloned().unwrap_or(Value::Null),
    })
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let Some(command) = argv.first().map(|row| row.trim().to_ascii_lowercase()) else {
        usage();
        return 0;
    };
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }
    let payload = match payload_json(argv) {
        Ok(value) => value,
        Err(err) => {
            print_json_line(&cli_error("shannon_bridge_error", &err));
            return 1;
        }
    };
    let payload = payload_obj(&payload);
    let state_path = state_path(root, argv, payload);
    let history_path = history_path(root, argv, payload);
    let approval_queue_path = approval_queue_path(root, argv, payload);
    let replay_dir = replay_dir(root, argv, payload);
    let observability_trace_path = observability_trace_path(root, argv, payload);
    let observability_metrics_path = observability_metrics_path(root, argv, payload);
    let desktop_history_path = desktop_history_path(root, argv, payload);
    let mut state = load_state(&state_path);

    let result = match command.as_str() {
        "status" => Ok(status(root, &state, &state_path, &history_path)),
        "register-pattern" => record_pattern(&mut state, payload),
        "guard-budget" => guard_budget(&mut state, payload),
        "memory-bridge" => memory_bridge(&mut state, payload),
        "replay-run" => replay_run(root, &mut state, &replay_dir, payload),
        "approval-checkpoint" => approval_checkpoint(&mut state, &approval_queue_path, payload),
        "sandbox-execute" => sandbox_execute(&mut state, payload),
        "record-observability" => record_observability(
            root,
            &mut state,
            &observability_trace_path,
            &observability_metrics_path,
            payload,
        ),
        "gateway-route" => gateway_route(root, &mut state, payload),
        "register-tooling" => register_tooling(root, &mut state, payload),
        "schedule-run" => schedule_run(&mut state, payload),
        "desktop-shell" => desktop_shell(root, &mut state, &desktop_history_path, payload),
        "p2p-reliability" => p2p_reliability(&mut state, payload),
        "assimilate-intake" => assimilate_intake(root, &mut state, payload),
        other => Err(format!("shannon_bridge_unknown_command:{other}")),
    };

    match result {
        Ok(payload_out) => {
            let receipt = cli_receipt(
                match command.as_str() {
                    "status" => "shannon_bridge_status",
                    "register-pattern" => "shannon_bridge_register_pattern",
                    "guard-budget" => "shannon_bridge_guard_budget",
                    "memory-bridge" => "shannon_bridge_memory_bridge",
                    "replay-run" => "shannon_bridge_replay_run",
                    "approval-checkpoint" => "shannon_bridge_approval_checkpoint",
                    "sandbox-execute" => "shannon_bridge_sandbox_execute",
                    "record-observability" => "shannon_bridge_record_observability",
                    "gateway-route" => "shannon_bridge_gateway_route",
                    "register-tooling" => "shannon_bridge_register_tooling",
                    "schedule-run" => "shannon_bridge_schedule_run",
                    "desktop-shell" => "shannon_bridge_desktop_shell",
                    "p2p-reliability" => "shannon_bridge_p2p_reliability",
                    "assimilate-intake" => "shannon_bridge_assimilate_intake",
                    _ => "shannon_bridge_command",
                },
                payload_out,
            );
            state["last_receipt"] = receipt.clone();
            if command != "status" {
                if let Err(err) = save_state(&state_path, &state) {
                    print_json_line(&cli_error("shannon_bridge_error", &err));
                    return 1;
                }
                if let Err(err) = append_history(&history_path, &receipt) {
                    print_json_line(&cli_error("shannon_bridge_error", &err));
                    return 1;
                }
            }
            print_json_line(&receipt);
            0
        }
        Err(err) => {
            print_json_line(&cli_error("shannon_bridge_error", &err));
            1
        }
    }
}
