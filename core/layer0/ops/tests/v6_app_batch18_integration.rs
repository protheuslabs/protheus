// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::snowball_plane;
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

fn format_with_commas(raw: f64) -> String {
    let base = format!("{raw:.1}");
    let parts = base.split('.').collect::<Vec<_>>();
    let integer = parts.first().copied().unwrap_or("0");
    let fraction = parts.get(1).copied().unwrap_or("0");
    let mut out = String::new();
    let bytes = integer.as_bytes();
    for (idx, ch) in bytes.iter().enumerate() {
        if idx > 0 && (bytes.len() - idx) % 3 == 0 {
            out.push(',');
        }
        out.push(*ch as char);
    }
    out.push('.');
    out.push_str(fraction);
    out
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
fn v6_app_batch18_snowball_governance_lanes_are_receipted() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let workspace = workspace_root();
    let benchmark_report =
        workspace.join("docs/client/reports/benchmark_matrix_run_2026-03-06.json");
    let benchmark_json = read_json(&benchmark_report);
    let readme_path = root.join("README.md");
    fs::write(
        &readme_path,
        format!(
            "# Snowball Benchmark Sync Fixture\n{:.1} ms\n{:.1} MB\n{} ops/sec\n{} ops/sec\n",
            benchmark_json
                .pointer("/openclaw_measured/cold_start_ms")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            benchmark_json
                .pointer("/openclaw_measured/idle_memory_mb")
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            format_with_commas(
                benchmark_json
                    .pointer("/pure_workspace_measured/tasks_per_sec")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            ),
            format_with_commas(
                benchmark_json
                    .pointer("/pure_workspace_tiny_max_measured/tasks_per_sec")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            )
        ),
    )
    .expect("write readme fixture");
    let directive_text = "intent:\n  objective: Keep survivor-only snowball compaction active\nconstraints:\n  hard:\n    - preserve benchmark evidence\nsuccess_metrics:\n  survivor_promotion: true\nscope:\n  include:\n    - snowball_plane\napproval_policy:\n  mode: governed";
    let assimilations_json = r#"[
      {"id":"survivor-rsi","idea":"rsi planner memory uplift","metric_gain":true,"pure_tiny_strength":true,"intelligence_gain":true,"tiny_hardware_fit":true},
      {"id":"demote-edge","idea":"low-power edge helper","metric_gain":false,"pure_tiny_strength":true,"intelligence_gain":false,"tiny_hardware_fit":true},
      {"id":"reject-heavy","idea":"desktop-only heavy optimizer","metric_gain":false,"pure_tiny_strength":false,"intelligence_gain":false,"tiny_hardware_fit":false}
    ]"#;

    std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "test-signing-key");

    let start_exit = snowball_plane::run(
        root,
        &[
            "start".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch18".to_string(),
            "--drops=compact-core,refresh-metrics,governance-pack".to_string(),
            "--deps-json={\"refresh-metrics\":[\"compact-core\"],\"governance-pack\":[\"refresh-metrics\"]}".to_string(),
        ],
    );
    assert_eq!(start_exit, 0);

    let melt_exit = snowball_plane::run(
        root,
        &[
            "melt-refine".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch18".to_string(),
            "--regression-pass=1".to_string(),
        ],
    );
    assert_eq!(melt_exit, 0);

    let compact_exit = snowball_plane::run(
        root,
        &[
            "compact".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch18".to_string(),
            format!("--benchmark-report={}", benchmark_report.display()),
            format!("--assimilations-json={assimilations_json}"),
            "--reliability-before=0.97".to_string(),
            "--reliability-after=0.99".to_string(),
        ],
    );
    assert_eq!(compact_exit, 0);
    let compact_latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        compact_latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_compact")
    );
    assert_claim(&compact_latest, "V6-APP-023.7");
    assert_claim(&compact_latest, "V6-APP-023.9");
    assert_claim(&compact_latest, "V6-APP-023.11");

    let review_exit = snowball_plane::run(
        root,
        &[
            "fitness-review".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch18".to_string(),
            format!("--benchmark-report={}", benchmark_report.display()),
            format!("--assimilations-json={assimilations_json}"),
            "--reliability-before=0.97".to_string(),
            "--reliability-after=0.99".to_string(),
        ],
    );
    assert_eq!(review_exit, 0);
    let review_latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        review_latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_fitness_review")
    );
    assert_claim(&review_latest, "V6-APP-023.7");
    let review_path = review_latest
        .pointer("/artifact/path")
        .and_then(Value::as_str)
        .expect("review path");
    assert!(Path::new(review_path).exists(), "review artifact missing");

    let archive_exit = snowball_plane::run(
        root,
        &[
            "archive-discarded".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch18".to_string(),
        ],
    );
    assert_eq!(archive_exit, 0);
    let archive_latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        archive_latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_archive_discarded")
    );
    assert_claim(&archive_latest, "V6-APP-023.9");
    let archive_items = archive_latest
        .pointer("/archive/items")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    assert_eq!(archive_items.len(), 2);

    let publish_exit = snowball_plane::run(
        root,
        &[
            "publish-benchmarks".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch18".to_string(),
            format!("--benchmark-report={}", benchmark_report.display()),
            format!("--readme-path={}", readme_path.display()),
        ],
    );
    assert_eq!(publish_exit, 0);
    let publish_latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        publish_latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_publish_benchmarks")
    );
    assert_claim(&publish_latest, "V6-APP-023.10");
    assert_eq!(
        publish_latest
            .pointer("/publication/readme_sync/synced")
            .and_then(Value::as_bool),
        Some(true)
    );

    let promote_exit = snowball_plane::run(
        root,
        &[
            "promote".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch18".to_string(),
            "--allow-neutral=1".to_string(),
            "--neutral-justification=benchmark delta remained neutral while regression proof and publication evidence stayed green".to_string(),
        ],
    );
    assert_eq!(promote_exit, 0);
    let promote_latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        promote_latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_promote")
    );
    assert_claim(&promote_latest, "V6-APP-023.8");
    assert_eq!(
        promote_latest
            .pointer("/promotion/promoted")
            .and_then(Value::as_bool),
        Some(true)
    );

    let prime_exit = snowball_plane::run(
        root,
        &[
            "prime-update".to_string(),
            "--strict=1".to_string(),
            "--cycle-id=batch18".to_string(),
            "--signer=test-snowball".to_string(),
            format!("--directive={directive_text}"),
        ],
    );
    std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
    assert_eq!(prime_exit, 0);
    let prime_latest = read_json(&snowball_latest_path(root));
    assert_eq!(
        prime_latest.get("type").and_then(Value::as_str),
        Some("snowball_plane_prime_update")
    );
    assert_claim(&prime_latest, "V6-APP-023.11");
    assert_eq!(
        prime_latest
            .pointer("/prime_directive_state/active_state_delta/next_stage")
            .and_then(Value::as_str),
        Some("prime-updated")
    );
}
