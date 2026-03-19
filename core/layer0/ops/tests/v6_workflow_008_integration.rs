// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V6-WORKFLOW-008.1, V6-WORKFLOW-008.2, V6-WORKFLOW-008.3,
// V6-WORKFLOW-008.4, V6-WORKFLOW-008.5, V6-WORKFLOW-008.6,
// V6-WORKFLOW-008.7, V6-WORKFLOW-008.8, V6-WORKFLOW-008.9

use protheus_ops_core::semantic_kernel_bridge;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_bridge(root: &Path, args: &[String]) -> i32 {
    semantic_kernel_bridge::run(root, args)
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
fn workflow_008_service_plugin_planner_and_connectors_emit_receipts() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/semantic/latest.json");
    let history_path = root.path().join("state/semantic/history.jsonl");

    let service_payload = json!({
        "name": "semantic-kernel-enterprise",
        "role": "orchestrator",
        "execution_surface": "workflow-executor",
        "default_budget": 640,
        "capabilities": ["planning", "plugins", "memory"],
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-service".to_string(),
                format!("--payload={}", service_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let state = read_json(&state_path);
    let service_id = state
        .get("services")
        .and_then(Value::as_object)
        .and_then(|rows| rows.keys().next().cloned())
        .expect("service id");
    let service_receipt = latest_receipt(&state_path);
    assert_eq!(
        service_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-008.1")
    );

    let plugin_payload = json!({
        "service_id": service_id,
        "plugin_name": "faq_router",
        "plugin_kind": "prompt",
        "bridge_path": "adapters/cognition/skills/mcp/mcp_gateway.ts",
        "entrypoint": "invoke",
        "prompt_template": "Summarize {{topic}} for {{audience}}"
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-plugin".to_string(),
                format!("--payload={}", plugin_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let state = read_json(&state_path);
    let plugin_id = state
        .get("plugins")
        .and_then(Value::as_object)
        .and_then(|rows| rows.keys().next().cloned())
        .expect("plugin id");

    let invoke_plugin_payload = json!({
        "plugin_id": plugin_id,
        "args": { "topic": "semantic kernel", "audience": "operators" }
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "invoke-plugin".to_string(),
                format!("--payload={}", invoke_plugin_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let plugin_receipt = latest_receipt(&state_path);
    assert!(plugin_receipt["payload"]["invocation"]["rendered"]
        .as_str()
        .unwrap_or_default()
        .contains("semantic kernel"));

    let plan_payload = json!({
        "service_id": service_id,
        "objective": "summarize and route an enterprise support case",
        "functions": [
            { "name": "route", "score": 0.7, "description": "Route case" },
            { "name": "summarize", "score": 0.6, "description": "Summarize case" }
        ]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "plan".to_string(),
                format!("--payload={}", plan_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let plan_receipt = latest_receipt(&state_path);
    assert_eq!(
        plan_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-008.4")
    );
    assert!(plan_receipt["payload"]["plan"]["steps"]
        .as_array()
        .map(|rows| rows.len() >= 2)
        .unwrap_or(false));

    let vector_payload = json!({
        "name": "sk-memory",
        "provider": "memory-plane",
        "context_budget_tokens": 64,
        "documents": [
            { "text": "semantic kernel planner maps functions to workflow steps" },
            { "text": "azure ai search connector is remote and rich profile only" }
        ]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-vector-connector".to_string(),
                format!("--payload={}", vector_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let state = read_json(&state_path);
    let connector_id = state
        .get("vector_connectors")
        .and_then(Value::as_object)
        .and_then(|rows| rows.keys().next().cloned())
        .expect("connector id");
    let retrieve_payload = json!({
        "connector_id": connector_id,
        "query": "planner workflow steps",
        "profile": "rich",
        "top_k": 2
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "retrieve".to_string(),
                format!("--payload={}", retrieve_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let retrieve_receipt = latest_receipt(&state_path);
    assert!(retrieve_receipt["payload"]["results"]
        .as_array()
        .map(|rows| !rows.is_empty())
        .unwrap_or(false));

    let llm_payload = json!({
        "name": "sk-azure-openai",
        "provider": "azure-openai",
        "model": "gpt-4.1",
        "modalities": ["text", "vision"]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-llm-connector".to_string(),
                format!("--payload={}", llm_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let state = read_json(&state_path);
    let llm_connector_id = state
        .get("llm_connectors")
        .and_then(Value::as_object)
        .and_then(|rows| rows.keys().next().cloned())
        .expect("llm connector id");
    let route_payload = json!({
        "connector_id": llm_connector_id,
        "modality": "vision",
        "profile": "rich",
        "prompt": "Inspect this screenshot"
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "route-llm".to_string(),
                format!("--payload={}", route_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let route_receipt = latest_receipt(&state_path);
    assert_eq!(
        route_receipt["payload"]["route"]["modality"].as_str(),
        Some("vision")
    );
}

#[test]
fn workflow_008_collaboration_structured_output_enterprise_and_dotnet_are_receipted() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/semantic/latest.json");
    let history_path = root.path().join("state/semantic/history.jsonl");
    let swarm_state_path = root.path().join("state/semantic/swarm.json");

    let service_payload = json!({
        "name": "semantic-kernel-enterprise",
        "role": "orchestrator",
        "execution_surface": "workflow-executor"
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-service".to_string(),
                format!("--payload={}", service_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );

    let collaboration_payload = json!({
        "name": "semantic-kernel-team",
        "agents": [
            { "label": "planner", "role": "planner", "task": "plan enterprise request", "budget": 240 },
            { "label": "executor", "role": "executor", "task": "execute enterprise request", "budget": 240 }
        ],
        "edges": [
            { "from": "planner", "to": "executor", "relation": "handoff", "importance": 0.85, "reason": "planner_to_executor" }
        ]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "collaborate".to_string(),
                format!("--payload={}", collaboration_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--swarm-state-path={}", swarm_state_path.display()),
            ],
        ),
        0
    );
    let collaboration_receipt = latest_receipt(&state_path);
    assert_eq!(
        collaboration_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-008.3")
    );
    assert!(
        collaboration_receipt["payload"]["collaboration"]["network_id"]
            .as_str()
            .map(|row| !row.is_empty())
            .unwrap_or(false)
    );

    let structured_payload = json!({
        "schema": {
            "type": "object",
            "required": ["answer"],
            "properties": {
                "answer": { "type": "string" },
                "confidence": { "type": "number" }
            }
        },
        "output": {
            "answer": "Use the workflow executor.",
            "confidence": 0.91
        },
        "process": {
            "steps": [
                { "id": "capture", "next": "route" },
                { "id": "route" }
            ]
        }
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "validate-structured-output".to_string(),
                format!("--payload={}", structured_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let structured_receipt = latest_receipt(&state_path);
    assert_eq!(
        structured_receipt["payload"]["record"]["process_report"]["validated"].as_bool(),
        Some(true)
    );

    let enterprise_payload = json!({
        "event_type": "semantic-kernel.azure.deployment",
        "sink": "otel",
        "cloud": "azure",
        "endpoint": "https://example.azure.com/otel",
        "deployment": { "resource_group": "rg-ops", "service": "aoai-prod" }
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "emit-enterprise-event".to_string(),
                format!("--payload={}", enterprise_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let enterprise_receipt = latest_receipt(&state_path);
    assert_eq!(
        enterprise_receipt["payload"]["event"]["cloud"].as_str(),
        Some("azure")
    );

    let dotnet_payload = json!({
        "name": "semantic-kernel-dotnet",
        "bridge_path": "adapters/polyglot/semantic_kernel_dotnet_bridge.ts",
        "capabilities": ["plugin", "agent"]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-dotnet-bridge".to_string(),
                format!("--payload={}", dotnet_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let state = read_json(&state_path);
    let bridge_id = state
        .get("dotnet_bridges")
        .and_then(Value::as_object)
        .and_then(|rows| rows.keys().next().cloned())
        .expect("bridge id");
    let invoke_dotnet_payload = json!({
        "bridge_id": bridge_id,
        "operation": "invoke-plugin",
        "dry_run": true,
        "args": { "plugin": "faq_router", "input": "hello" }
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "invoke-dotnet-bridge".to_string(),
                format!("--payload={}", invoke_dotnet_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let dotnet_receipt = latest_receipt(&state_path);
    assert_eq!(
        dotnet_receipt["payload"]["invocation"]["mode"].as_str(),
        Some("dry_run")
    );
}
