// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V6-WORKFLOW-002.1, V6-WORKFLOW-002.2, V6-WORKFLOW-002.3,
// V6-WORKFLOW-002.4, V6-WORKFLOW-002.5, V6-WORKFLOW-002.6

use protheus_ops_core::langgraph_bridge;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_bridge(root: &Path, args: &[String]) -> i32 {
    langgraph_bridge::run(root, args)
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
fn workflow_002_langgraph_bridge_emits_receipted_graph_checkpoint_hitl_subgraph_trace_and_stream() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/langgraph/latest.json");
    let history_path = root.path().join("state/langgraph/history.jsonl");
    let swarm_state_path = root.path().join("state/langgraph/swarm.json");
    let trace_path = root.path().join("state/langgraph/native_trace.jsonl");

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-graph".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "incident_graph",
                        "entry_node": "triage",
                        "nodes": [
                            {"id": "triage", "kind": "planner"},
                            {"id": "retrieve", "kind": "retriever"},
                            {"id": "respond", "kind": "responder"}
                        ],
                        "edges": [
                            {"from": "triage", "to": "retrieve", "label": "need_context", "condition": {"field": "route", "equals": "retrieve"}},
                            {"from": "triage", "to": "respond", "label": "default", "default": true},
                            {"from": "retrieve", "to": "respond", "label": "answer", "default": true}
                        ]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let graph_receipt = latest_receipt(&state_path);
    assert_eq!(
        graph_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-002.1")
    );
    let graph_id = graph_receipt["payload"]["graph"]["graph_id"]
        .as_str()
        .expect("graph id")
        .to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "checkpoint-run".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "graph_id": graph_id,
                        "thread_id": "incident-thread",
                        "checkpoint_label": "after_triage",
                        "state_snapshot": {"ticket": "INC-42", "route": "retrieve", "priority": "high"},
                        "replay_enabled": true
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let checkpoint_receipt = latest_receipt(&state_path);
    assert_eq!(
        checkpoint_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-002.2")
    );
    let checkpoint_id = checkpoint_receipt["payload"]["checkpoint"]["checkpoint_id"]
        .as_str()
        .expect("checkpoint id")
        .to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "inspect-state".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "checkpoint_id": checkpoint_id,
                        "operator_id": "human-reviewer",
                        "view_fields": ["ticket", "priority"],
                        "intervention_patch": {"priority": "urgent"}
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let inspection_receipt = latest_receipt(&state_path);
    assert_eq!(
        inspection_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-002.3")
    );
    assert_eq!(inspection_receipt["payload"]["inspection"]["change_applied"], json!(true));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "coordinate-subgraph".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "graph_id": graph_id,
                        "profile": "pure",
                        "subgraphs": [
                            {"name": "triage-subgraph", "role": "planner", "task": "triage incoming report"},
                            {"name": "retrieval-subgraph", "role": "retriever", "task": "collect evidence"},
                            {"name": "response-subgraph", "role": "responder", "task": "draft reply"}
                        ]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--swarm-state-path={}", swarm_state_path.display()),
            ],
        ),
        0
    );
    let coordination_receipt = latest_receipt(&state_path);
    assert_eq!(
        coordination_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-002.4")
    );
    assert_eq!(coordination_receipt["payload"]["coordination"]["degraded"], json!(true));
    assert_eq!(
        coordination_receipt["payload"]["coordination"]["child_sessions"]
            .as_array()
            .map(|rows| rows.len()),
        Some(2)
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "record-trace".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "graph_id": graph_id,
                        "stage": "transition",
                        "message": "triage routed into retrieval",
                        "transitions": [
                            {"from": "triage", "to": "retrieve", "reason": "need_context"}
                        ],
                        "metrics": {"latency_ms": 48},
                        "bridge_path": "adapters/protocol/langgraph_trace_bridge.ts"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--trace-path={}", trace_path.display()),
            ],
        ),
        0
    );
    let trace_receipt = latest_receipt(&state_path);
    assert_eq!(
        trace_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-002.5")
    );
    assert!(trace_path.exists());

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "stream-graph".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "graph_id": graph_id,
                        "profile": "pure",
                        "stream_mode": "updates",
                        "context": {"route": "retrieve"}
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let stream_receipt = latest_receipt(&state_path);
    assert_eq!(
        stream_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-002.6")
    );
    assert_eq!(stream_receipt["payload"]["stream"]["degraded"], json!(true));
    assert_eq!(
        stream_receipt["payload"]["stream"]["visited"]
            .as_array()
            .and_then(|rows| rows.first())
            .and_then(Value::as_str),
        Some("triage")
    );
}
