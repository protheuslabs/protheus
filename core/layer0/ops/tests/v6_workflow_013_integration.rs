// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V6-WORKFLOW-013.1, V6-WORKFLOW-013.2, V6-WORKFLOW-013.3,
// V6-WORKFLOW-013.4, V6-WORKFLOW-013.5, V6-WORKFLOW-013.6, V6-WORKFLOW-013.7,
// V6-WORKFLOW-013.8

use protheus_ops_core::camel_bridge;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_bridge(root: &Path, args: &[String]) -> i32 {
    camel_bridge::run(root, args)
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
fn workflow_013_society_world_dataset_conversation_benchmark_tools_and_observability_emit_receipts() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/camel/latest.json");
    let history_path = root.path().join("state/camel/history.jsonl");
    let swarm_state_path = root.path().join("state/camel/swarm.json");

    let society_payload = json!({
        "name": "incident-society",
        "roles": [
            {"label": "planner", "role": "coordinator", "goal": "plan response"},
            {"label": "researcher", "role": "retriever", "goal": "gather evidence"},
            {"label": "critic", "role": "reviewer", "goal": "check risks"}
        ],
        "supported_profiles": ["rich", "pure", "tiny-max"]
    });
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-society".to_string(),
                format!("--payload={society_payload}"),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let society_receipt = latest_receipt(&state_path);
    assert_eq!(
        society_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-013.1")
    );
    let society_id = society_receipt["payload"]["society"]["society_id"]
        .as_str()
        .expect("society id")
        .to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "run-society".to_string(),
                format!("--payload={}", json!({"society_id": society_id, "profile": "pure"})),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--swarm-state-path={}", swarm_state_path.display()),
            ],
        ),
        0
    );
    let run_receipt = latest_receipt(&state_path);
    assert_eq!(run_receipt["payload"]["run"]["degraded"].as_bool(), Some(true));
    assert_eq!(
        run_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-013.2")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "simulate-world".to_string(),
                format!("--payload={}", json!({
                    "world_name": "billing-world",
                    "profile": "pure",
                    "seed_state": {"region": "us-west"},
                    "events": [
                        {"id": "e1", "kind": "incident"},
                        {"id": "e2", "kind": "rumor"},
                        {"id": "e3", "kind": "update"}
                    ],
                    "agents_informed": ["planner", "researcher"]
                })),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let world_receipt = latest_receipt(&state_path);
    assert_eq!(world_receipt["payload"]["simulation"]["degraded"].as_bool(), Some(true));
    assert_eq!(
        world_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-013.3")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "import-dataset".to_string(),
                format!("--payload={}", json!({
                    "name": "incident-dataset",
                    "dataset_kind": "society",
                    "records": [
                        {"prompt": "triage", "completion": "collect evidence"},
                        {"prompt": "respond", "completion": "draft summary"}
                    ]
                })),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let dataset_receipt = latest_receipt(&state_path);
    assert_eq!(
        dataset_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-013.4")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "route-conversation".to_string(),
                format!("--payload={}", json!({
                    "name": "incident-chat",
                    "profile": "pure",
                    "code_prompt": "def solve(issue): return issue",
                    "turns": [
                        {"speaker": "planner", "text": "collect data"},
                        {"speaker": "researcher", "text": "billing service down"},
                        {"speaker": "critic", "text": "watch customer impact"},
                        {"speaker": "planner", "text": "draft mitigation"}
                    ],
                    "language_routes": ["python", "markdown"]
                })),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--swarm-state-path={}", swarm_state_path.display()),
            ],
        ),
        0
    );
    let convo_receipt = latest_receipt(&state_path);
    assert_eq!(convo_receipt["payload"]["conversation"]["degraded"].as_bool(), Some(true));
    assert_eq!(
        convo_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-013.5")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "record-crab-benchmark".to_string(),
                format!("--payload={}", json!({
                    "name": "incident-crab",
                    "profile": "pure",
                    "tasks": ["ocr", "retrieval"],
                    "artifacts": [
                        {"media_type": "image/png", "path": "adapters/assets/incident.png"},
                        {"media_type": "text/plain", "path": "adapters/assets/incident.txt"}
                    ],
                    "metrics": {"success": 0.82}
                })),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let benchmark_receipt = latest_receipt(&state_path);
    assert_eq!(benchmark_receipt["payload"]["benchmark"]["degraded"].as_bool(), Some(true));
    assert_eq!(
        benchmark_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-013.6")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-tool-gateway".to_string(),
                format!("--payload={}", json!({
                    "name": "incident-tools",
                    "bridge_path": "adapters/protocol/camel_connector_bridge.ts",
                    "tools": [
                        {"name": "search", "supported_profiles": ["rich", "pure"]},
                        {"name": "email", "supported_profiles": ["rich", "pure"], "requires_approval": true}
                    ]
                })),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let gateway_receipt = latest_receipt(&state_path);
    let gateway_id = gateway_receipt["payload"]["tool_gateway"]["gateway_id"]
        .as_str()
        .expect("gateway id")
        .to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "invoke-tool-gateway".to_string(),
                format!("--payload={}", json!({
                    "gateway_id": gateway_id,
                    "tool_name": "email",
                    "profile": "pure",
                    "approved": false,
                    "args": {"subject": "incident"}
                })),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let invocation_receipt = latest_receipt(&state_path);
    assert_eq!(
        invocation_receipt["payload"]["invocation"]["status"].as_str(),
        Some("denied")
    );
    assert_eq!(
        invocation_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-013.7")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "record-scaling-observation".to_string(),
                format!("--payload={}", json!({
                    "society_id": society_id,
                    "agent_count": 128,
                    "message_count": 4096,
                    "coherence": 0.33,
                    "risk_signals": ["herding", "feedback_loop"],
                    "metrics": {"entropy": 0.71}
                })),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let observation_receipt = latest_receipt(&state_path);
    assert_eq!(
        observation_receipt["payload"]["observation"]["emergent_risk"].as_str(),
        Some("elevated")
    );
    assert_eq!(
        observation_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-013.8")
    );

    let output_dir = "client/runtime/local/state/camel-shell-integration";
    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "assimilate-intake".to_string(),
                format!("--payload={}", json!({
                    "package_name": "camel-shell",
                    "output_dir": output_dir
                })),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    assert!(root.path().join(output_dir).join("package.json").exists());

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
    let state = read_json(&state_path);
    assert_eq!(
        state["societies"].as_object().map(|rows| rows.len()),
        Some(1)
    );
    assert_eq!(
        state["society_runs"].as_object().map(|rows| rows.len()),
        Some(1)
    );
    assert_eq!(
        state["world_simulations"].as_object().map(|rows| rows.len()),
        Some(1)
    );
    assert_eq!(state["datasets"].as_object().map(|rows| rows.len()), Some(1));
    assert_eq!(
        state["conversation_routes"]
            .as_object()
            .map(|rows| rows.len()),
        Some(1)
    );
    assert_eq!(state["benchmarks"].as_object().map(|rows| rows.len()), Some(1));
    assert_eq!(
        state["tool_gateways"].as_object().map(|rows| rows.len()),
        Some(1)
    );
    assert_eq!(
        state["tool_invocations"].as_object().map(|rows| rows.len()),
        Some(1)
    );
    assert_eq!(
        state["scaling_observations"]
            .as_object()
            .map(|rows| rows.len()),
        Some(1)
    );
    assert_eq!(state["intakes"].as_object().map(|rows| rows.len()), Some(1));
}
