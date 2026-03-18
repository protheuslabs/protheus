// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_STATE_REL: &str = "local/state/ops/camel_bridge/latest.json";
const DEFAULT_HISTORY_REL: &str = "local/state/ops/camel_bridge/history.jsonl";
const DEFAULT_SWARM_STATE_REL: &str = "local/state/ops/camel_bridge/swarm_state.json";
const DEFAULT_OUTPUT_DIR_REL: &str = "client/runtime/local/state/camel-shell";

fn usage() {
    println!("camel-bridge commands:");
    println!("  protheus-ops camel-bridge status [--state-path=<path>]");
    println!("  protheus-ops camel-bridge register-society [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops camel-bridge run-society [--payload-base64=<json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops camel-bridge simulate-world [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops camel-bridge import-dataset [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops camel-bridge route-conversation [--payload-base64=<json>] [--state-path=<path>] [--swarm-state-path=<path>]");
    println!("  protheus-ops camel-bridge record-crab-benchmark [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops camel-bridge register-tool-gateway [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops camel-bridge invoke-tool-gateway [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops camel-bridge record-scaling-observation [--payload-base64=<json>] [--state-path=<path>]");
    println!("  protheus-ops camel-bridge assimilate-intake [--payload-base64=<json>] [--state-path=<path>]");
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
            .map_err(|err| format!("camel_bridge_payload_decode_failed:{err}"));
    }
    if let Some(raw_b64) = lane_utils::parse_flag(argv, "payload-base64", false) {
        let bytes = BASE64_STANDARD
            .decode(raw_b64.as_bytes())
            .map_err(|err| format!("camel_bridge_payload_base64_decode_failed:{err}"))?;
        let text = String::from_utf8(bytes)
            .map_err(|err| format!("camel_bridge_payload_utf8_decode_failed:{err}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|err| format!("camel_bridge_payload_decode_failed:{err}"));
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
        .or_else(|| {
            payload
                .get("swarm_state_path")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .map(|raw| repo_path(root, &raw))
        .unwrap_or_else(|| root.join(DEFAULT_SWARM_STATE_REL))
}

fn default_state() -> Value {
    json!({
        "schema_version": "camel_bridge_state_v1",
        "societies": {},
        "society_runs": {},
        "world_simulations": {},
        "datasets": {},
        "conversation_routes": {},
        "benchmarks": {},
        "tool_gateways": {},
        "tool_invocations": {},
        "scaling_observations": {},
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
        "societies",
        "society_runs",
        "world_simulations",
        "datasets",
        "conversation_routes",
        "benchmarks",
        "tool_gateways",
        "tool_invocations",
        "scaling_observations",
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
        value["schema_version"] = json!("camel_bridge_state_v1");
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

fn clean_profiles(value: Option<&Value>, fallback: &[&str]) -> Vec<String> {
    let mut rows = Vec::new();
    if let Some(array) = value.and_then(Value::as_array) {
        for row in array {
            let token = clean_token(row.as_str(), "");
            if !token.is_empty() && !rows.contains(&token) {
                rows.push(token);
            }
        }
    }
    if rows.is_empty() {
        return fallback.iter().map(|row| row.to_string()).collect();
    }
    rows
}

fn parse_profile(payload: &Map<String, Value>) -> String {
    clean_token(payload.get("profile").and_then(Value::as_str), "rich")
}

fn constrained_profile(profile: &str) -> bool {
    matches!(profile, "pure" | "tiny-max" | "tiny_max")
}

fn safe_bridge_path(path: &str) -> bool {
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

fn safe_output_prefix(path: &str) -> bool {
    path.starts_with("client/runtime/local/state/") || path.starts_with("apps/")
}

fn claim(id: &str, detail: &str) -> Value {
    json!([{
        "id": id,
        "detail": detail,
    }])
}

fn store_receipt(
    state_path: &Path,
    history_path: &Path,
    state: &mut Value,
    receipt: &Value,
) -> Result<(), String> {
    state["last_receipt"] = receipt.clone();
    save_state(state_path, state)?;
    append_history(history_path, receipt)
}

fn status_payload(state: &Value, state_path: &Path, history_path: &Path) -> Value {
    json!({
        "ok": true,
        "schema_version": state.get("schema_version").and_then(Value::as_str).unwrap_or("camel_bridge_state_v1"),
        "societies": state.get("societies").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "society_runs": state.get("society_runs").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "world_simulations": state.get("world_simulations").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "datasets": state.get("datasets").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "conversation_routes": state.get("conversation_routes").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "benchmarks": state.get("benchmarks").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "tool_gateways": state.get("tool_gateways").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "tool_invocations": state.get("tool_invocations").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "scaling_observations": state.get("scaling_observations").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "intakes": state.get("intakes").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "state_path": rel(Path::new("."), state_path),
        "history_path": rel(Path::new("."), history_path),
        "last_receipt_hash": state.get("last_receipt").and_then(|row| row.get("receipt_hash")).and_then(Value::as_str).unwrap_or(""),
    })
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let command = argv
        .first()
        .map(|row| row.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    let payload_value = match payload_json(argv) {
        Ok(value) => value,
        Err(err) => {
            print_json_line(&cli_error("camel_bridge", &err));
            return 1;
        }
    };
    let payload = payload_obj(&payload_value);
    let state_path = state_path(root, argv, payload);
    let history_path = history_path(root, argv, payload);
    let swarm_state_path = swarm_state_path(root, argv, payload);

    if command == "status" {
        let state = load_state(&state_path);
        print_json_line(&cli_receipt(
            "camel_bridge_status",
            status_payload(&state, &state_path, &history_path),
        ));
        return 0;
    }

    let mut state = load_state(&state_path);

    let result = match command.as_str() {
        "register-society" => {
            let name = clean_text(payload.get("name").and_then(Value::as_str), 80);
            if name.is_empty() {
                Err("camel_bridge_society_name_required".to_string())
            } else {
                let roles = payload
                    .get("roles")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                if roles.is_empty() {
                    Err("camel_bridge_roles_required".to_string())
                } else {
                    let society_id =
                        stable_id("camel_society", &json!({"name": name, "roles": roles}));
                    let society = json!({
                        "society_id": society_id,
                        "name": name,
                        "roles": roles,
                        "supported_profiles": clean_profiles(payload.get("supported_profiles"), &["rich", "pure", "tiny-max"]),
                        "created_at": now_iso(),
                        "claim_evidence": claim("V6-WORKFLOW-013.1", "role_playing_society_registry"),
                    });
                    as_object_mut(&mut state, "societies").insert(society_id.clone(), society.clone());
                    Ok(json!({
                        "ok": true,
                        "society": society,
                        "claim_evidence": claim("V6-WORKFLOW-013.1", "role_playing_society_registry"),
                    }))
                }
            }
        }
        "run-society" => {
            let society_id = clean_token(payload.get("society_id").and_then(Value::as_str), "");
            if society_id.is_empty() {
                Err("camel_bridge_society_id_required".to_string())
            } else if let Some(society) = state.get("societies").and_then(|row| row.get(&society_id)).cloned() {
                let profile = parse_profile(payload);
                let roles = society.get("roles").and_then(Value::as_array).cloned().unwrap_or_default();
                let max_roles = if profile == "tiny-max" || profile == "tiny_max" { 1 } else if profile == "pure" { 2 } else { 6 };
                let selected_roles: Vec<Value> = roles.into_iter().take(max_roles).collect();
                let degraded = selected_roles.len() < society.get("roles").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0);
                let run_id = stable_id("camel_run", &json!({"society_id": society_id, "profile": profile, "selected_roles": selected_roles}));
                let sessions: Vec<Value> = selected_roles
                    .iter()
                    .enumerate()
                    .map(|(index, row)| {
                        let label = clean_token(row.get("label").and_then(Value::as_str), &format!("role-{}", index + 1));
                        json!({
                            "session_id": stable_id("camel_session", &json!({"run_id": run_id, "label": label})),
                            "label": label,
                            "role": clean_token(row.get("role").and_then(Value::as_str), "specialist"),
                            "budget": if constrained_profile(&profile) { 192 } else { 512 },
                        })
                    })
                    .collect();
                let run = json!({
                    "run_id": run_id,
                    "society_id": society_id,
                    "profile": profile,
                    "degraded": degraded,
                    "reason_code": if degraded { "society_profile_role_cap" } else { "society_run_ok" },
                    "importance_queue": sessions.iter().enumerate().map(|(index, row)| json!({"label": row["label"], "priority": (sessions.len() - index) as u64})).collect::<Vec<_>>(),
                    "sessions": sessions,
                    "created_at": now_iso(),
                    "claim_evidence": claim("V6-WORKFLOW-013.2", "scalable_multi_agent_society_execution"),
                });
                as_object_mut(&mut state, "society_runs").insert(run_id.clone(), run.clone());
                let swarm_summary = json!({
                    "ok": true,
                    "type": "camel_society_swarm_state",
                    "run": run,
                });
                if let Err(err) = lane_utils::write_json(&swarm_state_path, &swarm_summary) {
                    Err(err)
                } else {
                    Ok(json!({
                        "ok": true,
                        "run": swarm_summary["run"].clone(),
                        "swarm_state_path": rel(root, &swarm_state_path),
                        "claim_evidence": claim("V6-WORKFLOW-013.2", "scalable_multi_agent_society_execution"),
                    }))
                }
            } else {
                Err(format!("camel_bridge_society_not_found:{society_id}"))
            }
        }
        "simulate-world" => {
            let world_name = clean_text(payload.get("world_name").and_then(Value::as_str), 96);
            if world_name.is_empty() {
                Err("camel_bridge_world_name_required".to_string())
            } else {
                let profile = parse_profile(payload);
                let seed_state = payload.get("seed_state").cloned().unwrap_or_else(|| json!({}));
                let events = payload.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
                let max_events = if constrained_profile(&profile) { 2 } else { 8 };
                let truncated: Vec<Value> = events.into_iter().take(max_events).collect();
                let degraded = truncated.len() < payload.get("events").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0);
                let world_id = stable_id("camel_world", &json!({"world_name": world_name, "seed_state": seed_state}));
                let simulation = json!({
                    "world_id": world_id,
                    "world_name": world_name,
                    "profile": profile,
                    "seed_state": seed_state,
                    "events": truncated,
                    "degraded": degraded,
                    "reason_code": if degraded { "world_simulation_profile_event_cap" } else { "world_simulation_ok" },
                    "information_spread": payload.get("agents_informed").cloned().unwrap_or_else(|| json!([])),
                    "created_at": now_iso(),
                    "claim_evidence": claim("V6-WORKFLOW-013.3", "oasis_world_simulation_bridge"),
                });
                as_object_mut(&mut state, "world_simulations").insert(world_id.clone(), simulation.clone());
                Ok(json!({
                    "ok": true,
                    "simulation": simulation,
                    "claim_evidence": claim("V6-WORKFLOW-013.3", "oasis_world_simulation_bridge"),
                }))
            }
        }
        "import-dataset" => {
            let name = clean_text(payload.get("name").and_then(Value::as_str), 96);
            let kind = clean_token(payload.get("dataset_kind").and_then(Value::as_str), "society");
            let allowed = ["society", "domain", "code", "benchmark", "eval"];
            if name.is_empty() {
                Err("camel_bridge_dataset_name_required".to_string())
            } else if !allowed.contains(&kind.as_str()) {
                Err(format!("camel_bridge_unsupported_dataset_kind:{kind}"))
            } else {
                let source_path = clean_text(payload.get("source_path").and_then(Value::as_str), 240);
                if !source_path.is_empty() && !safe_bridge_path(&source_path) {
                    Err(format!("camel_bridge_dataset_source_path_unsafe:{source_path}"))
                } else {
                    let records = payload.get("records").and_then(Value::as_array).cloned().unwrap_or_default();
                    if source_path.is_empty() && records.is_empty() {
                        Err("camel_bridge_dataset_records_or_source_required".to_string())
                    } else {
                        let dataset_id = stable_id("camel_dataset", &json!({"name": name, "kind": kind, "source_path": source_path, "records": records}));
                        let dataset = json!({
                            "dataset_id": dataset_id,
                            "name": name,
                            "dataset_kind": kind,
                            "source_path": source_path,
                            "record_count": records.len(),
                            "provenance_tag": deterministic_receipt_hash(&json!({"dataset_id": dataset_id, "records": records})),
                            "created_at": now_iso(),
                            "claim_evidence": claim("V6-WORKFLOW-013.4", "synthetic_dataset_ingestion"),
                        });
                        as_object_mut(&mut state, "datasets").insert(dataset_id.clone(), dataset.clone());
                        Ok(json!({
                            "ok": true,
                            "dataset": dataset,
                            "claim_evidence": claim("V6-WORKFLOW-013.4", "synthetic_dataset_ingestion"),
                        }))
                    }
                }
            }
        }
        "route-conversation" => {
            let conversation_name = clean_text(payload.get("name").and_then(Value::as_str), 96);
            let code_prompt = clean_text(payload.get("code_prompt").or_else(|| payload.get("prompt")).and_then(Value::as_str), 400);
            if conversation_name.is_empty() || code_prompt.is_empty() {
                Err("camel_bridge_conversation_name_and_code_prompt_required".to_string())
            } else {
                let profile = parse_profile(payload);
                let turns = payload.get("turns").and_then(Value::as_array).cloned().unwrap_or_default();
                let max_turns = if constrained_profile(&profile) { 3 } else { 12 };
                let selected_turns: Vec<Value> = turns.into_iter().take(max_turns).collect();
                let degraded = selected_turns.len() < payload.get("turns").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0);
                let conversation_id = stable_id("camel_conversation", &json!({"name": conversation_name, "prompt": code_prompt}));
                let route = json!({
                    "conversation_id": conversation_id,
                    "name": conversation_name,
                    "profile": profile,
                    "code_prompt": code_prompt,
                    "turns": selected_turns,
                    "degraded": degraded,
                    "reason_code": if degraded { "conversation_profile_turn_cap" } else { "conversation_route_ok" },
                    "language_routes": payload.get("language_routes").cloned().unwrap_or_else(|| json!([])),
                    "session_id": stable_id("camel_session", &json!({"conversation_id": conversation_id})),
                    "created_at": now_iso(),
                    "claim_evidence": claim("V6-WORKFLOW-013.5", "code_as_prompt_stateful_conversation_routing"),
                });
                as_object_mut(&mut state, "conversation_routes").insert(conversation_id.clone(), route.clone());
                let swarm_summary = json!({
                    "ok": true,
                    "type": "camel_conversation_route",
                    "route": route,
                });
                if let Err(err) = lane_utils::write_json(&swarm_state_path, &swarm_summary) {
                    Err(err)
                } else {
                    Ok(json!({
                        "ok": true,
                        "conversation": swarm_summary["route"].clone(),
                        "swarm_state_path": rel(root, &swarm_state_path),
                        "claim_evidence": claim("V6-WORKFLOW-013.5", "code_as_prompt_stateful_conversation_routing"),
                    }))
                }
            }
        }
        "record-crab-benchmark" => {
            let name = clean_text(payload.get("name").and_then(Value::as_str), 96);
            if name.is_empty() {
                Err("camel_bridge_benchmark_name_required".to_string())
            } else {
                let profile = parse_profile(payload);
                let tasks = payload.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default();
                let artifacts = payload.get("artifacts").and_then(Value::as_array).cloned().unwrap_or_default();
                let multimodal = artifacts.iter().filter_map(|row| row.get("media_type").and_then(Value::as_str)).collect::<Vec<_>>();
                let degraded = constrained_profile(&profile) && multimodal.len() > 1;
                let benchmark_id = stable_id("camel_benchmark", &json!({"name": name, "tasks": tasks, "artifacts": artifacts}));
                let benchmark = json!({
                    "benchmark_id": benchmark_id,
                    "name": name,
                    "profile": profile,
                    "task_count": tasks.len(),
                    "artifacts": artifacts,
                    "metrics": payload.get("metrics").cloned().unwrap_or_else(|| json!({})),
                    "degraded": degraded,
                    "reason_code": if degraded { "crab_multimodal_requires_rich_profile" } else { "crab_benchmark_ok" },
                    "created_at": now_iso(),
                    "claim_evidence": claim("V6-WORKFLOW-013.6", "crab_benchmark_and_evaluation_bridge"),
                });
                as_object_mut(&mut state, "benchmarks").insert(benchmark_id.clone(), benchmark.clone());
                Ok(json!({
                    "ok": true,
                    "benchmark": benchmark,
                    "claim_evidence": claim("V6-WORKFLOW-013.6", "crab_benchmark_and_evaluation_bridge"),
                }))
            }
        }
        "register-tool-gateway" => {
            let name = clean_text(payload.get("name").and_then(Value::as_str), 96);
            let bridge_path = clean_text(payload.get("bridge_path").and_then(Value::as_str), 240);
            if name.is_empty() || bridge_path.is_empty() {
                Err("camel_bridge_tool_gateway_name_and_bridge_path_required".to_string())
            } else if !safe_bridge_path(&bridge_path) {
                Err(format!("camel_bridge_tool_gateway_path_unsafe:{bridge_path}"))
            } else {
                let tools = payload.get("tools").and_then(Value::as_array).cloned().unwrap_or_default();
                if tools.is_empty() {
                    Err("camel_bridge_tool_gateway_tools_required".to_string())
                } else {
                    let gateway_id = stable_id("camel_gateway", &json!({"name": name, "bridge_path": bridge_path, "tools": tools}));
                    let gateway = json!({
                        "gateway_id": gateway_id,
                        "name": name,
                        "bridge_path": bridge_path,
                        "tools": tools,
                        "created_at": now_iso(),
                        "claim_evidence": claim("V6-WORKFLOW-013.7", "tool_ecosystem_and_real_world_integration_gateway"),
                    });
                    as_object_mut(&mut state, "tool_gateways").insert(gateway_id.clone(), gateway.clone());
                    Ok(json!({
                        "ok": true,
                        "tool_gateway": gateway,
                        "claim_evidence": claim("V6-WORKFLOW-013.7", "tool_ecosystem_and_real_world_integration_gateway"),
                    }))
                }
            }
        }
        "invoke-tool-gateway" => {
            let gateway_id = clean_token(payload.get("gateway_id").and_then(Value::as_str), "");
            let tool_name = clean_token(payload.get("tool_name").and_then(Value::as_str), "");
            if gateway_id.is_empty() || tool_name.is_empty() {
                Err("camel_bridge_tool_gateway_and_tool_name_required".to_string())
            } else if let Some(gateway) = state.get("tool_gateways").and_then(|row| row.get(&gateway_id)).cloned() {
                let profile = parse_profile(payload);
                let tool = gateway
                    .get("tools")
                    .and_then(Value::as_array)
                    .and_then(|rows| rows.iter().find(|row| clean_token(row.get("name").and_then(Value::as_str), "") == tool_name))
                    .cloned();
                if let Some(tool_row) = tool {
                    let supported_profiles = clean_profiles(tool_row.get("supported_profiles"), &["rich", "pure"]);
                    let requires_approval = parse_bool_value(tool_row.get("requires_approval"), false);
                    let approved = parse_bool_value(payload.get("approved"), false);
                    let allowed_profile = supported_profiles.iter().any(|row| row == &profile);
                    let (status, reason_code) = if !allowed_profile {
                        ("denied", "tool_profile_not_supported")
                    } else if requires_approval && !approved {
                        ("denied", "tool_requires_explicit_approval")
                    } else {
                        ("executed", "tool_invocation_ok")
                    };
                    let invocation_id = stable_id("camel_tool", &json!({"gateway_id": gateway_id, "tool_name": tool_name, "args": payload.get("args")}));
                    let invocation = json!({
                        "invocation_id": invocation_id,
                        "gateway_id": gateway_id,
                        "tool_name": tool_name,
                        "profile": profile,
                        "status": status,
                        "reason_code": reason_code,
                        "fail_closed": status == "denied",
                        "args": payload.get("args").cloned().unwrap_or_else(|| json!({})),
                        "created_at": now_iso(),
                        "claim_evidence": claim("V6-WORKFLOW-013.7", "tool_ecosystem_and_real_world_integration_gateway"),
                    });
                    as_object_mut(&mut state, "tool_invocations").insert(invocation_id.clone(), invocation.clone());
                    Ok(json!({
                        "ok": true,
                        "invocation": invocation,
                        "claim_evidence": claim("V6-WORKFLOW-013.7", "tool_ecosystem_and_real_world_integration_gateway"),
                    }))
                } else {
                    Err(format!("camel_bridge_tool_not_found:{tool_name}"))
                }
            } else {
                Err(format!("camel_bridge_tool_gateway_not_found:{gateway_id}"))
            }
        }
        "record-scaling-observation" => {
            let society_id = clean_token(payload.get("society_id").and_then(Value::as_str), "unknown-society");
            let observation_id = stable_id("camel_observation", &json!({"society_id": society_id, "metrics": payload.get("metrics")}));
            let agent_count = parse_u64_value(payload.get("agent_count"), 1, 1, 10000);
            let message_count = parse_u64_value(payload.get("message_count"), 0, 0, 1000000);
            let coherence = parse_f64_value(payload.get("coherence"), 0.5, 0.0, 1.0);
            let emergent_risk = if agent_count > 100 || coherence < 0.4 { "elevated" } else { "stable" };
            let observation = json!({
                "observation_id": observation_id,
                "society_id": society_id,
                "agent_count": agent_count,
                "message_count": message_count,
                "coherence": coherence,
                "risk_signals": payload.get("risk_signals").cloned().unwrap_or_else(|| json!([])),
                "metrics": payload.get("metrics").cloned().unwrap_or_else(|| json!({})),
                "emergent_risk": emergent_risk,
                "created_at": now_iso(),
                "claim_evidence": claim("V6-WORKFLOW-013.8", "emergent_scaling_law_observability"),
            });
            as_object_mut(&mut state, "scaling_observations").insert(observation_id.clone(), observation.clone());
            Ok(json!({
                "ok": true,
                "observation": observation,
                "claim_evidence": claim("V6-WORKFLOW-013.8", "emergent_scaling_law_observability"),
            }))
        }
        "assimilate-intake" => {
            let package_name = clean_token(payload.get("package_name").and_then(Value::as_str), "camel-shell");
            let output_dir_raw = payload
                .get("output_dir")
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("{DEFAULT_OUTPUT_DIR_REL}-{}", package_name));
            if !safe_output_prefix(&output_dir_raw) {
                Err(format!("camel_bridge_output_dir_unsafe:{output_dir_raw}"))
            } else {
                let output_dir = repo_path(root, &output_dir_raw);
                if let Err(err) = fs::create_dir_all(&output_dir) {
                    Err(format!("camel_bridge_output_dir_create_failed:{err}"))
                } else {
                let package_json = json!({
                    "name": package_name,
                    "private": true,
                    "authority_delegate": "core://camel-bridge",
                    "bridge": "client/runtime/systems/workflow/camel_bridge.ts"
                });
                if let Err(err) = lane_utils::write_json(&output_dir.join("package.json"), &package_json) {
                    Err(err)
                } else if let Err(err) = fs::write(
                    output_dir.join("README.md"),
                    "# CAMEL Shell\n\nThis shell delegates all authority to `core://camel-bridge`.\n",
                ) {
                    Err(format!("camel_bridge_shell_readme_write_failed:{err}"))
                } else {
                let intake_id = stable_id("camel_intake", &json!({"package_name": package_name, "output_dir": output_dir_raw}));
                let intake = json!({
                    "intake_id": intake_id,
                    "package_name": package_name,
                    "output_dir": output_dir_raw,
                    "authority_delegate": "core://camel-bridge",
                    "created_at": now_iso(),
                    "claim_evidence": claim("V6-WORKFLOW-013.7", "tool_ecosystem_and_real_world_integration_gateway"),
                });
                as_object_mut(&mut state, "intakes").insert(intake_id.clone(), intake.clone());
                Ok(json!({
                    "ok": true,
                    "intake": intake,
                    "claim_evidence": claim("V6-WORKFLOW-013.7", "tool_ecosystem_and_real_world_integration_gateway"),
                }))
                }
                }
            }
        }
        _ => Err(format!("camel_bridge_unknown_command:{command}")),
    };

    match result {
        Ok(payload) => {
            let receipt = cli_receipt(&format!("camel_bridge_{command}"), payload);
            if let Err(err) = store_receipt(&state_path, &history_path, &mut state, &receipt) {
                print_json_line(&cli_error(&format!("camel_bridge_{command}"), &err));
                return 1;
            }
            print_json_line(&receipt);
            0
        }
        Err(err) => emit_error(&mut state, &state_path, &history_path, &format!("camel_bridge_{command}"), &err),
    }
}

fn emit_error(
    _state: &mut Value,
    _state_path: &Path,
    _history_path: &Path,
    kind: &str,
    err: &str,
) -> i32 {
    print_json_line(&cli_error(kind, err));
    1
}
