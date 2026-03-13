// SPDX-License-Identifier: Apache-2.0
use super::*;

#[test]
fn plan_and_spawn_echo() {
    let dir = tempfile::tempdir().expect("tempdir");
    let policy = default_policy();
    plan_payload(
        dir.path(),
        &policy,
        &[
            "--organ-id=o1".to_string(),
            "--budget-json={\"max_runtime_ms\":5000,\"max_output_bytes\":2048,\"allow_commands\":[\"echo\"]}".to_string(),
            "--apply=1".to_string(),
        ],
    )
    .expect("plan");
    let spawn = spawn_payload(
        dir.path(),
        &policy,
        &[
            "--organ-id=o1".to_string(),
            "--command=echo".to_string(),
            "--arg=hello".to_string(),
            "--apply=1".to_string(),
        ],
    )
    .expect("spawn");
    assert!(spawn.get("ok").and_then(Value::as_bool).unwrap_or(false));
}

#[test]
fn disallowed_command_fails_closed() {
    let dir = tempfile::tempdir().expect("tempdir");
    let policy = default_policy();
    let err = spawn_payload(
        dir.path(),
        &policy,
        &[
            "--organ-id=o2".to_string(),
            "--command=definitely_not_allowed".to_string(),
            "--apply=0".to_string(),
        ],
    )
    .expect_err("blocked");
    assert!(err.contains("command_blocked_by_budget_policy"));
}
