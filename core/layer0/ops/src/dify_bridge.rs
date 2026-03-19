// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::contract_lane_utils::{
    self as lane_utils, clean_text, clean_token, cli_error, cli_receipt,
    normalize_bridge_path_clean, payload_obj, print_json_line, rel_path as rel, repo_path,
};
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_STATE_REL: &str = "local/state/ops/dify_bridge/latest.json";
const DEFAULT_HISTORY_REL: &str = "local/state/ops/dify_bridge/history.jsonl";
const DEFAULT_SWARM_STATE_REL: &str = "local/state/ops/dify_bridge/swarm_state.json";
const DEFAULT_TRACE_REL: &str = "local/state/ops/dify_bridge/audit_trace.jsonl";
const DEFAULT_DASHBOARD_REL: &str = "client/runtime/local/state/dify_dashboard_shell";

fn usage() {
    println!("dify-bridge commands:");
    println!("  protheus-ops dify-bridge status [--state-path=<path>]");
    println!("  protheus-ops dify-bridge register-canvas [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops dify-bridge sync-knowledge-base [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops dify-bridge register-agent-app [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops dify-bridge publish-dashboard [--payload-base64=<json>] [--state-path=<path>] [--dashboard-dir=<path>]");
    println!(
        "  protheus-ops dify-bridge route-provider [--payload-base64=<json>] [--state-path=<path>]"
    );
    println!("  protheus-ops dify-bridge run-conditional-flow [--payload-base64=<json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops dify-bridge record-audit-trace [--payload-base64=<json>] [--state-path=<path>] [--trace-path=<path>]");
}

fn payload_json(argv: &[String]) -> Result<Value, String> {
    lane_utils::payload_json(argv, "dify_bridge")
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

fn dashboard_dir(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "dashboard-dir", false)
        .or_else(|| {
            payload
                .get("dashboard_dir")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_DASHBOARD_REL))
}

fn default_state() -> Value {
    json!({
        "schema_version": "dify_bridge_state_v1",
        "canvases": {},
        "knowledge_bases": {},
        "agent_apps": {},
        "dashboards": {},
        "provider_routes": {},
        "flow_runs": {},
        "audit_traces": [],
        "last_receipt": null,
    })
}

fn ensure_state_shape(value: &mut Value) {
    if !value.is_object() {
        *value = default_state();
        return;
    }
    for key in [
        "canvases",
        "knowledge_bases",
        "agent_apps",
        "dashboards",
        "provider_routes",
        "flow_runs",
    ] {
        if !value.get(key).map(Value::is_object).unwrap_or(false) {
            value[key] = json!({});
        }
    }
    if !value
        .get("audit_traces")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        value["audit_traces"] = json!([]);
    }
    if value
        .get("schema_version")
        .and_then(Value::as_str)
        .is_none()
    {
        value["schema_version"] = json!("dify_bridge_state_v1");
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

fn normalize_bridge_path(root: &Path, raw: &str) -> Result<String, String> {
    normalize_bridge_path_clean(root, raw, "dify_bridge_path_outside_allowed_surface")
}

fn claim(id: &str, claim: &str) -> Value {
    json!([{"id": id, "claim": claim}])
}

fn profile(raw: Option<&Value>) -> String {
    clean_token(raw.and_then(Value::as_str), "rich")
}

fn register_canvas(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let name = clean_text(payload.get("name").and_then(Value::as_str), 120);
    if name.is_empty() {
        return Err("dify_canvas_name_required".to_string());
    }
    let nodes = payload
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if nodes.is_empty() {
        return Err("dify_canvas_nodes_required".to_string());
    }
    let edges = payload
        .get("edges")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let canvas = json!({
        "canvas_id": stable_id("difycanvas", &json!({"name": name, "nodes": nodes, "edges": edges})),
        "name": name,
        "drag_and_drop": payload.get("drag_and_drop").and_then(Value::as_bool).unwrap_or(true),
        "node_count": nodes.len(),
        "edge_count": edges.len(),
        "conditional_edge_count": edges.iter().filter(|row| row.get("condition").is_some()).count(),
        "nodes": nodes,
        "edges": edges,
        "created_at": now_iso(),
    });
    let id = canvas
        .get("canvas_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "canvases").insert(id, canvas.clone());
    Ok(json!({
        "ok": true,
        "canvas": canvas,
        "claim_evidence": claim("V6-WORKFLOW-005.1", "dify_visual_canvas_nodes_edges_and_drag_drop_are_receipted_on_authoritative_workflow_surface"),
    }))
}

fn sync_knowledge_base(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let profile = profile(payload.get("profile"));
    let name = clean_text(
        payload.get("knowledge_base_name").and_then(Value::as_str),
        120,
    );
    if name.is_empty() {
        return Err("dify_knowledge_base_name_required".to_string());
    }
    let query = clean_text(payload.get("query").and_then(Value::as_str), 120);
    let documents = payload
        .get("documents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let adapter_path = normalize_bridge_path(
        root,
        payload
            .get("bridge_path")
            .and_then(Value::as_str)
            .unwrap_or("adapters/protocol/dify_connector_bridge.ts"),
    )?;
    let multimodal = documents.iter().any(|row| {
        row.get("modality")
            .and_then(Value::as_str)
            .unwrap_or("text")
            != "text"
    });
    let degraded = matches!(profile.as_str(), "tiny-max") && multimodal;
    let query_lower = query.to_ascii_lowercase();
    let retrieval_hits: Vec<Value> = documents
        .iter()
        .filter(|row| {
            let title = row
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let text = row
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            query_lower.is_empty() || title.contains(&query_lower) || text.contains(&query_lower)
        })
        .take(3)
        .cloned()
        .collect();
    let record = json!({
        "knowledge_base_id": stable_id("difykb", &json!({"name": name, "query": query, "documents": documents})),
        "name": name,
        "profile": profile,
        "bridge_path": adapter_path,
        "document_count": documents.len(),
        "query": query,
        "retrieval_hits": retrieval_hits,
        "context_budget": payload.get("context_budget").cloned().unwrap_or_else(|| json!(4096)),
        "degraded": degraded,
        "synced_at": now_iso(),
    });
    let id = record
        .get("knowledge_base_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "knowledge_bases").insert(id, record.clone());
    Ok(json!({
        "ok": true,
        "knowledge_base": record,
        "claim_evidence": claim("V6-WORKFLOW-005.2", "dify_knowledge_base_and_rag_semantics_route_through_governed_retrieval_with_budgeted_receipts"),
    }))
}

fn register_agent_app(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let app_name = clean_text(payload.get("app_name").and_then(Value::as_str), 120);
    if app_name.is_empty() {
        return Err("dify_agent_app_name_required".to_string());
    }
    let adapter_path = normalize_bridge_path(
        root,
        payload
            .get("bridge_path")
            .and_then(Value::as_str)
            .unwrap_or("adapters/protocol/dify_connector_bridge.ts"),
    )?;
    let tools = payload
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let plugins = payload
        .get("plugins")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let modalities = payload
        .get("modalities")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![json!("text")]);
    let denied_tools: Vec<Value> = tools
        .iter()
        .filter(|row| {
            let label = match row {
                Value::String(v) => v.as_str(),
                Value::Object(map) => map.get("name").and_then(Value::as_str).unwrap_or(""),
                _ => "",
            }
            .to_ascii_lowercase();
            label.contains("delete") || label.contains("rm") || label.contains("destructive")
        })
        .cloned()
        .collect();
    let allowed_tools: Vec<Value> = tools
        .iter()
        .filter(|row| !denied_tools.iter().any(|deny| deny == *row))
        .cloned()
        .collect();
    let app = json!({
        "app_id": stable_id("difyapp", &json!({"name": app_name, "tools": allowed_tools, "plugins": plugins})),
        "app_name": app_name,
        "bridge_path": adapter_path,
        "tool_count": allowed_tools.len(),
        "plugin_count": plugins.len(),
        "modalities": modalities,
        "allowed_tools": allowed_tools,
        "denied_tools": denied_tools,
        "registered_at": now_iso(),
    });
    let id = app
        .get("app_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "agent_apps").insert(id, app.clone());
    Ok(json!({
        "ok": true,
        "agent_app": app,
        "claim_evidence": claim("V6-WORKFLOW-005.3", "dify_agentic_apps_plugins_and_multimodal_tools_are_registered_with_fail_closed_denials"),
    }))
}

fn publish_dashboard(
    root: &Path,
    state: &mut Value,
    dashboard_dir: &Path,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let dashboard_name = clean_text(payload.get("dashboard_name").and_then(Value::as_str), 120);
    if dashboard_name.is_empty() {
        return Err("dify_dashboard_name_required".to_string());
    }
    let team = clean_token(payload.get("team").and_then(Value::as_str), "default-team");
    let environment = clean_token(
        payload.get("environment").and_then(Value::as_str),
        "staging",
    );
    fs::create_dir_all(dashboard_dir)
        .map_err(|err| format!("dify_dashboard_dir_create_failed:{err}"))?;
    let record = json!({
        "dashboard_id": stable_id("difydash", &json!({"dashboard_name": dashboard_name, "team": team, "environment": environment})),
        "dashboard_name": dashboard_name,
        "team": team,
        "environment": environment,
        "publish_action": clean_token(payload.get("publish_action").and_then(Value::as_str), "deploy"),
        "deploy_target": clean_text(payload.get("deploy_target").and_then(Value::as_str), 120),
        "shell_path": rel(root, dashboard_dir),
        "published_at": now_iso(),
    });
    let id = record
        .get("dashboard_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    fs::write(
        dashboard_dir.join(format!("{id}.json")),
        serde_json::to_string_pretty(&record)
            .map_err(|err| format!("dify_dashboard_encode_failed:{err}"))?,
    )
    .map_err(|err| format!("dify_dashboard_write_failed:{err}"))?;
    as_object_mut(state, "dashboards").insert(id, record.clone());
    Ok(json!({
        "ok": true,
        "dashboard": record,
        "claim_evidence": claim("V6-WORKFLOW-005.4", "dify_team_collaboration_and_deployment_dashboards_remain_shells_over_governed_actions"),
    }))
}

fn route_provider(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let profile = profile(payload.get("profile"));
    let modality = clean_token(payload.get("modality").and_then(Value::as_str), "text");
    let adapter_path = normalize_bridge_path(
        root,
        payload
            .get("bridge_path")
            .and_then(Value::as_str)
            .unwrap_or("adapters/protocol/dify_connector_bridge.ts"),
    )?;
    let local_models = payload
        .get("local_models")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let providers = payload
        .get("providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let supports_modality = match profile.as_str() {
        "tiny-max" => modality == "text",
        "pure" => matches!(modality.as_str(), "text" | "image"),
        _ => true,
    };
    let selected_route = if payload
        .get("prefer_local")
        .and_then(Value::as_bool)
        .unwrap_or(true)
        && !local_models.is_empty()
    {
        json!({"route_kind": "local_model", "target": local_models.first().cloned().unwrap_or_else(|| json!(null))})
    } else if !providers.is_empty() {
        json!({"route_kind": "provider", "target": providers.first().cloned().unwrap_or_else(|| json!(null))})
    } else if !local_models.is_empty() {
        json!({"route_kind": "local_model", "target": local_models.first().cloned().unwrap_or_else(|| json!(null))})
    } else {
        return Err("dify_provider_route_target_required".to_string());
    };
    let route = json!({
        "route_id": stable_id("difyroute", &json!({"profile": profile, "modality": modality, "selected_route": selected_route})),
        "profile": profile,
        "modality": modality,
        "bridge_path": adapter_path,
        "selected_route": selected_route,
        "degraded": !supports_modality,
        "routed_at": now_iso(),
    });
    let id = route
        .get("route_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "provider_routes").insert(id, route.clone());
    Ok(json!({
        "ok": true,
        "provider_route": route,
        "claim_evidence": claim("V6-WORKFLOW-005.5", "dify_provider_compatibility_is_absorbed_into_governed_route_and_invocation_receipts"),
    }))
}

fn matches_condition(context: &Map<String, Value>, condition: Option<&Map<String, Value>>) -> bool {
    let Some(condition) = condition else {
        return false;
    };
    let field = condition.get("field").and_then(Value::as_str).unwrap_or("");
    if field.is_empty() {
        return false;
    }
    match (context.get(field), condition.get("equals")) {
        (Some(Value::String(left)), Some(Value::String(right))) => left == right,
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

fn run_conditional_flow(
    root: &Path,
    state: &mut Value,
    swarm_state_path: &Path,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let flow_name = clean_text(payload.get("flow_name").and_then(Value::as_str), 120);
    if flow_name.is_empty() {
        return Err("dify_flow_name_required".to_string());
    }
    let profile = profile(payload.get("profile"));
    let context = payload
        .get("context")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let branches = payload
        .get("branches")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let selected_branch = branches
        .iter()
        .find(|row| {
            row.get("condition")
                .and_then(Value::as_object)
                .map(|cond| matches_condition(&context, Some(cond)))
                .unwrap_or_else(|| row.get("default").and_then(Value::as_bool).unwrap_or(false))
        })
        .cloned()
        .unwrap_or_else(|| json!({"id": "default", "target": "complete", "default": true}));
    let loop_cfg = payload
        .get("loop")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut iterations = loop_cfg
        .get("max_iterations")
        .and_then(Value::as_u64)
        .unwrap_or(1);
    if let Some(condition) = loop_cfg.get("continue_while").and_then(Value::as_object) {
        if !matches_condition(&context, Some(condition)) {
            iterations = 1;
        }
    }
    let mut degraded = false;
    if profile == "tiny-max" && iterations > 2 {
        iterations = 2;
        degraded = true;
    }
    let handoff_target = payload
        .get("handoffs")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter().find_map(|row| {
                let cond = row.get("when").and_then(Value::as_object);
                if matches_condition(&context, cond) {
                    row.get("target")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                } else {
                    None
                }
            })
        });
    let swarm_record = json!({
        "flow_name": flow_name,
        "selected_target": selected_branch.get("target").cloned().unwrap_or_else(|| json!("complete")),
        "handoff_target": handoff_target,
        "iterations": iterations,
        "profile": profile,
        "recorded_at": now_iso(),
    });
    lane_utils::write_json(swarm_state_path, &swarm_record)?;
    let record = json!({
        "flow_run_id": stable_id("difyflow", &json!({"flow_name": flow_name, "context": context, "selected_branch": selected_branch, "iterations": iterations})),
        "flow_name": flow_name,
        "profile": profile,
        "context": context,
        "selected_branch": selected_branch,
        "iterations": iterations,
        "handoff_target": handoff_target,
        "swarm_state_path": rel(root, swarm_state_path),
        "degraded": degraded,
        "executed_at": now_iso(),
    });
    let id = record
        .get("flow_run_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "flow_runs").insert(id, record.clone());
    Ok(json!({
        "ok": true,
        "flow_run": record,
        "claim_evidence": claim("V6-WORKFLOW-005.6", "dify_conditional_branches_loops_and_agent_handoffs_route_through_authoritative_workflow_primitives"),
    }))
}

fn record_audit_trace(
    root: &Path,
    state: &mut Value,
    trace_path: &Path,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let bridge_path = normalize_bridge_path(
        root,
        payload
            .get("bridge_path")
            .and_then(Value::as_str)
            .unwrap_or("client/runtime/lib/dify_bridge.ts"),
    )?;
    let trace = json!({
        "trace_id": stable_id("difytrace", &json!({"stage": payload.get("stage"), "message": payload.get("message")})),
        "stage": clean_token(payload.get("stage").and_then(Value::as_str), "run"),
        "message": clean_text(payload.get("message").and_then(Value::as_str), 180),
        "metrics": payload.get("metrics").cloned().unwrap_or_else(|| json!({})),
        "logs": payload.get("logs").cloned().unwrap_or_else(|| json!([])),
        "bridge_path": bridge_path,
        "trace_path": rel(root, trace_path),
        "recorded_at": now_iso(),
    });
    lane_utils::append_jsonl(trace_path, &trace)?;
    as_array_mut(state, "audit_traces").push(trace.clone());
    Ok(json!({
        "ok": true,
        "audit_trace": trace,
        "claim_evidence": claim("V6-WORKFLOW-005.7", "dify_logs_metrics_and_debugging_traces_stream_through_native_observability_and_receipt_lanes"),
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
            print_json_line(&cli_error("dify_bridge_error", &error));
            return 1;
        }
    };
    let payload = payload_obj(&payload);
    let state_path = state_path(root, argv, payload);
    let history_path = history_path(root, argv, payload);
    let swarm_state_path = swarm_state_path(root, argv, payload);
    let trace_path = trace_path(root, argv, payload);
    let dashboard_dir = dashboard_dir(root, argv, payload);

    if matches!(command, "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    let mut state = load_state(&state_path);
    let payload_out = match command {
        "status" => Ok(json!({
            "ok": true,
            "schema_version": state.get("schema_version").cloned().unwrap_or_else(|| json!(null)),
            "canvases": state.get("canvases").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
            "knowledge_bases": state.get("knowledge_bases").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
            "agent_apps": state.get("agent_apps").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
            "dashboards": state.get("dashboards").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
            "provider_routes": state.get("provider_routes").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
            "flow_runs": state.get("flow_runs").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
            "audit_traces": state.get("audit_traces").and_then(Value::as_array).map(|row| row.len()).unwrap_or(0),
            "state_path": rel(root, &state_path),
            "history_path": rel(root, &history_path),
        })),
        "register-canvas" => register_canvas(&mut state, payload),
        "sync-knowledge-base" => sync_knowledge_base(root, &mut state, payload),
        "register-agent-app" => register_agent_app(root, &mut state, payload),
        "publish-dashboard" => publish_dashboard(root, &mut state, &dashboard_dir, payload),
        "route-provider" => route_provider(root, &mut state, payload),
        "run-conditional-flow" => {
            run_conditional_flow(root, &mut state, &swarm_state_path, payload)
        }
        "record-audit-trace" => record_audit_trace(root, &mut state, &trace_path, payload),
        _ => Err(format!("unknown_dify_bridge_command:{command}")),
    };

    let payload_out = match payload_out {
        Ok(value) => value,
        Err(error) => {
            print_json_line(&cli_error("dify_bridge_error", &error));
            return 1;
        }
    };

    let receipt = cli_receipt("dify_bridge_receipt", payload_out);
    state["last_receipt"] = receipt.clone();
    if let Err(error) = save_state(&state_path, &state) {
        print_json_line(&cli_error("dify_bridge_error", &error));
        return 1;
    }
    if let Err(error) = append_history(&history_path, &receipt) {
        print_json_line(&cli_error("dify_bridge_error", &error));
        return 1;
    }
    print_json_line(&receipt);
    0
}
