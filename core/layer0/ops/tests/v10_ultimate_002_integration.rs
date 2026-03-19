// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V10-ULTIMATE-002.1, V10-ULTIMATE-002.2, V10-ULTIMATE-002.3

use protheus_ops_core::instinct_bridge;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_bridge(root: &Path, args: &[String]) -> i32 {
    instinct_bridge::run(root, args)
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
fn ultimate_002_instinct_bridge_models_activates_and_refines() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/instinct/latest.json");
    let history_path = root.path().join("state/instinct/history.jsonl");
    let lineage_path = root.path().join("state/instinct/lineage.jsonl");

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "cold-start-model".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "tools": ["search", "shell", "memory"],
                        "skills": ["planner", "summarizer"],
                        "adapters": ["receipt-provenance", "mcp"],
                        "modes": ["swarm", "pure", "rich"],
                        "memory_lanes": ["recent", "semantic"],
                        "platform": "desktop",
                        "memory_mb": 16384,
                        "cpu_cores": 8,
                        "battery_pct": 90
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let model_receipt = latest_receipt(&state_path);
    assert_eq!(
        model_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V10-ULTIMATE-002.1")
    );
    assert_eq!(
        model_receipt["payload"]["self_model"]["strongest_profile"],
        json!("rich")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "activate".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "requested_capabilities": ["swarm", "memory", "provenance"],
                        "event": "cold_start",
                        "battery_pct": 22,
                        "low_power": true,
                        "network_available": false
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let activation_receipt = latest_receipt(&state_path);
    assert_eq!(
        activation_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V10-ULTIMATE-002.2")
    );
    assert_eq!(
        activation_receipt["payload"]["activation"]["selected_profile"],
        json!("tiny-max")
    );
    assert!(
        activation_receipt["payload"]["activation"]["rejected_capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["capability"] == json!("swarm"))
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "refine".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "evidence": [
                            {"dimension": "memory", "success": true, "latency_ms": 180, "blob_ref": "blob://memory-success-1"},
                            {"dimension": "swarm", "success": false, "latency_ms": 1800, "blob_ref": "blob://swarm-failure-1"}
                        ]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--lineage-path={}", lineage_path.display()),
            ],
        ),
        0
    );
    let refine_receipt = latest_receipt(&state_path);
    assert_eq!(
        refine_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V10-ULTIMATE-002.3")
    );
    assert_eq!(
        refine_receipt["payload"]["refinement"]["rollbackable"],
        json!(true)
    );
    assert!(lineage_path.exists());

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
    assert_eq!(status_receipt["payload"]["activations"], json!(1));
    assert_eq!(status_receipt["payload"]["refinements"], json!(1));
    assert_eq!(status_receipt["payload"]["models"], json!(2));
}
