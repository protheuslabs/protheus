// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V6-WORKFLOW-014.1, V6-WORKFLOW-014.2, V6-WORKFLOW-014.3,
// V6-WORKFLOW-014.4, V6-WORKFLOW-014.5, V6-WORKFLOW-014.6, V6-WORKFLOW-014.7

use protheus_ops_core::langchain_bridge;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_bridge(root: &Path, args: &[String]) -> i32 {
    langchain_bridge::run(root, args)
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
fn workflow_014_chains_agents_memory_integrations_prompt_traces_and_checkpoints_emit_receipts() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/langchain/latest.json");
    let history_path = root.path().join("state/langchain/history.jsonl");
    let swarm_state_path = root.path().join("state/langchain/swarm.json");

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-chain".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "incident-chain",
                        "runnables": [
                            {"id": "retrieve", "runnable_type": "retriever", "parallel": true, "budget": 192},
                            {"id": "rank", "runnable_type": "ranker", "parallel": true, "budget": 160},
                            {"id": "answer", "runnable_type": "llm", "spawn": true, "budget": 256}
                        ]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let chain_receipt = latest_receipt(&state_path);
    assert_eq!(
        chain_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-014.1")
    );
    let chain_id = chain_receipt["payload"]["chain"]["chain_id"]
        .as_str()
        .expect("chain id")
        .to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "execute-chain".to_string(),
                format!(
                    "--payload={}",
                    json!({"chain_id": chain_id, "profile": "pure"})
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--swarm-state-path={}", swarm_state_path.display()),
            ],
        ),
        0
    );
    let run_receipt = latest_receipt(&state_path);
    assert_eq!(
        run_receipt["payload"]["run"]["degraded"].as_bool(),
        Some(true)
    );
    assert_eq!(
        run_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-014.1")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "run-deep-agent".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "incident-deep-agent",
                        "instruction": "triage billing incident and choose tools",
                        "profile": "pure",
                        "tools": [
                            {"name": "billing_lookup", "description": "billing incident ledger lookup", "tags": ["billing", "incident"]},
                            {"name": "general_faq", "description": "general frequently asked questions", "tags": ["faq"]},
                            {"name": "ops_console", "description": "operational incident tool", "tags": ["incident"]}
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
    let agent_receipt = latest_receipt(&state_path);
    assert_eq!(
        agent_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-014.2")
    );
    assert_eq!(
        agent_receipt["payload"]["agent"]["selected_tools"]
            .as_array()
            .map(|rows| !rows.is_empty()),
        Some(true)
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-memory-bridge".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "incident-memory",
                        "documents": [
                            {"text": "billing incident playbook", "metadata": {"kind": "graph", "source": "playbook"}},
                            {"text": "general faq on accounts", "metadata": {"kind": "faq", "source": "faq"}}
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
    let memory_id = memory_receipt["payload"]["memory_bridge"]["memory_id"]
        .as_str()
        .expect("memory id")
        .to_string();
    assert_eq!(
        memory_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-014.3")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "recall-memory".to_string(),
                format!(
                    "--payload={}",
                    json!({"memory_id": memory_id, "query": "billing incident", "mode": "hybrid", "profile": "pure", "top_k": 4})
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let recall_receipt = latest_receipt(&state_path);
    assert_eq!(
        recall_receipt["payload"]["recall"]["degraded"].as_bool(),
        Some(true)
    );
    assert_eq!(
        recall_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-014.3")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "import-integration".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "langchain-qdrant",
                        "integration_type": "vector-store",
                        "assets": [{"kind": "package", "name": "@langchain/qdrant"}]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let integration_receipt = latest_receipt(&state_path);
    assert_eq!(
        integration_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-014.4")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "route-prompt".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "incident-prompt",
                        "profile": "pure",
                        "provider": "anthropic",
                        "fallback_provider": "openai-compatible",
                        "model": "claude-3-7-sonnet",
                        "template": "Answer {{question}} with {{context}}",
                        "variables": {"question": "What happened?", "context": "billing service degraded"},
                        "supported_providers": ["anthropic", "openai-compatible"]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let prompt_receipt = latest_receipt(&state_path);
    assert_eq!(
        prompt_receipt["payload"]["route"]["degraded"].as_bool(),
        Some(true)
    );
    assert_eq!(
        prompt_receipt["payload"]["route"]["selected_provider"].as_str(),
        Some("openai-compatible")
    );
    assert_eq!(
        prompt_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-014.5")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "record-trace".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "trace_id": "incident-trace",
                        "steps": [
                            {"stage": "retrieve", "message": "retrieved evidence"},
                            {"stage": "answer", "message": "drafted response"}
                        ]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let trace_receipt = latest_receipt(&state_path);
    assert_eq!(
        trace_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-014.6")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "checkpoint-run".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "chain_id": chain_receipt["payload"]["chain"]["chain_id"],
                        "profile": "pure",
                        "prototype_label": "incident-fast-loop",
                        "state_snapshot": {"retrieved": 2, "drafted": true}
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--swarm-state-path={}", swarm_state_path.display()),
            ],
        ),
        0
    );
    let checkpoint_receipt = latest_receipt(&state_path);
    assert_eq!(
        checkpoint_receipt["payload"]["checkpoint"]["degraded"].as_bool(),
        Some(true)
    );
    assert_eq!(
        checkpoint_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-014.7")
    );

    let output_dir = root
        .path()
        .join("client/runtime/local/state/langchain-shell");
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "assimilate-intake".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "output_dir": output_dir.strip_prefix(root.path()).unwrap().display().to_string(),
                        "package_name": "langchain-shell"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let intake_receipt = latest_receipt(&state_path);
    assert_eq!(output_dir.join("package.json").exists(), true);
    assert_eq!(
        intake_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-014.4")
    );
}
