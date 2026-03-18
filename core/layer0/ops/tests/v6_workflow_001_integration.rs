// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V6-WORKFLOW-001.1, V6-WORKFLOW-001.2, V6-WORKFLOW-001.3,
// V6-WORKFLOW-001.4, V6-WORKFLOW-001.5, V6-WORKFLOW-001.6,
// V6-WORKFLOW-001.7, V6-WORKFLOW-001.8, V6-WORKFLOW-001.9,
// V6-WORKFLOW-001.10, V6-WORKFLOW-001.11, V6-WORKFLOW-001.12

use protheus_ops_core::shannon_bridge;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_bridge(root: &Path, args: &[String]) -> i32 {
    shannon_bridge::run(root, args)
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
fn workflow_001_shannon_bridge_emits_receipted_patterns_budget_memory_replay_hitl_sandbox_observability_gateway_tools_schedule_desktop_and_p2p(
) {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/shannon/latest.json");
    let history_path = root.path().join("state/shannon/history.jsonl");
    let replay_dir = root.path().join("state/shannon/replays");
    let approval_queue_path = root.path().join("state/shannon/reviews.yaml");
    let trace_path = root.path().join("state/shannon/observability.jsonl");
    let metrics_path = root.path().join("state/shannon/metrics.prom");
    let desktop_history_path = root.path().join("state/shannon/desktop.json");

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-pattern".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "pattern_name": "triage_router",
                        "strategies": ["planner", "executor", "reviewer"],
                        "stages": ["plan", "delegate", "review"],
                        "handoff_graph": [{"from": "planner", "to": "executor"}],
                        "profile": "rich"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let pattern_receipt = latest_receipt(&state_path);
    assert_eq!(
        pattern_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-001.1")
    );
    let pattern_id = pattern_receipt["payload"]["pattern"]["pattern_id"]
        .as_str()
        .unwrap()
        .to_string();

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "guard-budget".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "session_id": "session-1",
                        "token_budget": 1200,
                        "estimated_tokens": 2400,
                        "current_model": "gpt-5.4",
                        "fallback_models": ["gpt-5.4-mini"]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let budget_receipt = latest_receipt(&state_path);
    assert_eq!(
        budget_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-001.2")
    );
    assert_eq!(
        budget_receipt["payload"]["budget_guard"]["action"],
        json!("fallback")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "memory-bridge".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "workspace_id": "workspace-1",
                        "query": "launch readiness",
                        "profile": "pure",
                        "context_budget": 3,
                        "recent_items": [
                            {"id": "m1", "text": "recent launch note"},
                            {"id": "m2", "text": "recent release checklist"}
                        ],
                        "semantic_items": [
                            {"id": "m2", "text": "recent release checklist"},
                            {"id": "m3", "text": "semantic launch faq"}
                        ],
                        "hierarchy": {"root": ["recent", "semantic"]}
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let memory_receipt = latest_receipt(&state_path);
    assert_eq!(
        memory_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-001.3")
    );
    assert_eq!(
        memory_receipt["payload"]["memory_workspace"]["selected_items"]
            .as_array()
            .map(|v| v.len()),
        Some(3)
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "replay-run".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "run_id": "run-1",
                        "events": [
                            {"stage": "plan", "message": "planned"},
                            {"stage": "execute", "message": "executed"}
                        ],
                        "receipt_refs": [pattern_id],
                        "strict": true
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--replay-dir={}", replay_dir.display()),
            ],
        ),
        0
    );
    let replay_receipt = latest_receipt(&state_path);
    assert_eq!(
        replay_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-001.4")
    );
    assert!(replay_dir.join("run-1.json").exists());

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "approval-checkpoint".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "action_id": "action-1",
                        "title": "Approve launch action",
                        "reason": "operator review required",
                        "operator": "human-reviewer",
                        "status": "pending"
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
    assert_eq!(
        approval_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-001.5")
    );
    assert!(approval_queue_path.exists());

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "sandbox-execute".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "tenant_id": "tenant-a",
                        "sandbox_mode": "wasi",
                        "read_only": true,
                        "command": "cargo test --lib",
                        "fs_paths": ["core/", "client/"]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let sandbox_receipt = latest_receipt(&state_path);
    assert_eq!(
        sandbox_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-001.6")
    );
    assert_eq!(
        sandbox_receipt["payload"]["sandbox_run"]["read_only"],
        json!(true)
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "record-observability".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "run_id": "run-1",
                        "message": "captured workflow spans",
                        "spans": [{"name": "plan", "duration_ms": 12}],
                        "metrics": {"latency_ms": 12.0, "tokens": 320.0}
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--observability-trace-path={}", trace_path.display()),
                format!("--observability-metrics-path={}", metrics_path.display()),
            ],
        ),
        0
    );
    let observability_receipt = latest_receipt(&state_path);
    assert_eq!(
        observability_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-001.7")
    );
    assert!(trace_path.exists());
    assert!(metrics_path.exists());

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "gateway-route".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "request_id": "gateway-1",
                        "compat_mode": "/v1/chat/completions",
                        "providers": ["openai", "anthropic"],
                        "model": "vision-pro",
                        "streaming": true,
                        "profile": "tiny-max",
                        "bridge_path": "adapters/protocol/shannon_gateway_bridge.ts"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let gateway_receipt = latest_receipt(&state_path);
    assert_eq!(
        gateway_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-001.8")
    );
    assert_eq!(
        gateway_receipt["payload"]["gateway_route"]["degraded"],
        json!(true)
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "register-tooling".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "skills": ["timeline", "summarize"],
                        "mcp_tools": [
                            {"name": "filesystem", "unsafe": false},
                            {"name": "calendar", "unsafe": false}
                        ],
                        "bridge_path": "adapters/protocol/shannon_gateway_bridge.ts"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let tooling_receipt = latest_receipt(&state_path);
    assert_eq!(
        tooling_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-001.9")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "schedule-run".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "job_name": "nightly-replay",
                        "cron": "0 2 * * *",
                        "pattern_id": pattern_id,
                        "priority": 7,
                        "budget": {"tokens": 2048}
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let schedule_receipt = latest_receipt(&state_path);
    assert_eq!(
        schedule_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-001.10")
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "desktop-shell".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "surface": "notify",
                        "action": "notify",
                        "title": "Launch update",
                        "message": "desktop shell relayed"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--desktop-history-path={}", desktop_history_path.display()),
            ],
        ),
        0
    );
    let desktop_receipt = latest_receipt(&state_path);
    assert_eq!(
        desktop_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-001.11")
    );
    assert!(desktop_history_path.exists());

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "p2p-reliability".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "peer_id": "peer-1",
                        "version": "v1",
                        "supported_versions": ["v1", "v2"],
                        "message_ids": ["m1", "m1", "m2", "m3"]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let p2p_receipt = latest_receipt(&state_path);
    assert_eq!(
        p2p_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V6-WORKFLOW-001.12")
    );
    assert_eq!(
        p2p_receipt["payload"]["p2p_reliability"]["deduplicated_messages"],
        json!(3)
    );

    assert_eq!(
        run_bridge(
            root.path(),
            &[
                "assimilate-intake".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "shell_path": "client/runtime/systems/workflow/shannon_desktop_shell.ts",
                        "bridge_path": "adapters/protocol/shannon_gateway_bridge.ts"
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
        Some("V6-WORKFLOW-001.9")
    );

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
    assert_eq!(state["patterns"].as_object().map(|v| v.len()), Some(1));
    assert_eq!(state["budget_guards"].as_object().map(|v| v.len()), Some(1));
    assert_eq!(
        state["memory_workspaces"].as_object().map(|v| v.len()),
        Some(1)
    );
    assert_eq!(state["replays"].as_object().map(|v| v.len()), Some(1));
    assert_eq!(state["approvals"].as_object().map(|v| v.len()), Some(1));
    assert_eq!(state["sandbox_runs"].as_object().map(|v| v.len()), Some(1));
    assert_eq!(state["observability"].as_object().map(|v| v.len()), Some(1));
    assert_eq!(
        state["gateway_routes"].as_object().map(|v| v.len()),
        Some(1)
    );
    assert_eq!(
        state["tool_registrations"].as_object().map(|v| v.len()),
        Some(1)
    );
    assert_eq!(state["schedules"].as_object().map(|v| v.len()), Some(1));
    assert_eq!(
        state["desktop_events"].as_object().map(|v| v.len()),
        Some(1)
    );
    assert_eq!(
        state["p2p_reliability"].as_object().map(|v| v.len()),
        Some(1)
    );
    assert_eq!(state["intakes"].as_object().map(|v| v.len()), Some(1));
}
