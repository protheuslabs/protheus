// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V6-WORKFLOW-010.1, V6-WORKFLOW-010.2, V6-WORKFLOW-010.3,
// V6-WORKFLOW-010.4, V6-WORKFLOW-010.5, V6-WORKFLOW-010.6, V6-WORKFLOW-010.7,
// V6-WORKFLOW-010.8, V6-WORKFLOW-010.9

use protheus_ops_core::google_adk_bridge;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_bridge(root: &Path, args: &[String]) -> i32 {
    google_adk_bridge::run(root, args)
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
fn workflow_010_a2a_agents_tools_hierarchy_approval_rewind_sandbox_deploy_and_polyglot_emit_receipts(
) {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/google-adk/latest.json");
    let history_path = root.path().join("state/google-adk/history.jsonl");
    let swarm_state_path = root.path().join("state/google-adk/swarm.json");
    let approval_queue_path = root.path().join("state/google-adk/approvals.yaml");

    let a2a_payload = json!({
        "name": "remote-researcher",
        "language": "python",
        "transport": "a2a",
        "endpoint": "grpc://remote-researcher",
        "bridge_path": "adapters/polyglot/google_adk_runtime_bridge.ts",
        "supported_profiles": ["rich", "pure"],
        "capabilities": ["handoff", "research"]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-a2a-agent".to_string(),
                format!("--payload={}", a2a_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let state = read_json(&state_path);
    let agent_id = state
        .get("a2a_agents")
        .and_then(Value::as_object)
        .and_then(|rows| rows.keys().next().cloned())
        .expect("a2a id");
    assert_eq!(
        latest_receipt(&state_path)["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-010.1")
    );

    let runtime_bridge_payload = json!({
        "name": "python-gateway",
        "language": "python",
        "provider": "google",
        "model_family": "gemini",
        "models": ["gemini-2.0-flash"],
        "bridge_path": "adapters/polyglot/google_adk_runtime_bridge.ts",
        "supported_profiles": ["rich", "pure"]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-runtime-bridge".to_string(),
                format!("--payload={}", runtime_bridge_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let runtime_bridge_receipt = latest_receipt(&state_path);
    assert_eq!(
        runtime_bridge_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-010.9")
    );
    let runtime_bridge_id = runtime_bridge_receipt["payload"]["runtime_bridge"]["bridge_id"]
        .as_str()
        .expect("runtime bridge id")
        .to_string();

    let route_payload = json!({
        "bridge_id": runtime_bridge_id,
        "language": "python",
        "provider": "google",
        "model": "gemini-2.0-flash",
        "profile": "pure"
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "route-model".to_string(),
                format!("--payload={}", route_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let route_receipt = latest_receipt(&state_path);
    assert_eq!(
        route_receipt["payload"]["route"]["reason_code"].as_str(),
        Some("polyglot_runtime_requires_rich_profile")
    );

    let send_payload = json!({
        "agent_id": agent_id,
        "message": "collect evidence for incident triage",
        "profile": "pure",
        "sender_label": "dispatch",
        "sender_task": "incident-triage",
        "handoff_reason": "delegate_incident_research"
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "send-a2a-message".to_string(),
                format!("--payload={}", send_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--swarm-state-path={}", swarm_state_path.display()),
            ],
        ),
        0
    );
    let send_receipt = latest_receipt(&state_path);
    assert!(send_receipt["payload"]["a2a_message"]["remote_session_id"]
        .as_str()
        .is_some());

    let llm_payload = json!({
        "name": "incident-coordinator",
        "instruction": "triage the incident and plan the response",
        "mode": "parallel",
        "runtime_bridge_id": runtime_bridge_id,
        "language": "python",
        "provider": "google",
        "model": "gemini-2.0-flash",
        "profile": "rich",
        "budget": 640,
        "steps": [
            {"id": "research", "budget": 192},
            {"id": "draft", "budget": 192}
        ]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "run-llm-agent".to_string(),
                format!("--payload={}", llm_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--swarm-state-path={}", swarm_state_path.display()),
            ],
        ),
        0
    );
    let llm_receipt = latest_receipt(&state_path);
    assert_eq!(
        llm_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-010.2")
    );
    let primary_session_id = llm_receipt["payload"]["agent"]["primary_session_id"]
        .as_str()
        .expect("primary session")
        .to_string();
    assert_eq!(
        llm_receipt["payload"]["agent"]["child_sessions"]
            .as_array()
            .map(|rows| rows.len()),
        Some(2)
    );

    let tool_payload = json!({
        "name": "approval-tool",
        "kind": "custom",
        "bridge_path": "adapters/polyglot/google_adk_runtime_bridge.ts",
        "entrypoint": "invoke",
        "requires_approval": true,
        "supported_profiles": ["rich"]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-tool-manifest".to_string(),
                format!("--payload={}", tool_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let tool_receipt = latest_receipt(&state_path);
    let tool_id = tool_receipt["payload"]["tool"]["tool_id"]
        .as_str()
        .expect("tool id")
        .to_string();

    let approval_queue_payload = json!({
        "tool_id": tool_id,
        "summary": "approve risky tool",
        "reason": "requires operator ack",
        "risk": "high"
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "approval-checkpoint".to_string(),
                format!("--payload={}", approval_queue_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--approval-queue-path={}", approval_queue_path.display()),
            ],
        ),
        0
    );
    let queued_approval = latest_receipt(&state_path);
    let approval_action_id = queued_approval["payload"]["approval"]["action_id"]
        .as_str()
        .expect("approval action id")
        .to_string();
    assert_eq!(
        queued_approval["payload"]["approval"]["status"].as_str(),
        Some("pending")
    );

    let approval_accept_payload = json!({
        "action_id": approval_action_id,
        "decision": "approve",
        "tool_id": tool_id
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "approval-checkpoint".to_string(),
                format!("--payload={}", approval_accept_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--approval-queue-path={}", approval_queue_path.display()),
            ],
        ),
        0
    );
    let approval_receipt = latest_receipt(&state_path);
    assert_eq!(
        approval_receipt["payload"]["approval"]["status"].as_str(),
        Some("approved")
    );

    let invoke_payload = json!({
        "tool_id": tool_id,
        "profile": "rich",
        "approval_action_id": approval_action_id,
        "args": {"op": "status"}
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "invoke-tool-manifest".to_string(),
                format!("--payload={}", invoke_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--approval-queue-path={}", approval_queue_path.display()),
            ],
        ),
        0
    );
    let invoke_receipt = latest_receipt(&state_path);
    assert_eq!(
        invoke_receipt["payload"]["invocation"]["mode"].as_str(),
        Some("custom_function")
    );

    let hierarchy_payload = json!({
        "name": "triage-hierarchy",
        "profile": "pure",
        "coordinator_label": "root-coordinator",
        "agents": [
            {"label": "researcher", "role": "retriever", "reason": "collect_evidence", "context": {"topic": "incident"}},
            {"label": "responder", "role": "synthesizer", "reason": "draft_response", "context": {"topic": "response"}}
        ]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "coordinate-hierarchy".to_string(),
                format!("--payload={}", hierarchy_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--swarm-state-path={}", swarm_state_path.display()),
            ],
        ),
        0
    );
    let hierarchy_receipt = latest_receipt(&state_path);
    assert_eq!(
        hierarchy_receipt["payload"]["hierarchy"]["degraded"].as_bool(),
        Some(true)
    );
    assert_eq!(
        hierarchy_receipt["payload"]["hierarchy"]["agents"]
            .as_array()
            .map(|rows| rows.len()),
        Some(1)
    );

    let rewind_payload = json!({
        "session_id": primary_session_id
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "rewind-session".to_string(),
                format!("--payload={}", rewind_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--swarm-state-path={}", swarm_state_path.display()),
            ],
        ),
        0
    );
    let rewind_receipt = latest_receipt(&state_path);
    assert_eq!(
        rewind_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-010.6")
    );

    let eval_payload = json!({
        "session_id": primary_session_id,
        "profile": "pure",
        "score": 0.82,
        "metrics": {"success": 1, "handoffs": 2}
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "record-evaluation".to_string(),
                format!("--payload={}", eval_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let eval_receipt = latest_receipt(&state_path);
    assert_eq!(
        eval_receipt["payload"]["evaluation"]["score"].as_f64(),
        Some(0.82)
    );

    let sandbox_payload = json!({
        "language": "python",
        "profile": "pure",
        "cloud": "gcp",
        "bridge_path": "adapters/polyglot/google_adk_runtime_bridge.ts"
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "sandbox-execute".to_string(),
                format!("--payload={}", sandbox_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let sandbox_receipt = latest_receipt(&state_path);
    assert_eq!(
        sandbox_receipt["payload"]["sandbox"]["reason_code"].as_str(),
        Some("cloud_integration_requires_rich_profile")
    );

    let deploy_payload = json!({
        "shell_name": "google-adk-ui",
        "shell_path": "client/runtime/systems/workflow/google_adk_bridge.ts",
        "target": "local",
        "artifact_path": "apps/google-adk-ui"
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "deploy-shell".to_string(),
                format!("--payload={}", deploy_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let deploy_receipt = latest_receipt(&state_path);
    assert_eq!(
        deploy_receipt["payload"]["deployment"]["authority_delegate"].as_str(),
        Some("core://google-adk-bridge")
    );

    let status_receipt = {
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
        latest_receipt(&state_path)
    };
    assert_eq!(status_receipt["payload"]["a2a_agents"].as_u64(), Some(1));
    assert_eq!(status_receipt["payload"]["llm_agents"].as_u64(), Some(1));
    assert_eq!(
        status_receipt["payload"]["tool_manifests"].as_u64(),
        Some(1)
    );
    assert_eq!(status_receipt["payload"]["hierarchies"].as_u64(), Some(1));
    assert_eq!(
        status_receipt["payload"]["approval_records"].as_u64(),
        Some(1)
    );
    assert_eq!(
        status_receipt["payload"]["session_snapshots"].as_u64(),
        Some(1)
    );
    assert_eq!(status_receipt["payload"]["evaluations"].as_u64(), Some(1));
    assert_eq!(status_receipt["payload"]["sandbox_runs"].as_u64(), Some(1));
    assert_eq!(status_receipt["payload"]["deployments"].as_u64(), Some(1));
    assert_eq!(
        status_receipt["payload"]["runtime_bridges"].as_u64(),
        Some(1)
    );
}
