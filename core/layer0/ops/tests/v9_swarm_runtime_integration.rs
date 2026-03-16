// SPDX-License-Identifier: Apache-2.0
use protheus_ops_core::swarm_runtime;
use serde_json::Value;
use std::fs;

const SWARM_CONTRACT_IDS: &[&str] = &[
    "V6-SWARM-013",
    "V6-SWARM-014",
    "V6-SWARM-015",
    "V6-SWARM-016",
    "V6-SWARM-017",
    "V6-SWARM-018",
    "V6-SWARM-019",
    "V6-SWARM-020",
    "V6-SWARM-021",
    "V6-SWARM-022",
    "V6-SWARM-023",
    "V6-SWARM-024",
    "V6-SWARM-025",
    "V6-SWARM-026",
    "V6-SWARM-027",
    "V6-SWARM-028",
    "V6-SWARM-029",
    "V6-SWARM-030",
    "V6-SWARM-031",
];

fn run_swarm(root: &std::path::Path, args: &[String]) -> i32 {
    swarm_runtime::run(root, args)
}

fn read_state(path: &std::path::Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).expect("read state")).expect("parse state")
}

#[test]
fn swarm_contract_ids_are_embedded_for_receipt_audit_evidence() {
    assert_eq!(SWARM_CONTRACT_IDS.len(), 19);
    assert!(SWARM_CONTRACT_IDS
        .iter()
        .all(|id| id.starts_with("V6-SWARM-0")));
}

#[test]
fn sessions_send_receive_and_ack_support_sibling_chain() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let s1 = vec![
        "spawn".to_string(),
        "--task=comm-agent-1".to_string(),
        "--role=generator".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    let s2 = vec![
        "spawn".to_string(),
        "--task=comm-agent-2".to_string(),
        "--role=filter".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &s1), 0);
    assert_eq!(run_swarm(root.path(), &s2), 0);

    let state = read_state(&state_path);
    let mut ids = state
        .get("sessions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    ids.sort();
    let sender = ids.first().cloned().expect("sender");
    let recipient = ids.get(1).cloned().expect("recipient");

    let send_args = vec![
        "sessions".to_string(),
        "send".to_string(),
        format!("--sender-id={sender}"),
        format!("--session-id={recipient}"),
        "--message=hello-from-agent-1".to_string(),
        "--delivery=at_least_once".to_string(),
        "--simulate-first-attempt-fail=1".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &send_args), 0);

    let receive_args = vec![
        "sessions".to_string(),
        "receive".to_string(),
        format!("--session-id={recipient}"),
        "--limit=5".to_string(),
        "--mark-read=0".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &receive_args), 0);

    let state_after = read_state(&state_path);
    let msg_id = state_after
        .get("mailboxes")
        .and_then(|rows| rows.get(&recipient))
        .and_then(|row| row.get("unread"))
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .and_then(|row| row.get("message_id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .expect("message id in mailbox");

    let ack_args = vec![
        "sessions".to_string(),
        "ack".to_string(),
        format!("--session-id={recipient}"),
        format!("--message-id={msg_id}"),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &ack_args), 0);

    let final_state = read_state(&state_path);
    let acknowledged = final_state
        .get("mailboxes")
        .and_then(|rows| rows.get(&recipient))
        .and_then(|row| row.get("unread"))
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .and_then(|row| row.get("acknowledged"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    assert!(acknowledged, "expected message to be acknowledged");
}

#[test]
fn service_discovery_and_send_role_route_messages() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let s1 = vec![
        "spawn".to_string(),
        "--task=role-agent-1".to_string(),
        "--role=generator".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    let s2 = vec![
        "spawn".to_string(),
        "--task=role-agent-2".to_string(),
        "--role=filter".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &s1), 0);
    assert_eq!(run_swarm(root.path(), &s2), 0);

    let discover_args = vec![
        "sessions".to_string(),
        "discover".to_string(),
        "--role=filter".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &discover_args), 0);

    let send_role_args = vec![
        "sessions".to_string(),
        "send-role".to_string(),
        "--sender-id=coordinator".to_string(),
        "--role=filter".to_string(),
        "--message=role-routed-message".to_string(),
        "--delivery=exactly_once".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &send_role_args), 0);

    let state = read_state(&state_path);
    let filter_session_id = state
        .get("service_registry")
        .and_then(|rows| rows.get("filter"))
        .and_then(Value::as_array)
        .and_then(|rows| rows.first())
        .and_then(|row| row.get("session_id"))
        .and_then(Value::as_str)
        .map(ToString::to_string)
        .expect("filter session id");
    let inbox_count = state
        .get("mailboxes")
        .and_then(|rows| rows.get(&filter_session_id))
        .and_then(|row| row.get("unread"))
        .and_then(Value::as_array)
        .map(|rows| rows.len())
        .unwrap_or(0);
    assert!(inbox_count >= 1, "expected routed message in filter inbox");
}

#[test]
fn channels_create_publish_poll_and_communication_test_pass() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let mut sessions = Vec::new();
    for role in ["generator", "filter", "summarizer", "validator"] {
        let args = vec![
            "spawn".to_string(),
            format!("--task=channel-{role}"),
            format!("--role={role}"),
            format!("--state-path={}", state_path.display()),
        ];
        assert_eq!(run_swarm(root.path(), &args), 0);
    }
    let state = read_state(&state_path);
    let ids = state
        .get("sessions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
        .keys()
        .cloned()
        .collect::<Vec<_>>();
    sessions.extend(ids);
    sessions.sort();
    let sender = sessions.first().cloned().expect("sender");
    let pollee = sessions.get(1).cloned().expect("pollee");
    let participants = sessions.join(",");

    let create_args = vec![
        "channels".to_string(),
        "create".to_string(),
        "--name=swarm-test-6".to_string(),
        format!("--participants={participants}"),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &create_args), 0);

    let state_after_create = read_state(&state_path);
    let channel_id = state_after_create
        .get("channels")
        .and_then(Value::as_object)
        .and_then(|rows| rows.keys().next().cloned())
        .expect("channel id");

    let publish_args = vec![
        "channels".to_string(),
        "publish".to_string(),
        format!("--channel-id={channel_id}"),
        format!("--sender-id={sender}"),
        "--message=channel-broadcast".to_string(),
        "--delivery=at_most_once".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &publish_args), 0);

    let poll_args = vec![
        "channels".to_string(),
        "poll".to_string(),
        format!("--channel-id={channel_id}"),
        format!("--session-id={pollee}"),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &poll_args), 0);

    let chain_test_args = vec![
        "test".to_string(),
        "communication".to_string(),
        "--delivery=at_least_once".to_string(),
        "--simulate-first-attempt-fail=1".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &chain_test_args), 0);

    let final_state = read_state(&state_path);
    let mailbox_total = final_state
        .get("mailboxes")
        .and_then(Value::as_object)
        .map(|rows| rows.len())
        .unwrap_or(0);
    assert!(mailbox_total >= 2, "expected message mailboxes to exist");
}

#[test]
fn heterogeneous_results_registry_supports_query_wait_consensus_and_outliers() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let fast = vec![
        "spawn".to_string(),
        "--task=Calculate 1-100 quickly".to_string(),
        "--role=calculator".to_string(),
        "--auto-publish-results=1".to_string(),
        "--agent-label=swarm-test-7-het-agent-fast".to_string(),
        "--result-value=5050".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    let thorough = vec![
        "spawn".to_string(),
        "--task=Calculate and verify 1-100".to_string(),
        "--role=calculator".to_string(),
        "--auto-publish-results=1".to_string(),
        "--agent-label=swarm-test-7-het-agent-thorough".to_string(),
        "--result-value=5050".to_string(),
        "--verification-status=verified".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &fast), 0);
    assert_eq!(run_swarm(root.path(), &thorough), 0);

    let wait_args = vec![
        "results".to_string(),
        "wait".to_string(),
        "--label-pattern=swarm-test-7-het-agent-*".to_string(),
        "--min-count=2".to_string(),
        "--timeout-sec=2".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &wait_args), 0);

    let query_args = vec![
        "results".to_string(),
        "query".to_string(),
        "--role=calculator".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &query_args), 0);

    let consensus_args = vec![
        "results".to_string(),
        "consensus".to_string(),
        "--label-pattern=swarm-test-7-het-agent-*".to_string(),
        "--field=value".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &consensus_args), 0);

    let outlier_args = vec![
        "results".to_string(),
        "outliers".to_string(),
        "--label-pattern=swarm-test-7-het-agent-*".to_string(),
        "--field=value".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &outlier_args), 0);

    let state = read_state(&state_path);
    let result_count = state
        .get("result_registry")
        .and_then(Value::as_object)
        .map(|rows| rows.len())
        .unwrap_or(0);
    assert!(result_count >= 2, "expected published result rows");
    let labels = state
        .get("results_by_label")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    assert!(
        labels.contains_key("swarm-test-7-het-agent-fast")
            && labels.contains_key("swarm-test-7-het-agent-thorough"),
        "expected both heterogeneous labels indexed"
    );
}

#[test]
fn results_wait_times_out_when_min_count_not_met() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let wait_args = vec![
        "results".to_string(),
        "wait".to_string(),
        "--label-pattern=non-existent-*".to_string(),
        "--min-count=1".to_string(),
        "--timeout-sec=0.1".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &wait_args), 2);

    let state = read_state(&state_path);
    let result_count = state
        .get("result_registry")
        .and_then(Value::as_object)
        .map(|rows| rows.len())
        .unwrap_or(0);
    assert_eq!(result_count, 0, "timeout path must not fabricate results");
}

#[test]
fn results_consensus_emits_disagreement_event_for_conflicting_values() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    for (label, value) in [
        ("swarm-test-7-het-agent-fast", "5050"),
        ("swarm-test-7-het-agent-thorough", "4090"),
    ] {
        let args = vec![
            "spawn".to_string(),
            "--task=conflict-calc".to_string(),
            "--role=calculator".to_string(),
            "--auto-publish-results=1".to_string(),
            format!("--agent-label={label}"),
            format!("--result-value={value}"),
            format!("--state-path={}", state_path.display()),
        ];
        assert_eq!(run_swarm(root.path(), &args), 0);
    }

    let consensus_args = vec![
        "results".to_string(),
        "consensus".to_string(),
        "--label-pattern=swarm-test-7-het-agent-*".to_string(),
        "--field=value".to_string(),
        "--threshold=1.0".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &consensus_args), 0);

    let state = read_state(&state_path);
    let disagreement_event = state
        .get("events")
        .and_then(Value::as_array)
        .and_then(|rows| {
            rows.iter().rev().find(|row| {
                row.get("type").and_then(Value::as_str) == Some("swarm_results_consensus")
                    && row.get("status").and_then(Value::as_str) == Some("disagreement")
            })
        });
    assert!(
        disagreement_event.is_some(),
        "consensus command should persist a disagreement event for mismatched values"
    );
}

#[test]
fn results_publish_rejects_invalid_payload_json() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let spawn_args = vec![
        "spawn".to_string(),
        "--task=invalid-payload-source".to_string(),
        "--role=calculator".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &spawn_args), 0);

    let state = read_state(&state_path);
    let session_id = state
        .get("sessions")
        .and_then(Value::as_object)
        .and_then(|rows| rows.keys().next())
        .cloned()
        .expect("session id");

    let publish_args = vec![
        "results".to_string(),
        "publish".to_string(),
        format!("--session-id={session_id}"),
        "--data-json={bad json}".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &publish_args), 2);

    let state_after = read_state(&state_path);
    let result_count = state_after
        .get("result_registry")
        .and_then(Value::as_object)
        .map(|rows| rows.len())
        .unwrap_or(0);
    assert_eq!(result_count, 0, "invalid publish payload must fail closed");
}

#[test]
fn heterogeneous_test_suite_completes_with_consensus() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let args = vec![
        "test".to_string(),
        "heterogeneous".to_string(),
        "--label-pattern=swarm-test-7-het-agent-*".to_string(),
        "--min-count=2".to_string(),
        "--timeout-sec=5".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &args), 0);

    let state = read_state(&state_path);
    let roles = state
        .get("service_registry")
        .and_then(|rows| rows.get("calculator"))
        .and_then(Value::as_array)
        .map(|rows| rows.len())
        .unwrap_or(0);
    assert!(roles >= 2, "expected at least two calculator services");
    let results = state
        .get("result_registry")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    assert!(
        results.values().any(|row| {
            row.get("payload")
                .and_then(|payload| payload.get("kind"))
                .and_then(Value::as_str)
                == Some("calculation")
        }),
        "expected calculation payloads in result registry"
    );
}

#[test]
fn recursive_test_reaches_five_levels_with_parent_child_chain() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let args = vec![
        "test".to_string(),
        "recursive".to_string(),
        "--levels=5".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    let exit = run_swarm(root.path(), &args);
    assert_eq!(exit, 0, "recursive test command should succeed");

    let state = read_state(&state_path);
    let sessions = state
        .get("sessions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    assert_eq!(sessions.len(), 5, "expected 5 sessions for 5 levels");

    let max_depth = sessions
        .values()
        .filter_map(|session| session.get("depth").and_then(Value::as_u64))
        .max()
        .unwrap_or(0);
    assert_eq!(max_depth, 4);

    let with_parent = sessions
        .values()
        .filter(|session| {
            session
                .get("parent_id")
                .and_then(Value::as_str)
                .map(|id| !id.is_empty())
                .unwrap_or(false)
        })
        .count();
    assert_eq!(
        with_parent, 4,
        "all non-root sessions should have parent IDs"
    );
}

#[test]
fn byzantine_test_mode_enables_corrupted_reports() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let enable_args = vec![
        "byzantine-test".to_string(),
        "enable".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &enable_args), 0);

    let spawn_args = vec![
        "spawn".to_string(),
        "--task=swarm-test-3".to_string(),
        "--byzantine=1".to_string(),
        "--verify=1".to_string(),
        "--corruption-type=data_falsification".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &spawn_args), 0);

    let consensus_args = vec![
        "consensus-check".to_string(),
        "--task-id=swarm-test-3".to_string(),
        "--threshold=0.6".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &consensus_args), 0);

    let state = read_state(&state_path);
    assert_eq!(
        state
            .get("byzantine_test_mode")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        true,
        "expected byzantine mode enabled",
    );

    let sessions = state
        .get("sessions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let corrupted = sessions.values().any(|session| {
        session
            .get("report")
            .and_then(|value| value.get("corrupted"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    assert!(corrupted, "expected corrupted report in byzantine mode");
}

#[test]
fn concurrency_test_persists_detailed_spawn_metrics() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let args = vec![
        "test".to_string(),
        "concurrency".to_string(),
        "--agents=10".to_string(),
        "--metrics=detailed".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &args), 0);

    let state = read_state(&state_path);
    let sessions = state
        .get("sessions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    assert!(
        sessions.len() >= 10,
        "expected at least 10 sessions from concurrency test"
    );

    let metrics_complete = sessions.values().all(|session| {
        let Some(metrics) = session.get("metrics") else {
            return false;
        };
        metrics.get("queue_wait_ms").is_some()
            && metrics.get("execution_end_ms").is_some()
            && metrics.get("report_back_latency_ms").is_some()
    });
    assert!(
        metrics_complete,
        "expected detailed metrics on all sessions"
    );
}

#[test]
fn budget_enforcement_fail_hard_blocks_overrun() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");
    let args = vec![
        "spawn".to_string(),
        "--task=Write detailed exhaustive analysis with many references and examples".to_string(),
        "--token-budget=120".to_string(),
        "--on-budget-exhausted=fail".to_string(),
        "--adaptive-complexity=0".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    let exit = run_swarm(root.path(), &args);
    assert_eq!(exit, 2, "budget-overrun spawn should fail hard");

    let state = read_state(&state_path);
    let sessions = state
        .get("sessions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    assert_eq!(sessions.len(), 1, "expected failed session to be recorded");
    let exhausted = sessions.values().any(|session| {
        session
            .get("budget_telemetry")
            .and_then(|value| value.get("budget_exhausted"))
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    assert!(exhausted, "expected budget exhaustion in telemetry");
}

#[test]
fn budget_test_and_budget_report_emit_telemetry() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let test_args = vec![
        "test".to_string(),
        "budget".to_string(),
        "--assert-hard-enforcement=0".to_string(),
        "--budget=2000".to_string(),
        "--warning-at=0.5".to_string(),
        "--on-budget-exhausted=warn".to_string(),
        "--task=Read SOUL.md and summarize in three sentences".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &test_args), 0);

    let state = read_state(&state_path);
    let sessions = state
        .get("sessions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let session_id = sessions
        .keys()
        .next()
        .cloned()
        .expect("session id should exist");

    let report_args = vec![
        "budget-report".to_string(),
        format!("--session-id={session_id}"),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &report_args), 0);

    let telemetry_present = sessions.values().any(|session| {
        session
            .get("budget_telemetry")
            .and_then(|value| value.get("tool_breakdown"))
            .and_then(Value::as_object)
            .map(|rows| !rows.is_empty())
            .unwrap_or(false)
    });
    assert!(
        telemetry_present,
        "expected per-tool budget telemetry to be persisted"
    );
}

#[test]
fn budget_test_defaults_to_hard_fail_enforcement() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");
    let args = vec![
        "test".to_string(),
        "budget".to_string(),
        "--budget=120".to_string(),
        "--expect-fail=1".to_string(),
        "--on-budget-exhausted=fail".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &args), 0);
}

#[test]
fn budget_test_warn_action_requires_explicit_hard_enforcement_opt_out() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");
    let args = vec![
        "test".to_string(),
        "budget".to_string(),
        "--budget=2000".to_string(),
        "--on-budget-exhausted=warn".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(
        run_swarm(root.path(), &args),
        2,
        "warn action should fail unless --assert-hard-enforcement=0 is set"
    );
}

#[test]
fn persistent_mode_supports_tick_wake_terminate_and_metrics() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let spawn_args = vec![
        "spawn".to_string(),
        "--task=swarm-test-5-persistent-health".to_string(),
        "--execution-mode=persistent".to_string(),
        "--lifespan-sec=30".to_string(),
        "--check-in-interval-sec=5".to_string(),
        "--report-mode=always".to_string(),
        "--token-budget=2000".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &spawn_args), 0);

    let mut state = read_state(&state_path);
    let sessions = state
        .get("sessions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    assert_eq!(sessions.len(), 1, "expected one persistent session");
    let session_id = sessions.keys().next().cloned().expect("session id");
    let initial_check_ins = sessions
        .get(&session_id)
        .and_then(|row| row.get("check_ins"))
        .and_then(Value::as_array)
        .map(|rows| rows.len())
        .unwrap_or(0);
    assert!(
        initial_check_ins >= 1,
        "expected initial check-in at spawn time"
    );

    let tick_args = vec![
        "tick".to_string(),
        "--advance-ms=7000".to_string(),
        "--max-check-ins=8".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &tick_args), 0);

    state = read_state(&state_path);
    let post_tick_check_ins = state
        .get("sessions")
        .and_then(|rows| rows.get(&session_id))
        .and_then(|row| row.get("check_ins"))
        .and_then(Value::as_array)
        .map(|rows| rows.len())
        .unwrap_or(0);
    assert!(
        post_tick_check_ins >= 2,
        "expected additional check-in after tick"
    );

    let wake_args = vec![
        "sessions".to_string(),
        "wake".to_string(),
        format!("--session-id={session_id}"),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &wake_args), 0);

    state = read_state(&state_path);
    let post_wake_check_ins = state
        .get("sessions")
        .and_then(|rows| rows.get(&session_id))
        .and_then(|row| row.get("check_ins"))
        .and_then(Value::as_array)
        .map(|rows| rows.len())
        .unwrap_or(0);
    assert!(
        post_wake_check_ins >= 3,
        "expected manual wake to record check-in"
    );

    let metrics_args = vec![
        "sessions".to_string(),
        "metrics".to_string(),
        format!("--session-id={session_id}"),
        "--timeline=1".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &metrics_args), 0);

    let anomalies_args = vec![
        "sessions".to_string(),
        "anomalies".to_string(),
        format!("--session-id={session_id}"),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &anomalies_args), 0);

    let terminate_args = vec![
        "sessions".to_string(),
        "terminate".to_string(),
        format!("--session-id={session_id}"),
        "--graceful=1".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &terminate_args), 0);

    state = read_state(&state_path);
    let session = state
        .get("sessions")
        .and_then(|rows| rows.get(&session_id))
        .cloned()
        .unwrap_or(Value::Null);
    assert_eq!(
        session.get("status").and_then(Value::as_str),
        Some("terminated_graceful")
    );
    assert!(
        session
            .get("persistent")
            .and_then(|value| value.get("terminated_at_ms"))
            .and_then(Value::as_u64)
            .is_some(),
        "expected terminated_at_ms in persistent runtime"
    );
}

#[test]
fn sessions_state_command_returns_session_introspection() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let spawn_args = vec![
        "spawn".to_string(),
        "--task=swarm-test-state-introspection".to_string(),
        "--role=calculator".to_string(),
        "--capabilities=calculate,verify".to_string(),
        "--token-budget=2000".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &spawn_args), 0);

    let state = read_state(&state_path);
    let session_id = state
        .get("sessions")
        .and_then(Value::as_object)
        .and_then(|rows| rows.keys().next())
        .cloned()
        .expect("session id");

    let state_args = vec![
        "sessions".to_string(),
        "state".to_string(),
        format!("--session-id={session_id}"),
        "--timeline=1".to_string(),
        "--tool-history-limit=10".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &state_args), 0);
}

#[test]
fn queue_metrics_command_supports_prometheus_format() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    for idx in 0..3 {
        let spawn_args = vec![
            "spawn".to_string(),
            format!("--task=swarm-test-metrics-{idx}"),
            format!("--state-path={}", state_path.display()),
        ];
        assert_eq!(run_swarm(root.path(), &spawn_args), 0);
    }

    let metrics_args = vec![
        "metrics".to_string(),
        "queue".to_string(),
        "--format=prometheus".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &metrics_args), 0);
}

#[test]
fn background_worker_start_status_stop_lifecycle() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let start_args = vec![
        "background".to_string(),
        "start".to_string(),
        "--task=background-worker-health".to_string(),
        "--execution-mode=background".to_string(),
        "--lifespan-sec=60".to_string(),
        "--check-in-interval-sec=10".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &start_args), 0);

    let status_args = vec![
        "background".to_string(),
        "status".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &status_args), 0);

    let mut state = read_state(&state_path);
    let sessions = state
        .get("sessions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let (session_id, session_row) = sessions
        .iter()
        .find(|(_, row)| {
            row.get("background_worker")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .expect("background worker session");
    assert_eq!(
        session_row.get("status").and_then(Value::as_str),
        Some("background_running")
    );

    let stop_args = vec![
        "background".to_string(),
        "stop".to_string(),
        format!("--session-id={session_id}"),
        "--graceful=1".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &stop_args), 0);

    state = read_state(&state_path);
    assert_eq!(
        state
            .get("sessions")
            .and_then(|rows| rows.get(session_id))
            .and_then(|row| row.get("status"))
            .and_then(Value::as_str),
        Some("terminated_graceful")
    );
}

#[test]
fn scheduled_tasks_add_and_run_due_generate_sessions() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let add_args = vec![
        "scheduled".to_string(),
        "add".to_string(),
        "--task=scheduled-health-check".to_string(),
        "--interval-sec=1".to_string(),
        "--runs=1".to_string(),
        "--max-runtime-sec=2".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &add_args), 0);

    let status_args = vec![
        "scheduled".to_string(),
        "status".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &status_args), 0);

    let run_due_args = vec![
        "scheduled".to_string(),
        "run-due".to_string(),
        "--advance-ms=2000".to_string(),
        "--max-runs=1".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &run_due_args), 0);

    let state = read_state(&state_path);
    let tasks = state
        .get("scheduled_tasks")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    assert_eq!(tasks.len(), 1, "expected one scheduled task");
    let task = tasks.values().next().cloned().unwrap_or(Value::Null);
    assert_eq!(
        task.get("remaining_runs").and_then(Value::as_u64),
        Some(0),
        "expected scheduled task run budget exhausted"
    );
    assert_eq!(task.get("active").and_then(Value::as_bool), Some(false));
    assert!(
        task.get("last_session_id")
            .and_then(Value::as_str)
            .map(|value| !value.is_empty())
            .unwrap_or(false),
        "expected scheduled task to record a spawned session"
    );
    let session_count = state
        .get("sessions")
        .and_then(Value::as_object)
        .map(|rows| rows.len())
        .unwrap_or(0);
    assert!(session_count >= 1, "expected spawned session from run-due");
}

#[test]
fn persistent_test_suite_creates_check_in_timeline() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/swarm/latest.json");

    let args = vec![
        "test".to_string(),
        "persistent".to_string(),
        "--lifespan-sec=20".to_string(),
        "--check-in-interval-sec=5".to_string(),
        "--advance-ms=10000".to_string(),
        format!("--state-path={}", state_path.display()),
    ];
    assert_eq!(run_swarm(root.path(), &args), 0);

    let state = read_state(&state_path);
    let sessions = state
        .get("sessions")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    assert!(!sessions.is_empty(), "expected at least one session");
    let check_in_counts = sessions
        .values()
        .filter_map(|row| row.get("check_ins").and_then(Value::as_array))
        .map(|rows| rows.len())
        .collect::<Vec<_>>();
    assert!(
        check_in_counts.iter().any(|count| *count >= 2),
        "expected persistent test lane to produce timeline check-ins"
    );
}
