// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::collections::BTreeMap;

fn root() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

#[test]
fn checkpoint_and_restore_roundtrip() {
    let dir = root();
    let checkpoint = checkpoint_payload(
        dir.path(),
        &default_policy(),
        &[
            "--session-id=session-a".to_string(),
            "--state-json={\"attention_queue\":[\"a\"],\"memory_graph\":{\"n1\":{}},\"active_personas\":[\"planner\"]}".to_string(),
            "--apply=1".to_string(),
        ],
    )
    .expect("checkpoint");
    assert!(checkpoint
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false));

    let restored = restore_payload(
        dir.path(),
        &default_policy(),
        &[
            "--session-id=session-a".to_string(),
            "--apply=1".to_string(),
        ],
    )
    .expect("restore");
    assert!(restored.get("ok").and_then(Value::as_bool).unwrap_or(false));
    assert_eq!(
        restored
            .get("restored_state")
            .and_then(|v| v.get("active_personas"))
            .and_then(Value::as_array)
            .map(|rows| rows.len()),
        Some(1)
    );
}

#[test]
fn degraded_restore_is_blocked_without_override() {
    let dir = root();
    let policy = default_policy();
    let ckpt_path = checkpoints_dir(dir.path()).join("s1_manual_degraded.json");
    write_json(
        &ckpt_path,
        &json!({
            "session_id": "s1",
            "ts": now_iso(),
            "state": { "attention_queue": ["a"] },
            "degraded": true
        }),
    )
    .expect("write degraded checkpoint");
    let mut index = BTreeMap::new();
    index.insert("s1".to_string(), rel_path(dir.path(), &ckpt_path));
    write_checkpoint_index(dir.path(), &index).expect("write index");

    let err = restore_payload(
        dir.path(),
        &policy,
        &["--session-id=s1".to_string(), "--apply=0".to_string()],
    )
    .expect_err("blocked");
    assert!(err.contains("degraded_restore_blocked_by_policy"));
}

#[test]
fn vault_encrypts_and_decrypts_state() {
    let dir = root();
    let policy = default_policy();
    std::env::set_var("TEST_CONTINUITY_KEY", "s3cr3t");

    let put = vault_put_payload(
        dir.path(),
        &ContinuityPolicy {
            vault_key_env: "TEST_CONTINUITY_KEY".to_string(),
            ..policy.clone()
        },
        &[
            "--session-id=s2".to_string(),
            "--state-json={\"attention_queue\":[\"a\"],\"memory_graph\":{},\"active_personas\":[]}"
                .to_string(),
            "--apply=1".to_string(),
        ],
    )
    .expect("vault put");
    assert!(put
        .get("encrypted")
        .and_then(Value::as_bool)
        .unwrap_or(false));

    let get = vault_get_payload(
        dir.path(),
        &ContinuityPolicy {
            vault_key_env: "TEST_CONTINUITY_KEY".to_string(),
            ..policy
        },
        &["--session-id=s2".to_string(), "--emit-state=1".to_string()],
    )
    .expect("vault get");

    assert_eq!(
        get.get("state")
            .and_then(|v| v.get("attention_queue"))
            .and_then(Value::as_array)
            .map(|rows| rows.len()),
        Some(1)
    );

    std::env::remove_var("TEST_CONTINUITY_KEY");
}
