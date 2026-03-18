// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_STATE_REL: &str = "local/state/ops/llamaindex_bridge/latest.json";
const DEFAULT_HISTORY_REL: &str = "local/state/ops/llamaindex_bridge/history.jsonl";
const DEFAULT_SWARM_STATE_REL: &str = "local/state/ops/llamaindex_bridge/swarm_state.json";

fn usage() {
    println!("llamaindex-bridge commands:");
    println!("  protheus-ops llamaindex-bridge status [--state-path=<path>]");
    println!("  protheus-ops llamaindex-bridge register-index [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops llamaindex-bridge query [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops llamaindex-bridge run-agent-workflow [--payload-base64=<json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops llamaindex-bridge ingest-multimodal [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops llamaindex-bridge record-memory-eval [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops llamaindex-bridge run-conditional-workflow [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops llamaindex-bridge emit-trace [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops llamaindex-bridge register-connector [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops llamaindex-bridge connector-query [--payload-base64=<json>] [--state-path=<path>]");
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
            .map_err(|err| format!("llamaindex_bridge_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("llamaindex_bridge_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("llamaindex_bridge_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("llamaindex_bridge_payload_decode_failed:{err}"));
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

fn state_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "state-path", false)
        .or_else(|| payload.get("state_path").and_then(Value::as_str).map(ToString::to_string))
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_STATE_REL))
}

fn history_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "history-path", false)
        .or_else(|| payload.get("history_path").and_then(Value::as_str).map(ToString::to_string))
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_HISTORY_REL))
}

fn swarm_state_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "swarm-state-path", false)
        .or_else(|| payload.get("swarm_state_path").and_then(Value::as_str).map(ToString::to_string))
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_SWARM_STATE_REL))
}

fn default_state() -> Value {
    json!({
        "schema_version": "llamaindex_bridge_state_v1",
        "indexes": {},
        "agent_workflows": {},
        "ingestions": {},
        "memory_store": {},
        "evaluations": {},
        "conditional_workflows": {},
        "traces": [],
        "connectors": {},
        "last_receipt": null,
    })
}

fn ensure_state_shape(value: &mut Value) {
    if !value.is_object() {
        *value = default_state();
        return;
    }
    for key in [
        "indexes",
        "agent_workflows",
        "ingestions",
        "memory_store",
        "evaluations",
        "conditional_workflows",
        "connectors",
    ] {
        if !value.get(key).map(Value::is_object).unwrap_or(false) {
            value[key] = json!({});
        }
    }
    if !value.get("traces").map(Value::is_array).unwrap_or(false) {
        value["traces"] = json!([]);
    }
    if value.get("schema_version").and_then(Value::as_str).is_none() {
        value["schema_version"] = json!("llamaindex_bridge_state_v1");
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
    value.get_mut(key).and_then(Value::as_object_mut).expect("object")
}

fn as_array_mut<'a>(value: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    if !value.get(key).map(Value::is_array).unwrap_or(false) {
        value[key] = json!([]);
    }
    value.get_mut(key).and_then(Value::as_array_mut).expect("array")
}

fn now_millis() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|row| row.as_millis())
        .unwrap_or(0)
}

fn to_base36(mut value: u128) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        out.push(if digit < 10 { (b'0' + digit) as char } else { (b'a' + (digit - 10)) as char });
        value /= 36;
    }
    out.iter().rev().collect()
}

fn stable_id(prefix: &str, basis: &Value) -> String {
    let digest = deterministic_receipt_hash(basis);
    format!("{prefix}_{}_{}", to_base36(now_millis()), &digest[..12])
}

fn clean_text(raw: Option<&str>, max_len: usize) -> String {
    raw.unwrap_or_default()
        .chars()
        .map(|ch| if ch.is_control() { ' ' } else { ch })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_len)
        .collect::<String>()
}

fn clean_token(raw: Option<&str>, fallback: &str) -> String {
    let cleaned = raw
        .unwrap_or_default()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':'))
        .collect::<String>();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned
    }
}

fn parse_u64_value(value: Option<&Value>, fallback: u64, min: u64, max: u64) -> u64 {
    value.and_then(|row| row.as_u64()).unwrap_or(fallback).clamp(min, max)
}

fn parse_f64_value(value: Option<&Value>, fallback: f64, min: f64, max: f64) -> f64 {
    value.and_then(|row| row.as_f64()).unwrap_or(fallback).clamp(min, max)
}

fn rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn safe_prefix_for_bridge(path: &str) -> bool {
    [
        "adapters/",
        "client/runtime/systems/",
        "client/runtime/lib/",
        "client/lib/",
        "planes/contracts/",
    ]
    .iter()
    .any(|prefix| path.starts_with(prefix))
}

fn normalize_bridge_path(root: &Path, raw: &str) -> Result<String, String> {
    let candidate = raw.trim();
    if candidate.is_empty() {
        return Err("bridge_path_required".to_string());
    }
    if candidate.contains("..") {
        return Err("unsafe_bridge_path_parent_reference".to_string());
    }
    let abs = repo_path(root, candidate);
    let rel_path = rel(root, &abs);
    if !safe_prefix_for_bridge(&rel_path) {
        return Err("unsupported_bridge_path".to_string());
    }
    Ok(rel_path)
}

fn default_claim_evidence(id: &str, claim: &str) -> Value {
    json!([{ "id": id, "claim": claim }])
}

fn read_swarm_state(path: &Path) -> Value {
    lane_utils::read_json(path)
        .unwrap_or_else(|| json!({ "sessions": {}, "handoff_registry": {} }))
}

fn find_swarm_session_id_by_task(state: &Value, task: &str) -> Option<String> {
    state
        .get("sessions")
        .and_then(Value::as_object)
        .and_then(|rows| {
            rows.iter().find_map(|(session_id, row)| {
                let row_task = row.get("task").and_then(Value::as_str);
                let report_task = row
                    .get("report")
                    .and_then(|value| value.get("task"))
                    .and_then(Value::as_str);
                (row_task == Some(task) || report_task == Some(task)).then(|| session_id.clone())
            })
        })
}

fn semantic_claim(id: &str) -> &'static str {
    match id {
        "V6-WORKFLOW-009.1" => "llamaindex_indexes_retrievers_and_query_engines_are_governed_and_receipted",
        "V6-WORKFLOW-009.2" => "llamaindex_agentic_workflows_reuse_authoritative_swarm_handoffs_and_receipted_tool_calls",
        "V6-WORKFLOW-009.3" => "llamaindex_multimodal_ingestion_and_loader_paths_enforce_profile_degradation_and_receipts",
        "V6-WORKFLOW-009.4" => "llamaindex_memory_store_and_eval_outputs_persist_as_governed_observability_artifacts",
        "V6-WORKFLOW-009.5" => "llamaindex_conditional_workflows_route_deterministically_with_checkpoint_receipts",
        "V6-WORKFLOW-009.6" => "llamaindex_traces_fold_into_native_observability_without_duplicate_telemetry_stacks",
        "V6-WORKFLOW-009.7" => "llamaindex_connectors_normalize_into_governed_manifests_with_fail_closed_query_paths",
        _ => "llamaindex_bridge_claim",
    }
}

fn doc_token_set(doc: &Value) -> BTreeSet<String> {
    clean_text(doc.get("text").and_then(Value::as_str), 4096)
        .to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|row| !row.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn query_terms(query: &str) -> Vec<String> {
    clean_text(Some(query), 240)
        .to_ascii_lowercase()
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|row| !row.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn retrieval_score(doc: &Value, terms: &[String], mode: &str) -> i64 {
    let tokens = doc_token_set(doc);
    let mut score = 0i64;
    for term in terms {
        if tokens.contains(term) {
            score += match mode {
                "graph" => 4,
                "vector" => 3,
                _ => 2,
            };
        }
    }
    if mode == "hybrid" && doc.get("metadata").and_then(|row| row.get("kind")).and_then(Value::as_str) == Some("graph") {
        score += 2;
    }
    score
}

fn register_index(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let name = clean_token(payload.get("name").and_then(Value::as_str), "llamaindex-index");
    let documents = payload.get("documents").and_then(Value::as_array).cloned().unwrap_or_default();
    if documents.is_empty() {
        return Err("llamaindex_index_documents_required".to_string());
    }
    let retrieval_modes = payload.get("retrieval_modes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![json!("hybrid"), json!("vector"), json!("graph")]);
    let query_engine = clean_token(payload.get("query_engine").and_then(Value::as_str), "router");
    let index = json!({
        "index_id": stable_id("llxidx", &json!({"name": name, "engine": query_engine})),
        "name": name,
        "retrieval_modes": retrieval_modes,
        "query_engine": query_engine,
        "documents": documents,
        "registered_at": now_iso(),
    });
    let index_id = index.get("index_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "indexes").insert(index_id, index.clone());
    Ok(json!({
        "ok": true,
        "index": index,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-009.1", semantic_claim("V6-WORKFLOW-009.1")),
    }))
}

fn query_index(state: &Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let index_id = clean_token(payload.get("index_id").and_then(Value::as_str), "");
    if index_id.is_empty() {
        return Err("llamaindex_query_index_id_required".to_string());
    }
    let query = clean_text(payload.get("query").and_then(Value::as_str), 240);
    if query.is_empty() {
        return Err("llamaindex_query_text_required".to_string());
    }
    let mode = clean_token(payload.get("mode").and_then(Value::as_str), "hybrid");
    let top_k = parse_u64_value(payload.get("top_k"), 3, 1, 12) as usize;
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let index = state
        .get("indexes")
        .and_then(Value::as_object)
        .and_then(|rows| rows.get(&index_id))
        .cloned()
        .ok_or_else(|| format!("unknown_llamaindex_index:{index_id}"))?;
    let supported = index.get("retrieval_modes").and_then(Value::as_array).cloned().unwrap_or_default();
    let supported_modes = supported.iter().filter_map(Value::as_str).collect::<BTreeSet<_>>();
    if !supported_modes.contains(mode.as_str()) {
        return Err(format!("llamaindex_query_mode_unsupported:{mode}"));
    }
    if (profile == "pure" || profile == "tiny-max") && mode == "graph" {
        return Ok(json!({
            "ok": true,
            "index_id": index_id,
            "profile": profile,
            "mode": mode,
            "degraded": true,
            "reason_code": "graph_retrieval_requires_rich_profile",
            "results": [],
            "claim_evidence": default_claim_evidence("V6-WORKFLOW-009.1", semantic_claim("V6-WORKFLOW-009.1")),
        }));
    }
    let terms = query_terms(&query);
    let mut ranked = index
        .get("documents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|doc| {
            let score = retrieval_score(&doc, &terms, &mode);
            (score, doc)
        })
        .filter(|(score, _)| *score > 0)
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| b.0.cmp(&a.0));
    let results = ranked.into_iter().take(top_k).map(|(score, doc)| {
        json!({
            "score": score,
            "text": doc.get("text").cloned().unwrap_or(Value::Null),
            "metadata": doc.get("metadata").cloned().unwrap_or(Value::Null),
        })
    }).collect::<Vec<_>>();
    Ok(json!({
        "ok": true,
        "index_id": index_id,
        "query": query,
        "mode": mode,
        "profile": profile,
        "query_engine": index.get("query_engine").cloned().unwrap_or(Value::Null),
        "results": results,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-009.1", semantic_claim("V6-WORKFLOW-009.1")),
    }))
}

fn run_agent_workflow(root: &Path, argv: &[String], state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let workflow_name = clean_token(payload.get("name").and_then(Value::as_str), "llamaindex-agent-workflow");
    let query = clean_text(payload.get("query").and_then(Value::as_str), 200);
    if query.is_empty() {
        return Err("llamaindex_agent_workflow_query_required".to_string());
    }
    let swarm_state_path = swarm_state_path(root, argv, payload);
    let tools = payload.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
    let handoffs = payload.get("handoffs").and_then(Value::as_array).cloned().unwrap_or_default();
    let child_budget_sum = handoffs
        .iter()
        .filter_map(|row| row.get("budget").and_then(Value::as_u64))
        .sum::<u64>();
    let agent_budget = parse_u64_value(payload.get("budget"), 640, 64, 4096);
    let total_budget = agent_budget
        .saturating_add(child_budget_sum)
        .saturating_add(1024)
        .clamp(1024, 16384);
    let agent_task = format!("llamaindex:{}:{}", workflow_name, query);
    let agent_label = clean_token(payload.get("agent_label").and_then(Value::as_str), "llamaindex-agent");
    let spawn_exit = crate::swarm_runtime::run(
        root,
        &[
            "spawn".to_string(),
            format!("--task={agent_task}"),
            format!("--max-tokens={total_budget}"),
            format!("--agent-label={agent_label}"),
            format!("--state-path={}", swarm_state_path.display()),
        ],
    );
    if spawn_exit != 0 {
        return Err("llamaindex_agent_workflow_spawn_failed".to_string());
    }
    let swarm_state = read_swarm_state(&swarm_state_path);
    let primary_session_id = find_swarm_session_id_by_task(&swarm_state, &agent_task)
        .ok_or_else(|| "llamaindex_agent_workflow_primary_session_missing".to_string())?;

    let mut tool_calls = Vec::new();
    for tool in tools {
        let tool_obj = tool.as_object().ok_or_else(|| "llamaindex_tool_object_required".to_string())?;
        let tool_name = clean_token(tool_obj.get("name").and_then(Value::as_str), "tool");
        let bridge_path = normalize_bridge_path(root, tool_obj.get("bridge_path").and_then(Value::as_str).unwrap_or(""))?;
        let entrypoint = clean_token(tool_obj.get("entrypoint").and_then(Value::as_str), "run");
        tool_calls.push(json!({
            "tool_name": tool_name,
            "bridge_path": bridge_path,
            "entrypoint": entrypoint,
            "arguments": tool_obj.get("args").cloned().unwrap_or_else(|| json!({})),
            "mode": "governed_receipted_invocation",
        }));
    }

    let mut handoff_rows = Vec::new();
    let mut session_ids = BTreeMap::new();
    session_ids.insert(agent_label.clone(), primary_session_id.clone());
    for handoff in handoffs {
        let handoff_obj = handoff.as_object().ok_or_else(|| "llamaindex_handoff_object_required".to_string())?;
        let label = clean_token(handoff_obj.get("label").and_then(Value::as_str), "handoff-agent");
        let role = clean_token(handoff_obj.get("role").and_then(Value::as_str), "specialist");
        let task = format!(
            "llamaindex:{}:{}:{}",
            workflow_name,
            label,
            clean_text(handoff_obj.get("task").and_then(Value::as_str), 120)
        );
        let budget = parse_u64_value(handoff_obj.get("budget"), 256, 32, 4096);
        let spawn_child_exit = crate::swarm_runtime::run(
            root,
            &[
                "spawn".to_string(),
                format!("--task={task}"),
                format!("--session-id={primary_session_id}"),
                format!("--max-tokens={budget}"),
                format!("--agent-label={label}"),
                format!("--role={role}"),
                format!("--state-path={}", swarm_state_path.display()),
            ],
        );
        if spawn_child_exit != 0 {
            return Err(format!("llamaindex_agent_handoff_spawn_failed:{label}"));
        }
        let updated = read_swarm_state(&swarm_state_path);
        let child_session_id = find_swarm_session_id_by_task(&updated, &task)
            .ok_or_else(|| format!("llamaindex_agent_handoff_session_missing:{label}"))?;
        let reason = clean_text(handoff_obj.get("reason").and_then(Value::as_str), 120);
        let handoff_exit = crate::swarm_runtime::run(
            root,
            &[
                "sessions".to_string(),
                "handoff".to_string(),
                format!("--session-id={primary_session_id}"),
                format!("--target-session-id={child_session_id}"),
                format!("--reason={}", if reason.is_empty() { "llamaindex_handoff" } else { &reason }),
                format!("--importance={:.2}", parse_f64_value(handoff_obj.get("importance"), 0.75, 0.0, 1.0)),
                format!("--state-path={}", swarm_state_path.display()),
            ],
        );
        if handoff_exit != 0 {
            return Err(format!("llamaindex_agent_handoff_failed:{label}"));
        }
        session_ids.insert(label.clone(), child_session_id.clone());
        handoff_rows.push(json!({
            "label": label,
            "role": role,
            "session_id": child_session_id,
            "reason": reason,
        }));
    }

    let workflow = json!({
        "workflow_id": stable_id("llxwf", &json!({"name": workflow_name, "query": query})),
        "name": workflow_name,
        "query": query,
        "primary_session_id": primary_session_id,
        "session_ids": session_ids,
        "tool_calls": tool_calls,
        "handoffs": handoff_rows,
        "swarm_state_path": rel(root, &swarm_state_path),
        "executed_at": now_iso(),
    });
    let workflow_id = workflow.get("workflow_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "agent_workflows").insert(workflow_id, workflow.clone());
    Ok(json!({
        "ok": true,
        "workflow": workflow,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-009.2", semantic_claim("V6-WORKFLOW-009.2")),
    }))
}

fn ingest_multimodal(root: &Path, state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let loader_name = clean_token(payload.get("loader_name").and_then(Value::as_str), "llamaindex-loader");
    let modality = clean_token(payload.get("modality").and_then(Value::as_str), "text");
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let assets = payload.get("assets").and_then(Value::as_array).cloned().unwrap_or_default();
    if assets.is_empty() {
        return Err("llamaindex_ingestion_assets_required".to_string());
    }
    let connector = payload.get("bridge_path").and_then(Value::as_str)
        .map(|raw| normalize_bridge_path(root, raw))
        .transpose()?;
    let degraded = matches!(profile.as_str(), "pure" | "tiny-max") && matches!(modality.as_str(), "audio" | "video" | "image");
    let reason_code = if degraded { "profile_multimodal_degraded" } else { "ingestion_ok" };
    let record = json!({
        "ingestion_id": stable_id("llxingest", &json!({"loader": loader_name, "modality": modality})),
        "loader_name": loader_name,
        "modality": modality,
        "profile": profile,
        "bridge_path": connector,
        "asset_count": assets.len(),
        "degraded": degraded,
        "reason_code": reason_code,
        "recorded_at": now_iso(),
    });
    let ingestion_id = record.get("ingestion_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "ingestions").insert(ingestion_id, record.clone());
    Ok(json!({
        "ok": true,
        "ingestion": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-009.3", semantic_claim("V6-WORKFLOW-009.3")),
    }))
}

fn emit_native_trace(root: &Path, trace_id: &str, intent: &str, message: &str) -> Result<(), String> {
    let enable_exit = crate::observability_plane::run(
        root,
        &[
            "acp-provenance".to_string(),
            "--op=enable".to_string(),
            "--enabled=1".to_string(),
            "--visibility-mode=meta".to_string(),
            "--strict=1".to_string(),
        ],
    );
    if enable_exit != 0 {
        return Err("llamaindex_observability_enable_failed".to_string());
    }
    let exit = crate::observability_plane::run(
        root,
        &[
            "acp-provenance".to_string(),
            "--op=trace".to_string(),
            "--source-agent=llamaindex-bridge".to_string(),
            format!("--target-agent={}", clean_token(Some(intent), "workflow")),
            format!("--intent={}", clean_text(Some(intent), 80)),
            format!("--message={}", clean_text(Some(message), 160)),
            format!("--trace-id={trace_id}"),
            "--visibility-mode=meta".to_string(),
            "--strict=1".to_string(),
        ],
    );
    if exit != 0 {
        return Err("llamaindex_observability_trace_failed".to_string());
    }
    Ok(())
}

fn record_memory_eval(root: &Path, state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let memory_key = clean_token(payload.get("memory_key").and_then(Value::as_str), "llamaindex-memory");
    let entries = payload.get("entries").and_then(Value::as_array).cloned().unwrap_or_default();
    if entries.is_empty() {
        return Err("llamaindex_memory_entries_required".to_string());
    }
    let expected = payload.get("expected_hits").and_then(Value::as_array).cloned().unwrap_or_default();
    let actual = payload.get("actual_hits").and_then(Value::as_array).cloned().unwrap_or_default();
    let expected_set = expected.iter().filter_map(Value::as_str).collect::<BTreeSet<_>>();
    let actual_set = actual.iter().filter_map(Value::as_str).collect::<BTreeSet<_>>();
    let overlap = expected_set.intersection(&actual_set).count() as f64;
    let recall = if expected_set.is_empty() { 1.0 } else { overlap / (expected_set.len() as f64) };
    let eval = json!({
        "evaluation_id": stable_id("llxeval", &json!({"memory_key": memory_key, "expected": expected_set.len(), "actual": actual_set.len()})),
        "memory_key": memory_key,
        "entry_count": entries.len(),
        "expected_hits": expected,
        "actual_hits": actual,
        "recall": recall,
        "evaluated_at": now_iso(),
    });
    let eval_id = eval.get("evaluation_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "memory_store").insert(memory_key.clone(), json!({
        "entries": entries,
        "updated_at": now_iso(),
    }));
    as_object_mut(state, "evaluations").insert(eval_id, eval.clone());
    emit_native_trace(root, eval.get("evaluation_id").and_then(Value::as_str).unwrap_or("llamaindex-eval"), "llamaindex_eval", &format!("memory_key={memory_key} recall={recall:.2}"))?;
    Ok(json!({
        "ok": true,
        "evaluation": eval,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-009.4", semantic_claim("V6-WORKFLOW-009.4")),
    }))
}

fn condition_matches(condition: &Value, context: &Map<String, Value>) -> bool {
    let field = condition.get("field").and_then(Value::as_str).unwrap_or_default();
    let equals = condition.get("equals");
    if field.is_empty() {
        return false;
    }
    context.get(field) == equals
}

fn run_conditional_workflow(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let workflow_name = clean_token(payload.get("name").and_then(Value::as_str), "llamaindex-conditional");
    let steps = payload.get("steps").and_then(Value::as_array).cloned().unwrap_or_default();
    if steps.is_empty() {
        return Err("llamaindex_conditional_workflow_steps_required".to_string());
    }
    let context = payload.get("context").and_then(Value::as_object).cloned().unwrap_or_default();
    let mut current = steps.first().cloned().unwrap_or(Value::Null);
    let mut visited = Vec::new();
    for _ in 0..steps.len().saturating_add(2) {
        let step = current.as_object().cloned().ok_or_else(|| "llamaindex_conditional_step_object_required".to_string())?;
        let step_id = clean_token(step.get("id").and_then(Value::as_str), "step");
        let matched = step.get("condition").map(|row| condition_matches(row, &context)).unwrap_or(true);
        let next_id = if matched {
            step.get("next").and_then(Value::as_str)
        } else {
            step.get("else").and_then(Value::as_str)
        };
        visited.push(json!({
            "step_id": step_id,
            "matched": matched,
            "checkpoint_key": step.get("checkpoint_key").cloned().unwrap_or_else(|| json!(Value::Null)),
        }));
        let Some(next_id) = next_id else {
            break;
        };
        if next_id.is_empty() {
            break;
        }
        current = steps.iter()
            .find(|row| row.get("id").and_then(Value::as_str) == Some(next_id))
            .cloned()
            .ok_or_else(|| format!("llamaindex_conditional_workflow_unknown_step:{next_id}"))?;
    }
    let record = json!({
        "workflow_id": stable_id("llxroute", &json!({"name": workflow_name, "context": context})),
        "name": workflow_name,
        "visited": visited,
        "context": context,
        "executed_at": now_iso(),
    });
    let workflow_id = record.get("workflow_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "conditional_workflows").insert(workflow_id, record.clone());
    Ok(json!({
        "ok": true,
        "workflow": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-009.5", semantic_claim("V6-WORKFLOW-009.5")),
    }))
}

fn emit_trace(root: &Path, state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let trace_id = clean_token(payload.get("trace_id").and_then(Value::as_str), "llamaindex-trace");
    let stage = clean_token(payload.get("stage").and_then(Value::as_str), "query");
    let message = clean_text(payload.get("message").and_then(Value::as_str), 160);
    emit_native_trace(root, &trace_id, &stage, &message)?;
    let record = json!({
        "trace_id": trace_id,
        "stage": stage,
        "message": message,
        "data": payload.get("data").cloned().unwrap_or_else(|| json!({})),
        "recorded_at": now_iso(),
    });
    as_array_mut(state, "traces").push(record.clone());
    Ok(json!({
        "ok": true,
        "trace": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-009.6", semantic_claim("V6-WORKFLOW-009.6")),
    }))
}

fn register_connector(root: &Path, state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let name = clean_token(payload.get("name").and_then(Value::as_str), "llamaindex-connector");
    let bridge_path = normalize_bridge_path(root, payload.get("bridge_path").and_then(Value::as_str).unwrap_or(""))?;
    let capabilities = payload.get("capabilities").and_then(Value::as_array).cloned().unwrap_or_default();
    let documents = payload.get("documents").and_then(Value::as_array).cloned().unwrap_or_default();
    let supported_profiles = payload.get("supported_profiles").and_then(Value::as_array).cloned().unwrap_or_else(|| vec![json!("rich"), json!("pure")]);
    let connector = json!({
        "connector_id": stable_id("llxconn", &json!({"name": name, "bridge_path": bridge_path})),
        "name": name,
        "bridge_path": bridge_path,
        "capabilities": capabilities,
        "supported_profiles": supported_profiles,
        "documents": documents,
        "registered_at": now_iso(),
    });
    let connector_id = connector.get("connector_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "connectors").insert(connector_id, connector.clone());
    Ok(json!({
        "ok": true,
        "connector": connector,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-009.7", semantic_claim("V6-WORKFLOW-009.7")),
    }))
}

fn connector_query(state: &Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let connector_id = clean_token(payload.get("connector_id").and_then(Value::as_str), "");
    if connector_id.is_empty() {
        return Err("llamaindex_connector_id_required".to_string());
    }
    let query = clean_text(payload.get("query").and_then(Value::as_str), 240);
    if query.is_empty() {
        return Err("llamaindex_connector_query_required".to_string());
    }
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let connector = state
        .get("connectors")
        .and_then(Value::as_object)
        .and_then(|rows| rows.get(&connector_id))
        .cloned()
        .ok_or_else(|| format!("unknown_llamaindex_connector:{connector_id}"))?;
    let supported = connector.get("supported_profiles").and_then(Value::as_array).cloned().unwrap_or_default();
    if !supported.iter().filter_map(Value::as_str).any(|row| row == profile) {
        return Err(format!("llamaindex_connector_profile_unsupported:{profile}"));
    }
    let terms = query_terms(&query);
    let mut ranked = connector
        .get("documents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|doc| (retrieval_score(&doc, &terms, "hybrid"), doc))
        .filter(|(score, _)| *score > 0)
        .collect::<Vec<_>>();
    ranked.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(json!({
        "ok": true,
        "connector_id": connector_id,
        "query": query,
        "profile": profile,
        "results": ranked.into_iter().take(3).map(|(score, doc)| json!({
            "score": score,
            "text": doc.get("text").cloned().unwrap_or(Value::Null),
            "metadata": doc.get("metadata").cloned().unwrap_or(Value::Null),
        })).collect::<Vec<_>>(),
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-009.7", semantic_claim("V6-WORKFLOW-009.7")),
    }))
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    if argv.is_empty() || matches!(argv[0].as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }
    let command = argv[0].as_str();
    let payload = match payload_json(&argv[1..]) {
        Ok(payload) => payload,
        Err(err) => {
            print_json_line(&cli_error("llamaindex_bridge_error", &err));
            return 1;
        }
    };
    let input = payload_obj(&payload);
    let state_path = state_path(root, argv, input);
    let history_path = history_path(root, argv, input);
    let mut state = load_state(&state_path);

    let result = match command {
        "status" => Ok(json!({
            "ok": true,
            "state_path": rel(root, &state_path),
            "history_path": rel(root, &history_path),
            "indexes": as_object_mut(&mut state, "indexes").len(),
            "agent_workflows": as_object_mut(&mut state, "agent_workflows").len(),
            "ingestions": as_object_mut(&mut state, "ingestions").len(),
            "memory_store": as_object_mut(&mut state, "memory_store").len(),
            "evaluations": as_object_mut(&mut state, "evaluations").len(),
            "conditional_workflows": as_object_mut(&mut state, "conditional_workflows").len(),
            "traces": as_array_mut(&mut state, "traces").len(),
            "connectors": as_object_mut(&mut state, "connectors").len(),
            "last_receipt": state.get("last_receipt").cloned().unwrap_or(Value::Null),
        })),
        "register-index" => register_index(&mut state, input),
        "query" => query_index(&state, input),
        "run-agent-workflow" => run_agent_workflow(root, argv, &mut state, input),
        "ingest-multimodal" => ingest_multimodal(root, &mut state, input),
        "record-memory-eval" => record_memory_eval(root, &mut state, input),
        "run-conditional-workflow" => run_conditional_workflow(&mut state, input),
        "emit-trace" => emit_trace(root, &mut state, input),
        "register-connector" => register_connector(root, &mut state, input),
        "connector-query" => connector_query(&state, input),
        _ => Err(format!("unknown_llamaindex_bridge_command:{command}")),
    };

    match result {
        Ok(payload) => {
            let receipt = cli_receipt(&format!("llamaindex_bridge_{}", command.replace('-', "_")), payload);
            state["last_receipt"] = receipt.clone();
            if let Err(err) = save_state(&state_path, &state).and_then(|_| append_history(&history_path, &receipt)) {
                print_json_line(&cli_error("llamaindex_bridge_error", &err));
                return 1;
            }
            print_json_line(&receipt);
            0
        }
        Err(err) => {
            print_json_line(&cli_error("llamaindex_bridge_error", &err));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_index_ranks_matching_documents() {
        let mut state = default_state();
        let payload = json!({
            "name": "ops-index",
            "documents": [
                {"text": "llamaindex query engine supports hybrid retrieval"},
                {"text": "semantic kernel planner supports function routing"}
            ]
        });
        let _ = register_index(&mut state, payload.as_object().unwrap()).expect("register");
        let index_id = state["indexes"].as_object().unwrap().keys().next().unwrap().to_string();
        let query = json!({"index_id": index_id, "query": "hybrid retrieval", "mode": "hybrid"});
        let out = query_index(&state, query.as_object().unwrap()).expect("query");
        assert!(out["results"].as_array().map(|rows| !rows.is_empty()).unwrap_or(false));
    }

    #[test]
    fn conditional_workflow_routes_deterministically() {
        let mut state = default_state();
        let payload = json!({
            "name": "router",
            "context": {"intent": "support"},
            "steps": [
                {"id": "start", "condition": {"field": "intent", "equals": "support"}, "next": "support-lane", "else": "generic"},
                {"id": "support-lane"},
                {"id": "generic"}
            ]
        });
        let out = run_conditional_workflow(&mut state, payload.as_object().unwrap()).expect("workflow");
        assert_eq!(out["workflow"]["visited"][0]["matched"].as_bool(), Some(true));
    }
}
