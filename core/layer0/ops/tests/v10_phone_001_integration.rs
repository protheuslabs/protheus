// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V10-PHONE-001.1, V10-PHONE-001.2, V10-PHONE-001.3,
// V10-PHONE-001.4, V10-PHONE-001.5

use protheus_ops_core::phone_runtime_bridge;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_bridge(root: &Path, args: &[String]) -> i32 {
    phone_runtime_bridge::run(root, args)
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).expect("read json")).expect("parse json")
}

fn latest_receipt(state_path: &Path) -> Value {
    read_json(state_path)
        .get("last_receipt")
        .cloned()
        .expect("last receipt")
}

#[test]
fn phone_001_runtime_bridge_schedules_sensors_interaction_background_and_profiles() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/phone/latest.json");
    let history_path = root.path().join("state/phone/history.jsonl");
    let background_state_path = root.path().join("state/phone/background.json");
    let sensor_state_path = root.path().join("state/phone/sensors.json");

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "battery-schedule".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "battery_pct": 9,
                        "charging": false,
                        "thermal_c": 41,
                        "critical_tasks": ["notifications", "voice_reply"]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let battery_receipt = latest_receipt(&state_path);
    assert_eq!(
        battery_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V10-PHONE-001.1")
    );
    assert_eq!(
        battery_receipt["payload"]["battery_event"]["selected_profile"],
        json!("tiny-max")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "sensor-intake".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "allowed_sensors": ["gps", "camera", "mic"],
                        "requested_sensors": [
                            {"name": "gps", "available": true, "consent": true},
                            {"name": "camera", "available": false, "consent": true},
                            {"name": "mic", "available": true, "consent": false}
                        ]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--sensor-state-path={}", sensor_state_path.display()),
            ],
        ),
        0
    );
    let sensor_receipt = latest_receipt(&state_path);
    assert_eq!(
        sensor_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V10-PHONE-001.2")
    );
    assert_eq!(
        sensor_receipt["payload"]["sensor_event"]["accepted"]
            .as_array()
            .map(|v| v.len()),
        Some(1)
    );
    assert!(sensor_state_path.exists());

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "interaction-mode".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "modality": "voice",
                        "target_latency_ms": 180,
                        "local_model_available": false,
                        "notification_lane": "notify"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let interaction_receipt = latest_receipt(&state_path);
    assert_eq!(
        interaction_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V10-PHONE-001.3")
    );
    assert_eq!(
        interaction_receipt["payload"]["interaction_mode"]["transport"],
        json!("text-fallback")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "background-daemon".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "action": "wake",
                        "platform": "ios",
                        "handoff": "edge",
                        "drain_budget_pct_24h": 4,
                        "wake_reason": "push_notification"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!(
                    "--background-state-path={}",
                    background_state_path.display()
                ),
            ],
        ),
        0
    );
    let background_receipt = latest_receipt(&state_path);
    assert_eq!(
        background_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V10-PHONE-001.4")
    );
    assert!(background_state_path.exists());

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "phone-profile".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "platform": "android",
                        "device_class": "legacy-phone",
                        "memory_mb": 1024,
                        "cpu_cores": 2,
                        "battery_pct": 14
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let profile_receipt = latest_receipt(&state_path);
    assert_eq!(
        profile_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V10-PHONE-001.5")
    );
    assert_eq!(
        profile_receipt["payload"]["phone_profile"]["selected_profile"],
        json!("tiny-max")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "status".to_string(),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let status_receipt = latest_receipt(&state_path);
    assert_eq!(status_receipt["payload"]["battery_events"], json!(1));
    assert_eq!(status_receipt["payload"]["sensor_events"], json!(1));
    assert_eq!(status_receipt["payload"]["interaction_modes"], json!(1));
    assert_eq!(status_receipt["payload"]["background_events"], json!(1));
    assert_eq!(status_receipt["payload"]["profiles"], json!(1));
}
