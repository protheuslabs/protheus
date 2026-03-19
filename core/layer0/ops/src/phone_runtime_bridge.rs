// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

use crate::contract_lane_utils::{
    self as lane_utils, clean_text, clean_token, cli_error, cli_receipt, json_bool as parse_bool,
    json_u64 as parse_u64, path_flag, payload_obj, print_json_line, string_set,
};
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_STATE_REL: &str = "local/state/ops/phone_runtime_bridge/latest.json";
const DEFAULT_HISTORY_REL: &str = "local/state/ops/phone_runtime_bridge/history.jsonl";
const DEFAULT_BACKGROUND_REL: &str = "client/runtime/local/state/phone_background_state.json";
const DEFAULT_SENSOR_REL: &str = "client/runtime/local/state/phone_sensor_state.json";

fn usage() {
    println!("phone-runtime-bridge commands:");
    println!("  protheus-ops phone-runtime-bridge status [--state-path=<path>]");
    println!("  protheus-ops phone-runtime-bridge battery-schedule [--payload-base64=<json>] [--state-path=<path>] [--history-path=<path>]");
    println!("  protheus-ops phone-runtime-bridge sensor-intake [--payload-base64=<json>] [--state-path=<path>] [--history-path=<path>] [--sensor-state-path=<path>]");
    println!("  protheus-ops phone-runtime-bridge interaction-mode [--payload-base64=<json>] [--state-path=<path>] [--history-path=<path>]");
    println!("  protheus-ops phone-runtime-bridge background-daemon [--payload-base64=<json>] [--state-path=<path>] [--history-path=<path>] [--background-state-path=<path>]");
    println!("  protheus-ops phone-runtime-bridge phone-profile [--payload-base64=<json>] [--state-path=<path>] [--history-path=<path>]");
}

fn payload_json(argv: &[String]) -> Result<Value, String> {
    lane_utils::payload_json(argv, "phone_runtime_bridge")
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

fn background_state_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    path_flag(
        root,
        argv,
        payload,
        "background-state-path",
        "background_state_path",
        DEFAULT_BACKGROUND_REL,
    )
}

fn sensor_state_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    path_flag(
        root,
        argv,
        payload,
        "sensor-state-path",
        "sensor_state_path",
        DEFAULT_SENSOR_REL,
    )
}

fn default_state() -> Value {
    json!({
        "schema_version": "phone_runtime_bridge_state_v1",
        "battery_events": {},
        "sensor_events": {},
        "interaction_modes": {},
        "background_events": {},
        "profiles": {},
        "background_state": {
            "mode": "idle",
            "handoff": "edge",
            "drain_budget_pct_24h": 4.0,
        },
        "last_receipt": null,
    })
}

fn ensure_state_shape(value: &mut Value) {
    if !value.is_object() {
        *value = default_state();
        return;
    }
    for key in [
        "battery_events",
        "sensor_events",
        "interaction_modes",
        "background_events",
        "profiles",
    ] {
        if !value.get(key).map(Value::is_object).unwrap_or(false) {
            value[key] = json!({});
        }
    }
    if !value
        .get("background_state")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        value["background_state"] =
            json!({"mode": "idle", "handoff": "edge", "drain_budget_pct_24h": 4.0});
    }
    if value
        .get("schema_version")
        .and_then(Value::as_str)
        .is_none()
    {
        value["schema_version"] = json!("phone_runtime_bridge_state_v1");
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

fn battery_schedule(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let battery_pct = parse_u64(payload.get("battery_pct"), 100, 0, 100);
    let charging = parse_bool(payload.get("charging"), false);
    let thermal_c = parse_u64(payload.get("thermal_c"), 26, 0, 120);
    let mut critical_tasks = string_set(payload.get("critical_tasks"));
    if critical_tasks.is_empty() {
        critical_tasks = vec!["notifications".to_string()];
    }
    let (mode, profile, reason_code, throughput_pct) = if !charging && battery_pct <= 10 {
        ("pause_noncritical", "tiny-max", "battery_critical", 10)
    } else if battery_pct <= 25 || thermal_c >= 42 {
        ("reduced", "pure", "battery_low_or_thermal_high", 45)
    } else {
        ("normal", "rich", "battery_nominal", 100)
    };
    let paused_noncritical = mode == "pause_noncritical";
    let record = json!({
        "event_id": stable_id("phonebattery", &json!({"battery_pct": battery_pct, "thermal_c": thermal_c, "mode": mode})),
        "battery_pct": battery_pct,
        "charging": charging,
        "thermal_c": thermal_c,
        "mode": mode,
        "selected_profile": profile,
        "throughput_pct": throughput_pct,
        "paused_noncritical": paused_noncritical,
        "critical_tasks": critical_tasks,
        "reason_code": reason_code,
        "scheduler_authority": "existing_profile_selection",
        "recorded_at": now_iso(),
    });
    let event_id = record["event_id"].as_str().unwrap().to_string();
    as_object_mut(state, "battery_events").insert(event_id, record.clone());
    Ok(json!({
        "ok": true,
        "battery_event": record,
        "claim_evidence": [{
            "id": "V10-PHONE-001.1",
            "claim": "phone_battery_scheduler_switches_profiles_and_pauses_noncritical_work_receipted"
        }]
    }))
}

fn sensor_intake(
    state: &mut Value,
    sensor_state_path: &Path,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let requested = payload
        .get("requested_sensors")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if requested.is_empty() {
        return Err("phone_runtime_bridge_requested_sensors_required".to_string());
    }
    let allowed = string_set(payload.get("allowed_sensors"));
    let mut accepted = Vec::new();
    let mut degraded = Vec::new();
    for sensor in requested {
        let name = clean_token(sensor.get("name").and_then(Value::as_str), "sensor");
        let available = parse_bool(sensor.get("available"), false);
        let consent = parse_bool(sensor.get("consent"), false);
        let allowed_here = allowed.is_empty() || allowed.iter().any(|row| row == &name);
        if available && consent && allowed_here {
            accepted.push(json!({"name": name, "mode": "governed_ingest"}));
        } else {
            let reason_code = if !available {
                "sensor_unavailable"
            } else if !consent {
                "sensor_consent_missing"
            } else {
                "sensor_policy_denied"
            };
            degraded.push(json!({"name": name, "reason_code": reason_code}));
        }
    }
    let record = json!({
        "event_id": stable_id("phonesensor", &json!({"accepted": accepted, "degraded": degraded})),
        "accepted": accepted,
        "degraded": degraded,
        "recorded_at": now_iso(),
        "policy_authority": "sensory_and_eyes",
    });
    if let Some(parent) = sensor_state_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("phone_runtime_bridge_sensor_dir_create_failed:{err}"))?;
    }
    lane_utils::write_json(sensor_state_path, &record)?;
    let event_id = record["event_id"].as_str().unwrap().to_string();
    as_object_mut(state, "sensor_events").insert(event_id, record.clone());
    Ok(json!({
        "ok": true,
        "sensor_event": record,
        "sensor_state_path": sensor_state_path.display().to_string(),
        "claim_evidence": [{
            "id": "V10-PHONE-001.2",
            "claim": "phone_sensor_ingest_is_policy_gated_receipted_and_explicitly_degraded"
        }]
    }))
}

fn interaction_mode(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let modality = clean_token(payload.get("modality").and_then(Value::as_str), "text");
    let target_latency_ms = parse_u64(payload.get("target_latency_ms"), 200, 50, 10_000);
    let local_model_available = parse_bool(payload.get("local_model_available"), false);
    let notification_lane = clean_token(
        payload.get("notification_lane").and_then(Value::as_str),
        "notify",
    );
    let (transport, degraded, reason_code) = if modality == "voice" && !local_model_available {
        ("text-fallback", true, "voice_local_model_unavailable")
    } else if modality == "voice" && target_latency_ms > 350 {
        ("half-duplex-voice", true, "latency_target_relaxed")
    } else {
        (modality.as_str(), false, "interaction_ok")
    };
    let record = json!({
        "event_id": stable_id("phoneinteraction", &json!({"modality": modality, "transport": transport, "latency": target_latency_ms})),
        "modality": modality,
        "transport": transport,
        "target_latency_ms": target_latency_ms,
        "degraded": degraded,
        "reason_code": reason_code,
        "notification_lane": notification_lane,
        "recorded_at": now_iso(),
    });
    let event_id = record["event_id"].as_str().unwrap().to_string();
    as_object_mut(state, "interaction_modes").insert(event_id, record.clone());
    Ok(json!({
        "ok": true,
        "interaction_mode": record,
        "claim_evidence": [{
            "id": "V10-PHONE-001.3",
            "claim": "phone_voice_and_text_interaction_modes_are_receipted_and_low_latency_bounded"
        }]
    }))
}

fn background_daemon(
    state: &mut Value,
    background_state_path: &Path,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let action = clean_token(payload.get("action").and_then(Value::as_str), "status");
    let platform = clean_token(payload.get("platform").and_then(Value::as_str), "android");
    let handoff = clean_token(payload.get("handoff").and_then(Value::as_str), "edge");
    let drain_budget_pct_24h = parse_u64(payload.get("drain_budget_pct_24h"), 4, 1, 20) as f64;
    let wake_reason = clean_text(payload.get("wake_reason").and_then(Value::as_str), 120);
    let current = state
        .get("background_state")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let mode = match action.as_str() {
        "wake" => {
            if drain_budget_pct_24h > 5.0 {
                "reduced"
            } else {
                "wake"
            }
        }
        "pause" => "pause",
        "idle" => "idle",
        _ => current
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("idle"),
    };
    let record = json!({
        "event_id": stable_id("phonebg", &json!({"action": action, "platform": platform, "mode": mode})),
        "action": action,
        "platform": platform,
        "handoff": handoff,
        "mode": mode,
        "wake_reason": wake_reason,
        "drain_budget_pct_24h": drain_budget_pct_24h,
        "recorded_at": now_iso(),
        "platform_bridge_owned": true,
    });
    state["background_state"] = record.clone();
    if let Some(parent) = background_state_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("phone_runtime_bridge_background_dir_create_failed:{err}"))?;
    }
    lane_utils::write_json(background_state_path, &record)?;
    let event_id = record["event_id"].as_str().unwrap().to_string();
    as_object_mut(state, "background_events").insert(event_id, record.clone());
    Ok(json!({
        "ok": true,
        "background_event": record,
        "background_state_path": background_state_path.display().to_string(),
        "claim_evidence": [{
            "id": "V10-PHONE-001.4",
            "claim": "phone_background_daemon_transitions_are_receipted_and_low_drain_bounded"
        }]
    }))
}

fn phone_profile(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let platform = clean_token(payload.get("platform").and_then(Value::as_str), "android");
    let device_class = clean_token(payload.get("device_class").and_then(Value::as_str), "phone");
    let memory_mb = parse_u64(payload.get("memory_mb"), 3072, 256, 65_536);
    let cpu_cores = parse_u64(payload.get("cpu_cores"), 4, 1, 64);
    let battery_pct = parse_u64(payload.get("battery_pct"), 100, 0, 100);
    let selected_profile = if memory_mb < 1536
        || cpu_cores <= 2
        || battery_pct <= 15
        || device_class == "legacy-phone"
    {
        "tiny-max"
    } else if memory_mb < 4096 || cpu_cores < 4 || battery_pct <= 35 {
        "pure"
    } else {
        "rich"
    };
    let shed_capabilities = match selected_profile {
        "tiny-max" => vec![
            "vision",
            "swarm_parallelism",
            "background_audio",
            "high_freq_tracing",
        ],
        "pure" => vec!["vision", "swarm_parallelism"],
        _ => Vec::new(),
    };
    let record = json!({
        "profile_id": stable_id("phoneprofile", &json!({"platform": platform, "memory_mb": memory_mb, "cpu_cores": cpu_cores, "battery_pct": battery_pct})),
        "platform": platform,
        "device_class": device_class,
        "memory_mb": memory_mb,
        "cpu_cores": cpu_cores,
        "battery_pct": battery_pct,
        "selected_profile": selected_profile,
        "shed_capabilities": shed_capabilities,
        "recorded_at": now_iso(),
        "policy_bounded": true,
    });
    let profile_id = record["profile_id"].as_str().unwrap().to_string();
    as_object_mut(state, "profiles").insert(profile_id, record.clone());
    Ok(json!({
        "ok": true,
        "phone_profile": record,
        "claim_evidence": [{
            "id": "V10-PHONE-001.5",
            "claim": "phone_hardware_profile_selects_deterministic_pure_or_tiny_max_modes"
        }]
    }))
}

fn status(state: &Value) -> Value {
    json!({
        "ok": true,
        "battery_events": state.get("battery_events").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
        "sensor_events": state.get("sensor_events").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
        "interaction_modes": state.get("interaction_modes").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
        "background_events": state.get("background_events").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
        "profiles": state.get("profiles").and_then(Value::as_object).map(|row| row.len()).unwrap_or(0),
        "background_state": state.get("background_state").cloned().unwrap_or_else(|| json!({})),
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
            print_json_line(&cli_error("phone_runtime_bridge_error", &err));
            return 1;
        }
    };
    let payload = payload_obj(&payload_json);
    let state_path = state_path(root, argv, payload);
    let history_path = history_path(root, argv, payload);
    let background_state_path = background_state_path(root, argv, payload);
    let sensor_state_path = sensor_state_path(root, argv, payload);
    let mut state = load_state(&state_path);

    let result = match command.as_str() {
        "status" => Ok(status(&state)),
        "battery-schedule" => battery_schedule(&mut state, payload),
        "sensor-intake" => sensor_intake(&mut state, &sensor_state_path, payload),
        "interaction-mode" => interaction_mode(&mut state, payload),
        "background-daemon" => background_daemon(&mut state, &background_state_path, payload),
        "phone-profile" => phone_profile(&mut state, payload),
        _ => Err("phone_runtime_bridge_unknown_command".to_string()),
    };

    match result {
        Ok(payload_out) => {
            let receipt = cli_receipt(&format!("phone_runtime_bridge_{command}"), payload_out);
            state["last_receipt"] = receipt.clone();
            state["updated_at"] = json!(now_iso());
            if let Err(err) = save_state(&state_path, &state) {
                print_json_line(&cli_error("phone_runtime_bridge_error", &err));
                return 1;
            }
            if let Err(err) = append_history(&history_path, &receipt) {
                print_json_line(&cli_error("phone_runtime_bridge_error", &err));
                return 1;
            }
            print_json_line(&receipt);
            0
        }
        Err(err) => {
            print_json_line(&cli_error("phone_runtime_bridge_error", &err));
            1
        }
    }
}
