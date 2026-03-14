use super::*;

#[test]
fn safety_gate_denies_when_budget_exhausted() {
    let root = tempfile::tempdir().expect("tempdir");
    let policy = json!({
        "safety_plane": {
            "enabled": true,
            "required_modes": ["stealth"],
            "allow_actions": ["research_fetch:*"],
            "max_requests_per_mode": {"stealth": 1}
        }
    });
    let first = safety_gate_receipt(
        root.path(),
        &policy,
        "stealth",
        "research_fetch:auto",
        "x",
        true,
    );
    let second = safety_gate_receipt(
        root.path(),
        &policy,
        "stealth",
        "research_fetch:auto",
        "x",
        true,
    );
    assert_eq!(first.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(second.get("ok").and_then(Value::as_bool), Some(false));
}

#[test]
fn spider_enqueues_links_with_rules() {
    let root = tempfile::tempdir().expect("tempdir");
    let parsed = crate::parse_args(&[
        "spider".to_string(),
        "--graph-json={\"https://a.test\":{\"links\":[\"https://a.test/x\",\"https://b.test/y\"]},\"https://a.test/x\":{\"links\":[]},\"https://b.test/y\":{\"links\":[]}}".to_string(),
        "--seed-urls=https://a.test".to_string(),
        "--allowed-domains=a.test".to_string(),
    ]);
    let out = run_spider(root.path(), &parsed, true);
    assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(out.get("visited_count").and_then(Value::as_u64), Some(2));
}
