// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V6-WORKFLOW-017.1, V6-WORKFLOW-017.2, V6-WORKFLOW-017.3,
// V6-WORKFLOW-017.4, V6-WORKFLOW-017.5, V6-WORKFLOW-017.6, V6-WORKFLOW-017.7,
// V6-WORKFLOW-017.8

use protheus_ops_core::dspy_bridge;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_bridge(root: &Path, args: &[String]) -> i32 {
    dspy_bridge::run(root, args)
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
fn workflow_017_signatures_compile_optimize_assert_multihop_eval_and_intake_emit_receipts() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/dspy/latest.json");
    let history_path = root.path().join("state/dspy/history.jsonl");
    let swarm_state_path = root.path().join("state/dspy/swarm.json");

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-signature".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "incident_signature",
                        "predictor_type": "chain_of_thought",
                        "input_fields": ["question", "context"],
                        "output_fields": ["answer", "confidence"],
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let signature_receipt = latest_receipt(&state_path);
    assert_eq!(
        signature_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-017.1")
    );
    let signature_id = signature_receipt["payload"]["signature"]["signature_id"]
        .as_str()
        .expect("signature id")
        .to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "compile-program".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "incident_program",
                        "modules": [
                            {"label": "retrieve", "signature_id": signature_id, "strategy": "predict"},
                            {"label": "answer", "signature_id": signature_id, "strategy": "chain_of_thought"}
                        ]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let program_receipt = latest_receipt(&state_path);
    assert_eq!(
        program_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-017.2")
    );
    let program_id = program_receipt["payload"]["program"]["program_id"]
        .as_str()
        .expect("program id")
        .to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "optimize-program".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "program_id": program_id,
                        "profile": "pure",
                        "optimizer_kind": "teleprompter",
                        "max_trials": 8,
                        "baseline_score": 0.40
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let optimization_receipt = latest_receipt(&state_path);
    assert_eq!(
        optimization_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-017.3")
    );
    let optimization_id = optimization_receipt["payload"]["optimization"]["optimization_id"]
        .as_str()
        .expect("optimization id")
        .to_string();
    assert_eq!(
        optimization_receipt["payload"]["optimization"]["degraded"],
        json!(true)
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "assert-program".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "program_id": program_id,
                        "assertions": [{"field": "answer"}, {"field": "confidence"}],
                        "candidate_output": {"answer": "billing outage"},
                        "attempt": 1,
                        "max_retries": 1,
                        "context_budget": 512,
                        "profile": "rich"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let assertion_receipt = latest_receipt(&state_path);
    assert_eq!(
        assertion_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-017.4")
    );
    assert_eq!(
        assertion_receipt["payload"]["assertion"]["status"].as_str(),
        Some("retry")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "import-integration".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "dspy-retriever",
                        "kind": "retriever",
                        "bridge_path": "adapters/protocol/dspy_program_bridge.ts",
                        "source": "hybrid search backend",
                        "capabilities": ["retrieve", "rank"]
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
        Some("V6-WORKFLOW-017.7")
    );
    let integration_id = integration_receipt["payload"]["integration"]["integration_id"]
        .as_str()
        .expect("integration id")
        .to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "execute-multihop".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "name": "incident-multihop",
                        "program_id": program_id,
                        "integration_ids": [integration_id],
                        "profile": "pure",
                        "hops": [
                            {"label": "plan", "signature_id": signature_id, "query": "plan the search", "tool_tags": ["plan"]},
                            {"label": "retrieve", "signature_id": signature_id, "query": "retrieve incident evidence", "tool_tags": ["retrieve"]},
                            {"label": "answer", "signature_id": signature_id, "query": "answer the user", "tool_tags": ["answer"]}
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
    let multihop_receipt = latest_receipt(&state_path);
    assert_eq!(
        multihop_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-017.5")
    );
    assert_eq!(
        multihop_receipt["payload"]["multihop"]["degraded"],
        json!(true)
    );
    assert_eq!(
        multihop_receipt["payload"]["multihop"]["hop_count"],
        json!(2)
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "record-benchmark".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "program_id": program_id,
                        "benchmark_name": "incident_eval",
                        "profile": "rich",
                        "score": 0.77,
                        "metrics": {"exact_match": 0.8, "latency_ms": 420}
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let benchmark_receipt = latest_receipt(&state_path);
    assert_eq!(
        benchmark_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-017.6")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "record-optimization-trace".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "program_id": program_id,
                        "optimization_id": optimization_id,
                        "seed": 13,
                        "reproducible": true,
                        "message": "teleprompter candidate improved recall"
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
        Some("V6-WORKFLOW-017.8")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "assimilate-intake".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "shell_name": "dspy-shell",
                        "shell_path": "client/runtime/systems/workflow/dspy_bridge.ts",
                        "target": "local",
                        "artifact_path": "adapters/protocol/dspy_program_bridge.ts"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let intake_receipt = latest_receipt(&state_path);
    assert_eq!(
        intake_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-017.7")
    );
    assert_eq!(
        intake_receipt["payload"]["intake"]["authority_delegate"],
        json!("core://dspy-bridge")
    );
}
