// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_STATE_REL: &str = "local/state/ops/google_adk_bridge/latest.json";
const DEFAULT_HISTORY_REL: &str = "local/state/ops/google_adk_bridge/history.jsonl";
const DEFAULT_SWARM_STATE_REL: &str = "local/state/ops/google_adk_bridge/swarm_state.json";
const DEFAULT_APPROVAL_QUEUE_REL: &str = "client/runtime/local/state/google_adk_approvals.yaml";

fn usage() {
    println!("google-adk-bridge commands:");
    println!("  protheus-ops google-adk-bridge status [--state-path=<path>]");
    println!("  protheus-ops google-adk-bridge register-a2a-agent [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops google-adk-bridge send-a2a-message [--payload-base64=<json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops google-adk-bridge run-llm-agent [--payload-base64=<json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops google-adk-bridge register-tool-manifest [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops google-adk-bridge invoke-tool-manifest [--payload-base64=<json>] [--state-path=<path>] [--approval-queue-path=<path>]");
    println!("  protheus-ops google-adk-bridge coordinate-hierarchy [--payload-base64=<json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops google-adk-bridge approval-checkpoint [--payload-base64=<json>] [--state-path=<path>] [--approval-queue-path=<path>]");
    println!("  protheus-ops google-adk-bridge rewind-session [--payload-base64=<json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops google-adk-bridge record-evaluation [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops google-adk-bridge sandbox-execute [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops google-adk-bridge deploy-shell [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops google-adk-bridge register-runtime-bridge [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops google-adk-bridge route-model [--payload-base64=<json>] [--state-path=<path>]");
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
            .map_err(|err| format!("google_adk_bridge_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("google_adk_bridge_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("google_adk_bridge_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("google_adk_bridge_payload_decode_failed:{err}"));
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

fn approval_queue_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    lane_utils::parse_flag(argv, "approval-queue-path", false)
        .or_else(|| {
            payload
                .get("approval_queue_path")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_APPROVAL_QUEUE_REL))
}

fn default_state() -> Value {
    json!({
        "schema_version": "google_adk_bridge_state_v1",
        "a2a_agents": {},
        "llm_agents": {},
        "tool_manifests": {},
        "hierarchies": {},
        "approval_records": {},
        "session_snapshots": {},
        "evaluations": {},
        "sandbox_runs": {},
        "deployments": {},
        "runtime_bridges": {},
        "last_receipt": null,
    })
}

fn ensure_state_shape(value: &mut Value) {
    if !value.is_object() {
        *value = default_state();
        return;
    }
    for key in [
        "a2a_agents",
        "llm_agents",
        "tool_manifests",
        "hierarchies",
        "approval_records",
        "session_snapshots",
        "evaluations",
        "sandbox_runs",
        "deployments",
        "runtime_bridges",
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
        value["schema_version"] = json!("google_adk_bridge_state_v1");
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

fn clean_text(raw: Option<&str>, max_len: usize) -> String {
    lane_utils::clean_text(raw, max_len)
}

fn clean_token(raw: Option<&str>, fallback: &str) -> String {
    lane_utils::clean_token(raw, fallback)
}

fn parse_u64_value(value: Option<&Value>, fallback: u64, min: u64, max: u64) -> u64 {
    value
        .and_then(|row| match row {
            Value::Number(n) => n.as_u64(),
            Value::String(s) => s.trim().parse::<u64>().ok(),
            _ => None,
        })
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn parse_f64_value(value: Option<&Value>, fallback: f64, min: f64, max: f64) -> f64 {
    value
        .and_then(|row| match row {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        })
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn parse_bool_value(value: Option<&Value>, fallback: bool) -> bool {
    value
        .and_then(|row| match row {
            Value::Bool(v) => Some(*v),
            Value::String(s) => {
                let lower = s.trim().to_ascii_lowercase();
                match lower.as_str() {
                    "1" | "true" | "yes" | "on" => Some(true),
                    "0" | "false" | "no" | "off" => Some(false),
                    _ => None,
                }
            }
            _ => None,
        })
        .unwrap_or(fallback)
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

fn safe_shell_prefix(path: &str) -> bool {
    ["client/", "apps/"]
        .iter()
        .any(|prefix| path.starts_with(prefix))
}

fn normalize_bridge_path(root: &Path, raw: &str) -> Result<String, String> {
    let candidate = raw.trim();
    if candidate.is_empty() {
        return Err("google_adk_bridge_path_required".to_string());
    }
    if candidate.contains("..") {
        return Err("google_adk_unsafe_bridge_path_parent_reference".to_string());
    }
    let abs = repo_path(root, candidate);
    let rel_path = rel(root, &abs);
    if !safe_prefix_for_bridge(&rel_path) {
        return Err("google_adk_unsupported_bridge_path".to_string());
    }
    Ok(rel_path)
}

fn normalize_shell_path(root: &Path, raw: &str) -> Result<String, String> {
    let candidate = raw.trim();
    if candidate.is_empty() {
        return Err("google_adk_shell_path_required".to_string());
    }
    if candidate.contains("..") {
        return Err("google_adk_shell_path_parent_reference".to_string());
    }
    let abs = repo_path(root, candidate);
    let rel_path = rel(root, &abs);
    if !safe_shell_prefix(&rel_path) {
        return Err("google_adk_shell_path_outside_client_or_apps".to_string());
    }
    Ok(rel_path)
}

fn encode_json_arg(value: &Value) -> Result<String, String> {
    serde_json::to_string(value).map_err(|err| format!("google_adk_json_encode_failed:{err}"))
}

fn default_claim_evidence(id: &str, claim: &str) -> Value {
    json!([{ "id": id, "claim": claim }])
}

fn adk_claim(id: &str) -> &'static str {
    match id {
        "V6-WORKFLOW-010.1" => "google_adk_a2a_registry_routes_remote_agent_interop_through_governed_swarm_sessions_and_adapter_paths",
        "V6-WORKFLOW-010.2" => "google_adk_llmagent_and_workflow_semantics_execute_over_authoritative_workflow_and_budget_lanes",
        "V6-WORKFLOW-010.3" => "google_adk_tool_imports_and_invocations_normalize_into_governed_mcp_openapi_and_custom_tool_manifests",
        "V6-WORKFLOW-010.4" => "google_adk_hierarchical_coordination_reuses_authoritative_swarm_lineage_budgets_and_context_controls",
        "V6-WORKFLOW-010.5" => "google_adk_hitl_tool_approvals_reuse_existing_approval_gate_with_deterministic_decision_receipts",
        "V6-WORKFLOW-010.6" => "google_adk_session_rewind_and_evaluation_artifacts_restore_bounded_state_and_emit_native_observability_receipts",
        "V6-WORKFLOW-010.7" => "google_adk_sandbox_and_cloud_paths_stay_adapter_owned_policy_gated_and_fail_closed",
        "V6-WORKFLOW-010.8" => "google_adk_dev_shells_and_deployment_artifacts_remain_non_authoritative_and_delegate_to_core_bridge_receipts",
        "V6-WORKFLOW-010.9" => "google_adk_model_agnostic_polyglot_routing_remains_adapter_owned_and_profile_safe",
        _ => "google_adk_bridge_claim",
    }
}

fn read_swarm_state(path: &Path) -> Value {
    lane_utils::read_json(path)
        .unwrap_or_else(|| json!({ "sessions": {}, "handoff_registry": {}, "message_queues": {} }))
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

fn parse_string_list(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| row.as_str().map(|s| clean_token(Some(s), "")))
        .filter(|row| !row.is_empty())
        .collect()
}

fn profile_supported(supported_profiles: &[String], profile: &str) -> bool {
    supported_profiles.is_empty() || supported_profiles.iter().any(|row| row == profile)
}

fn read_yaml_value(path: &Path) -> Value {
    let raw = std::fs::read_to_string(path).unwrap_or_default();
    if raw.trim().is_empty() {
        return json!({});
    }
    serde_yaml::from_str::<Value>(&raw).unwrap_or_else(|_| json!({}))
}

fn approval_status_from_queue(queue_path: &Path, action_id: &str) -> String {
    let queue = read_yaml_value(queue_path);
    for (status, key) in [
        ("pending", "pending"),
        ("approved", "approved"),
        ("denied", "denied"),
    ] {
        if queue
            .get(key)
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .any(|row| row.get("action_id").and_then(Value::as_str) == Some(action_id))
            })
            .unwrap_or(false)
        {
            return status.to_string();
        }
    }
    "unknown".to_string()
}

fn approval_is_approved(queue_path: &Path, action_id: &str) -> bool {
    approval_status_from_queue(queue_path, action_id) == "approved"
}

fn allowed_language(language: &str) -> bool {
    matches!(language, "python" | "ts" | "go" | "java" | "rust")
}

fn allowed_tool_kind(kind: &str) -> bool {
    matches!(kind, "native" | "mcp" | "openapi" | "custom")
}

fn allowed_workflow_mode(mode: &str) -> bool {
    matches!(mode, "sequential" | "parallel" | "loop")
}

fn emit_native_trace(
    root: &Path,
    trace_id: &str,
    intent: &str,
    message: &str,
) -> Result<(), String> {
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
        return Err("google_adk_observability_enable_failed".to_string());
    }
    let exit = crate::observability_plane::run(
        root,
        &[
            "acp-provenance".to_string(),
            "--op=trace".to_string(),
            "--source-agent=google-adk-bridge".to_string(),
            format!("--target-agent={}", clean_token(Some(intent), "workflow")),
            format!("--intent={}", clean_text(Some(intent), 80)),
            format!("--message={}", clean_text(Some(message), 160)),
            format!("--trace-id={trace_id}"),
            "--visibility-mode=meta".to_string(),
            "--strict=1".to_string(),
        ],
    );
    if exit != 0 {
        return Err("google_adk_observability_trace_failed".to_string());
    }
    Ok(())
}

fn register_a2a_agent(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let name = clean_token(
        payload.get("name").and_then(Value::as_str),
        "google-adk-agent",
    );
    let language = clean_token(payload.get("language").and_then(Value::as_str), "python");
    if !allowed_language(&language) {
        return Err("google_adk_a2a_language_invalid".to_string());
    }
    let transport = clean_token(payload.get("transport").and_then(Value::as_str), "a2a");
    let bridge_path = normalize_bridge_path(
        root,
        payload
            .get("bridge_path")
            .and_then(Value::as_str)
            .unwrap_or("adapters/polyglot/google_adk_runtime_bridge.ts"),
    )?;
    let supported_profiles = parse_string_list(payload.get("supported_profiles"));
    let record = json!({
        "agent_id": stable_id("gadka2a", &json!({"name": name, "language": language, "bridge_path": bridge_path})),
        "name": name,
        "language": language,
        "transport": transport,
        "bridge_path": bridge_path,
        "endpoint": clean_text(payload.get("endpoint").and_then(Value::as_str), 240),
        "capabilities": payload.get("capabilities").cloned().unwrap_or_else(|| json!([])),
        "supported_profiles": supported_profiles,
        "registered_at": now_iso(),
        "session_id": Value::Null,
    });
    let agent_id = record
        .get("agent_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "a2a_agents").insert(agent_id, record.clone());
    Ok(json!({
        "ok": true,
        "agent": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-010.1", adk_claim("V6-WORKFLOW-010.1")),
    }))
}

fn ensure_session_for_task(
    root: &Path,
    swarm_state_path: &Path,
    task: &str,
    label: &str,
    role: Option<&str>,
    parent_session_id: Option<&str>,
    max_tokens: u64,
) -> Result<String, String> {
    let mut args = vec![
        "spawn".to_string(),
        format!("--task={task}"),
        format!("--agent-label={label}"),
        format!("--max-tokens={max_tokens}"),
        format!("--state-path={}", swarm_state_path.display()),
    ];
    if let Some(role) = role {
        args.push(format!("--role={role}"));
    }
    if let Some(parent) = parent_session_id {
        args.push(format!("--session-id={parent}"));
    }
    let exit = crate::swarm_runtime::run(root, &args);
    if exit != 0 {
        return Err(format!("google_adk_swarm_spawn_failed:{label}"));
    }
    let swarm_state = read_swarm_state(swarm_state_path);
    find_swarm_session_id_by_task(&swarm_state, task)
        .ok_or_else(|| format!("google_adk_swarm_session_missing:{label}"))
}

fn send_a2a_message(
    root: &Path,
    argv: &[String],
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let agent_id = clean_token(payload.get("agent_id").and_then(Value::as_str), "");
    if agent_id.is_empty() {
        return Err("google_adk_a2a_agent_id_required".to_string());
    }
    let message = clean_text(payload.get("message").and_then(Value::as_str), 400);
    if message.is_empty() {
        return Err("google_adk_a2a_message_required".to_string());
    }
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let swarm_state_path = swarm_state_path(root, argv, payload);
    let agent = as_object_mut(state, "a2a_agents")
        .get_mut(&agent_id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("unknown_google_adk_a2a_agent:{agent_id}"))?;
    let supported_profiles = parse_string_list(agent.get("supported_profiles"));
    if !profile_supported(&supported_profiles, &profile) {
        return Err(format!("google_adk_a2a_profile_unsupported:{profile}"));
    }
    let sender_label = clean_token(
        payload.get("sender_label").and_then(Value::as_str),
        "google-adk-sender",
    );
    let sender_task = format!(
        "google-adk:a2a:{}:{}",
        sender_label,
        clean_text(payload.get("sender_task").and_then(Value::as_str), 120)
    );
    let sender_session_id = ensure_session_for_task(
        root,
        &swarm_state_path,
        &sender_task,
        &sender_label,
        Some("coordinator"),
        None,
        parse_u64_value(payload.get("sender_budget"), 320, 64, 4096),
    )?;
    let agent_name = clean_token(agent.get("name").and_then(Value::as_str), "remote-agent");
    let remote_task = format!("google-adk:a2a:remote:{agent_name}");
    let existing_session = agent
        .get("session_id")
        .and_then(Value::as_str)
        .map(ToString::to_string);
    let remote_session_id = match existing_session {
        Some(id) if !id.is_empty() => id,
        _ => {
            let id = ensure_session_for_task(
                root,
                &swarm_state_path,
                &remote_task,
                &agent_name,
                Some("remote-agent"),
                None,
                parse_u64_value(payload.get("receiver_budget"), 320, 64, 4096),
            )?;
            agent.insert("session_id".to_string(), json!(id.clone()));
            id
        }
    };
    let send_exit = crate::swarm_runtime::run(
        root,
        &[
            "sessions".to_string(),
            "send".to_string(),
            format!("--sender-id={sender_session_id}"),
            format!("--session-id={remote_session_id}"),
            format!("--message={message}"),
            "--delivery=at_least_once".to_string(),
            format!(
                "--ttl-ms={}",
                parse_u64_value(payload.get("ttl_ms"), 60000, 1000, 300000)
            ),
            format!("--state-path={}", swarm_state_path.display()),
        ],
    );
    if send_exit != 0 {
        return Err("google_adk_a2a_send_failed".to_string());
    }
    let handoff_reason = clean_text(payload.get("handoff_reason").and_then(Value::as_str), 120);
    let handoff_exit = crate::swarm_runtime::run(
        root,
        &[
            "sessions".to_string(),
            "handoff".to_string(),
            format!("--session-id={sender_session_id}"),
            format!("--target-session-id={remote_session_id}"),
            format!(
                "--reason={}",
                if handoff_reason.is_empty() {
                    "google_adk_a2a_handoff"
                } else {
                    handoff_reason.as_str()
                }
            ),
            format!(
                "--importance={:.2}",
                parse_f64_value(payload.get("importance"), 0.82, 0.0, 1.0)
            ),
            format!("--state-path={}", swarm_state_path.display()),
        ],
    );
    if handoff_exit != 0 {
        return Err("google_adk_a2a_handoff_failed".to_string());
    }
    let receipt = json!({
        "message_id": stable_id("gadka2amsg", &json!({"agent_id": agent_id, "message": message})),
        "agent_id": agent_id,
        "profile": profile,
        "sender_session_id": sender_session_id,
        "remote_session_id": remote_session_id,
        "message": message,
        "bridge_path": agent.get("bridge_path").cloned().unwrap_or(Value::Null),
        "sent_at": now_iso(),
    });
    Ok(json!({
        "ok": true,
        "a2a_message": receipt,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-010.1", adk_claim("V6-WORKFLOW-010.1")),
    }))
}

fn register_runtime_bridge(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let name = clean_token(
        payload.get("name").and_then(Value::as_str),
        "google-adk-runtime",
    );
    let language = clean_token(payload.get("language").and_then(Value::as_str), "python");
    if !allowed_language(&language) {
        return Err("google_adk_runtime_language_invalid".to_string());
    }
    let bridge_path = normalize_bridge_path(
        root,
        payload
            .get("bridge_path")
            .and_then(Value::as_str)
            .unwrap_or("adapters/polyglot/google_adk_runtime_bridge.ts"),
    )?;
    if !bridge_path.starts_with("adapters/") {
        return Err("google_adk_runtime_bridge_must_be_adapter_owned".to_string());
    }
    let supported_profiles = parse_string_list(payload.get("supported_profiles"));
    let record = json!({
        "bridge_id": stable_id("gadkrt", &json!({"name": name, "language": language, "bridge_path": bridge_path})),
        "name": name,
        "language": language,
        "provider": clean_token(payload.get("provider").and_then(Value::as_str), "openai-compatible"),
        "model_family": clean_token(payload.get("model_family").and_then(Value::as_str), "gemini"),
        "models": payload.get("models").cloned().unwrap_or_else(|| json!([])),
        "supported_profiles": supported_profiles,
        "bridge_path": bridge_path,
        "registered_at": now_iso(),
    });
    let bridge_id = record
        .get("bridge_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "runtime_bridges").insert(bridge_id, record.clone());
    Ok(json!({
        "ok": true,
        "runtime_bridge": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-010.9", adk_claim("V6-WORKFLOW-010.9")),
    }))
}

fn select_runtime_bridge<'a>(
    bridges: &'a Map<String, Value>,
    bridge_id: &str,
    language: &str,
    provider: &str,
) -> Result<&'a Value, String> {
    if !bridge_id.is_empty() {
        return bridges
            .get(bridge_id)
            .ok_or_else(|| format!("unknown_google_adk_runtime_bridge:{bridge_id}"));
    }
    bridges
        .values()
        .find(|row| {
            let language_match = row.get("language").and_then(Value::as_str) == Some(language);
            let provider_match = provider.is_empty()
                || row.get("provider").and_then(Value::as_str) == Some(provider);
            language_match && provider_match
        })
        .ok_or_else(|| format!("google_adk_runtime_bridge_not_found:{language}:{provider}"))
}

fn route_model(state: &Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let bridge_id = clean_token(payload.get("bridge_id").and_then(Value::as_str), "");
    let language = clean_token(payload.get("language").and_then(Value::as_str), "python");
    let provider = clean_token(
        payload.get("provider").and_then(Value::as_str),
        "openai-compatible",
    );
    let model = clean_token(
        payload.get("model").and_then(Value::as_str),
        "gemini-2.0-flash",
    );
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let bridges = state
        .get("runtime_bridges")
        .and_then(Value::as_object)
        .ok_or_else(|| "google_adk_runtime_bridges_missing".to_string())?;
    let bridge = select_runtime_bridge(bridges, &bridge_id, &language, &provider)?;
    let supported_profiles = parse_string_list(bridge.get("supported_profiles"));
    if !profile_supported(&supported_profiles, &profile) {
        return Err(format!("google_adk_runtime_profile_unsupported:{profile}"));
    }
    let polyglot_requires_rich = matches!(language.as_str(), "python" | "go" | "java")
        && matches!(profile.as_str(), "pure" | "tiny-max");
    Ok(json!({
        "ok": true,
        "route": {
            "bridge_id": bridge.get("bridge_id").cloned().unwrap_or(Value::Null),
            "bridge_path": bridge.get("bridge_path").cloned().unwrap_or(Value::Null),
            "language": language,
            "provider": provider,
            "model": model,
            "profile": profile,
            "degraded": polyglot_requires_rich,
            "reason_code": if polyglot_requires_rich { "polyglot_runtime_requires_rich_profile" } else { "route_ok" },
            "invocation_mode": "adapter_owned_runtime_bridge"
        },
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-010.9", adk_claim("V6-WORKFLOW-010.9")),
    }))
}

fn snapshot_record(state: &mut Value, session_id: &str, payload: Value) {
    as_object_mut(state, "session_snapshots").insert(session_id.to_string(), payload);
}

fn run_llm_agent(
    root: &Path,
    argv: &[String],
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let name = clean_token(
        payload.get("name").and_then(Value::as_str),
        "google-adk-llm-agent",
    );
    let instruction = clean_text(payload.get("instruction").and_then(Value::as_str), 240);
    if instruction.is_empty() {
        return Err("google_adk_llm_agent_instruction_required".to_string());
    }
    let mode = clean_token(payload.get("mode").and_then(Value::as_str), "sequential");
    if !allowed_workflow_mode(&mode) {
        return Err("google_adk_llm_agent_mode_invalid".to_string());
    }
    let steps = payload
        .get("steps")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if steps.is_empty() {
        return Err("google_adk_llm_agent_steps_required".to_string());
    }
    let swarm_state_path = swarm_state_path(root, argv, payload);
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let route = route_model(
        state,
        &Map::from_iter([
            (
                "bridge_id".to_string(),
                payload
                    .get("runtime_bridge_id")
                    .cloned()
                    .unwrap_or(Value::String(String::new())),
            ),
            (
                "language".to_string(),
                payload
                    .get("language")
                    .cloned()
                    .unwrap_or_else(|| json!("python")),
            ),
            (
                "provider".to_string(),
                payload
                    .get("provider")
                    .cloned()
                    .unwrap_or_else(|| json!("openai-compatible")),
            ),
            (
                "model".to_string(),
                payload
                    .get("model")
                    .cloned()
                    .unwrap_or_else(|| json!("gemini-2.0-flash")),
            ),
            ("profile".to_string(), json!(profile.clone())),
        ]),
    )?;
    let primary_task = format!("google-adk:llm:{}:{}", name, instruction);
    let primary_session_id = ensure_session_for_task(
        root,
        &swarm_state_path,
        &primary_task,
        &name,
        Some("llm-agent"),
        None,
        parse_u64_value(payload.get("budget"), 640, 64, 8192),
    )?;

    let mut step_reports = Vec::new();
    let mut child_sessions = Vec::new();
    match mode.as_str() {
        "sequential" => {
            for (idx, step) in steps.iter().enumerate() {
                let step_id = clean_token(
                    step.get("id").and_then(Value::as_str),
                    &format!("step-{}", idx + 1),
                );
                step_reports.push(json!({
                    "step_id": step_id,
                    "mode": "sequential",
                    "budget": parse_u64_value(step.get("budget"), 96, 16, 2048),
                }));
            }
        }
        "parallel" => {
            for (idx, step) in steps.iter().enumerate() {
                let step_id = clean_token(
                    step.get("id").and_then(Value::as_str),
                    &format!("parallel-{}", idx + 1),
                );
                let task = format!("google-adk:parallel:{name}:{step_id}");
                let child = ensure_session_for_task(
                    root,
                    &swarm_state_path,
                    &task,
                    &step_id,
                    Some("llm-worker"),
                    Some(&primary_session_id),
                    parse_u64_value(step.get("budget"), 128, 16, 2048),
                )?;
                child_sessions.push(child.clone());
                step_reports
                    .push(json!({"step_id": step_id, "mode": "parallel", "session_id": child}));
            }
        }
        "loop" => {
            let max_iterations = parse_u64_value(payload.get("max_iterations"), 2, 1, 6);
            for iter in 0..max_iterations {
                for (idx, step) in steps.iter().enumerate() {
                    let step_id = clean_token(
                        step.get("id").and_then(Value::as_str),
                        &format!("loop-{}", idx + 1),
                    );
                    step_reports.push(json!({
                        "step_id": step_id,
                        "mode": "loop",
                        "iteration": iter + 1,
                        "budget": parse_u64_value(step.get("budget"), 64, 16, 1024),
                    }));
                }
            }
        }
        _ => unreachable!(),
    }

    let agent = json!({
        "agent_id": stable_id("gadkagent", &json!({"name": name, "instruction": instruction, "mode": mode})),
        "name": name,
        "instruction": instruction,
        "mode": mode,
        "profile": profile,
        "route": route.get("route").cloned().unwrap_or(Value::Null),
        "primary_session_id": primary_session_id,
        "child_sessions": child_sessions,
        "steps": step_reports,
        "executed_at": now_iso(),
    });
    let agent_id = agent
        .get("agent_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    snapshot_record(
        state,
        agent
            .get("primary_session_id")
            .and_then(Value::as_str)
            .unwrap_or("google-adk-session"),
        json!({
            "snapshot_id": stable_id("gadksnap", &json!({"agent_id": agent_id})),
            "agent_id": agent_id,
            "context_payload": {"instruction": instruction, "mode": mode, "profile": profile},
            "route": route.get("route").cloned().unwrap_or(Value::Null),
            "recorded_at": now_iso(),
        }),
    );
    as_object_mut(state, "llm_agents").insert(agent_id, agent.clone());
    Ok(json!({
        "ok": true,
        "agent": agent,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-010.2", adk_claim("V6-WORKFLOW-010.2")),
    }))
}

fn register_tool_manifest(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let name = clean_token(
        payload.get("name").and_then(Value::as_str),
        "google-adk-tool",
    );
    let kind = clean_token(payload.get("kind").and_then(Value::as_str), "custom");
    if !allowed_tool_kind(&kind) {
        return Err("google_adk_tool_kind_invalid".to_string());
    }
    let bridge_path = normalize_bridge_path(
        root,
        payload
            .get("bridge_path")
            .and_then(Value::as_str)
            .unwrap_or("adapters/polyglot/google_adk_runtime_bridge.ts"),
    )?;
    let supported_profiles = parse_string_list(payload.get("supported_profiles"));
    let openapi_url = clean_text(payload.get("openapi_url").and_then(Value::as_str), 200);
    if kind == "openapi"
        && !(openapi_url.starts_with("https://") || openapi_url.ends_with("openapi.json"))
    {
        return Err("google_adk_tool_openapi_url_invalid".to_string());
    }
    if kind == "mcp" {
        let exit = crate::mcp_plane::run(
            root,
            &[
                "capability-matrix".to_string(),
                "--server-capabilities=tools,resources,prompts".to_string(),
                "--strict=1".to_string(),
            ],
        );
        if exit != 0 {
            return Err("google_adk_tool_mcp_capability_validation_failed".to_string());
        }
    }
    let record = json!({
        "tool_id": stable_id("gadktool", &json!({"name": name, "kind": kind, "bridge_path": bridge_path})),
        "name": name,
        "kind": kind,
        "bridge_path": bridge_path,
        "entrypoint": clean_token(payload.get("entrypoint").and_then(Value::as_str), "invoke"),
        "openapi_url": openapi_url,
        "requires_approval": parse_bool_value(payload.get("requires_approval"), false),
        "supported_profiles": supported_profiles,
        "schema": payload.get("schema").cloned().unwrap_or(Value::Null),
        "capabilities": payload.get("capabilities").cloned().unwrap_or_else(|| json!([])),
        "registered_at": now_iso(),
        "invocation_count": 0,
        "fail_closed": true,
    });
    let tool_id = record
        .get("tool_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "tool_manifests").insert(tool_id, record.clone());
    Ok(json!({
        "ok": true,
        "tool": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-010.3", adk_claim("V6-WORKFLOW-010.3")),
    }))
}

fn invoke_tool_manifest(
    root: &Path,
    argv: &[String],
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let tool_id = clean_token(payload.get("tool_id").and_then(Value::as_str), "");
    if tool_id.is_empty() {
        return Err("google_adk_tool_id_required".to_string());
    }
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let queue_path = approval_queue_path(root, argv, payload);
    let tools = as_object_mut(state, "tool_manifests");
    let tool = tools
        .get_mut(&tool_id)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| format!("unknown_google_adk_tool:{tool_id}"))?;
    let supported_profiles = parse_string_list(tool.get("supported_profiles"));
    if !profile_supported(&supported_profiles, &profile) {
        return Err(format!("google_adk_tool_profile_unsupported:{profile}"));
    }
    let requires_approval = parse_bool_value(tool.get("requires_approval"), false)
        || parse_bool_value(payload.get("requires_approval"), false);
    if requires_approval {
        let approval_action_id = clean_token(
            payload.get("approval_action_id").and_then(Value::as_str),
            "",
        );
        if approval_action_id.is_empty() {
            return Err("google_adk_tool_requires_approval".to_string());
        }
        if !approval_is_approved(&queue_path, &approval_action_id) {
            return Err("google_adk_tool_approval_not_granted".to_string());
        }
    }
    let kind = clean_token(tool.get("kind").and_then(Value::as_str), "custom");
    let args = payload.get("args").cloned().unwrap_or_else(|| json!({}));
    let invocation = match kind.as_str() {
        "openapi" => json!({
            "mode": "openapi_request",
            "target": tool.get("openapi_url").cloned().unwrap_or(Value::Null),
            "method": payload.get("method").cloned().unwrap_or_else(|| json!("POST")),
            "path": payload.get("path").cloned().unwrap_or_else(|| json!("/invoke")),
            "body": args,
        }),
        "mcp" => json!({
            "mode": "mcp_tool_call",
            "tool": tool.get("name").cloned().unwrap_or_else(|| json!("tool")),
            "arguments": args,
        }),
        "native" => json!({
            "mode": "native_call",
            "entrypoint": tool.get("entrypoint").cloned().unwrap_or_else(|| json!("invoke")),
            "arguments": args,
        }),
        _ => json!({
            "mode": "custom_function",
            "entrypoint": tool.get("entrypoint").cloned().unwrap_or_else(|| json!("invoke")),
            "arguments": args,
        }),
    };
    let invocation_count = tool
        .get("invocation_count")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        .saturating_add(1);
    tool.insert("invocation_count".to_string(), json!(invocation_count));
    tool.insert("last_invoked_at".to_string(), json!(now_iso()));
    Ok(json!({
        "ok": true,
        "tool_id": tool_id,
        "invocation": invocation,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-010.3", adk_claim("V6-WORKFLOW-010.3")),
    }))
}

fn coordinate_hierarchy(
    root: &Path,
    argv: &[String],
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let name = clean_token(
        payload.get("name").and_then(Value::as_str),
        "google-adk-hierarchy",
    );
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let swarm_state_path = swarm_state_path(root, argv, payload);
    let coordinator_label = clean_token(
        payload.get("coordinator_label").and_then(Value::as_str),
        "google-adk-coordinator",
    );
    let coordinator_task = format!("google-adk:hierarchy:{name}:coordinator");
    let coordinator_id = ensure_session_for_task(
        root,
        &swarm_state_path,
        &coordinator_task,
        &coordinator_label,
        Some("coordinator"),
        None,
        parse_u64_value(payload.get("budget"), 960, 96, 12288),
    )?;
    let all_agents = payload
        .get("agents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if all_agents.is_empty() {
        return Err("google_adk_hierarchy_agents_required".to_string());
    }
    let degraded = matches!(profile.as_str(), "pure" | "tiny-max") && all_agents.len() > 1;
    let selected_agents = if degraded {
        vec![all_agents[0].clone()]
    } else {
        all_agents
    };
    let mut rows = Vec::new();
    for agent in selected_agents {
        let obj = agent
            .as_object()
            .ok_or_else(|| "google_adk_hierarchy_agent_object_required".to_string())?;
        let label = clean_token(obj.get("label").and_then(Value::as_str), "subagent");
        let role = clean_token(obj.get("role").and_then(Value::as_str), "specialist");
        let task = format!("google-adk:hierarchy:{name}:{label}");
        let child_id = ensure_session_for_task(
            root,
            &swarm_state_path,
            &task,
            &label,
            Some(&role),
            Some(&coordinator_id),
            parse_u64_value(obj.get("budget"), 224, 32, 4096),
        )?;
        let handoff_exit = crate::swarm_runtime::run(
            root,
            &[
                "sessions".to_string(),
                "handoff".to_string(),
                format!("--session-id={coordinator_id}"),
                format!("--target-session-id={child_id}"),
                format!(
                    "--reason={}",
                    clean_text(obj.get("reason").and_then(Value::as_str), 120)
                ),
                format!(
                    "--importance={:.2}",
                    parse_f64_value(obj.get("importance"), 0.78, 0.0, 1.0)
                ),
                format!("--state-path={}", swarm_state_path.display()),
            ],
        );
        if handoff_exit != 0 {
            return Err(format!("google_adk_hierarchy_handoff_failed:{label}"));
        }
        let context = obj.get("context").cloned().unwrap_or_else(|| json!({}));
        let context_json = encode_json_arg(&context)?;
        let context_exit = crate::swarm_runtime::run(
            root,
            &[
                "sessions".to_string(),
                "context-put".to_string(),
                format!("--session-id={child_id}"),
                format!("--context-json={context_json}"),
                "--merge=1".to_string(),
                format!("--state-path={}", swarm_state_path.display()),
            ],
        );
        if context_exit != 0 {
            return Err(format!("google_adk_hierarchy_context_put_failed:{label}"));
        }
        rows.push(json!({
            "label": label,
            "role": role,
            "session_id": child_id,
            "context_budget": parse_u64_value(obj.get("context_budget"), 96, 16, 4096),
        }));
    }
    let record = json!({
        "hierarchy_id": stable_id("gadkh", &json!({"name": name, "profile": profile})),
        "name": name,
        "profile": profile,
        "coordinator_session_id": coordinator_id,
        "agents": rows,
        "degraded": degraded,
        "reason_code": if degraded { "hierarchy_profile_limited_to_single_subagent" } else { "hierarchy_ok" },
        "executed_at": now_iso(),
    });
    let hierarchy_id = record
        .get("hierarchy_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "hierarchies").insert(hierarchy_id, record.clone());
    Ok(json!({
        "ok": true,
        "hierarchy": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-010.4", adk_claim("V6-WORKFLOW-010.4")),
    }))
}

fn approval_checkpoint(
    root: &Path,
    argv: &[String],
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let queue_path = approval_queue_path(root, argv, payload);
    let action_id = clean_token(payload.get("action_id").and_then(Value::as_str), "");
    let decision = clean_token(payload.get("decision").and_then(Value::as_str), "pending");
    let result = if action_id.is_empty() || decision == "pending" {
        let new_action_id = if action_id.is_empty() {
            stable_id(
                "gadkapproval",
                &json!({
                    "tool_id": payload.get("tool_id"),
                    "summary": payload.get("summary"),
                    "risk": payload.get("risk")
                }),
            )
        } else {
            action_id.clone()
        };
        let action_envelope = json!({
            "action_id": new_action_id,
            "directive_id": "google-adk-bridge",
            "type": "tool_invocation",
            "summary": clean_text(payload.get("summary").and_then(Value::as_str), 200),
            "payload_pointer": clean_text(payload.get("tool_id").and_then(Value::as_str), 160),
        });
        let queue_payload = json!({
            "action_envelope": action_envelope,
            "reason": clean_text(payload.get("reason").and_then(Value::as_str), 200),
        });
        let encoded = BASE64_STANDARD.encode(encode_json_arg(&queue_payload)?.as_bytes());
        let exit = crate::approval_gate_kernel::run(
            root,
            &[
                "queue".to_string(),
                format!("--payload-base64={encoded}"),
                format!("--queue-path={}", queue_path.display()),
            ],
        );
        if exit != 0 {
            return Err("google_adk_approval_queue_failed".to_string());
        }
        json!({
            "action_id": new_action_id,
            "decision": "pending",
            "status": approval_status_from_queue(&queue_path, &new_action_id),
        })
    } else {
        let args = if decision == "approve" {
            vec![
                "approve".to_string(),
                format!("--action-id={action_id}"),
                format!("--queue-path={}", queue_path.display()),
            ]
        } else {
            vec![
                "deny".to_string(),
                format!("--action-id={action_id}"),
                format!(
                    "--reason={}",
                    clean_text(payload.get("reason").and_then(Value::as_str), 120)
                ),
                format!("--queue-path={}", queue_path.display()),
            ]
        };
        let exit = crate::approval_gate_kernel::run(root, &args);
        if exit != 0 {
            return Err(format!("google_adk_approval_{}_failed", decision));
        }
        json!({
            "action_id": action_id,
            "decision": decision,
            "status": approval_status_from_queue(&queue_path, &action_id),
        })
    };
    let action_id = result
        .get("action_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "approval_records").insert(
        action_id.clone(),
        json!({
            "action_id": action_id,
            "tool_id": payload.get("tool_id").cloned().unwrap_or(Value::Null),
            "queue_path": rel(root, &queue_path),
            "status": result.get("status").cloned().unwrap_or(Value::Null),
            "updated_at": now_iso(),
        }),
    );
    Ok(json!({
        "ok": true,
        "approval": result,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-010.5", adk_claim("V6-WORKFLOW-010.5")),
    }))
}

fn rewind_session(
    root: &Path,
    argv: &[String],
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let session_id = clean_token(payload.get("session_id").and_then(Value::as_str), "");
    if session_id.is_empty() {
        return Err("google_adk_rewind_session_id_required".to_string());
    }
    let snapshot = state
        .get("session_snapshots")
        .and_then(Value::as_object)
        .and_then(|rows| rows.get(&session_id))
        .cloned()
        .ok_or_else(|| format!("google_adk_snapshot_missing:{session_id}"))?;
    let context_payload = snapshot
        .get("context_payload")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let swarm_state_path = swarm_state_path(root, argv, payload);
    let context_json = encode_json_arg(&context_payload)?;
    let exit = crate::swarm_runtime::run(
        root,
        &[
            "sessions".to_string(),
            "context-put".to_string(),
            format!("--session-id={session_id}"),
            format!("--context-json={context_json}"),
            "--merge=0".to_string(),
            format!("--state-path={}", swarm_state_path.display()),
        ],
    );
    if exit != 0 {
        return Err("google_adk_rewind_context_restore_failed".to_string());
    }
    emit_native_trace(
        root,
        &clean_token(
            snapshot.get("snapshot_id").and_then(Value::as_str),
            "google-adk-rewind",
        ),
        "google_adk_rewind",
        &format!("rewound session {session_id}"),
    )?;
    Ok(json!({
        "ok": true,
        "restored": {
            "session_id": session_id,
            "snapshot": snapshot,
            "swarm_state_path": rel(root, &swarm_state_path),
        },
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-010.6", adk_claim("V6-WORKFLOW-010.6")),
    }))
}

fn record_evaluation(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let session_id = clean_token(
        payload.get("session_id").and_then(Value::as_str),
        "google-adk-session",
    );
    let metrics = payload.get("metrics").cloned().unwrap_or_else(|| json!({}));
    let evaluation = json!({
        "evaluation_id": stable_id("gadkeval", &json!({"session_id": session_id, "metrics": metrics})),
        "session_id": session_id,
        "metrics": metrics,
        "score": parse_f64_value(payload.get("score"), 0.0, 0.0, 1.0),
        "profile": clean_token(payload.get("profile").and_then(Value::as_str), "rich"),
        "evaluated_at": now_iso(),
    });
    let evaluation_id = evaluation
        .get("evaluation_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "evaluations").insert(evaluation_id.clone(), evaluation.clone());
    emit_native_trace(
        root,
        &evaluation_id,
        "google_adk_eval",
        &format!(
            "session_id={} score={:.2}",
            session_id,
            evaluation
                .get("score")
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        ),
    )?;
    Ok(json!({
        "ok": true,
        "evaluation": evaluation,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-010.6", adk_claim("V6-WORKFLOW-010.6")),
    }))
}

fn sandbox_execute(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let language = clean_token(payload.get("language").and_then(Value::as_str), "python");
    if !allowed_language(&language) {
        return Err("google_adk_sandbox_language_invalid".to_string());
    }
    let profile = clean_token(payload.get("profile").and_then(Value::as_str), "rich");
    let cloud = clean_token(payload.get("cloud").and_then(Value::as_str), "gcp");
    let bridge_path = normalize_bridge_path(
        root,
        payload
            .get("bridge_path")
            .and_then(Value::as_str)
            .unwrap_or("adapters/polyglot/google_adk_runtime_bridge.ts"),
    )?;
    if !bridge_path.starts_with("adapters/") {
        return Err("google_adk_sandbox_bridge_must_be_adapter_owned".to_string());
    }
    let degraded = matches!(profile.as_str(), "pure" | "tiny-max") && !cloud.is_empty();
    let reason_code = if degraded {
        "cloud_integration_requires_rich_profile"
    } else {
        let tier = clean_token(payload.get("tier").and_then(Value::as_str), "wasm");
        let escape_attempt = parse_bool_value(payload.get("escape_attempt"), false);
        let exit = crate::canyon_plane::run(
            root,
            &[
                "sandbox".to_string(),
                "--op=run".to_string(),
                format!("--tier={tier}"),
                format!("--language={language}"),
                format!(
                    "--fuel={}",
                    parse_u64_value(payload.get("fuel"), 2000, 200, 50000)
                ),
                format!(
                    "--epoch={}",
                    parse_u64_value(payload.get("epoch"), 4, 1, 64)
                ),
                format!("--escape-attempt={}", if escape_attempt { 1 } else { 0 }),
                "--strict=1".to_string(),
            ],
        );
        if exit != 0 {
            return Err("google_adk_sandbox_execution_failed".to_string());
        }
        "sandbox_ok"
    };
    let record = json!({
        "sandbox_id": stable_id("gadksbx", &json!({"language": language, "profile": profile, "cloud": cloud})),
        "language": language,
        "profile": profile,
        "cloud": cloud,
        "bridge_path": bridge_path,
        "degraded": degraded,
        "reason_code": reason_code,
        "executed_at": now_iso(),
    });
    let sandbox_id = record
        .get("sandbox_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "sandbox_runs").insert(sandbox_id, record.clone());
    Ok(json!({
        "ok": true,
        "sandbox": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-010.7", adk_claim("V6-WORKFLOW-010.7")),
    }))
}

fn deploy_shell(
    root: &Path,
    state: &mut Value,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let shell_path = normalize_shell_path(
        root,
        payload
            .get("shell_path")
            .and_then(Value::as_str)
            .unwrap_or("client/runtime/systems/workflow/google_adk_bridge.ts"),
    )?;
    let target = clean_token(payload.get("target").and_then(Value::as_str), "local");
    let record = json!({
        "deployment_id": stable_id("gadkdep", &json!({"shell_path": shell_path, "target": target})),
        "shell_name": clean_token(payload.get("shell_name").and_then(Value::as_str), "google-adk-shell"),
        "shell_path": shell_path,
        "target": target,
        "deletable": true,
        "authority_delegate": "core://google-adk-bridge",
        "artifact_path": clean_text(payload.get("artifact_path").and_then(Value::as_str), 240),
        "deployed_at": now_iso(),
    });
    let deployment_id = record
        .get("deployment_id")
        .and_then(Value::as_str)
        .unwrap()
        .to_string();
    as_object_mut(state, "deployments").insert(deployment_id, record.clone());
    Ok(json!({
        "ok": true,
        "deployment": record,
        "claim_evidence": default_claim_evidence("V6-WORKFLOW-010.8", adk_claim("V6-WORKFLOW-010.8")),
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
            print_json_line(&cli_error("google_adk_bridge_error", &err));
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
            "a2a_agents": as_object_mut(&mut state, "a2a_agents").len(),
            "llm_agents": as_object_mut(&mut state, "llm_agents").len(),
            "tool_manifests": as_object_mut(&mut state, "tool_manifests").len(),
            "hierarchies": as_object_mut(&mut state, "hierarchies").len(),
            "approval_records": as_object_mut(&mut state, "approval_records").len(),
            "session_snapshots": as_object_mut(&mut state, "session_snapshots").len(),
            "evaluations": as_object_mut(&mut state, "evaluations").len(),
            "sandbox_runs": as_object_mut(&mut state, "sandbox_runs").len(),
            "deployments": as_object_mut(&mut state, "deployments").len(),
            "runtime_bridges": as_object_mut(&mut state, "runtime_bridges").len(),
            "last_receipt": state.get("last_receipt").cloned().unwrap_or(Value::Null),
        })),
        "register-a2a-agent" => register_a2a_agent(root, &mut state, input),
        "send-a2a-message" => send_a2a_message(root, argv, &mut state, input),
        "register-runtime-bridge" => register_runtime_bridge(root, &mut state, input),
        "route-model" => route_model(&state, input),
        "run-llm-agent" => run_llm_agent(root, argv, &mut state, input),
        "register-tool-manifest" => register_tool_manifest(root, &mut state, input),
        "invoke-tool-manifest" => invoke_tool_manifest(root, argv, &mut state, input),
        "coordinate-hierarchy" => coordinate_hierarchy(root, argv, &mut state, input),
        "approval-checkpoint" => approval_checkpoint(root, argv, &mut state, input),
        "rewind-session" => rewind_session(root, argv, &mut state, input),
        "record-evaluation" => record_evaluation(root, &mut state, input),
        "sandbox-execute" => sandbox_execute(root, &mut state, input),
        "deploy-shell" => deploy_shell(root, &mut state, input),
        _ => Err(format!("unknown_google_adk_bridge_command:{command}")),
    };

    match result {
        Ok(payload) => {
            let receipt = cli_receipt(
                &format!("google_adk_bridge_{}", command.replace('-', "_")),
                payload,
            );
            state["last_receipt"] = receipt.clone();
            if let Err(err) = save_state(&state_path, &state)
                .and_then(|_| append_history(&history_path, &receipt))
            {
                print_json_line(&cli_error("google_adk_bridge_error", &err));
                return 1;
            }
            print_json_line(&receipt);
            0
        }
        Err(err) => {
            print_json_line(&cli_error("google_adk_bridge_error", &err));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_bridge_route_degrades_polyglot_in_pure_mode() {
        let mut state = default_state();
        let payload = json!({
            "name": "python-gateway",
            "language": "python",
            "provider": "google",
            "bridge_path": "adapters/polyglot/google_adk_runtime_bridge.ts",
            "supported_profiles": ["rich", "pure"]
        });
        let _ = register_runtime_bridge(Path::new("."), &mut state, payload.as_object().unwrap())
            .expect("register");
        let out = route_model(
            &state,
            &Map::from_iter([
                ("language".to_string(), json!("python")),
                ("provider".to_string(), json!("google")),
                ("model".to_string(), json!("gemini-2.0-flash")),
                ("profile".to_string(), json!("pure")),
            ]),
        )
        .expect("route");
        assert_eq!(out["route"]["degraded"].as_bool(), Some(true));
    }
}
