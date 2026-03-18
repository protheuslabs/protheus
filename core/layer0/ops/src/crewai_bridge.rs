// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::contract_lane_utils::{
    self as lane_utils, clean_text, clean_token, cli_error, cli_receipt, normalize_bridge_path,
    payload_obj, print_json_line, rel_path as rel, repo_path,
};
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_STATE_REL: &str = "local/state/ops/crewai_bridge/latest.json";
const DEFAULT_HISTORY_REL: &str = "local/state/ops/crewai_bridge/history.jsonl";
const DEFAULT_SWARM_STATE_REL: &str = "local/state/ops/crewai_bridge/swarm_state.json";
const DEFAULT_APPROVAL_QUEUE_REL: &str = "client/runtime/local/state/crewai_approvals.yaml";
const DEFAULT_TRACE_REL: &str = "local/state/ops/crewai_bridge/amp_trace.jsonl";

fn usage() {
    println!("crewai-bridge commands:");
    println!("  protheus-ops crewai-bridge status [--state-path=<path>]");
    println!("  protheus-ops crewai-bridge register-crew [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops crewai-bridge run-process [--payload-base64=<json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops crewai-bridge run-flow [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops crewai-bridge memory-bridge [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops crewai-bridge ingest-config [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops crewai-bridge route-delegation [--payload-base64=<json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops crewai-bridge review-crew [--payload-base64=<json>] [--state-path=<path>] [--approval-queue-path=<path>]");
    println!("  protheus-ops crewai-bridge record-amp-trace [--payload-base64=<json>] [--state-path=<path>] [--trace-path=<path>]");
    println!("  protheus-ops crewai-bridge benchmark-parity [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops crewai-bridge route-model [--payload-base64=<json>] [--state-path=<path>]");
}

fn payload_json(argv: &[String]) -> Result<Value, String> {
    lane_utils::payload_json(argv, "crewai_bridge")
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

fn approval_queue_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "approval-queue-path", false)
        .or_else(|| payload.get("approval_queue_path").and_then(Value::as_str).map(ToString::to_string))
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_APPROVAL_QUEUE_REL))
}

fn trace_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "trace-path", false)
        .or_else(|| payload.get("trace_path").and_then(Value::as_str).map(ToString::to_string))
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_TRACE_REL))
}

fn default_state() -> Value {
    json!({
        "schema_version": "crewai_bridge_state_v1",
        "crews": {},
        "process_runs": {},
        "flow_runs": {},
        "memory_records": {},
        "configs": {},
        "delegations": {},
        "reviews": {},
        "traces": [],
        "benchmarks": {},
        "model_routes": {},
        "last_receipt": null,
    })
}

fn ensure_state_shape(value: &mut Value) {
    if !value.is_object() {
        *value = default_state();
        return;
    }
    for key in [
        "crews",
        "process_runs",
        "flow_runs",
        "memory_records",
        "configs",
        "delegations",
        "reviews",
        "benchmarks",
        "model_routes",
    ] {
        if !value.get(key).map(Value::is_object).unwrap_or(false) {
            value[key] = json!({});
        }
    }
    if !value.get("traces").map(Value::is_array).unwrap_or(false) {
        value["traces"] = json!([]);
    }
    if value.get("schema_version").and_then(Value::as_str).is_none() {
        value["schema_version"] = json!("crewai_bridge_state_v1");
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

fn clean_tools(value: Option<&Value>) -> Vec<Value> {
    value
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| match row {
            Value::String(s) => Some(Value::String(clean_token(Some(&s), "tool"))),
            Value::Object(obj) => obj
                .get("name")
                .and_then(Value::as_str)
                .map(|name| Value::String(clean_token(Some(name), "tool"))),
            _ => None,
        })
        .collect()
}

fn default_claim_evidence(id: &str, claim: &str) -> Value {
    json!([{ "id": id, "claim": claim }])
}

fn semantic_claim(id: &str) -> &'static str {
    match id {
        "V6-WORKFLOW-004.1" => "crewai_roles_goals_and_crews_register_as_governed_receipted_execution_units",
        "V6-WORKFLOW-004.2" => "crewai_sequential_and_hierarchical_processes_reuse_authoritative_workflow_and_swarm_primitives",
        "V6-WORKFLOW-004.3" => "crewai_event_driven_flows_and_decorators_route_through_fail_closed_workflow_paths",
        "V6-WORKFLOW-004.4" => "crewai_unified_memory_routes_through_canonical_receipted_memory_authority",
        "V6-WORKFLOW-004.5" => "crewai_yaml_and_declarative_config_assets_normalize_through_governed_intake_bridges",
        "V6-WORKFLOW-004.6" => "crewai_dynamic_delegation_and_tool_routing_stay_receipted_and_profile_aware",
        "V6-WORKFLOW-004.7" => "crewai_human_review_and_intervention_reuse_existing_approval_boundaries",
        "V6-WORKFLOW-004.8" => "crewai_amp_style_tracing_and_control_plane_events_fold_into_native_observability",
        "V6-WORKFLOW-004.9" => "crewai_runtime_parity_claims_route_through_governed_benchmark_receipts",
        "V6-WORKFLOW-004.10" => "crewai_multimodal_and_local_model_routing_remains_adapter_owned_and_fail_closed",
        _ => "crewai_bridge_claim",
    }
}

fn read_swarm_state(path: &Path) -> Value {
    lane_utils::read_json(path).unwrap_or_else(|| json!({"sessions": {}, "handoff_registry": {}}))
}

fn save_swarm_state(path: &Path, state: &Value) -> Result<(), String> {
    lane_utils::write_json(path, state)
}

fn load_review_queue(path: &Path) -> Value {
    match fs::read_to_string(path) {
        Ok(raw) => serde_yaml::from_str::<Value>(&raw).unwrap_or_else(|_| json!({"entries": []})),
        Err(_) => json!({"entries": []}),
    }
}

fn save_review_queue(path: &Path, queue: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("crewai_review_queue_parent_create_failed:{err}"))?;
    }
    let encoded = serde_yaml::to_string(queue)
        .map_err(|err| format!("crewai_review_queue_encode_failed:{err}"))?;
    fs::write(path, encoded).map_err(|err| format!("crewai_review_queue_write_failed:{err}"))
}

fn emit_amp_trace(trace_path: &Path, row: &Value) -> Result<(), String> {
    lane_utils::append_jsonl(trace_path, row)
}

fn normalize_agent(agent: &Value) -> Value {
    let obj = agent.as_object().cloned().unwrap_or_default();
    json!({
        "agent_id": clean_token(obj.get("agent_id").and_then(Value::as_str).or_else(|| obj.get("role").and_then(Value::as_str)), "agent"),
        "role": clean_token(obj.get("role").and_then(Value::as_str), "specialist"),
        "goal": clean_text(obj.get("goal").and_then(Value::as_str), 180),
        "backstory": clean_text(obj.get("backstory").and_then(Value::as_str), 200),
        "tools": clean_tools(obj.get("tools")),
        "multimodal": obj.get("multimodal").and_then(Value::as_bool).unwrap_or(false),
        "local_model_only": obj.get("local_model_only").and_then(Value::as_bool).unwrap_or(false),
    })
}

fn normalize_task(task: &Value, idx: usize) -> Value {
    let obj = task.as_object().cloned().unwrap_or_default();
    json!({
        "task_id": clean_token(obj.get("task_id").and_then(Value::as_str), &format!("task{}", idx + 1)),
        "name": clean_token(obj.get("name").and_then(Value::as_str), &format!("task{}", idx + 1)),
        "description": clean_text(obj.get("description").and_then(Value::as_str), 180),
        "role_hint": clean_token(obj.get("role_hint").and_then(Value::as_str), ""),
        "required_tool": clean_token(obj.get("required_tool").and_then(Value::as_str), ""),
    })
}

fn select_agent_for_task(agents: &[Value], task: &Value) -> Option<Value> {
    let role_hint = task.get("role_hint").and_then(Value::as_str).unwrap_or_default();
    let required_tool = task.get("required_tool").and_then(Value::as_str).unwrap_or_default();
    if !required_tool.is_empty() {
        if let Some(agent) = agents.iter().find(|agent| {
            agent.get("tools")
                .and_then(Value::as_array)
                .map(|rows| rows.iter().any(|row| row.as_str() == Some(required_tool)))
                .unwrap_or(false)
        }) {
            return Some(agent.clone());
        }
    }
    if !role_hint.is_empty() {
        if let Some(agent) = agents.iter().find(|agent| agent.get("role").and_then(Value::as_str) == Some(role_hint)) {
            return Some(agent.clone());
        }
    }
    agents.first().cloned()
}

fn allowed_route(route: &Value, trigger_event: &str, context: &Map<String, Value>) -> bool {
    let obj = route.as_object().cloned().unwrap_or_default();
    let event = obj.get("event").and_then(Value::as_str).unwrap_or_default();
    let default_route = obj.get("default").and_then(Value::as_bool).unwrap_or(false);
    if !event.is_empty() && event != trigger_event {
        return false;
    }
    if let Some(condition) = obj.get("condition").and_then(Value::as_object) {
        let field = condition.get("field").and_then(Value::as_str).unwrap_or_default();
        if field.is_empty() {
            return default_route;
        }
        let actual = context.get(field);
        if let Some(expected) = condition.get("equals") {
            return actual == Some(expected);
        }
        return default_route;
    }
    default_route || event == trigger_event
}

fn top_level_unsupported_keys(obj: &Map<String, Value>) -> Vec<String> {
    const ALLOWED: &[&str] = &[
        "crew", "agents", "tasks", "flows", "process", "tools", "models", "memory", "config",
    ];
    let mut unsupported = Vec::new();
    for key in obj.keys() {
        if !ALLOWED.iter().any(|allowed| allowed == key) {
            unsupported.push(key.to_string());
        }
    }
    unsupported.sort();
    unsupported
}

fn register_crew(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let agents = payload.get("agents").and_then(Value::as_array).cloned().unwrap_or_default();
    if agents.is_empty() {
        return Err("crewai_agents_required".to_string());
    }
    let normalized_agents: Vec<Value> = agents.iter().map(normalize_agent).collect();
    let crew = json!({
        "crew_id": stable_id("crew", &json!({"name": payload.get("crew_name"), "agents": normalized_agents})),
        "crew_name": clean_token(payload.get("crew_name").and_then(Value::as_str), "crew"),
        "process_type": clean_token(payload.get("process_type").and_then(Value::as_str), "sequential"),
        "manager_role": clean_token(payload.get("manager_role").and_then(Value::as_str), normalized_agents.first().and_then(|row| row.get("role")).and_then(Value::as_str).unwrap_or("manager")),
        "agents": normalized_agents,
        "goal": clean_text(payload.get("goal").and_then(Value::as_str), 180),
        "registered_at": now_iso(),
    });
    let crew_id = crew.get("crew_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "crews").insert(crew_id, crew.clone());
    Ok(json!({
        "ok": true,
        "crew": crew,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-004.1", semantic_claim("V6-WORKFLOW-004.1")),
    }))
}

fn run_process(state: &mut Value, swarm_state_path: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let crew_id = clean_token(payload.get("crew_id").and_then(Value::as_str), "");
    if crew_id.is_empty() {
        return Err("crewai_process_crew_id_required".to_string());
    }
    let crew = state
        .get("crews")
        .and_then(Value::as_object)
        .and_then(|rows| rows.get(&crew_id))
        .cloned()
        .ok_or_else(|| format!("unknown_crewai_crew:{crew_id}"))?;
    let tasks = payload.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default();
    if tasks.is_empty() {
        return Err("crewai_process_tasks_required".to_string());
    }
    let normalized_tasks: Vec<Value> = tasks.iter().enumerate().map(|(idx, row)| normalize_task(row, idx)).collect();
    let agents = crew.get("agents").and_then(Value::as_array).cloned().unwrap_or_default();
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let process_type = clean_token(payload.get("process_type").and_then(Value::as_str).or_else(|| crew.get("process_type").and_then(Value::as_str)), "sequential");
    let max_children = match profile.as_str() {
        "tiny-max" => 1usize,
        "pure" => 2usize,
        _ => normalized_tasks.len().max(1),
    };
    let degraded = normalized_tasks.len() > max_children;
    let selected_tasks: Vec<Value> = normalized_tasks.into_iter().take(max_children).collect();
    let run_id = stable_id("crrun", &json!({"crew_id": crew_id, "process_type": process_type, "tasks": selected_tasks}));
    let manager_role = crew.get("manager_role").and_then(Value::as_str).unwrap_or("manager");
    let manager = agents
        .iter()
        .find(|agent| agent.get("role").and_then(Value::as_str) == Some(manager_role))
        .cloned()
        .or_else(|| agents.first().cloned())
        .unwrap_or_else(|| json!({"agent_id": "manager", "role": "manager"}));
    let child_sessions: Vec<Value> = selected_tasks
        .iter()
        .enumerate()
        .filter_map(|(idx, task)| {
            select_agent_for_task(&agents, task).map(|agent| {
                json!({
                    "session_id": stable_id("crewsess", &json!({"run_id": run_id, "idx": idx, "task": task})),
                    "agent_id": agent.get("agent_id").cloned().unwrap_or_else(|| json!(null)),
                    "role": agent.get("role").cloned().unwrap_or_else(|| json!(null)),
                    "task": task,
                })
            })
        })
        .collect();

    let mut swarm = read_swarm_state(swarm_state_path);
    let sessions = as_object_mut(&mut swarm, "sessions");
    let manager_session_id = stable_id("crewsess", &json!({"run_id": run_id, "role": "manager"}));
    sessions.insert(
        manager_session_id.clone(),
        json!({
            "session_id": manager_session_id,
            "crew_id": crew_id,
            "run_id": run_id,
            "role": manager.get("role").cloned().unwrap_or_else(|| json!("manager")),
            "agent_id": manager.get("agent_id").cloned().unwrap_or_else(|| json!("manager")),
            "task": if process_type == "hierarchical" { json!("manager_review") } else { json!("sequential_dispatch") },
            "created_at": now_iso(),
        }),
    );
    for child in &child_sessions {
        let session_id = child.get("session_id").and_then(Value::as_str).unwrap().to_string();
        sessions.insert(
            session_id.clone(),
            json!({
                "session_id": session_id,
                "crew_id": crew_id,
                "run_id": run_id,
                "parent_session_id": manager_session_id,
                "role": child.get("role").cloned().unwrap_or_else(|| json!(null)),
                "agent_id": child.get("agent_id").cloned().unwrap_or_else(|| json!(null)),
                "task": child.get("task").cloned().unwrap_or_else(|| json!(null)),
                "created_at": now_iso(),
            }),
        );
    }
    save_swarm_state(swarm_state_path, &swarm)?;

    let record = json!({
        "run_id": run_id,
        "crew_id": crew_id,
        "process_type": process_type,
        "profile": profile,
        "degraded": degraded,
        "manager_session_id": manager_session_id,
        "child_sessions": child_sessions,
        "task_count": selected_tasks.len(),
        "executed_at": now_iso(),
    });
    let record_id = record.get("run_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "process_runs").insert(record_id, record.clone());
    Ok(json!({
        "ok": true,
        "process_run": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-004.2", semantic_claim("V6-WORKFLOW-004.2")),
    }))
}

fn run_flow(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let crew_id = clean_token(payload.get("crew_id").and_then(Value::as_str), "");
    if crew_id.is_empty() {
        return Err("crewai_flow_crew_id_required".to_string());
    }
    let _crew = state
        .get("crews")
        .and_then(Value::as_object)
        .and_then(|rows| rows.get(&crew_id))
        .cloned()
        .ok_or_else(|| format!("unknown_crewai_crew:{crew_id}"))?;
    let flow_name = clean_token(payload.get("flow_name").and_then(Value::as_str), "flow");
    let trigger_event = clean_token(payload.get("trigger_event").and_then(Value::as_str), "start");
    let routes = payload.get("routes").and_then(Value::as_array).cloned().unwrap_or_default();
    if routes.is_empty() {
        return Err("crewai_flow_routes_required".to_string());
    }
    let context = payload.get("context").and_then(Value::as_object).cloned().unwrap_or_default();
    let selected = routes.iter().find(|route| allowed_route(route, &trigger_event, &context)).cloned();
    let Some(route) = selected else {
        return Err("crewai_flow_no_matching_route_fail_closed".to_string());
    };
    let decorators = payload.get("decorators").and_then(Value::as_array).cloned().unwrap_or_default();
    let listeners = payload.get("listeners").and_then(Value::as_array).cloned().unwrap_or_default();
    let record = json!({
        "flow_run_id": stable_id("crflow", &json!({"crew_id": crew_id, "flow_name": flow_name, "trigger_event": trigger_event})),
        "crew_id": crew_id,
        "flow_name": flow_name,
        "trigger_event": trigger_event,
        "selected_route": route,
        "decorators": decorators,
        "listeners": listeners,
        "context": context,
        "executed_at": now_iso(),
    });
    let record_id = record.get("flow_run_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "flow_runs").insert(record_id, record.clone());
    Ok(json!({
        "ok": true,
        "flow": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-004.3", semantic_claim("V6-WORKFLOW-004.3")),
    }))
}

fn memory_bridge(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let crew_id = clean_token(payload.get("crew_id").and_then(Value::as_str), "");
    if crew_id.is_empty() {
        return Err("crewai_memory_crew_id_required".to_string());
    }
    let _crew = state
        .get("crews")
        .and_then(Value::as_object)
        .and_then(|rows| rows.get(&crew_id))
        .cloned()
        .ok_or_else(|| format!("unknown_crewai_crew:{crew_id}"))?;
    let memories = payload.get("memories").and_then(Value::as_array).cloned().unwrap_or_default();
    let normalized: Vec<Value> = memories
        .iter()
        .enumerate()
        .map(|(idx, row)| {
            let obj = row.as_object().cloned().unwrap_or_default();
            json!({
                "memory_id": clean_token(obj.get("memory_id").and_then(Value::as_str), &format!("mem{}", idx + 1)),
                "scope": clean_token(obj.get("scope").and_then(Value::as_str), "crew"),
                "text": clean_text(obj.get("text").and_then(Value::as_str), 240),
                "agent_id": clean_token(obj.get("agent_id").and_then(Value::as_str), ""),
            })
        })
        .collect();
    let query = clean_text(payload.get("recall_query").and_then(Value::as_str), 120);
    let recall_hits: Vec<Value> = normalized
        .iter()
        .filter(|row| {
            query.is_empty() || row.get("text").and_then(Value::as_str).map(|text| text.to_ascii_lowercase().contains(&query.to_ascii_lowercase())).unwrap_or(false)
        })
        .take(5)
        .cloned()
        .collect();
    let record = json!({
        "memory_run_id": stable_id("crmem", &json!({"crew_id": crew_id, "query": query})),
        "crew_id": crew_id,
        "thread_id": clean_token(payload.get("thread_id").and_then(Value::as_str), "thread"),
        "summary": clean_text(payload.get("summary").and_then(Value::as_str), 180),
        "memories": normalized,
        "recall_query": query,
        "recall_hits": recall_hits,
        "stored_at": now_iso(),
    });
    let record_id = record.get("memory_run_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "memory_records").insert(record_id, record.clone());
    Ok(json!({
        "ok": true,
        "memory": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-004.4", semantic_claim("V6-WORKFLOW-004.4")),
    }))
}

fn parse_config_payload(payload: &Map<String, Value>) -> Result<Value, String> {
    if let Some(raw_yaml) = payload.get("config_yaml").and_then(Value::as_str).or_else(|| payload.get("yaml").and_then(Value::as_str)) {
        return serde_yaml::from_str::<Value>(raw_yaml)
            .map_err(|err| format!("crewai_config_yaml_parse_failed:{err}"));
    }
    Ok(payload.get("config_json").cloned().unwrap_or_else(|| json!({})))
}

fn ingest_config(root: &Path, state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let config = parse_config_payload(payload)?;
    let config_obj = config.as_object().cloned().ok_or_else(|| "crewai_config_object_required".to_string())?;
    let unsupported_keys = top_level_unsupported_keys(&config_obj);
    if !unsupported_keys.is_empty() {
        return Err(format!("crewai_config_unsupported_keys_fail_closed:{}", unsupported_keys.join(",")));
    }
    let adapter_path = normalize_bridge_path(
        root,
        payload.get("bridge_path").and_then(Value::as_str).unwrap_or("adapters/protocol/crewai_tool_bridge.ts"),
    )?;
    let manifest = json!({
        "config_id": stable_id("crcfg", &json!({"config": config, "adapter": adapter_path})),
        "adapter_path": adapter_path,
        "crew_name": clean_token(
            config_obj
                .get("crew")
                .and_then(Value::as_object)
                .and_then(|crew| crew.get("name"))
                .and_then(Value::as_str),
            "crew",
        ),
        "agent_count": config_obj.get("agents").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0),
        "task_count": config_obj.get("tasks").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0),
        "flow_count": config_obj.get("flows").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0),
        "config": config,
        "ingested_at": now_iso(),
    });
    let config_id = manifest.get("config_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "configs").insert(config_id, manifest.clone());
    Ok(json!({
        "ok": true,
        "config": manifest,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-004.5", semantic_claim("V6-WORKFLOW-004.5")),
    }))
}

fn route_delegation(root: &Path, state: &mut Value, swarm_state_path: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let crew_id = clean_token(payload.get("crew_id").and_then(Value::as_str), "");
    if crew_id.is_empty() {
        return Err("crewai_delegation_crew_id_required".to_string());
    }
    let crew = state
        .get("crews")
        .and_then(Value::as_object)
        .and_then(|rows| rows.get(&crew_id))
        .cloned()
        .ok_or_else(|| format!("unknown_crewai_crew:{crew_id}"))?;
    let task = normalize_task(&json!({
        "task_id": payload.get("task_id").cloned().unwrap_or_else(|| json!(null)),
        "name": payload.get("task_name").cloned().unwrap_or_else(|| json!("delegate")),
        "description": payload.get("task").cloned().unwrap_or_else(|| json!(null)),
        "role_hint": payload.get("role_hint").cloned().unwrap_or_else(|| json!(null)),
        "required_tool": payload.get("required_tool").cloned().unwrap_or_else(|| json!(null)),
    }), 0);
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let adapter_path = normalize_bridge_path(
        root,
        payload.get("bridge_path").and_then(Value::as_str).unwrap_or("adapters/protocol/crewai_tool_bridge.ts"),
    )?;
    let agents = crew.get("agents").and_then(Value::as_array).cloned().unwrap_or_default();
    let selected_agent = select_agent_for_task(&agents, &task).ok_or_else(|| "crewai_no_agent_available".to_string())?;
    let mut selected_tools = selected_agent.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut degraded = false;
    if profile == "pure" && selected_tools.len() > 2 {
        selected_tools.truncate(2);
        degraded = true;
    }
    if profile == "tiny-max" {
        if selected_tools.len() > 1 {
            selected_tools.truncate(1);
        }
        if selected_agent.get("multimodal").and_then(Value::as_bool).unwrap_or(false) {
            degraded = true;
        }
    }
    let session_id = stable_id("crewsess", &json!({"crew_id": crew_id, "task": task}));
    let mut swarm = read_swarm_state(swarm_state_path);
    as_object_mut(&mut swarm, "sessions").insert(
        session_id.clone(),
        json!({
            "session_id": session_id,
            "crew_id": crew_id,
            "agent_id": selected_agent.get("agent_id").cloned().unwrap_or_else(|| json!(null)),
            "role": selected_agent.get("role").cloned().unwrap_or_else(|| json!(null)),
            "task": task,
            "created_at": now_iso(),
        }),
    );
    save_swarm_state(swarm_state_path, &swarm)?;
    let record = json!({
        "delegation_id": stable_id("crdel", &json!({"crew_id": crew_id, "task": task, "agent": selected_agent})),
        "crew_id": crew_id,
        "profile": profile,
        "bridge_path": adapter_path,
        "selected_agent": selected_agent,
        "selected_tools": selected_tools,
        "task": task,
        "session_id": session_id,
        "degraded": degraded,
        "delegated_at": now_iso(),
    });
    let record_id = record.get("delegation_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "delegations").insert(record_id, record.clone());
    Ok(json!({
        "ok": true,
        "delegation": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-004.6", semantic_claim("V6-WORKFLOW-004.6")),
    }))
}

fn review_crew(state: &mut Value, approval_queue_path: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let crew_id = clean_token(payload.get("crew_id").and_then(Value::as_str), "");
    if crew_id.is_empty() {
        return Err("crewai_review_crew_id_required".to_string());
    }
    let _crew = state
        .get("crews")
        .and_then(Value::as_object)
        .and_then(|rows| rows.get(&crew_id))
        .cloned()
        .ok_or_else(|| format!("unknown_crewai_crew:{crew_id}"))?;
    let review = json!({
        "review_id": stable_id("crreview", &json!({"crew_id": crew_id, "run_id": payload.get("run_id"), "operator": payload.get("operator_id")})),
        "crew_id": crew_id,
        "run_id": clean_token(payload.get("run_id").and_then(Value::as_str), ""),
        "operator_id": clean_token(payload.get("operator_id").and_then(Value::as_str), "operator"),
        "action": clean_token(payload.get("action").and_then(Value::as_str), "approve"),
        "notes": clean_text(payload.get("notes").and_then(Value::as_str), 180),
        "reviewed_at": now_iso(),
    });
    let mut queue = load_review_queue(approval_queue_path);
    as_array_mut(&mut queue, "entries").push(review.clone());
    save_review_queue(approval_queue_path, &queue)?;
    let review_id = review.get("review_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "reviews").insert(review_id, review.clone());
    Ok(json!({
        "ok": true,
        "review": review,
        "approval_queue_path": approval_queue_path.display().to_string(),
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-004.7", semantic_claim("V6-WORKFLOW-004.7")),
    }))
}

fn record_amp_trace(root: &Path, state: &mut Value, trace_path: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let crew_id = clean_token(payload.get("crew_id").and_then(Value::as_str), "");
    if crew_id.is_empty() {
        return Err("crewai_trace_crew_id_required".to_string());
    }
    let _crew = state
        .get("crews")
        .and_then(Value::as_object)
        .and_then(|rows| rows.get(&crew_id))
        .cloned()
        .ok_or_else(|| format!("unknown_crewai_crew:{crew_id}"))?;
    let trace = json!({
        "trace_id": stable_id("crtrace", &json!({"crew_id": crew_id, "stage": payload.get("stage"), "message": payload.get("message")})),
        "crew_id": crew_id,
        "run_id": clean_token(payload.get("run_id").and_then(Value::as_str), ""),
        "stage": clean_token(payload.get("stage").and_then(Value::as_str), "execution"),
        "message": clean_text(payload.get("message").and_then(Value::as_str), 180),
        "metrics": payload.get("metrics").cloned().unwrap_or_else(|| json!({})),
        "controls": payload.get("controls").cloned().unwrap_or_else(|| json!({})),
        "trace_path": rel(root, trace_path),
        "recorded_at": now_iso(),
    });
    emit_amp_trace(trace_path, &trace)?;
    as_array_mut(state, "traces").push(trace.clone());
    Ok(json!({
        "ok": true,
        "trace": trace,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-004.8", semantic_claim("V6-WORKFLOW-004.8")),
    }))
}

fn benchmark_parity(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let metrics = payload.get("metrics").and_then(Value::as_object).cloned().ok_or_else(|| "crewai_benchmark_metrics_required".to_string())?;
    let cold_start_ms = metrics.get("cold_start_ms").and_then(Value::as_f64).unwrap_or(0.0);
    let throughput_ops_sec = metrics.get("throughput_ops_sec").and_then(Value::as_f64).unwrap_or(0.0);
    let memory_mb = metrics.get("memory_mb").and_then(Value::as_f64).unwrap_or(0.0);
    let targets = payload.get("targets").and_then(Value::as_object).cloned().unwrap_or_else(|| {
        match profile.as_str() {
            "tiny-max" => json!({"max_cold_start_ms": 8.0, "min_throughput_ops_sec": 3000.0, "max_memory_mb": 8.0}).as_object().cloned().unwrap(),
            "pure" => json!({"max_cold_start_ms": 10.0, "min_throughput_ops_sec": 2500.0, "max_memory_mb": 12.0}).as_object().cloned().unwrap(),
            _ => json!({"max_cold_start_ms": 20.0, "min_throughput_ops_sec": 2000.0, "max_memory_mb": 64.0}).as_object().cloned().unwrap(),
        }
    });
    let parity_ok = cold_start_ms <= targets.get("max_cold_start_ms").and_then(Value::as_f64).unwrap_or(f64::MAX)
        && throughput_ops_sec >= targets.get("min_throughput_ops_sec").and_then(Value::as_f64).unwrap_or(0.0)
        && memory_mb <= targets.get("max_memory_mb").and_then(Value::as_f64).unwrap_or(f64::MAX);
    let record = json!({
        "benchmark_id": stable_id("crbench", &json!({"profile": profile, "metrics": metrics})),
        "profile": profile,
        "metrics": metrics,
        "targets": targets,
        "parity_ok": parity_ok,
        "recorded_at": now_iso(),
    });
    let record_id = record.get("benchmark_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "benchmarks").insert(record_id, record.clone());
    Ok(json!({
        "ok": true,
        "benchmark": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-004.9", semantic_claim("V6-WORKFLOW-004.9")),
    }))
}

fn route_model(root: &Path, state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let modality = clean_token(payload.get("modality").and_then(Value::as_str), "text");
    let adapter_path = normalize_bridge_path(
        root,
        payload.get("bridge_path").and_then(Value::as_str).unwrap_or("adapters/protocol/crewai_tool_bridge.ts"),
    )?;
    let local_models = payload.get("local_models").and_then(Value::as_array).cloned().unwrap_or_default();
    let providers = payload.get("providers").and_then(Value::as_array).cloned().unwrap_or_default();
    let supported = match profile.as_str() {
        "tiny-max" => matches!(modality.as_str(), "text"),
        "pure" => matches!(modality.as_str(), "text" | "image"),
        _ => true,
    };
    let degraded = !supported;
    let selected_route = if payload.get("prefer_local").and_then(Value::as_bool).unwrap_or(true) && !local_models.is_empty() {
        json!({"route_kind": "local_model", "target": local_models.first().cloned().unwrap_or_else(|| json!(null))})
    } else if !providers.is_empty() {
        json!({"route_kind": "provider", "target": providers.first().cloned().unwrap_or_else(|| json!(null))})
    } else if !local_models.is_empty() {
        json!({"route_kind": "local_model", "target": local_models.first().cloned().unwrap_or_else(|| json!(null))})
    } else {
        return Err("crewai_model_route_target_required".to_string());
    };
    let record = json!({
        "route_id": stable_id("crroute", &json!({"profile": profile, "modality": modality, "route": selected_route})),
        "profile": profile,
        "modality": modality,
        "bridge_path": adapter_path,
        "selected_route": selected_route,
        "degraded": degraded,
        "routed_at": now_iso(),
    });
    let record_id = record.get("route_id").and_then(Value::as_str).unwrap().to_string();
    as_object_mut(state, "model_routes").insert(record_id, record.clone());
    Ok(json!({
        "ok": true,
        "model_route": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-004.10", semantic_claim("V6-WORKFLOW-004.10")),
    }))
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    if argv.is_empty() {
        usage();
        return 0;
    }
    let command = argv[0].as_str();
    let payload = match payload_json(argv) {
        Ok(value) => value,
        Err(error) => {
            print_json_line(&cli_error("crewai_bridge_error", &error));
            return 1;
        }
    };
    let payload = payload_obj(&payload);
    let state_path = state_path(root, argv, payload);
    let history_path = history_path(root, argv, payload);
    let swarm_state_path = swarm_state_path(root, argv, payload);
    let approval_queue_path = approval_queue_path(root, argv, payload);
    let trace_path = trace_path(root, argv, payload);

    if command == "status" {
        let state = load_state(&state_path);
        let receipt = cli_receipt(
            "crewai_bridge_status",
            json!({
                "ok": true,
                "schema_version": state.get("schema_version").cloned().unwrap_or_else(|| json!(null)),
                "crews": state.get("crews").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
                "process_runs": state.get("process_runs").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
                "flow_runs": state.get("flow_runs").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
                "memory_records": state.get("memory_records").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
                "configs": state.get("configs").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
                "delegations": state.get("delegations").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
                "reviews": state.get("reviews").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
                "traces": state.get("traces").and_then(Value::as_array).map(|row| row.len()).unwrap_or(0),
                "benchmarks": state.get("benchmarks").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
                "model_routes": state.get("model_routes").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
                "state_path": rel(root, &state_path),
                "history_path": rel(root, &history_path),
            }),
        );
        print_json_line(&receipt);
        return 0;
    }

    let mut state = load_state(&state_path);
    let payload_out = match command {
        "register-crew" => register_crew(&mut state, payload),
        "run-process" => run_process(&mut state, &swarm_state_path, payload),
        "run-flow" => run_flow(&mut state, payload),
        "memory-bridge" => memory_bridge(&mut state, payload),
        "ingest-config" => ingest_config(root, &mut state, payload),
        "route-delegation" => route_delegation(root, &mut state, &swarm_state_path, payload),
        "review-crew" => review_crew(&mut state, &approval_queue_path, payload),
        "record-amp-trace" => record_amp_trace(root, &mut state, &trace_path, payload),
        "benchmark-parity" => benchmark_parity(&mut state, payload),
        "route-model" => route_model(root, &mut state, payload),
        "help" | "--help" | "-h" => {
            usage();
            return 0;
        }
        _ => {
            print_json_line(&cli_error("crewai_bridge_error", &format!("unknown_crewai_bridge_command:{command}")));
            return 1;
        }
    };

    let payload_out = match payload_out {
        Ok(value) => value,
        Err(error) => {
            print_json_line(&cli_error("crewai_bridge_error", &error));
            return 1;
        }
    };

    let receipt = cli_receipt("crewai_bridge_receipt", payload_out);
    state["last_receipt"] = receipt.clone();
    if let Err(error) = save_state(&state_path, &state) {
        print_json_line(&cli_error("crewai_bridge_error", &error));
        return 1;
    }
    if let Err(error) = append_history(&history_path, &receipt) {
        print_json_line(&cli_error("crewai_bridge_error", &error));
        return 1;
    }
    print_json_line(&receipt);
    0
}
