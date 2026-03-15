// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{eval_plane, llm_economy_organ, snowball_plane};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use tempfile::TempDir;
use walkdir::WalkDir;

fn workspace_root() -> PathBuf {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest
        .ancestors()
        .nth(3)
        .expect("workspace ancestor")
        .to_path_buf()
}

fn copy_tree(src: &Path, dst: &Path) {
    for entry in WalkDir::new(src).into_iter().filter_map(Result::ok) {
        let rel = entry.path().strip_prefix(src).expect("strip prefix");
        let out = dst.join(rel);
        if entry.file_type().is_dir() {
            fs::create_dir_all(&out).expect("mkdir");
            continue;
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).expect("mkdir parent");
        }
        fs::copy(entry.path(), &out).expect("copy file");
    }
}

fn stage_fixture_root() -> TempDir {
    let workspace = workspace_root();
    let tmp = tempfile::tempdir().expect("tempdir");
    copy_tree(
        &workspace.join("planes").join("contracts"),
        &tmp.path().join("planes").join("contracts"),
    );
    tmp
}

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read");
    serde_json::from_str(&raw).expect("parse")
}

fn assert_claim(payload: &Value, claim_id: &str) {
    let has = payload
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some(claim_id));
    assert!(has, "missing claim evidence id={claim_id}");
}

fn snowball_latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("snowball_plane")
        .join("latest.json")
}

fn eval_latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("eval_plane")
        .join("latest.json")
}

fn economy_latest_path(root: &Path) -> PathBuf {
    root.join("client")
        .join("local")
        .join("state")
        .join("ops")
        .join("llm_economy_organ")
        .join("latest.json")
}

fn economy_trust_ledger_path(root: &Path) -> PathBuf {
    root.join("client")
        .join("local")
        .join("state")
        .join("ops")
        .join("llm_economy_organ")
        .join("trust_ledger.json")
}

#[test]
fn v6_batch35_snowball_backlog_pack_is_dependency_ordered_and_receipted() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let start_exit = snowball_plane::run(
        root,
        &[
            "start".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch35".to_string(),
            "--drops=core,eval,economy".to_string(),
        ],
    );
    assert_eq!(start_exit, 0);

    let unresolved = json!([
        {"id":"deploy-release","priority":0,"depends_on":["verify-regression"]},
        {"id":"generate-artifacts","priority":1,"depends_on":["verify-regression"]},
        {"id":"verify-regression","priority":9,"depends_on":[]}
    ]);
    let backlog_exit = snowball_plane::run(
        root,
        &[
            "backlog-pack".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch35".to_string(),
            format!("--unresolved-json={}", unresolved),
        ],
    );
    assert_eq!(backlog_exit, 0);
    let backlog_latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        backlog_latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_backlog_pack")
    );
    assert_claim(&backlog_latest, "V6-APP-023.4");
    assert_claim(&backlog_latest, "V6-APP-023.5");
    assert_claim(&backlog_latest, "V6-APP-023.6");
    let ordered = backlog_latest
        .pointer("/backlog/items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .map(str::to_string)
        .collect::<Vec<_>>();
    assert_eq!(
        ordered.first().map(String::as_str),
        Some("verify-regression")
    );
    let verify_idx = ordered
        .iter()
        .position(|id| id == "verify-regression")
        .expect("verify item");
    let deploy_idx = ordered
        .iter()
        .position(|id| id == "deploy-release")
        .expect("deploy item");
    let artifacts_idx = ordered
        .iter()
        .position(|id| id == "generate-artifacts")
        .expect("artifacts item");
    assert!(verify_idx < deploy_idx);
    assert!(verify_idx < artifacts_idx);

    let regress_exit = snowball_plane::run(
        root,
        &[
            "regress".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch35".to_string(),
            "--regression-pass=1".to_string(),
        ],
    );
    assert_eq!(regress_exit, 0);
    let regress_latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        regress_latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_melt_refine")
    );
    assert_claim(&regress_latest, "V6-APP-023.6");

    let status_exit = snowball_plane::run(
        root,
        &["status".to_string(), "--cycle-id=batch35".to_string()],
    );
    assert_eq!(status_exit, 0);
}

#[test]
fn v6_batch35_eval_dashboard_and_conduit_gate_are_receipted() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    assert_eq!(
        eval_plane::run(
            root,
            &[
                "enable-neuralavb".to_string(),
                "--strict=1".to_string(),
                "--enabled=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        eval_plane::run(
            root,
            &[
                "experiment-loop".to_string(),
                "--strict=1".to_string(),
                "--iterations=3".to_string(),
                "--baseline-cost-usd=20".to_string(),
                "--run-cost-usd=9".to_string(),
                "--baseline-accuracy=0.93".to_string(),
                "--run-accuracy=0.91".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        eval_plane::run(root, &["benchmark".to_string(), "--strict=1".to_string()]),
        0
    );
    assert_eq!(
        eval_plane::run(root, &["dashboard".to_string(), "--strict=1".to_string()]),
        0
    );
    let dashboard_latest = read_json(&eval_latest_path(root));
    assert_eq!(
        dashboard_latest.get("type").and_then(Value::as_str),
        Some("eval_plane_dashboard")
    );
    assert_claim(&dashboard_latest, "V6-EVAL-001.5");
    assert!(dashboard_latest
        .pointer("/dashboard/cost_accuracy_deltas")
        .is_some());

    let bypass_exit = eval_plane::run(
        root,
        &[
            "dashboard".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(bypass_exit, 1);
    let bypass_latest = read_json(&eval_latest_path(root));
    assert_eq!(
        bypass_latest.get("type").and_then(Value::as_str),
        Some("eval_plane_conduit_gate")
    );
}

#[test]
fn v6_batch35_openclaw_v2_rl_upgrade_is_receipted_and_queryable() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    assert_eq!(
        eval_plane::run(
            root,
            &[
                "rl-upgrade".to_string(),
                "--strict=1".to_string(),
                "--profile=openclaw-v2".to_string(),
                "--iterations=5".to_string(),
                "--runtime-classes=terminal,gui,swe,tool-call".to_string(),
                "--persona=research-shadow".to_string(),
            ],
        ),
        0
    );
    let rl_latest = read_json(&eval_latest_path(root));
    assert_eq!(
        rl_latest.get("type").and_then(Value::as_str),
        Some("eval_plane_rl_upgrade")
    );
    assert_claim(&rl_latest, "V6-COCKPIT-017.11");
    assert_claim(&rl_latest, "V6-COCKPIT-017.12");
    assert_claim(&rl_latest, "V6-COCKPIT-017.13");
    assert_claim(&rl_latest, "V6-COCKPIT-017.14");
    assert_claim(&rl_latest, "V6-COCKPIT-017.15");
    assert!(rl_latest
        .pointer("/rl_profile/runtime_class_matrix")
        .and_then(Value::as_array)
        .map(|rows| rows.len() >= 4)
        .unwrap_or(false));

    assert_eq!(
        eval_plane::run(root, &["rl-status".to_string(), "--strict=1".to_string()]),
        0
    );
    let status_latest = read_json(&eval_latest_path(root));
    assert_eq!(
        status_latest.get("type").and_then(Value::as_str),
        Some("eval_plane_rl_status")
    );
    assert_claim(&status_latest, "V6-COCKPIT-017.15");
    assert!(status_latest
        .get("history_rows")
        .and_then(Value::as_u64)
        .map(|rows| rows > 0)
        .unwrap_or(false));

    assert_eq!(
        eval_plane::run(
            root,
            &[
                "rl-upgrade".to_string(),
                "--strict=1".to_string(),
                "--profile=invalid".to_string(),
            ],
        ),
        1
    );
}

#[test]
fn v6_batch35_fairscale_credit_updates_identity_bound_scores() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    assert_eq!(
        llm_economy_organ::run(
            root,
            &[
                "fairscale-credit".to_string(),
                "--strict=1".to_string(),
                "--identity=alice".to_string(),
                "--delta=2".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        llm_economy_organ::run(
            root,
            &[
                "fairscale-credit".to_string(),
                "--strict=1".to_string(),
                "--identity=bob".to_string(),
                "--delta=1".to_string(),
            ],
        ),
        0
    );
    assert_eq!(
        llm_economy_organ::run(
            root,
            &[
                "fairscale-credit".to_string(),
                "--strict=1".to_string(),
                "--identity=alice".to_string(),
                "--delta=3".to_string(),
            ],
        ),
        0
    );

    let latest = read_json(&economy_latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("llm_economy_fairscale_credit")
    );
    assert_claim(&latest, "V6-ECONOMY-001.5");
    let ledger = read_json(&economy_trust_ledger_path(root));
    assert_eq!(
        ledger
            .pointer("/scores/alice")
            .and_then(Value::as_f64)
            .unwrap_or(-1.0),
        5.0
    );
    assert_eq!(
        ledger
            .pointer("/scores/bob")
            .and_then(Value::as_f64)
            .unwrap_or(-1.0),
        1.0
    );
}
