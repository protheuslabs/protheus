// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V6-WORKFLOW-006.1, V6-WORKFLOW-006.2, V6-WORKFLOW-006.3,
// V6-WORKFLOW-006.4, V6-WORKFLOW-006.5, V6-WORKFLOW-006.6,
// V6-WORKFLOW-006.7, V6-WORKFLOW-006.8

use protheus_ops_core::metagpt_bridge;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_bridge(root: &Path, args: &[String]) -> i32 {
    metagpt_bridge::run(root, args)
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
fn workflow_006_metagpt_bridge_emits_receipted_company_sop_pr_debate_requirements_oversight_trace_and_config(
) {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/metagpt/latest.json");
    let history_path = root.path().join("state/metagpt/history.jsonl");
    let approval_queue_path = root.path().join("state/metagpt/reviews.yaml");
    let trace_path = root.path().join("state/metagpt/trace.jsonl");

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-company".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "company_name": "launch_company",
                        "product_goal": "ship launch plan",
                        "roles": [
                            {"role": "pm", "goal": "shape scope"},
                            {"role": "architect", "goal": "design system"},
                            {"role": "engineer", "goal": "implement changes"}
                        ],
                        "org_chart": ["pm", "architect", "engineer"]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let company_receipt = latest_receipt(&state_path);
    assert_eq!(
        company_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-006.1")
    );
    let company_id = company_receipt["payload"]["company"]["company_id"]
        .as_str()
        .unwrap()
        .to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "run-sop".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "company_id": company_id,
                        "pipeline_name": "prd_to_release",
                        "steps": [
                            {"name": "requirements", "owner": "pm"},
                            {"name": "design", "owner": "architect"},
                            {"name": "build", "owner": "engineer"}
                        ],
                        "checkpoint_labels": ["req", "design", "build"],
                        "budget": {"tokens": 1800, "max_stages": 3}
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let sop_receipt = latest_receipt(&state_path);
    assert_eq!(
        sop_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-006.2")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "simulate-pr".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "task": "add launch summary",
                        "changed_files": ["client/runtime/lib/metagpt_bridge.ts", "docs/workspace/SRS.md"],
                        "generated_patch_summary": "adds governed workflow surface",
                        "tests": ["node tests/client-memory-tools/metagpt_bridge.test.js"],
                        "sandbox_mode": "readonly",
                        "bridge_path": "adapters/protocol/metagpt_config_bridge.ts"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let pr_receipt = latest_receipt(&state_path);
    assert_eq!(
        pr_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-006.3")
    );
    assert_eq!(
        pr_receipt["payload"]["pr_simulation"]["review_required"],
        json!(true)
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "run-debate".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "proposal": "ship launch dashboard",
                        "participants": ["pm", "architect", "engineer"],
                        "rounds": 3,
                        "profile": "tiny-max",
                        "context_budget": 800,
                        "recommendation": "revise"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let debate_receipt = latest_receipt(&state_path);
    assert_eq!(
        debate_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-006.4")
    );
    assert_eq!(debate_receipt["payload"]["debate"]["degraded"], json!(true));
    assert_eq!(debate_receipt["payload"]["debate"]["rounds"], json!(2));

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "plan-requirements".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "prd_title": "Launch Assistant",
                        "requirements": ["capture FAQ context", "draft launch reply"],
                        "stakeholders": ["ops", "marketing"],
                        "auto_recall_query": "launch assistant"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let plan_receipt = latest_receipt(&state_path);
    assert_eq!(
        plan_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-006.5")
    );
    assert_eq!(
        plan_receipt["payload"]["requirements_plan"]["stories"]
            .as_array()
            .map(|v| v.len()),
        Some(2)
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "record-oversight".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "operator_id": "human-reviewer",
                        "action": "approve",
                        "target_id": company_id,
                        "notes": "company setup approved"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--approval-queue-path={}", approval_queue_path.display()),
            ],
        ),
        0
    );
    let oversight_receipt = latest_receipt(&state_path);
    assert_eq!(
        oversight_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-006.6")
    );
    assert!(approval_queue_path.exists());

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "record-pipeline-trace".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "run_id": "pipeline-1",
                        "stage": "design",
                        "message": "architect completed design",
                        "metrics": {"latency_ms": 55}
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
        Some("V6-WORKFLOW-006.7")
    );
    assert!(trace_path.exists());

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "ingest-config".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "config_yaml": "roles:\n  - pm\n  - engineer\nsops:\n  - requirements\n  - build\nextensions:\n  - docs\n",
                        "bridge_path": "adapters/protocol/metagpt_config_bridge.ts"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let config_receipt = latest_receipt(&state_path);
    assert_eq!(
        config_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-006.8")
    );
    assert_eq!(
        config_receipt["payload"]["config"]["bridge_path"],
        json!("adapters/protocol/metagpt_config_bridge.ts")
    );
}
