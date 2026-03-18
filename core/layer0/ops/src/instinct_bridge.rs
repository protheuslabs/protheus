// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use crate::contract_lane_utils::{
    self as lane_utils, clean_text, clean_token, cli_error, cli_receipt, json_bool as parse_bool,
    json_u64 as parse_u64, path_flag, payload_obj, print_json_line, string_set,
};
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_STATE_REL: &str = "local/state/ops/instinct_bridge/latest.json";
const DEFAULT_HISTORY_REL: &str = "local/state/ops/instinct_bridge/history.jsonl";
const DEFAULT_LINEAGE_REL: &str = "local/state/ops/instinct_bridge/lineage.jsonl";

fn usage() {
    println!("instinct-bridge commands:");
    println!("  protheus-ops instinct-bridge status [--state-path=<path>]");
    println!("  protheus-ops instinct-bridge cold-start-model [--payload-base64=<json>] [--state-path=<path>] [--history-path=<path>]");
    println!("  protheus-ops instinct-bridge activate [--payload-base64=<json>] [--state-path=<path>] [--history-path=<path>]");
    println!("  protheus-ops instinct-bridge refine [--payload-base64=<json>] [--state-path=<path>] [--history-path=<path>] [--lineage-path=<path>]");
}

fn payload_json(argv: &[String]) -> Result<Value, String> {
    lane_utils::payload_json(argv, "instinct_bridge")
}

fn state_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    path_flag(root, argv, payload, "state-path", "state_path", DEFAULT_STATE_REL)
}

fn history_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    path_flag(root, argv, payload, "history-path", "history_path", DEFAULT_HISTORY_REL)
}

fn lineage_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    path_flag(root, argv, payload, "lineage-path", "lineage_path", DEFAULT_LINEAGE_REL)
}

fn default_state() -> Value {
    json!({
        "schema_version": "instinct_bridge_state_v1",
        "self_model": {},
        "models": {},
        "activations": {},
        "refinements": {},
        "last_receipt": null,
    })
}

fn ensure_state_shape(value: &mut Value) {
    if !value.is_object() {
        *value = default_state();
        return;
    }
    for key in ["models", "activations", "refinements"] {
        if !value.get(key).map(Value::is_object).unwrap_or(false) {
            value[key] = json!({});
        }
    }
    if !value.get("self_model").map(Value::is_object).unwrap_or(false) {
        value["self_model"] = json!({});
    }
    if value.get("schema_version").and_then(Value::as_str).is_none() {
        value["schema_version"] = json!("instinct_bridge_state_v1");
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

fn preferred_profiles(memory_mb: u64, cpu_cores: u64, battery_pct: u64, platform: &str) -> Vec<String> {
    let mut profiles = BTreeSet::new();
    profiles.insert("tiny-max".to_string());
    profiles.insert("pure".to_string());
    if memory_mb >= 4096 && cpu_cores >= 4 && battery_pct > 20 && platform != "legacy-phone" {
        profiles.insert("rich".to_string());
    }
    profiles.into_iter().collect()
}

fn strongest_profile(memory_mb: u64, cpu_cores: u64, battery_pct: u64, platform: &str) -> String {
    if battery_pct <= 15 || memory_mb < 1536 || cpu_cores <= 2 || platform == "legacy-phone" {
        "tiny-max".to_string()
    } else if memory_mb < 4096 || cpu_cores < 4 || battery_pct <= 35 {
        "pure".to_string()
    } else {
        "rich".to_string()
    }
}

fn cold_start_model(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let tools = string_set(payload.get("tools"));
    let skills = string_set(payload.get("skills"));
    let adapters = string_set(payload.get("adapters"));
    let modes = string_set(payload.get("modes"));
    let memory_lanes = string_set(payload.get("memory_lanes"));
    let platform = clean_token(payload.get("platform").and_then(Value::as_str), "desktop");
    let memory_mb = parse_u64(payload.get("memory_mb"), 8192, 128, 262_144);
    let cpu_cores = parse_u64(payload.get("cpu_cores"), 4, 1, 128);
    let battery_pct = parse_u64(payload.get("battery_pct"), 100, 0, 100);
    let supported_profiles = {
        let explicit = string_set(payload.get("supported_profiles"));
        if explicit.is_empty() {
            preferred_profiles(memory_mb, cpu_cores, battery_pct, &platform)
        } else {
            explicit
        }
    };
    let dominant_profile = strongest_profile(memory_mb, cpu_cores, battery_pct, &platform);
    let model = json!({
        "model_id": stable_id("instinctmodel", &json!({
            "tools": tools,
            "skills": skills,
            "adapters": adapters,
            "modes": modes,
            "memory_lanes": memory_lanes,
            "platform": platform,
            "memory_mb": memory_mb,
            "cpu_cores": cpu_cores,
            "battery_pct": battery_pct,
        })),
        "recorded_at": now_iso(),
        "platform": platform,
        "memory_mb": memory_mb,
        "cpu_cores": cpu_cores,
        "battery_pct": battery_pct,
        "tools": tools,
        "skills": skills,
        "adapters": adapters,
        "modes": modes,
        "memory_lanes": memory_lanes,
        "supported_profiles": supported_profiles,
        "strongest_profile": dominant_profile,
        "confidence": {
            "activation": 0.7,
            "memory": if memory_lanes.is_empty() { 0.2 } else { 0.8 },
            "swarm": if modes.iter().any(|row| row == "swarm") { 0.8 } else { 0.3 },
            "provenance": if adapters.iter().any(|row| row.contains("provenance")) { 0.8 } else { 0.4 },
        },
        "scheduler_authority": "existing_profile_selection",
    });
    let model_id = model["model_id"].as_str().unwrap().to_string();
    state["self_model"] = model.clone();
    as_object_mut(state, "models").insert(model_id, model.clone());
    Ok(json!({
        "ok": true,
        "self_model": model,
        "claim_evidence": [{
            "id": "V10-ULTIMATE-002.1",
            "claim": "ultra_instinct_capability_self_model_is_authoritative_and_receipted"
        }]
    }))
}

fn activate(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let self_model = state.get("self_model").cloned().unwrap_or_else(|| json!({}));
    if !self_model.is_object() || self_model.as_object().map(|m| m.is_empty()).unwrap_or(true) {
        return Err("instinct_bridge_self_model_missing".to_string());
    }
    let supported_profiles = string_set(self_model.get("supported_profiles"));
    let modes = string_set(self_model.get("modes"));
    let adapters = string_set(self_model.get("adapters"));
    let memory_lanes = string_set(self_model.get("memory_lanes"));
    let requested = string_set(payload.get("requested_capabilities"));
    let boot_reason = clean_token(payload.get("event").and_then(Value::as_str), "cold_start");
    let fallback_battery_pct = self_model
        .get("battery_pct")
        .and_then(Value::as_u64)
        .unwrap_or(100);
    let battery_pct = parse_u64(payload.get("battery_pct"), fallback_battery_pct, 0, 100);
    let low_power = parse_bool(payload.get("low_power"), battery_pct <= 25);
    let network_available = parse_bool(payload.get("network_available"), true);
    let want_swarm = requested.iter().any(|row| row == "swarm") || parse_bool(payload.get("want_swarm"), true);
    let want_provenance = requested.iter().any(|row| row == "provenance") || parse_bool(payload.get("want_provenance"), true);
    let want_memory = requested.iter().any(|row| row == "memory") || parse_bool(payload.get("want_memory"), true);

    let selected_profile = if low_power || battery_pct <= 15 {
        "tiny-max".to_string()
    } else if supported_profiles.iter().any(|row| row == "rich") && network_available {
        "rich".to_string()
    } else if supported_profiles.iter().any(|row| row == "pure") {
        "pure".to_string()
    } else {
        supported_profiles.first().cloned().unwrap_or_else(|| "pure".to_string())
    };

    let mut activated = vec![format!("profile:{selected_profile}")];
    let mut rejected = Vec::new();
    if want_memory {
        if memory_lanes.is_empty() {
            rejected.push(json!({"capability": "memory", "reason_code": "memory_lane_missing"}));
        } else {
            activated.push("memory".to_string());
        }
    }
    if want_provenance {
        if adapters.iter().any(|row| row.contains("provenance") || row.contains("receipt")) {
            activated.push("provenance".to_string());
        } else {
            rejected.push(json!({"capability": "provenance", "reason_code": "provenance_adapter_missing"}));
        }
    }
    if want_swarm {
        if !modes.iter().any(|row| row == "swarm") {
            rejected.push(json!({"capability": "swarm", "reason_code": "swarm_mode_missing"}));
        } else if selected_profile == "tiny-max" {
            rejected.push(json!({"capability": "swarm", "reason_code": "profile_budget_too_low"}));
        } else {
            activated.push("swarm".to_string());
        }
    }
    activated.sort();
    activated.dedup();

    let activation = json!({
        "activation_id": stable_id("instinctact", &json!({"boot_reason": boot_reason, "profile": selected_profile, "activated": activated})),
        "boot_reason": boot_reason,
        "selected_profile": selected_profile,
        "activated_capabilities": activated,
        "rejected_capabilities": rejected,
        "low_power": low_power,
        "network_available": network_available,
        "scheduler_authority": "existing_profile_selection",
        "recorded_at": now_iso(),
    });
    let activation_id = activation["activation_id"].as_str().unwrap().to_string();
    as_object_mut(state, "activations").insert(activation_id, activation.clone());
    Ok(json!({
        "ok": true,
        "activation": activation,
        "claim_evidence": [{
            "id": "V10-ULTIMATE-002.2",
            "claim": "ultra_instinct_activates_best_valid_profile_with_fail_closed_rejections"
        }]
    }))
}

fn f64_from_value(value: &Value) -> Option<f64> {
    value.as_f64().or_else(|| value.as_i64().map(|v| v as f64)).or_else(|| value.as_u64().map(|v| v as f64))
}

fn refine(state: &mut Value, lineage_path: &Path, payload: &Map<String, Value>) -> Result<Value, String> {
    let mut self_model = state.get("self_model").cloned().unwrap_or_else(|| json!({}));
    if !self_model.is_object() || self_model.as_object().map(|m| m.is_empty()).unwrap_or(true) {
        return Err("instinct_bridge_self_model_missing".to_string());
    }
    let evidence = payload
        .get("evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if evidence.is_empty() {
        return Err("instinct_bridge_refine_requires_evidence".to_string());
    }

    let mut confidence_map: BTreeMap<String, f64> = BTreeMap::new();
    if let Some(existing) = self_model.get("confidence").and_then(Value::as_object) {
        for (key, value) in existing {
            confidence_map.insert(key.clone(), f64_from_value(value).unwrap_or(0.5));
        }
    }

    let mut blob_refs = BTreeSet::new();
    let mut updates = Vec::new();
    for row in &evidence {
        if let Some(blob_ref) = row.get("blob_ref").and_then(Value::as_str) {
            let clean = clean_text(Some(blob_ref), 260);
            if !clean.is_empty() {
                blob_refs.insert(clean);
            }
        }
        let key = clean_token(
            row.get("dimension")
                .and_then(Value::as_str)
                .or_else(|| row.get("profile").and_then(Value::as_str))
                .or_else(|| row.get("capability").and_then(Value::as_str)),
            "general",
        );
        let success = parse_bool(row.get("success"), true);
        let latency_ms = parse_u64(row.get("latency_ms"), 0, 0, 60_000);
        let base = confidence_map.get(&key).copied().unwrap_or(0.5);
        let latency_delta = if latency_ms > 0 && latency_ms > 1200 { -0.03 } else if latency_ms > 0 && latency_ms < 300 { 0.02 } else { 0.0 };
        let delta = if success { 0.05 } else { -0.08 } + latency_delta;
        let updated = (base + delta).clamp(0.0, 1.0);
        confidence_map.insert(key.clone(), updated);
        updates.push(json!({
            "dimension": key,
            "delta": delta,
            "updated_confidence": updated,
        }));
    }

    let parent_model_id = self_model
        .get("model_id")
        .and_then(Value::as_str)
        .unwrap_or("instinctmodel_root")
        .to_string();

    let confidence_json = Value::Object(
        confidence_map
            .iter()
            .map(|(key, value)| (key.clone(), json!((value * 1000.0).round() / 1000.0)))
            .collect::<Map<String, Value>>(),
    );
    self_model["confidence"] = confidence_json;
    self_model["updated_at"] = json!(now_iso());
    let child_model_id = stable_id(
        "instinctmodel",
        &json!({
            "parent": parent_model_id,
            "confidence": self_model.get("confidence"),
            "blob_refs": blob_refs,
        }),
    );
    self_model["parent_model_id"] = json!(parent_model_id.clone());
    self_model["model_id"] = json!(child_model_id.clone());
    self_model["lineage_head"] = json!(child_model_id.clone());

    as_object_mut(state, "models").insert(child_model_id.clone(), self_model.clone());
    state["self_model"] = self_model.clone();
    let refinement = json!({
        "refinement_id": stable_id("instinctrefine", &json!({"parent": parent_model_id, "child": child_model_id})),
        "parent_model_id": parent_model_id,
        "child_model_id": child_model_id,
        "blob_refs": blob_refs.into_iter().collect::<Vec<_>>(),
        "updates": updates,
        "recorded_at": now_iso(),
        "rollbackable": true,
    });
    let refinement_id = refinement["refinement_id"].as_str().unwrap().to_string();
    as_object_mut(state, "refinements").insert(refinement_id, refinement.clone());
    append_history(lineage_path, &refinement)?;
    Ok(json!({
        "ok": true,
        "self_model": self_model,
        "refinement": refinement,
        "claim_evidence": [{
            "id": "V10-ULTIMATE-002.3",
            "claim": "ultra_instinct_refines_capability_confidence_from_usage_and_blob_lineage"
        }]
    }))
}

fn status(state: &Value) -> Value {
    json!({
        "ok": true,
        "self_model_id": state.get("self_model").and_then(|row| row.get("model_id")).cloned().unwrap_or(Value::Null),
        "supported_profiles": state.get("self_model").and_then(|row| row.get("supported_profiles")).cloned().unwrap_or_else(|| json!([])),
        "activations": state.get("activations").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
        "refinements": state.get("refinements").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
        "models": state.get("models").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
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

    let payload_json = match payload_json(argv) {
        Ok(value) => value,
        Err(err) => {
            print_json_line(&cli_error("instinct_bridge_error", &err));
            return 1;
        }
    };
    let payload = payload_obj(&payload_json);
    let state_path = state_path(root, argv, payload);
    let history_path = history_path(root, argv, payload);
    let lineage_path = lineage_path(root, argv, payload);
    let mut state = load_state(&state_path);

    let result = match command.as_str() {
        "status" => Ok(status(&state)),
        "cold-start-model" => cold_start_model(&mut state, payload),
        "activate" => activate(&mut state, payload),
        "refine" => refine(&mut state, &lineage_path, payload),
        _ => Err("instinct_bridge_unknown_command".to_string()),
    };

    match result {
        Ok(payload_out) => {
            let receipt = cli_receipt(&format!("instinct_bridge_{command}"), payload_out);
            state["last_receipt"] = receipt.clone();
            state["updated_at"] = json!(now_iso());
            if let Err(err) = save_state(&state_path, &state) {
                print_json_line(&cli_error("instinct_bridge_error", &err));
                return 1;
            }
            if let Err(err) = append_history(&history_path, &receipt) {
                print_json_line(&cli_error("instinct_bridge_error", &err));
                return 1;
            }
            print_json_line(&receipt);
            0
        }
        Err(err) => {
            print_json_line(&cli_error("instinct_bridge_error", &err));
            1
        }
    }
}
