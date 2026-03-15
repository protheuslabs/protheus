use std::fs;
use std::path::{Path, PathBuf};

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn assert_path_contains(repo_root: &Path, rel: &str, needle: &str) {
    let path = repo_root.join(rel);
    assert!(path.exists(), "missing evidence path: {rel}");
    let content = fs::read_to_string(&path).unwrap_or_default();
    assert!(
        content.contains(needle),
        "expected marker `{needle}` in {rel}"
    );
}

#[test]
fn pure_workspace_srs_rows_have_runtime_evidence_paths() {
    let repo = repo_root();

    // V7-PURE-WORKSPACE-001.1
    assert_path_contains(&repo, "client/pure-workspace/src/lib.rs", "pure-workspace");
    assert_path_contains(&repo, "client/pure-workspace/src/main.rs", "benchmark-ping");

    // V7-PURE-WORKSPACE-001.2
    assert_path_contains(
        &repo,
        "core/layer0/ops/src/protheusctl_routes.rs",
        "tiny-max",
    );
    assert_path_contains(&repo, "core/layer0/ops/src/canyon_plane.rs", "--pure");
    assert_path_contains(
        &repo,
        "core/layer0/ops/tests/v7_pure_workspace_integration.rs",
        "ecosystem_init_pure_dry_run_emits_pure_components",
    );

    // V7-PURE-WORKSPACE-001.3
    assert_path_contains(&repo, "install.sh", "--pure");
    assert_path_contains(&repo, "install.ps1", "InstallPure");
    assert_path_contains(
        &repo,
        "core/layer0/ops/src/benchmark_matrix.rs",
        "pure_workspace_measured",
    );

    // V7-PURE-WORKSPACE-002.1
    assert_path_contains(&repo, "core/layer0/ops/Cargo.toml", "embedded-max");
    assert_path_contains(&repo, "core/layer0/ops/src/protheusd.rs", "tiny-max-status");

    // V7-PURE-WORKSPACE-002.2
    assert_path_contains(
        &repo,
        "core/layer0/ops/src/benchmark_matrix.rs",
        "pure_workspace_tiny_max_measured",
    );
    assert_path_contains(&repo, "README.md", "Tiny-max");
}

#[test]
fn bench_recovery_srs_rows_have_runtime_evidence_paths() {
    let repo = repo_root();

    // V7-BENCH-RECOVERY-001.1
    assert_path_contains(&repo, "core/layer0/ops/src/lib.rs", "core-lazy");
    assert_path_contains(
        &repo,
        "core/layer0/ops/tests/v7_bench_recovery_integration.rs",
        "runtime_efficiency_core_lazy_path_stays_receipted_and_live",
    );

    // V7-BENCH-RECOVERY-001.2
    assert_path_contains(
        &repo,
        "core/layer0/ops/src/lib.rs",
        "configure_low_memory_allocator_env",
    );
    assert_path_contains(
        &repo,
        "core/layer0/ops/src/protheusd.rs",
        "configure_low_memory_allocator_env",
    );

    // V7-BENCH-RECOVERY-001.3
    assert_path_contains(&repo, "core/layer0/ops/src/lib.rs", "no-client-bloat");
    assert_path_contains(&repo, "install.sh", ".tar.zst");
    assert_path_contains(&repo, "install.ps1", ".tar.zst");

    // V7-BENCH-RECOVERY-001.4
    assert_path_contains(&repo, "core/layer0/tiny_runtime/Cargo.toml", "protheus-tiny-runtime");
    assert_path_contains(&repo, "core/layer0/ops/src/protheusd.rs", "tiny-status");
}
