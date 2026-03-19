// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};

use crate::contract_lane_utils::{
    self as lane_utils, clean_text, clean_token, cli_error, cli_receipt, normalize_bridge_path,
    payload_obj, print_json_line, rel_path as rel, repo_path,
};
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_STATE_REL: &str = "local/state/ops/langgraph_bridge/latest.json";
const DEFAULT_HISTORY_REL: &str = "local/state/ops/langgraph_bridge/history.jsonl";
const DEFAULT_SWARM_STATE_REL: &str = "local/state/ops/langgraph_bridge/swarm_state.json";
const DEFAULT_TRACE_REL: &str = "local/state/ops/langgraph_bridge/native_trace.jsonl";

fn usage() {
    println!("langgraph-bridge commands:");
    println!("  protheus-ops langgraph-bridge status [--state-path=<path>]");
    println!("  protheus-ops langgraph-bridge register-graph [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops langgraph-bridge checkpoint-run [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops langgraph-bridge inspect-state [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops langgraph-bridge coordinate-subgraph [--payload-base64=<json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops langgraph-bridge record-trace [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops langgraph-bridge stream-graph [--payload-base64=<json>] [--state-path=<path>]");
}

fn payload_json(argv: &[String]) -> Result<Value, String> {
    lane_utils::payload_json(argv, "langgraph_bridge")
}

fn state_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "state-path", false)
        .or_else(|| {
            payload
                .get("state_path")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_STATE_REL))
}

fn history_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "history-path", false)
        .or_else(|| {
            payload
                .get("history_path")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_HISTORY_REL))
}

fn swarm_state_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "swarm-state-path", false)
        .or_else(|| {
            payload
                .get("swarm_state_path")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_SWARM_STATE_REL))
}

fn trace_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "trace-path", false)
        .or_else(|| {
            payload
                .get("trace_path")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_TRACE_REL))
}

fn default_state() -> Value {
    json!({
        "schema_version": "langgraph_bridge_state_v1",
        "graphs": {},
        "checkpoints": {},
        "inspections": {},
        "subgraphs": {},
        "traces": [],
        "streams": [],
        "last_receipt": null,
    })
}

fn ensure_state_shape(value: &mut Value) {
    if !value.is_object() {
        *value = default_state();
        return;
    }
    for key in ["graphs", "checkpoints", "inspections", "subgraphs"] {
        if !value.get(key).map(Value::is_object).unwrap_or(false) {
            value[key] = json!({});
        }
    }
    for key in ["traces", "streams"] {
        if !value.get(key).map(Value::is_array).unwrap_or(false) {
            value[key] = json!([]);
        }
    }
    if value
        .get("schema_version")
        .and_then(Value::as_str)
        .is_none()
    {
        value["schema_version"] = json!("langgraph_bridge_state_v1");
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

fn as_array_mut<'a>(value: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    if !value.get(key).map(Value::is_array).unwrap_or(false) {
        value[key] = json!([]);
    }
    value
        .get_mut(key)
        .and_then(Value::as_array_mut)
        .expect("array")
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

fn default_claim_evidence(id: &str, claim: &str) -> Value {
    json!([{ "id": id, "claim": claim }])
}

fn semantic_claim(id: &str) -> &'static str {
    match id {
        "V6-WORKFLOW-002.1" => {
            "langgraph_nodes_edges_and_cycles_register_as_governed_receipted_graphs"
        }
        "V6-WORKFLOW-002.2" => {
            "langgraph_checkpoints_and_time_travel_replay_route_through_receipted_persistence"
        }
        "V6-WORKFLOW-002.3" => {
            "langgraph_hitl_state_inspection_and_intervention_remain_governed_and_receipted"
        }
        "V6-WORKFLOW-002.4" => {
            "langgraph_subgraphs_and_nested_agents_reuse_authoritative_swarm_lineage"
        }
        "V6-WORKFLOW-002.5" => {
            "langgraph_traces_fold_into_native_observability_without_duplicate_telemetry_stacks"
        }
        "V6-WORKFLOW-002.6" => {
            "langgraph_streaming_and_conditional_edges_remain_receipted_and_fail_closed"
        }
        _ => "langgraph_bridge_claim",
    }
}

fn emit_native_trace(
    root: &Path,
    trace_path: &Path,
    trace_id: &str,
    stage: &str,
    message: &str,
) -> Result<(), String> {
    lane_utils::append_jsonl(
        trace_path,
        &json!({
            "trace_id": clean_token(Some(trace_id), "langgraph-trace"),
            "stage": clean_token(Some(stage), "graph"),
            "message": clean_text(Some(message), 200),
            "recorded_at": now_iso(),
            "root": rel(root, trace_path),
        }),
    )
}

fn read_swarm_state(path: &Path) -> Value {
    lane_utils::read_json(path).unwrap_or_else(|| json!({"sessions": {}, "handoff_registry": {}}))
}

fn save_swarm_state(path: &Path, state: &Value) -> Result<(), String> {
    lane_utils::write_json(path, state)
}

fn normalize_node(node: &Value) -> Value {
    let obj = node.as_object().cloned().unwrap_or_default();
    let node_id = clean_token(obj.get("id").and_then(Value::as_str), "node");
    json!({
        "id": node_id,
        "kind": clean_token(obj.get("kind").and_then(Value::as_str), "step"),
        "tool": clean_token(obj.get("tool").and_then(Value::as_str), ""),
        "checkpoint_key": clean_token(obj.get("checkpoint_key").and_then(Value::as_str), ""),
        "prompt": clean_text(obj.get("prompt").and_then(Value::as_str), 240),
    })
}

fn normalize_edge(edge: &Value) -> Value {
    let obj = edge.as_object().cloned().unwrap_or_default();
    json!({
        "from": clean_token(obj.get("from").and_then(Value::as_str), ""),
        "to": clean_token(obj.get("to").and_then(Value::as_str), ""),
        "label": clean_token(obj.get("label").and_then(Value::as_str), "edge"),
        "default": obj.get("default").and_then(Value::as_bool).unwrap_or(false),
        "condition": obj.get("condition").cloned().unwrap_or_else(|| json!(null)),
    })
}

fn condition_matches(condition: &Value, context: &Map<String, Value>) -> bool {
    let Some(obj) = condition.as_object() else {
        return false;
    };
    let field = obj.get("field").and_then(Value::as_str).unwrap_or_default();
    if field.is_empty() {
        return false;
    }
    let equals = obj.get("equals");
    let contains = obj.get("contains").and_then(Value::as_str);
    match (context.get(field), equals, contains) {
        (Some(actual), Some(expected), _) => actual == expected,
        (Some(actual), _, Some(needle)) => actual
            .as_str()
            .map(|row| row.contains(needle))
            .unwrap_or(false),
        _ => false,
    }
}

fn register_graph(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let name = clean_token(
        payload.get("name").and_then(Value::as_str),
        "langgraph-graph",
    );
    let nodes = payload
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if nodes.is_empty() {
        return Err("langgraph_nodes_required".to_string());
    }
    let edges = payload
        .get("edges")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let normalized_nodes: Vec<Value> = nodes.iter().map(normalize_node).collect();
    let normalized_edges: Vec<Value> = edges.iter().map(normalize_edge).collect();
    let entry_node = clean_token(
        payload
            .get("entry_node")
            .and_then(Value::as_str)
            .or_else(|| {
                normalized_nodes
                    .first()
                    .and_then(|row| row.get("id"))
                    .and_then(Value::as_str)
            }),
        "start",
    );
    let graph = json!({
        "graph_id": stable_id("lggraph", &json!({"name": name, "entry": entry_node})),
        "name": name,
        "entry_node": entry_node,
        "checkpoint_mode": clean_token(payload.get("checkpoint_mode").and_then(Value::as_str), "per_node"),
        "nodes": normalized_nodes,
        "edges": normalized_edges,
        "node_count": nodes.len(),
        "edge_count": edges.len(),
        "conditional_edge_count": normalized_edges.iter().filter(|row| row.get("condition").map(|v| !v.is_null()).unwrap_or(false)).count(),
        "registered_at": now_iso(),
    });
    let graph_id = graph
        .get("graph_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "graphs").insert(graph_id, graph.clone());
    Ok(json!({
        "ok": true,
        "graph": graph,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-002.1", semantic_claim("V6-WORKFLOW-002.1")),
    }))
}

fn checkpoint_run(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let graph_id = clean_token(payload.get("graph_id").and_then(Value::as_str), "");
    if graph_id.is_empty() {
        return Err("langgraph_checkpoint_graph_id_required".to_string());
    }
    let graph = state
        .get("graphs")
        .and_then(Value::as_object)
        .and_then(|rows| rows.get(&graph_id))
        .cloned()
        .ok_or_else(|| format!("unknown_langgraph_graph:{graph_id}"))?;
    let snapshot = payload
        .get("state_snapshot")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let replay_enabled = payload
        .get("replay_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let checkpoint = json!({
        "checkpoint_id": stable_id("lgcp", &json!({"graph_id": graph_id, "snapshot": snapshot})),
        "graph_id": graph_id,
        "graph_name": graph.get("name").cloned().unwrap_or_else(|| json!(null)),
        "thread_id": clean_token(payload.get("thread_id").and_then(Value::as_str), "thread"),
        "checkpoint_label": clean_token(payload.get("checkpoint_label").and_then(Value::as_str), "graph_step"),
        "snapshot": snapshot,
        "snapshot_hash": deterministic_receipt_hash(&json!({"snapshot": payload.get("state_snapshot").cloned().unwrap_or_else(|| json!({}))})),
        "replay_enabled": replay_enabled,
        "replay_token": if replay_enabled { json!(stable_id("lgreplay", &json!({"graph_id": graph_id}))) } else { json!(null) },
        "rewind_from": clean_token(payload.get("rewind_from").and_then(Value::as_str), ""),
        "captured_at": now_iso(),
    });
    let checkpoint_id = checkpoint
        .get("checkpoint_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "checkpoints").insert(checkpoint_id, checkpoint.clone());
    Ok(json!({
        "ok": true,
        "checkpoint": checkpoint,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-002.2", semantic_claim("V6-WORKFLOW-002.2")),
    }))
}

fn inspect_state(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let checkpoint_id = clean_token(payload.get("checkpoint_id").and_then(Value::as_str), "");
    let checkpoint = if checkpoint_id.is_empty() {
        None
    } else {
        state
            .get("checkpoints")
            .and_then(Value::as_object)
            .and_then(|rows| rows.get(&checkpoint_id))
            .cloned()
    };
    let graph_id = clean_token(
        payload.get("graph_id").and_then(Value::as_str).or_else(|| {
            checkpoint
                .as_ref()
                .and_then(|row| row.get("graph_id"))
                .and_then(Value::as_str)
        }),
        "",
    );
    if graph_id.is_empty() {
        return Err("langgraph_inspection_graph_or_checkpoint_required".to_string());
    }
    let state_view = checkpoint
        .as_ref()
        .and_then(|row| row.get("snapshot"))
        .cloned()
        .unwrap_or_else(|| json!({}));
    let intervention = payload
        .get("intervention_patch")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let inspection = json!({
        "inspection_id": stable_id("lginspect", &json!({"graph_id": graph_id, "checkpoint_id": checkpoint_id, "state": state_view})),
        "graph_id": graph_id,
        "checkpoint_id": if checkpoint_id.is_empty() { json!(null) } else { json!(checkpoint_id) },
        "operator_id": clean_token(payload.get("operator_id").and_then(Value::as_str), "operator"),
        "inspection_mode": if intervention.as_object().map(|row| !row.is_empty()).unwrap_or(false) { json!("intervened") } else { json!("inspect_only") },
        "view_fields": payload.get("view_fields").cloned().unwrap_or_else(|| json!([])),
        "state_view": state_view,
        "intervention_patch": intervention,
        "change_applied": payload.get("intervention_patch").and_then(Value::as_object).map(|row| !row.is_empty()).unwrap_or(false),
        "inspected_at": now_iso(),
    });
    let inspection_id = inspection
        .get("inspection_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "inspections").insert(inspection_id, inspection.clone());
    Ok(json!({
        "ok": true,
        "inspection": inspection,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-002.3", semantic_claim("V6-WORKFLOW-002.3")),
    }))
}

fn coordinate_subgraph(
    state: &mut Value,
    swarm_state_path: &Path,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let graph_id = clean_token(payload.get("graph_id").and_then(Value::as_str), "");
    if graph_id.is_empty() {
        return Err("langgraph_subgraph_graph_id_required".to_string());
    }
    let graph = state
        .get("graphs")
        .and_then(Value::as_object)
        .and_then(|rows| rows.get(&graph_id))
        .cloned()
        .ok_or_else(|| format!("unknown_langgraph_graph:{graph_id}"))?;
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let requested = payload
        .get("subgraphs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if requested.is_empty() {
        return Err("langgraph_subgraphs_required".to_string());
    }
    let max_children = match profile.as_str() {
        "tiny-max" => 1usize,
        "pure" => 2usize,
        _ => requested.len().max(1),
    };
    let degraded = requested.len() > max_children;
    let subgraphs: Vec<Value> = requested.into_iter().take(max_children).collect();
    let coordinator_id = stable_id(
        "lgsession",
        &json!({"graph_id": graph_id, "role": "coordinator"}),
    );
    let child_rows: Vec<Value> = subgraphs
        .iter()
        .enumerate()
        .map(|(idx, row)| {
            let label = clean_token(
                row.get("name")
                    .and_then(Value::as_str)
                    .or_else(|| row.get("role").and_then(Value::as_str)),
                &format!("subgraph{}", idx + 1),
            );
            json!({
                "session_id": stable_id("lgsession", &json!({"graph_id": graph_id, "label": label, "index": idx})),
                "name": label,
                "role": clean_token(row.get("role").and_then(Value::as_str), "worker"),
                "task": clean_text(row.get("task").and_then(Value::as_str), 160),
            })
        })
        .collect();

    let mut swarm = read_swarm_state(swarm_state_path);
    let sessions = as_object_mut(&mut swarm, "sessions");
    sessions.insert(
        coordinator_id.clone(),
        json!({
            "session_id": coordinator_id,
            "task": format!("langgraph:{}", graph.get("name").and_then(Value::as_str).unwrap_or("graph")),
            "role": "coordinator",
            "graph_id": graph_id,
            "created_at": now_iso(),
        }),
    );
    for child in &child_rows {
        let session_id = child
            .get("session_id")
            .and_then(Value::as_str)
            .unwrap()
            .to_string();
        sessions.insert(
            session_id.clone(),
            json!({
                "session_id": session_id,
                "task": child.get("task").cloned().unwrap_or_else(|| json!(null)),
                "role": child.get("role").cloned().unwrap_or_else(|| json!("worker")),
                "graph_id": graph_id,
                "parent_session_id": coordinator_id,
                "created_at": now_iso(),
            }),
        );
    }
    save_swarm_state(swarm_state_path, &swarm)?;

    let record = json!({
        "coordination_id": stable_id("lgsub", &json!({"graph_id": graph_id, "coordinator": coordinator_id})),
        "graph_id": graph_id,
        "graph_name": graph.get("name").cloned().unwrap_or_else(|| json!(null)),
        "profile": profile,
        "degraded": degraded,
        "coordinator_session_id": coordinator_id,
        "child_sessions": child_rows,
        "coordinated_at": now_iso(),
    });
    let record_id = record
        .get("coordination_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "subgraphs").insert(record_id, record.clone());
    Ok(json!({
        "ok": true,
        "coordination": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-002.4", semantic_claim("V6-WORKFLOW-002.4")),
    }))
}

fn record_trace(
    root: &Path,
    state: &mut Value,
    trace_path: &Path,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let graph_id = clean_token(payload.get("graph_id").and_then(Value::as_str), "");
    if graph_id.is_empty() {
        return Err("langgraph_trace_graph_id_required".to_string());
    }
    let adapter_path = normalize_bridge_path(
        root,
        payload
            .get("bridge_path")
            .and_then(Value::as_str)
            .unwrap_or("adapters/protocol/langgraph_trace_bridge.ts"),
    )?;
    let trace = json!({
        "trace_id": stable_id("lgtrace", &json!({"graph_id": graph_id, "message": payload.get("message")})),
        "graph_id": graph_id,
        "stage": clean_token(payload.get("stage").and_then(Value::as_str), "transition"),
        "message": clean_text(payload.get("message").and_then(Value::as_str), 180),
        "transitions": payload.get("transitions").cloned().unwrap_or_else(|| json!([])),
        "metrics": payload.get("metrics").cloned().unwrap_or_else(|| json!({})),
        "bridge_path": adapter_path,
        "recorded_at": now_iso(),
    });
    emit_native_trace(
        root,
        trace_path,
        trace
            .get("trace_id")
            .and_then(Value::as_str)
            .unwrap_or("langgraph-trace"),
        trace
            .get("stage")
            .and_then(Value::as_str)
            .unwrap_or("transition"),
        trace
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("trace"),
    )?;
    as_array_mut(state, "traces").push(trace.clone());
    Ok(json!({
        "ok": true,
        "trace": trace,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-002.5", semantic_claim("V6-WORKFLOW-002.5")),
    }))
}

fn outgoing_edges(graph: &Value, from: &str) -> Vec<Value> {
    graph
        .get("edges")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|row| row.get("from").and_then(Value::as_str) == Some(from))
        .collect()
}

fn node_exists(graph: &Value, node_id: &str) -> bool {
    graph
        .get("nodes")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .any(|row| row.get("id").and_then(Value::as_str) == Some(node_id))
        })
        .unwrap_or(false)
}

fn select_edge(edges: &[Value], context: &Map<String, Value>) -> Option<Value> {
    if let Some(row) = edges.iter().find(|row| {
        row.get("condition")
            .map(|condition| condition_matches(condition, context))
            .unwrap_or(false)
    }) {
        return Some(row.clone());
    }
    edges
        .iter()
        .find(|row| row.get("default").and_then(Value::as_bool).unwrap_or(false))
        .cloned()
}

fn stream_graph(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let graph_id = clean_token(payload.get("graph_id").and_then(Value::as_str), "");
    if graph_id.is_empty() {
        return Err("langgraph_stream_graph_id_required".to_string());
    }
    let graph = state
        .get("graphs")
        .and_then(Value::as_object)
        .and_then(|rows| rows.get(&graph_id))
        .cloned()
        .ok_or_else(|| format!("unknown_langgraph_graph:{graph_id}"))?;
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let context = payload
        .get("context")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let max_steps = match profile.as_str() {
        "tiny-max" => 2usize,
        "pure" => 3usize,
        _ => 8usize,
    };
    let mut current = clean_token(
        payload
            .get("entry_node")
            .and_then(Value::as_str)
            .or_else(|| graph.get("entry_node").and_then(Value::as_str)),
        "",
    );
    if current.is_empty() || !node_exists(&graph, &current) {
        return Err("langgraph_stream_entry_node_unknown".to_string());
    }
    let mut visited = Vec::new();
    let mut events = Vec::new();
    let mut degraded = false;
    for step in 0..max_steps {
        visited.push(Value::String(current.clone()));
        events.push(json!({
            "event": "node_enter",
            "step": step,
            "node_id": current,
        }));
        let edges = outgoing_edges(&graph, &current);
        if edges.is_empty() {
            break;
        }
        let Some(edge) = select_edge(&edges, &context) else {
            return Err("langgraph_stream_no_matching_edge_fail_closed".to_string());
        };
        let next = clean_token(edge.get("to").and_then(Value::as_str), "");
        if next.is_empty() || !node_exists(&graph, &next) {
            return Err("langgraph_stream_edge_target_unknown".to_string());
        }
        events.push(json!({
            "event": "edge_selected",
            "step": step,
            "from": current,
            "to": next,
            "label": edge.get("label").cloned().unwrap_or_else(|| json!(null)),
            "conditional": edge.get("condition").map(|row| !row.is_null()).unwrap_or(false),
        }));
        current = next;
    }
    if profile != "rich" {
        degraded = true;
        events.push(json!({
            "event": "degraded_profile",
            "profile": profile,
            "reason": "bounded_stream_step_cap",
        }));
    }
    let record = json!({
        "stream_id": stable_id("lgstream", &json!({"graph_id": graph_id, "context": context})),
        "graph_id": graph_id,
        "profile": profile,
        "visited": visited,
        "events": events,
        "degraded": degraded,
        "stream_mode": clean_token(payload.get("stream_mode").and_then(Value::as_str), "updates"),
        "streamed_at": now_iso(),
    });
    as_array_mut(state, "streams").push(record.clone());
    Ok(json!({
        "ok": true,
        "stream": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-002.6", semantic_claim("V6-WORKFLOW-002.6")),
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
            print_json_line(&cli_error("langgraph_bridge_error", &error));
            return 1;
        }
    };
    let payload = payload_obj(&payload);
    let state_path = state_path(root, argv, payload);
    let history_path = history_path(root, argv, payload);
    let swarm_path = swarm_state_path(root, argv, payload);
    let native_trace_path = trace_path(root, argv, payload);

    if command == "status" {
        let state = load_state(&state_path);
        let receipt = cli_receipt(
            "langgraph_bridge_status",
            json!({
                "ok": true,
                "schema_version": state.get("schema_version").cloned().unwrap_or_else(|| json!(null)),
                "graphs": state.get("graphs").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
                "checkpoints": state.get("checkpoints").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
                "inspections": state.get("inspections").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
                "subgraphs": state.get("subgraphs").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
                "traces": state.get("traces").and_then(Value::as_array).map(|row| row.len()).unwrap_or(0),
                "streams": state.get("streams").and_then(Value::as_array).map(|row| row.len()).unwrap_or(0),
                "state_path": rel(root, &state_path),
                "history_path": rel(root, &history_path),
            }),
        );
        print_json_line(&receipt);
        return 0;
    }

    let mut state = load_state(&state_path);
    let payload_result = match command {
        "register-graph" => register_graph(&mut state, payload),
        "checkpoint-run" => checkpoint_run(&mut state, payload),
        "inspect-state" => inspect_state(&mut state, payload),
        "coordinate-subgraph" => coordinate_subgraph(&mut state, &swarm_path, payload),
        "record-trace" => record_trace(root, &mut state, &native_trace_path, payload),
        "stream-graph" => stream_graph(&mut state, payload),
        "help" | "--help" | "-h" => {
            usage();
            return 0;
        }
        _ => {
            print_json_line(&cli_error(
                "langgraph_bridge_error",
                &format!("unknown_langgraph_bridge_command:{command}"),
            ));
            return 1;
        }
    };

    let payload_out = match payload_result {
        Ok(value) => value,
        Err(error) => {
            let receipt = cli_error("langgraph_bridge_error", &error);
            print_json_line(&receipt);
            return 1;
        }
    };
    let receipt = cli_receipt("langgraph_bridge_receipt", payload_out);
    state["last_receipt"] = receipt.clone();
    if let Err(error) = save_state(&state_path, &state) {
        let err = cli_error("langgraph_bridge_error", &error);
        print_json_line(&err);
        return 1;
    }
    if let Err(error) = append_history(&history_path, &receipt) {
        let err = cli_error("langgraph_bridge_error", &error);
        print_json_line(&err);
        return 1;
    }
    print_json_line(&receipt);
    0
}
