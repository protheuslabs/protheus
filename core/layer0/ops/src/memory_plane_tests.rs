// SPDX-License-Identifier: Apache-2.0
use super::*;

#[test]
fn causal_graph_record_and_blame_round_trip() {
    let dir = tempfile::tempdir().expect("tempdir");
    let policy = default_policy();
    graph_record_payload(
        dir.path(),
        &policy,
        &[
            "--event-id=e1".to_string(),
            "--summary=root".to_string(),
            "--actor=planner".to_string(),
            "--apply=1".to_string(),
        ],
    )
    .expect("record root");
    graph_record_payload(
        dir.path(),
        &policy,
        &[
            "--event-id=e2".to_string(),
            "--summary=child".to_string(),
            "--actor=executor".to_string(),
            "--caused-by=e1".to_string(),
            "--apply=1".to_string(),
        ],
    )
    .expect("record child");

    let blame = graph_blame_payload(dir.path(), &["--event-id=e2".to_string()]).expect("blame");
    let ancestry = blame
        .get("ancestry")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert!(!ancestry.is_empty());
    assert_eq!(
        ancestry[0]
            .get("event_id")
            .and_then(Value::as_str)
            .unwrap_or(""),
        "e1"
    );
}

#[test]
fn federation_sync_resolves_with_vector_counter() {
    let dir = tempfile::tempdir().expect("tempdir");
    let policy = default_policy();
    let sync1 = federation_sync_payload(
        dir.path(),
        &policy,
        &[
            "--device-id=d1".to_string(),
            "--entries-json=[{\"key\":\"k\",\"value\":{\"v\":1},\"counter\":1}]".to_string(),
            "--apply=1".to_string(),
        ],
    )
    .expect("sync1");
    assert_eq!(sync1.get("accepted").and_then(Value::as_u64), Some(1));

    let sync2 = federation_sync_payload(
        dir.path(),
        &policy,
        &[
            "--device-id=d1".to_string(),
            "--entries-json=[{\"key\":\"k\",\"value\":{\"v\":2},\"counter\":2}]".to_string(),
            "--apply=1".to_string(),
        ],
    )
    .expect("sync2");
    assert_eq!(sync2.get("replaced").and_then(Value::as_u64), Some(1));

    let pull = federation_pull_payload(dir.path(), &[]);
    let entries = pull
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let value = entries
        .first()
        .and_then(|row| row.get("entry"))
        .and_then(|v| v.get("value"))
        .and_then(|v| v.get("v"))
        .and_then(Value::as_i64);
    assert_eq!(value, Some(2));
}
