// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V6-WORKFLOW-007.1, V6-WORKFLOW-007.2, V6-WORKFLOW-007.3,
// V6-WORKFLOW-007.4, V6-WORKFLOW-007.5, V6-WORKFLOW-007.7
use protheus_ops_core::swarm_runtime;
use serde_json::Value;
use std::fs;
use std::path::Path;

fn run_swarm(root: &Path, args: &[String]) -> i32 {
    swarm_runtime::run(root, args)
}

fn read_state(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).expect("read state")).expect("parse state")
}

fn find_session_id_by_task(state: &Value, task: &str) -> String {
    state
        .get("sessions")
        .and_then(Value::as_object)
        .and_then(|rows| {
            rows.iter().find_map(|(session_id, row)| {
                let report_task = row
                    .get("report")
                    .and_then(|value| value.get("task"))
                    .and_then(Value::as_str);
                let session_task = row.get("task").and_then(Value::as_str);
                (report_task == Some(task) || session_task == Some(task))
                    .then(|| session_id.clone())
            })
        })
        .expect("session id by task")
}

#[test]
fn workflow_007_handoff_registry_and_context_propagation_are_receipted() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    assert_eq!(
        run_swarm(
            root.path(),
            &[
                "spawn".to_string(),
                "--task=workflow-007 coordinator".to_string(),
                "--max-tokens=192".to_string(),
                format!("--state-path={}", state_path.display()),
            ],
        ),
        0
    );
    assert_eq!(
        run_swarm(
            root.path(),
            &[
                "spawn".to_string(),
                "--task=workflow-007 specialist".to_string(),
                "--max-tokens=192".to_string(),
                format!("--state-path={}", state_path.display()),
            ],
        ),
        0
    );

    let state = read_state(&state_path);
    let coordinator = find_session_id_by_task(&state, "workflow-007 coordinator");
    let specialist = find_session_id_by_task(&state, "workflow-007 specialist");

    let oversized_context = format!(
        "{{\"objective\":\"workflow-007\",\"oversized\":\"{}\"}}",
        "x".repeat(3200)
    );
    assert_eq!(
        run_swarm(
            root.path(),
            &[
                "sessions".to_string(),
                "context-put".to_string(),
                format!("--session-id={coordinator}"),
                format!("--context-json={oversized_context}"),
                format!("--state-path={}", state_path.display()),
            ],
        ),
        0
    );
    assert_eq!(
        run_swarm(
            root.path(),
            &[
                "sessions".to_string(),
                "handoff".to_string(),
                format!("--session-id={coordinator}"),
                format!("--target-session-id={specialist}"),
                "--reason=delegate specialist analysis".to_string(),
                "--importance=0.85".to_string(),
                "--context-json={\"delegated_goal\":\"produce governed answer\",\"owner\":\"workflow-007 coordinator\"}".to_string(),
                format!("--state-path={}", state_path.display()),
            ],
        ),
        0
    );

    let state_after = read_state(&state_path);
    let coordinator_row = state_after
        .get("sessions")
        .and_then(|rows| rows.get(&coordinator))
        .expect("coordinator row");
    let specialist_row = state_after
        .get("sessions")
        .and_then(|rows| rows.get(&specialist))
        .expect("specialist row");
    assert_eq!(
        coordinator_row.get("context_mode").and_then(Value::as_str),
        Some("context_compacted")
    );
    assert_eq!(
        specialist_row
            .get("context_vars")
            .and_then(|row| row.get("delegated_goal"))
            .and_then(Value::as_str),
        Some("produce governed answer")
    );
    let handoff_count = state_after
        .get("handoff_registry")
        .and_then(Value::as_object)
        .map(|rows| rows.len())
        .unwrap_or(0);
    assert!(handoff_count >= 1, "expected handoff registry receipt");
    let first_handoff = state_after
        .get("handoff_registry")
        .and_then(Value::as_object)
        .and_then(|rows| rows.values().next())
        .expect("handoff receipt");
    assert_eq!(
        first_handoff
            .get("sender_session_id")
            .and_then(Value::as_str),
        Some(coordinator.as_str())
    );
    assert_eq!(
        first_handoff
            .get("recipient_session_id")
            .and_then(Value::as_str),
        Some(specialist.as_str())
    );
}

#[test]
fn workflow_007_tool_bridge_registers_invokes_and_denies_unsafe_paths() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    assert_eq!(
        run_swarm(
            root.path(),
            &[
                "spawn".to_string(),
                "--task=workflow-007 tool agent".to_string(),
                format!("--state-path={}", state_path.display()),
            ],
        ),
        0
    );
    let state = read_state(&state_path);
    let agent = find_session_id_by_task(&state, "workflow-007 tool agent");

    assert_eq!(
        run_swarm(
            root.path(),
            &[
                "tools".to_string(),
                "register-json-schema".to_string(),
                format!("--session-id={agent}"),
                "--tool-name=context_patch".to_string(),
                "--schema-json={\"type\":\"object\",\"properties\":{\"context\":{\"type\":\"object\"}},\"required\":[\"context\"]}".to_string(),
                "--bridge-path=client/runtime/systems/autonomy/swarm_sessions_bridge.ts".to_string(),
                "--entrypoint=sessions_context_put".to_string(),
                format!("--state-path={}", state_path.display()),
            ],
        ),
        0
    );
    assert_eq!(
        run_swarm(
            root.path(),
            &[
                "tools".to_string(),
                "invoke".to_string(),
                format!("--session-id={agent}"),
                "--tool-name=context_patch".to_string(),
                "--args-json={\"context\":{\"tool_applied\":true,\"source\":\"rust-integration\"},\"merge\":true}".to_string(),
                format!("--state-path={}", state_path.display()),
            ],
        ),
        0
    );
    assert_ne!(
        run_swarm(
            root.path(),
            &[
                "tools".to_string(),
                "register-json-schema".to_string(),
                format!("--session-id={agent}"),
                "--tool-name=unsafe_tool".to_string(),
                "--schema-json={\"type\":\"object\"}".to_string(),
                "--bridge-path=../unsafe/bridge.ts".to_string(),
                "--entrypoint=noop".to_string(),
                format!("--state-path={}", state_path.display()),
            ],
        ),
        0
    );

    let state_after = read_state(&state_path);
    let tool_registry = state_after
        .get("tool_registry")
        .and_then(Value::as_object)
        .expect("tool registry");
    assert_eq!(tool_registry.len(), 1);
    let manifest = tool_registry.values().next().expect("tool manifest");
    assert_eq!(
        manifest.get("invocation_count").and_then(Value::as_u64),
        Some(1)
    );
    let agent_row = state_after
        .get("sessions")
        .and_then(|rows| rows.get(&agent))
        .expect("agent row");
    assert_eq!(
        agent_row
            .get("context_vars")
            .and_then(|row| row.get("tool_applied"))
            .and_then(Value::as_bool),
        Some(true)
    );
}

#[test]
fn workflow_007_stream_turns_and_networks_emit_receipts() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    assert_eq!(
        run_swarm(
            root.path(),
            &[
                "spawn".to_string(),
                "--task=workflow-007 owner".to_string(),
                "--role=coordinator".to_string(),
                format!("--state-path={}", state_path.display()),
            ],
        ),
        0
    );
    let state = read_state(&state_path);
    let owner = find_session_id_by_task(&state, "workflow-007 owner");

    assert_eq!(
        run_swarm(
            root.path(),
            &[
                "stream".to_string(),
                "emit".to_string(),
                format!("--session-id={owner}"),
                "--turn-id=workflow-007-turn".to_string(),
                "--agent-label=workflow-007-owner".to_string(),
                "--chunks-json=[{\"delimiter\":\"agent_start\",\"content\":\"hello:\"},{\"delimiter\":\"agent_delta\",\"content\":\"stream\"},{\"delimiter\":\"agent_end\",\"content\":\"\"}]".to_string(),
                format!("--state-path={}", state_path.display()),
            ],
        ),
        0
    );
    assert_eq!(
        run_swarm(
            root.path(),
            &[
                "turns".to_string(),
                "run".to_string(),
                format!("--session-id={owner}"),
                "--label=workflow-007-run".to_string(),
                "--turns-json=[{\"message\":\"draft governed answer\",\"fail_first_attempt\":true,\"recovery\":\"retry_once\"}]".to_string(),
                format!("--state-path={}", state_path.display()),
            ],
        ),
        0
    );
    assert_eq!(
        run_swarm(
            root.path(),
            &[
                "networks".to_string(),
                "create".to_string(),
                format!("--session-id={owner}"),
                "--spec-json={\"name\":\"workflow-007-network\",\"nodes\":[{\"label\":\"planner\",\"role\":\"planner\",\"task\":\"plan\"},{\"label\":\"executor\",\"role\":\"executor\",\"task\":\"execute\"}],\"edges\":[{\"from\":\"planner\",\"to\":\"executor\",\"relation\":\"handoff\",\"importance\":0.7,\"auto_handoff\":true,\"reason\":\"planner_to_executor\"}]}".to_string(),
                format!("--state-path={}", state_path.display()),
            ],
        ),
        0
    );

    let state_after = read_state(&state_path);
    let stream_rows = state_after
        .get("stream_registry")
        .and_then(Value::as_object)
        .map(|rows| rows.len())
        .unwrap_or(0);
    let turn_rows = state_after
        .get("turn_registry")
        .and_then(Value::as_object)
        .map(|rows| rows.len())
        .unwrap_or(0);
    let network_rows = state_after
        .get("network_registry")
        .and_then(Value::as_object)
        .map(|rows| rows.len())
        .unwrap_or(0);
    assert!(stream_rows >= 1, "expected stream receipt rows");
    assert!(turn_rows >= 1, "expected turn receipt rows");
    assert!(network_rows >= 1, "expected network receipt rows");

    let network = state_after
        .get("network_registry")
        .and_then(Value::as_object)
        .and_then(|rows| rows.values().next())
        .expect("network receipt");
    assert_eq!(
        network
            .get("nodes")
            .and_then(Value::as_array)
            .map(|rows| rows.len()),
        Some(2)
    );
    assert_eq!(
        network
            .get("edges")
            .and_then(Value::as_array)
            .map(|rows| rows.len()),
        Some(1)
    );
}
