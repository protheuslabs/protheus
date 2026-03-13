// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{eval_plane, llm_economy_organ, snowball_plane};
use serde_json::Value;
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

fn snowball_latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("snowball_plane")
        .join("latest.json")
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

#[test]
fn v6_batch18_eval_economy_and_snowball_visibility_are_receipted() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let eval_enable_exit = eval_plane::run(
        root,
        &[
            "enable-neuralavb".to_string(),
            "--strict=1".to_string(),
            "--enabled=1".to_string(),
        ],
    );
    assert_eq!(eval_enable_exit, 0);
    let eval_enable_latest = read_json(&eval_latest_path(root));
    assert_eq!(
        eval_enable_latest.get("type").and_then(Value::as_str),
        Some("eval_plane_enable_neuralavb")
    );
    assert_claim(&eval_enable_latest, "V6-EVAL-001.1");
    assert_claim(&eval_enable_latest, "V6-EVAL-001.4");

    let eval_loop_exit = eval_plane::run(
        root,
        &[
            "experiment-loop".to_string(),
            "--strict=1".to_string(),
            "--iterations=3".to_string(),
            "--baseline-cost-usd=18".to_string(),
            "--run-cost-usd=7".to_string(),
            "--baseline-accuracy=0.93".to_string(),
            "--run-accuracy=0.91".to_string(),
        ],
    );
    assert_eq!(eval_loop_exit, 0);
    let eval_loop_latest = read_json(&eval_latest_path(root));
    assert_eq!(
        eval_loop_latest.get("type").and_then(Value::as_str),
        Some("eval_plane_experiment_loop")
    );
    assert_claim(&eval_loop_latest, "V6-EVAL-001.2");
    assert_claim(&eval_loop_latest, "V6-EVAL-001.3");

    let eval_benchmark_exit =
        eval_plane::run(root, &["benchmark".to_string(), "--strict=1".to_string()]);
    assert_eq!(eval_benchmark_exit, 0);
    let eval_benchmark_latest = read_json(&eval_latest_path(root));
    assert_eq!(
        eval_benchmark_latest.get("type").and_then(Value::as_str),
        Some("eval_plane_benchmark")
    );
    assert_claim(&eval_benchmark_latest, "V6-EVAL-001.3");
    assert_claim(&eval_benchmark_latest, "V6-EVAL-001.4");

    let economy_virtuals_exit = llm_economy_organ::run(
        root,
        &[
            "virtuals-acp".to_string(),
            "--strict=1".to_string(),
            "--action=earn".to_string(),
        ],
    );
    assert_eq!(economy_virtuals_exit, 0);
    let economy_virtuals_latest = read_json(&economy_latest_path(root));
    assert_eq!(
        economy_virtuals_latest.get("type").and_then(Value::as_str),
        Some("llm_economy_virtuals_acp")
    );
    assert_claim(&economy_virtuals_latest, "V6-ECONOMY-001.1");

    let economy_bankrbot_exit = llm_economy_organ::run(
        root,
        &[
            "bankrbot-defi".to_string(),
            "--strict=1".to_string(),
            "--strategy=yield-stable".to_string(),
        ],
    );
    assert_eq!(economy_bankrbot_exit, 0);
    let economy_bankrbot_latest = read_json(&economy_latest_path(root));
    assert_eq!(
        economy_bankrbot_latest.get("type").and_then(Value::as_str),
        Some("llm_economy_bankrbot_defi")
    );
    assert_claim(&economy_bankrbot_latest, "V6-ECONOMY-001.2");

    let economy_jobs_exit = llm_economy_organ::run(
        root,
        &[
            "jobs-marketplace".to_string(),
            "--strict=1".to_string(),
            "--source=nookplot".to_string(),
        ],
    );
    assert_eq!(economy_jobs_exit, 0);
    let economy_jobs_latest = read_json(&economy_latest_path(root));
    assert_eq!(
        economy_jobs_latest.get("type").and_then(Value::as_str),
        Some("llm_economy_jobs_marketplace")
    );
    assert_claim(&economy_jobs_latest, "V6-ECONOMY-001.3");

    let economy_skills_exit = llm_economy_organ::run(
        root,
        &[
            "skills-marketplace".to_string(),
            "--strict=1".to_string(),
            "--source=heurist".to_string(),
        ],
    );
    assert_eq!(economy_skills_exit, 0);
    let economy_skills_latest = read_json(&economy_latest_path(root));
    assert_eq!(
        economy_skills_latest.get("type").and_then(Value::as_str),
        Some("llm_economy_skills_marketplace")
    );
    assert_claim(&economy_skills_latest, "V6-ECONOMY-001.4");

    let snowball_start_exit = snowball_plane::run(
        root,
        &[
            "start".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch18".to_string(),
            "--drops=eval,economy,snowball".to_string(),
        ],
    );
    assert_eq!(snowball_start_exit, 0);
    let snowball_start_latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        snowball_start_latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_start")
    );
    assert_claim(&snowball_start_latest, "V6-APP-023.1");
    assert_claim(&snowball_start_latest, "V6-APP-023.6");

    let snowball_compact_exit = snowball_plane::run(
        root,
        &[
            "compact".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch18".to_string(),
        ],
    );
    assert_eq!(snowball_compact_exit, 0);
    let snowball_compact_latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        snowball_compact_latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_compact")
    );
    assert_claim(&snowball_compact_latest, "V6-APP-023.6");

    let snowball_control_exit = snowball_plane::run(
        root,
        &[
            "control".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch18".to_string(),
            "--op=pause".to_string(),
        ],
    );
    assert_eq!(snowball_control_exit, 0);
    let snowball_control_latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        snowball_control_latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_control")
    );
    assert_claim(&snowball_control_latest, "V6-APP-023.6");
}

#[test]
fn v6_batch18_eval_and_economy_reject_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let eval_exit = eval_plane::run(
        root,
        &[
            "run".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(eval_exit, 1);
    let eval_latest = read_json(&eval_latest_path(root));
    assert_eq!(
        eval_latest.get("type").and_then(Value::as_str),
        Some("eval_plane_conduit_gate")
    );

    let economy_exit = llm_economy_organ::run(
        root,
        &[
            "virtuals-acp".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(economy_exit, 1);
    let economy_latest = read_json(&economy_latest_path(root));
    assert_eq!(
        economy_latest.get("type").and_then(Value::as_str),
        Some("llm_economy_organ_conduit_gate")
    );
}
