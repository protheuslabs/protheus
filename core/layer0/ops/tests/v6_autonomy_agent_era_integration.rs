// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::autonomy_controller;
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("autonomy_controller")
        .join("latest.json")
}

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read json");
    serde_json::from_str(&raw).expect("decode json")
}

fn has_claim(receipt: &Value, claim_id: &str) -> bool {
    receipt
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some(claim_id))
}

#[test]
fn v6_autonomy_and_v8_agent_era_lanes_execute_with_behavior_proof() {
    let root = tempfile::tempdir().expect("tempdir");

    assert_eq!(
        autonomy_controller::run(
            root.path(),
            &[
                "hand-new".to_string(),
                "--strict=1".to_string(),
                "--hand-id=alpha".to_string(),
                "--template=researcher".to_string(),
                "--schedule=*/15 * * * *".to_string(),
                "--provider=bitnet".to_string(),
                "--fallback=local-moe".to_string(),
            ],
        ),
        0
    );
    let mut latest = read_json(&latest_path(root.path()));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("autonomy_hand_new")
    );
    assert!(has_claim(&latest, "V6-AUTONOMY-001.1"));

    assert_eq!(
        autonomy_controller::run(
            root.path(),
            &[
                "hand-cycle".to_string(),
                "--strict=1".to_string(),
                "--hand-id=alpha".to_string(),
                "--goal=triage backlog".to_string(),
                "--provider=bitnet".to_string(),
            ],
        ),
        0
    );
    latest = read_json(&latest_path(root.path()));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("autonomy_hand_cycle")
    );
    assert!(has_claim(&latest, "V6-AUTONOMY-001.2"));
    assert!(has_claim(&latest, "V6-AUTONOMY-001.3"));
    assert!(latest
        .pointer("/chain/merkle_root")
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));

    assert_eq!(
        autonomy_controller::run(
            root.path(),
            &[
                "hand-memory-page".to_string(),
                "--strict=1".to_string(),
                "--hand-id=alpha".to_string(),
                "--op=page-in".to_string(),
                "--tier=archival".to_string(),
                "--key=q1-plan".to_string(),
            ],
        ),
        0
    );
    latest = read_json(&latest_path(root.path()));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("autonomy_hand_memory_page")
    );
    assert!(has_claim(&latest, "V6-AUTONOMY-001.4"));
    assert!(latest
        .pointer("/memory/archival")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().any(|v| v.as_str() == Some("q1-plan")))
        .unwrap_or(false));

    assert_eq!(
        autonomy_controller::run(
            root.path(),
            &[
                "hand-wasm-task".to_string(),
                "--strict=1".to_string(),
                "--hand-id=alpha".to_string(),
                "--task=render".to_string(),
                "--fuel=120000".to_string(),
                "--epoch-ms=1200".to_string(),
            ],
        ),
        0
    );
    latest = read_json(&latest_path(root.path()));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("autonomy_hand_wasm_task")
    );
    assert!(has_claim(&latest, "V6-AUTONOMY-001.5"));
    assert!(latest
        .pointer("/result/work_units")
        .and_then(Value::as_u64)
        .map(|v| v > 0)
        .unwrap_or(false));

    assert_eq!(
        autonomy_controller::run(
            root.path(),
            &[
                "ephemeral-run".to_string(),
                "--strict=1".to_string(),
                "--goal=summarize ticket risks".to_string(),
                "--domain=research".to_string(),
                "--ui-leaf=1".to_string(),
            ],
        ),
        0
    );
    latest = read_json(&latest_path(root.path()));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("autonomy_ephemeral_run")
    );
    assert!(has_claim(&latest, "V8-AGENT-ERA-001.1"));
    assert!(has_claim(&latest, "V8-AGENT-ERA-001.2"));
    assert!(has_claim(&latest, "V8-AGENT-ERA-001.3"));
    assert!(has_claim(&latest, "V8-AGENT-ERA-001.4"));
    assert!(has_claim(&latest, "V8-AGENT-ERA-001.5"));
    assert_eq!(
        latest.pointer("/run/state/discarded_runtime"),
        Some(&Value::Bool(true))
    );

    assert_eq!(
        autonomy_controller::run(
            root.path(),
            &["trunk-status".to_string(), "--strict=1".to_string()]
        ),
        0
    );
    latest = read_json(&latest_path(root.path()));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("autonomy_trunk_status")
    );
    assert!(has_claim(&latest, "V8-AGENT-ERA-001.2"));
    assert!(has_claim(&latest, "V8-AGENT-ERA-001.5"));
    assert!(latest
        .pointer("/events/count")
        .and_then(Value::as_u64)
        .map(|v| v > 0)
        .unwrap_or(false));
}

#[test]
fn v6_autonomy_and_v8_agent_era_fail_closed_paths_are_enforced() {
    let root = tempfile::tempdir().expect("tempdir");

    assert_eq!(
        autonomy_controller::run(
            root.path(),
            &[
                "hand-new".to_string(),
                "--strict=1".to_string(),
                "--bypass=1".to_string(),
            ],
        ),
        1
    );
    let mut latest = read_json(&latest_path(root.path()));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("autonomy_controller_conduit_gate")
    );
    assert_eq!(
        latest.get("error").and_then(Value::as_str),
        Some("conduit_bypass_rejected")
    );

    assert_eq!(
        autonomy_controller::run(
            root.path(),
            &[
                "ephemeral-run".to_string(),
                "--strict=1".to_string(),
                "--domain=forbidden".to_string(),
            ],
        ),
        1
    );
    latest = read_json(&latest_path(root.path()));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("autonomy_ephemeral_run")
    );
    assert_eq!(
        latest.get("error").and_then(Value::as_str),
        Some("domain_constraint_denied")
    );
}
