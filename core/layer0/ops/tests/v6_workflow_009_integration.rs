// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V6-WORKFLOW-009.1, V6-WORKFLOW-009.2, V6-WORKFLOW-009.3,
// V6-WORKFLOW-009.4, V6-WORKFLOW-009.5, V6-WORKFLOW-009.6, V6-WORKFLOW-009.7

use protheus_ops_core::llamaindex_bridge;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_bridge(root: &Path, args: &[String]) -> i32 {
    llamaindex_bridge::run(root, args)
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
fn workflow_009_indexes_agents_ingestion_memory_routing_traces_and_connectors_emit_receipts() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/llamaindex/latest.json");
    let history_path = root.path().join("state/llamaindex/history.jsonl");
    let swarm_state_path = root.path().join("state/llamaindex/swarm.json");

    let index_payload = json!({
        "name": "llamaindex-ops",
        "retrieval_modes": ["hybrid", "vector", "graph"],
        "query_engine": "router",
        "documents": [
            {"text": "llamaindex hybrid retrieval composes vector search with graph context", "metadata": {"kind": "graph", "source": "guide-1"}},
            {"text": "agent workflows route tool calls through the authoritative swarm runtime", "metadata": {"kind": "text", "source": "guide-2"}}
        ]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-index".to_string(),
                format!("--payload={}", index_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let state = read_json(&state_path);
    let index_id = state
        .get("indexes")
        .and_then(Value::as_object)
        .and_then(|rows| rows.keys().next().cloned())
        .expect("index id");
    let register_receipt = latest_receipt(&state_path);
    assert_eq!(
        register_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-009.1")
    );

    let query_payload = json!({
        "index_id": index_id,
        "query": "hybrid retrieval graph context",
        "mode": "hybrid",
        "top_k": 2,
        "profile": "rich"
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "query".to_string(),
                format!("--payload={}", query_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let query_receipt = latest_receipt(&state_path);
    assert!(query_receipt["payload"]["results"]
        .as_array()
        .map(|rows| !rows.is_empty())
        .unwrap_or(false));

    let workflow_payload = json!({
        "name": "llamaindex-agent-team",
        "query": "triage a support incident",
        "budget": 480,
        "agent_label": "llamaindex-coordinator",
        "tools": [
            {
                "name": "mcp_gateway",
                "bridge_path": "adapters/cognition/skills/mcp/mcp_gateway.ts",
                "entrypoint": "invoke",
                "args": {"op": "status"}
            }
        ],
        "handoffs": [
            {"label": "researcher", "role": "retriever", "task": "retrieve support evidence", "budget": 180, "reason": "collect_evidence", "importance": 0.82},
            {"label": "responder", "role": "synthesizer", "task": "draft final answer", "budget": 180, "reason": "respond", "importance": 0.76}
        ]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "run-agent-workflow".to_string(),
                format!("--payload={}", workflow_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--swarm-state-path={}", swarm_state_path.display()),
            ],
        ),
        0
    );
    let workflow_receipt = latest_receipt(&state_path);
    assert_eq!(
        workflow_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-009.2")
    );
    assert_eq!(
        workflow_receipt["payload"]["workflow"]["handoffs"]
            .as_array()
            .map(|rows| rows.len()),
        Some(2)
    );

    let ingestion_payload = json!({
        "loader_name": "llamaindex-pdf-loader",
        "modality": "image",
        "profile": "pure",
        "bridge_path": "adapters/cognition/skills/mcp/mcp_gateway.ts",
        "assets": ["guide.pdf", "diagram.png"]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "ingest-multimodal".to_string(),
                format!("--payload={}", ingestion_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let ingestion_receipt = latest_receipt(&state_path);
    assert_eq!(
        ingestion_receipt["payload"]["ingestion"]["degraded"].as_bool(),
        Some(true)
    );

    let evaluation_payload = json!({
        "memory_key": "incident-memory",
        "entries": [
            {"id": "mem-1", "text": "Hybrid retrieval should surface graph-backed context."},
            {"id": "mem-2", "text": "Swarm handoffs must be receipted."}
        ],
        "expected_hits": ["mem-1", "mem-2"],
        "actual_hits": ["mem-1"]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "record-memory-eval".to_string(),
                format!("--payload={}", evaluation_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let eval_receipt = latest_receipt(&state_path);
    assert_eq!(
        eval_receipt["payload"]["evaluation"]["recall"].as_f64(),
        Some(0.5)
    );

    let conditional_payload = json!({
        "name": "llamaindex-router",
        "context": {"intent": "support"},
        "steps": [
            {"id": "start", "condition": {"field": "intent", "equals": "support"}, "next": "support-lane", "else": "generic-lane", "checkpoint_key": "cp-start"},
            {"id": "support-lane", "checkpoint_key": "cp-support"},
            {"id": "generic-lane", "checkpoint_key": "cp-generic"}
        ]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "run-conditional-workflow".to_string(),
                format!("--payload={}", conditional_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let conditional_receipt = latest_receipt(&state_path);
    assert_eq!(
        conditional_receipt["payload"]["workflow"]["visited"][0]["matched"].as_bool(),
        Some(true)
    );

    let trace_payload = json!({
        "trace_id": "llx-trace-1",
        "stage": "retrieval",
        "message": "llamaindex query trace recorded",
        "data": {"top_k": 2}
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "emit-trace".to_string(),
                format!("--payload={}", trace_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let trace_receipt = latest_receipt(&state_path);
    assert_eq!(
        trace_receipt["payload"]["trace"]["trace_id"].as_str(),
        Some("llx-trace-1")
    );

    let connector_payload = json!({
        "name": "llamaindex-mcp",
        "bridge_path": "adapters/cognition/skills/mcp/mcp_gateway.ts",
        "capabilities": ["load", "query"],
        "supported_profiles": ["rich", "pure"],
        "documents": [
            {"text": "mcp connectors expose governed loader manifests", "metadata": {"source": "mcp-docs"}},
            {"text": "connector query receipts fail closed when unsupported", "metadata": {"source": "policy"}}
        ]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-connector".to_string(),
                format!("--payload={}", connector_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let state = read_json(&state_path);
    let connector_id = state
        .get("connectors")
        .and_then(Value::as_object)
        .and_then(|rows| rows.keys().next().cloned())
        .expect("connector id");
    let connector_query_payload = json!({
        "connector_id": connector_id,
        "query": "governed loader manifests",
        "profile": "rich"
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "connector-query".to_string(),
                format!("--payload={}", connector_query_payload),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let connector_receipt = latest_receipt(&state_path);
    assert!(connector_receipt["payload"]["results"]
        .as_array()
        .map(|rows| !rows.is_empty())
        .unwrap_or(false));

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
    assert_eq!(status_receipt["payload"]["indexes"].as_u64(), Some(1));
    assert_eq!(
        status_receipt["payload"]["agent_workflows"].as_u64(),
        Some(1)
    );
    assert_eq!(status_receipt["payload"]["ingestions"].as_u64(), Some(1));
    assert_eq!(status_receipt["payload"]["evaluations"].as_u64(), Some(1));
    assert_eq!(
        status_receipt["payload"]["conditional_workflows"].as_u64(),
        Some(1)
    );
    assert_eq!(status_receipt["payload"]["traces"].as_u64(), Some(1));
    assert_eq!(status_receipt["payload"]["connectors"].as_u64(), Some(1));
}
