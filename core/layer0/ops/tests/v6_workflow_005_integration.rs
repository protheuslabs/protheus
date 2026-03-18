// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V6-WORKFLOW-005.1, V6-WORKFLOW-005.2, V6-WORKFLOW-005.3,
// V6-WORKFLOW-005.4, V6-WORKFLOW-005.5, V6-WORKFLOW-005.6, V6-WORKFLOW-005.7

use protheus_ops_core::dify_bridge;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_bridge(root: &Path, args: &[String]) -> i32 {
    dify_bridge::run(root, args)
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
fn workflow_005_dify_bridge_emits_receipted_canvas_rag_app_dashboard_provider_flow_and_audit_trace() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/dify/latest.json");
    let history_path = root.path().join("state/dify/history.jsonl");
    let swarm_state_path = root.path().join("state/dify/swarm.json");
    let trace_path = root.path().join("state/dify/audit_trace.jsonl");
    let dashboard_dir = root.path().join("shell/dify-dashboard");

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-canvas".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "support_canvas",
                        "nodes": [
                            {"id": "input", "kind": "trigger"},
                            {"id": "retrieve", "kind": "retriever"},
                            {"id": "answer", "kind": "llm"}
                        ],
                        "edges": [
                            {"from": "input", "to": "retrieve", "condition": {"field": "route", "equals": "kb"}},
                            {"from": "retrieve", "to": "answer", "default": true}
                        ],
                        "drag_and_drop": true
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let canvas_receipt = latest_receipt(&state_path);
    assert_eq!(canvas_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-005.1"));
    let canvas_id = canvas_receipt["payload"]["canvas"]["canvas_id"].as_str().unwrap().to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "sync-knowledge-base".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "knowledge_base_name": "support_kb",
                        "profile": "tiny-max",
                        "query": "billing",
                        "documents": [
                            {"id": "doc-1", "title": "Billing FAQ", "text": "Billing cycles and invoices", "modality": "text"},
                            {"id": "doc-2", "title": "Invoice Screenshot", "text": "Billing screenshot", "modality": "image"}
                        ],
                        "context_budget": 2048,
                        "bridge_path": "adapters/protocol/dify_connector_bridge.ts"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let kb_receipt = latest_receipt(&state_path);
    assert_eq!(kb_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-005.2"));
    assert_eq!(kb_receipt["payload"]["knowledge_base"]["degraded"], json!(true));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-agent-app".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "app_name": "support_agent",
                        "tools": [
                            {"name": "kb_search", "kind": "retrieval"},
                            {"name": "delete_customer", "kind": "destructive"}
                        ],
                        "plugins": ["slack", "zendesk"],
                        "modalities": ["text", "image"],
                        "bridge_path": "adapters/protocol/dify_connector_bridge.ts"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let app_receipt = latest_receipt(&state_path);
    assert_eq!(app_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-005.3"));
    assert_eq!(app_receipt["payload"]["agent_app"]["denied_tools"].as_array().map(|v| v.len()), Some(1));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "publish-dashboard".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "dashboard_name": "support_dashboard",
                        "team": "ops",
                        "environment": "staging",
                        "publish_action": "deploy",
                        "deploy_target": "internal-cluster"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--dashboard-dir={}", dashboard_dir.display()),
            ],
        ),
        0
    );
    let dashboard_receipt = latest_receipt(&state_path);
    assert_eq!(dashboard_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-005.4"));
    assert!(dashboard_dir.exists());

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "route-provider".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "profile": "pure",
                        "modality": "image",
                        "prefer_local": true,
                        "local_models": ["qwen-vl-local"],
                        "providers": ["openai"],
                        "bridge_path": "adapters/protocol/dify_connector_bridge.ts"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let route_receipt = latest_receipt(&state_path);
    assert_eq!(route_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-005.5"));
    assert_eq!(route_receipt["payload"]["provider_route"]["selected_route"]["route_kind"], json!("local_model"));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "run-conditional-flow".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "flow_name": "support_flow",
                        "profile": "tiny-max",
                        "context": {"route": "kb", "retry": true, "handoff": "agent"},
                        "branches": [
                            {"id": "kb_branch", "condition": {"field": "route", "equals": "kb"}, "target": "retrieve"},
                            {"id": "fallback", "default": true, "target": "answer"}
                        ],
                        "loop": {"max_iterations": 4, "continue_while": {"field": "retry", "equals": true}},
                        "handoffs": [
                            {"when": {"field": "handoff", "equals": "agent"}, "target": "support_agent"}
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
    let flow_receipt = latest_receipt(&state_path);
    assert_eq!(flow_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-005.6"));
    assert_eq!(flow_receipt["payload"]["flow_run"]["degraded"], json!(true));
    assert_eq!(flow_receipt["payload"]["flow_run"]["iterations"], json!(2));
    assert_eq!(flow_receipt["payload"]["flow_run"]["selected_branch"]["target"], json!("retrieve"));
    assert_eq!(flow_receipt["payload"]["flow_run"]["handoff_target"], json!("support_agent"));
    let swarm_record = read_json(&swarm_state_path);
    assert_eq!(swarm_record["selected_target"], json!("retrieve"));
    assert_eq!(swarm_record["iterations"], json!(2));
    let _ = canvas_id;

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "record-audit-trace".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "stage": "deploy",
                        "message": "published support dashboard",
                        "metrics": {"latency_ms": 31},
                        "logs": ["deploy requested", "deploy approved"],
                        "bridge_path": "client/runtime/lib/dify_bridge.ts"
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
    assert_eq!(trace_receipt["payload"]["claim_evidence"][0]["id"].as_str(), Some("V6-WORKFLOW-005.7"));
    assert!(trace_path.exists());
}
