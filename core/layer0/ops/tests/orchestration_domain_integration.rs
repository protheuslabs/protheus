// SPDX-License-Identifier: Apache-2.0
use protheus_ops_core::orchestration;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_invoke(root: &Path, op: &str, payload: Value) -> i32 {
    let args = vec![
        "invoke".to_string(),
        format!("--op={op}"),
        format!("--payload-json={}", serde_json::to_string(&payload).expect("payload")),
    ];
    orchestration::run(root, &args)
}

#[test]
fn scratchpad_write_and_append_finding_roundtrip() {
    let root = tempfile::tempdir().expect("tempdir");
    let scratchpad_dir = root.path().join("tmp-scratchpad");

    let write_code = run_invoke(
        root.path(),
        "scratchpad.write",
        json!({
            "task_id": "audit-task-001",
            "patch": { "progress": { "processed": 1, "total": 3 } },
            "root_dir": scratchpad_dir
        }),
    );
    assert_eq!(write_code, 0);

    let append_code = run_invoke(
        root.path(),
        "scratchpad.append_finding",
        json!({
            "task_id": "audit-task-001",
            "finding": {
                "audit_id": "audit-001",
                "item_id": "item-001",
                "severity": "high",
                "status": "open",
                "location": "core/layer0/ops/src/main.rs:10",
                "evidence": [{"type":"receipt","value":"abc"}],
                "timestamp": "2026-03-15T00:00:00Z"
            },
            "root_dir": scratchpad_dir
        }),
    );
    assert_eq!(append_code, 0);

    let file_path = scratchpad_dir.join("audit-task-001.json");
    assert!(file_path.exists());
    let stored: Value =
        serde_json::from_str(&fs::read_to_string(&file_path).expect("read scratchpad")).expect("parse");
    assert_eq!(stored.get("schema_version").and_then(Value::as_str), Some("scratchpad/v1"));
    assert_eq!(stored.get("findings").and_then(Value::as_array).map(|rows| rows.len()), Some(1));
}

#[test]
fn coordinator_run_writes_taskgroup_and_progress() {
    let root = tempfile::tempdir().expect("tempdir");
    let scratchpad_dir = root.path().join("coord-scratchpad");

    let code = run_invoke(
        root.path(),
        "coordinator.run",
        json!({
            "task_id": "coord-task-001",
            "task_type": "integration-audit",
            "coordinator_session": "session-main",
            "agent_count": 2,
            "items": ["V6-SEC-010", "V6-MEMORY-013", "REQ-38-001"],
            "scopes": [
                { "scope_id": "scope-sec", "series": ["V6-SEC"], "paths": ["core/*"] },
                { "scope_id": "scope-memory", "series": ["V6-MEMORY", "REQ-38"], "paths": ["client/*"] }
            ],
            "findings": [
                {
                    "audit_id": "audit-001",
                    "agent_id": "agent-1",
                    "item_id": "V6-SEC-010",
                    "severity": "high",
                    "status": "open",
                    "location": "core/layer0/ops/src/security_plane.rs:10",
                    "evidence": [{"type":"receipt","value":"sec"}],
                    "timestamp": "2026-03-15T00:00:00Z"
                },
                {
                    "audit_id": "audit-001",
                    "agent_id": "agent-2",
                    "item_id": "REQ-38-001",
                    "severity": "low",
                    "status": "open",
                    "location": "client/cognition/orchestration/coordinator.ts:1",
                    "evidence": [{"type":"receipt","value":"req"}],
                    "timestamp": "2026-03-15T00:00:01Z"
                }
            ],
            "root_dir": scratchpad_dir
        }),
    );

    assert_eq!(code, 0);

    let scratchpad_path = scratchpad_dir.join("coord-task-001.json");
    assert!(scratchpad_path.exists());
    let scratchpad: Value = serde_json::from_str(
        &fs::read_to_string(&scratchpad_path).expect("read scratchpad"),
    )
    .expect("parse scratchpad");
    assert_eq!(
        scratchpad
            .get("progress")
            .and_then(|v| v.get("total"))
            .and_then(Value::as_f64),
        Some(3.0)
    );

    let entries = fs::read_dir(&scratchpad_dir)
        .expect("taskgroup root dir")
        .filter_map(Result::ok)
        .filter(|entry| {
            entry
                .path()
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with("integration-audit-") && name.ends_with(".json"))
                .unwrap_or(false)
        })
        .collect::<Vec<_>>();
    assert!(!entries.is_empty());

    let taskgroup: Value = serde_json::from_str(
        &fs::read_to_string(entries[0].path()).expect("read taskgroup"),
    )
    .expect("parse taskgroup");
    assert_eq!(taskgroup.get("status").and_then(Value::as_str), Some("done"));
    assert_eq!(
        taskgroup
            .get("agents")
            .and_then(Value::as_array)
            .map(|rows| rows.len()),
        Some(2)
    );
}
