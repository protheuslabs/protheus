// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V6-WORKFLOW-004.1, V6-WORKFLOW-004.2, V6-WORKFLOW-004.3,
// V6-WORKFLOW-004.4, V6-WORKFLOW-004.5, V6-WORKFLOW-004.6,
// V6-WORKFLOW-004.7, V6-WORKFLOW-004.8, V6-WORKFLOW-004.9, V6-WORKFLOW-004.10

use protheus_ops_core::crewai_bridge;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_bridge(root: &Path, args: &[String]) -> i32 {
    crewai_bridge::run(root, args)
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
fn workflow_004_crewai_bridge_emits_receipted_crew_process_flow_memory_config_delegation_review_trace_benchmark_and_model_route() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/crewai/latest.json");
    let history_path = root.path().join("state/crewai/history.jsonl");
    let swarm_state_path = root.path().join("state/crewai/swarm.json");
    let approval_queue_path = root.path().join("state/crewai/reviews.yaml");
    let trace_path = root.path().join("state/crewai/amp_trace.jsonl");

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-crew".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "crew_name": "launch_crew",
                        "process_type": "hierarchical",
                        "manager_role": "manager",
                        "goal": "ship validated launch plan",
                        "agents": [
                            {"role": "manager", "goal": "coordinate", "backstory": "chief", "tools": ["plan", "approve"]},
                            {"role": "researcher", "goal": "gather facts", "backstory": "analyst", "tools": ["search", "summarize"]},
                            {"role": "writer", "goal": "draft copy", "backstory": "editor", "tools": ["write", "edit"], "multimodal": true}
                        ]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let crew_receipt = latest_receipt(&state_path);
    assert_eq!(crew_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-004.1"));
    let crew_id = crew_receipt["payload"]["crew"]["crew_id"].as_str().unwrap().to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "run-process".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "crew_id": crew_id,
                        "process_type": "hierarchical",
                        "profile": "pure",
                        "tasks": [
                            {"name": "research", "description": "collect evidence", "role_hint": "researcher", "required_tool": "search"},
                            {"name": "draft", "description": "draft launch note", "role_hint": "writer", "required_tool": "write"},
                            {"name": "review", "description": "manager approval", "role_hint": "manager", "required_tool": "approve"}
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
    let process_receipt = latest_receipt(&state_path);
    assert_eq!(process_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-004.2"));
    let run_id = process_receipt["payload"]["process_run"]["run_id"].as_str().unwrap().to_string();
    assert_eq!(process_receipt["payload"]["process_run"]["degraded"], json!(true));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "run-flow".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "crew_id": crew_id,
                        "flow_name": "launch_flow",
                        "trigger_event": "task_completed",
                        "decorators": ["@start", "@listen"],
                        "listeners": ["task_completed", "manager_review"],
                        "context": {"stage": "draft"},
                        "routes": [
                            {"event": "task_completed", "condition": {"field": "stage", "equals": "draft"}, "target": "manager_review"},
                            {"default": true, "target": "done"}
                        ]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let flow_receipt = latest_receipt(&state_path);
    assert_eq!(flow_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-004.3"));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "memory-bridge".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "crew_id": crew_id,
                        "thread_id": "launch-thread",
                        "summary": "crew context",
                        "recall_query": "launch",
                        "memories": [
                            {"scope": "crew", "text": "launch campaign requires accurate dates"},
                            {"scope": "agent", "agent_id": "researcher", "text": "launch metrics sourced from analytics"}
                        ]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let memory_receipt = latest_receipt(&state_path);
    assert_eq!(memory_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-004.4"));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "ingest-config".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "config_yaml": "crew:\n  name: launch_crew\nagents:\n  - role: researcher\n    goal: gather facts\ntasks:\n  - name: research\nflows:\n  - name: launch_flow\n"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let config_receipt = latest_receipt(&state_path);
    assert_eq!(config_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-004.5"));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "route-delegation".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "crew_id": crew_id,
                        "profile": "pure",
                        "task": "collect launch evidence",
                        "role_hint": "researcher",
                        "required_tool": "search"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--swarm-state-path={}", swarm_state_path.display()),
            ],
        ),
        0
    );
    let delegation_receipt = latest_receipt(&state_path);
    assert_eq!(delegation_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-004.6"));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "review-crew".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "crew_id": crew_id,
                        "run_id": run_id,
                        "operator_id": "human-approver",
                        "action": "approve",
                        "notes": "looks good"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--approval-queue-path={}", approval_queue_path.display()),
            ],
        ),
        0
    );
    let review_receipt = latest_receipt(&state_path);
    assert_eq!(review_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-004.7"));
    assert!(approval_queue_path.exists());

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "record-amp-trace".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "crew_id": crew_id,
                        "run_id": run_id,
                        "stage": "delegation",
                        "message": "delegated research task",
                        "metrics": {"latency_ms": 42},
                        "controls": {"profile": "pure"}
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
    assert_eq!(trace_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-004.8"));
    assert!(trace_path.exists());

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "benchmark-parity".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "profile": "pure",
                        "metrics": {"cold_start_ms": 3.2, "throughput_ops_sec": 4800.0, "memory_mb": 7.5}
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let benchmark_receipt = latest_receipt(&state_path);
    assert_eq!(benchmark_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-004.9"));
    assert_eq!(benchmark_receipt["payload"]["benchmark"]["parity_ok"], json!(true));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "route-model".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "profile": "pure",
                        "modality": "image",
                        "prefer_local": true,
                        "local_models": ["llava-local"],
                        "providers": ["openai"]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let route_receipt = latest_receipt(&state_path);
    assert_eq!(route_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-004.10"));
    assert_eq!(route_receipt["payload"]["model_route"]["degraded"], json!(false));
}
