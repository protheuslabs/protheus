// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V6-WORKFLOW-015.1, V6-WORKFLOW-015.2, V6-WORKFLOW-015.3,
// V6-WORKFLOW-015.4, V6-WORKFLOW-015.5, V6-WORKFLOW-015.6, V6-WORKFLOW-015.7,
// V6-WORKFLOW-015.8, V6-WORKFLOW-015.9, V6-WORKFLOW-015.10

use protheus_ops_core::pydantic_ai_bridge;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_bridge(root: &Path, args: &[String]) -> i32 {
    pydantic_ai_bridge::run(root, args)
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
fn workflow_015_typed_agents_validation_protocol_durable_approval_observability_graph_stream_and_eval_emit_receipts() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/pydantic-ai/latest.json");
    let history_path = root.path().join("state/pydantic-ai/history.jsonl");
    let swarm_state_path = root.path().join("state/pydantic-ai/swarm.json");
    let approval_queue_path = root.path().join("state/pydantic-ai/approvals.json");

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-agent".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "typed-incident-agent",
                        "input_required": ["question", "context"],
                        "output_required": ["summary", "confidence"],
                        "dependencies": ["memory_store"],
                        "dependency_schema": {"memory_store": "required"},
                        "output_schema": {"summary": "string", "confidence": "number"}
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let agent_receipt = latest_receipt(&state_path);
    assert_eq!(agent_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-015.1"));
    let agent_id = agent_receipt["payload"]["agent"]["agent_id"].as_str().expect("agent id").to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "validate-output".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "agent_id": agent_id,
                        "data": {"summary": "incident contained"},
                        "attempt": 1,
                        "max_retries": 1,
                        "profile": "pure",
                        "nested_depth": 5
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let validation_receipt = latest_receipt(&state_path);
    assert_eq!(validation_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-015.2"));
    assert_eq!(validation_receipt["payload"]["validation"]["status"].as_str(), Some("retry"));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-tool-context".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "risky-lookup",
                        "kind": "custom",
                        "entrypoint": "invoke",
                        "requires_approval": true,
                        "required_args": ["ticket_id"],
                        "required_dependencies": ["memory_store"],
                        "argument_schema": {"ticket_id": "string"},
                        "dependency_context": {"memory_store": "incident-memory"},
                        "supported_profiles": ["rich"]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let tool_receipt = latest_receipt(&state_path);
    assert_eq!(tool_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-015.3"));
    let tool_id = tool_receipt["payload"]["tool_context"]["tool_id"].as_str().expect("tool id").to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "approval-checkpoint".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "tool_id": tool_id,
                        "summary": "approve risky lookup",
                        "reason": "needs human check",
                        "risk": "high"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--approval-queue-path={}", approval_queue_path.display()),
            ],
        ),
        0
    );
    let approval_receipt = latest_receipt(&state_path);
    assert_eq!(approval_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-015.6"));
    let action_id = approval_receipt["payload"]["approval"]["action_id"].as_str().expect("action id").to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "approval-checkpoint".to_string(),
                format!(
                    "--payload={}",
                    json!({"action_id": action_id, "decision": "approve", "tool_id": tool_id})
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--approval-queue-path={}", approval_queue_path.display()),
            ],
        ),
        0
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "invoke-tool-context".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "tool_id": tool_id,
                        "profile": "rich",
                        "approval_action_id": action_id,
                        "args": {"ticket_id": "INC-42"},
                        "dependency_keys": ["memory_store"]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--approval-queue-path={}", approval_queue_path.display()),
            ],
        ),
        0
    );
    let invoke_receipt = latest_receipt(&state_path);
    assert_eq!(invoke_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-015.3"));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-runtime-bridge".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "python-gateway",
                        "language": "python",
                        "provider": "google",
                        "model_family": "gemini",
                        "models": ["gemini-2.0-flash"],
                        "supported_profiles": ["rich", "pure"]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let runtime_receipt = latest_receipt(&state_path);
    assert_eq!(runtime_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-015.9"));
    let bridge_id = runtime_receipt["payload"]["runtime_bridge"]["bridge_id"].as_str().expect("bridge id").to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "bridge-protocol".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "protocol_kind": "a2a",
                        "agent_id": agent_id,
                        "message": "investigate incident",
                        "sender_label": "typed-dispatch",
                        "sender_task": "triage",
                        "profile": "rich"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--swarm-state-path={}", swarm_state_path.display()),
            ],
        ),
        0
    );
    let protocol_receipt = latest_receipt(&state_path);
    assert_eq!(protocol_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-015.4"));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "durable-run".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "durable-typed-agent",
                        "instruction": "produce typed incident response",
                        "runtime_bridge_id": bridge_id,
                        "language": "python",
                        "provider": "google",
                        "model": "gemini-2.0-flash",
                        "profile": "rich",
                        "retry_count": 1,
                        "steps": [{"id": "plan"}, {"id": "respond"}]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--swarm-state-path={}", swarm_state_path.display()),
            ],
        ),
        0
    );
    let durable_receipt = latest_receipt(&state_path);
    assert_eq!(durable_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-015.5"));
    let session_id = durable_receipt["payload"]["durable_run"]["session_id"].as_str().expect("session id").to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "record-logfire".to_string(),
                format!(
                    "--payload={}",
                    json!({"trace_id": "pydantic-trace", "event_name": "validated-response", "message": "typed response emitted", "tokens": 321, "cost_usd": 0.02})
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let logfire_receipt = latest_receipt(&state_path);
    assert_eq!(logfire_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-015.7"));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "execute-graph".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "typed-graph",
                        "profile": "pure",
                        "nodes": [
                            {"id": "planner", "kind": "planner", "budget": 96},
                            {"id": "responder", "kind": "worker", "budget": 96}
                        ],
                        "edges": [{"from": "planner", "to": "responder"}]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--swarm-state-path={}", swarm_state_path.display()),
            ],
        ),
        0
    );
    let graph_receipt = latest_receipt(&state_path);
    assert_eq!(graph_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-015.8"));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "stream-model".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "bridge_id": bridge_id,
                        "language": "python",
                        "provider": "google",
                        "model": "gemini-2.0-flash",
                        "profile": "pure",
                        "structured_fields": ["summary", "confidence"]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let stream_receipt = latest_receipt(&state_path);
    assert_eq!(stream_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-015.9"));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "record-eval".to_string(),
                format!(
                    "--payload={}",
                    json!({"session_id": session_id, "profile": "pure", "score": 0.91, "metrics": {"typed": 1, "validated": 1}})
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let eval_receipt = latest_receipt(&state_path);
    assert_eq!(eval_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-015.10"));
}
