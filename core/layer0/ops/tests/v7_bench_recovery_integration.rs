use protheus_ops_core::{parse_args, run_runtime_efficiency_floor};
use serde_json::json;
use std::fs;

#[test]
fn runtime_efficiency_core_lazy_path_stays_receipted_and_live() {
    let root = tempfile::tempdir().expect("tempdir");
    let policy = root
        .path()
        .join("client/runtime/config/runtime_efficiency_floor_policy.json");
    fs::create_dir_all(policy.parent().expect("policy parent")).expect("mkdir policy parent");
    fs::write(
        &policy,
        serde_json::to_string_pretty(&json!({
            "version": "1.0",
            "strict_default": false,
            "target_hold_days": 1,
            "enforce_hold_streak_strict": false,
            "cold_start_probe": {
                "engine": "core-lazy",
                "command": ["node", "client/lib/conduit_full_lifecycle_probe.ts"],
                "samples": 1,
                "max_ms": 5000,
                "warmup_runs": 0,
                "runtime_mode": "source",
                "require_full_dist": false
            },
            "idle_rss_probe": {
                "measurement_mode": "process",
                "samples": 1,
                "max_mb": 9999,
                "require_modules": []
            },
            "install_artifact_probe": {
                "max_mb": 9999,
                "paths": ["dist"]
            },
            "state_path": "local/state/ops/runtime_efficiency_floor.json",
            "history_path": "local/state/ops/runtime_efficiency_floor_history.jsonl"
        }))
        .expect("json"),
    )
    .expect("write policy");

    let parsed = parse_args(&[
        "run".to_string(),
        format!("--policy={}", policy.display()),
        "--strict=0".to_string(),
    ]);
    let out = run_runtime_efficiency_floor(root.path(), &parsed).expect("runtime floor run");
    assert_eq!(
        out.exit_code, 0,
        "runtime floor should run in non-strict mode"
    );
    assert_eq!(
        out.json
            .pointer("/cold_start/engine")
            .and_then(|v| v.as_str()),
        Some("core-lazy"),
        "expected core-lazy cold-start engine"
    );
    assert_eq!(
        out.json
            .pointer("/idle_rss/measurement_mode")
            .and_then(|v| v.as_str()),
        Some("process"),
        "expected process idle RSS mode"
    );
}
