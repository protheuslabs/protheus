// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::top1_assurance;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("mkdir");
    }
    let mut body = serde_json::to_string_pretty(value).expect("encode");
    body.push('\n');
    fs::write(path, body).expect("write");
}

fn stage_top1_fixture() -> tempfile::TempDir {
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();

    write_json(
        &root.join("client/runtime/config/top1_assurance_policy.json"),
        &json!({
            "version": "1.0",
            "strict_default": true,
            "proof_coverage": {
                "map_path": "proofs/layer0/core_formal_coverage_map.json",
                "min_proven_ratio": 0.2,
                "check_toolchains_default": false
            },
            "proof_vm": {
                "dockerfile_path": "proofs/layer0/ProofVM.Dockerfile",
                "replay_script_path": "proofs/layer0/replay.sh",
                "manifest_path": "core/local/state/ops/top1_assurance/proof_vm_manifest.json"
            },
            "size_gate": {
                "binary_path": "target/x86_64-unknown-linux-musl/release/protheusd",
                "min_mb": 25,
                "max_mb": 35,
                "require_static": false
            },
            "benchmark": {
                "benchmark_path": "core/local/state/ops/top1_assurance/benchmark_latest.json",
                "cold_start_max_ms": 80,
                "idle_rss_max_mb": 25,
                "tasks_per_sec_min": 5000,
                "sample_ms": 200
            },
            "comparison": {
                "snapshot_path": "client/runtime/config/competitive_benchmark_snapshot_2026_02.json",
                "output_path": "docs/comparison/protheus_vs_x.md"
            },
            "outputs": {
                "latest_path": "core/local/state/ops/top1_assurance/latest.json",
                "history_path": "core/local/state/ops/top1_assurance/history.jsonl"
            }
        }),
    );

    write_json(
        &root.join("proofs/layer0/core_formal_coverage_map.json"),
        &json!({
            "schema_id": "core_formal_coverage_map",
            "schema_version": "1.0",
            "surfaces": [
                {
                    "id": "core/layer0/ops::directive_kernel",
                    "status": "proven",
                    "artifact": "proofs/layer0/Layer0Invariants.lean",
                    "proof_commands": [
                        {
                            "id": "cargo_version",
                            "required": true,
                            "argv": ["cargo", "--version"]
                        }
                    ]
                },
                {
                    "id": "core/layer0/ops::metakernel",
                    "status": "partial",
                    "artifact": "core/layer0/ops/tests/v7_meta_lanes_integration.rs"
                },
                {
                    "id": "core/layer2/execution::scheduler",
                    "status": "unproven",
                    "artifact": "core/layer2/execution/src/lib.rs"
                }
            ]
        }),
    );

    if let Some(parent) = root.join("proofs/layer0/ProofVM.Dockerfile").parent() {
        fs::create_dir_all(parent).expect("mkdir");
    }
    fs::write(
        root.join("proofs/layer0/ProofVM.Dockerfile"),
        "FROM rust:1.84-bookworm\n",
    )
    .expect("write docker");
    fs::write(
        root.join("proofs/layer0/Layer0Invariants.lean"),
        "-- fixture\n",
    )
    .expect("write lean");
    if let Some(parent) = root
        .join("core/layer0/ops/tests/v7_meta_lanes_integration.rs")
        .parent()
    {
        fs::create_dir_all(parent).expect("mkdir");
    }
    fs::write(
        root.join("core/layer0/ops/tests/v7_meta_lanes_integration.rs"),
        "// fixture\n",
    )
    .expect("write metakernel fixture");
    if let Some(parent) = root.join("core/layer2/execution/src/lib.rs").parent() {
        fs::create_dir_all(parent).expect("mkdir");
    }
    fs::write(
        root.join("core/layer2/execution/src/lib.rs"),
        "// fixture\n",
    )
    .expect("write execution fixture");
    fs::write(
        root.join("proofs/layer0/replay.sh"),
        "#!/usr/bin/env bash\nset -euo pipefail\necho replay\n",
    )
    .expect("write replay");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let path = root.join("proofs/layer0/replay.sh");
        let mut perm = fs::metadata(&path).expect("metadata").permissions();
        perm.set_mode(0o755);
        fs::set_permissions(path, perm).expect("chmod");
    }

    write_json(
        &root.join("client/runtime/config/competitive_benchmark_snapshot_2026_02.json"),
        &json!({
            "version": "2026.02",
            "projects": {
                "OpenClaw": {
                    "cold_start_ms": 96,
                    "idle_memory_mb": 33,
                    "install_size_mb": 154,
                    "tasks_per_sec": 4200
                }
            }
        }),
    );

    write_json(
        &root.join("core/local/state/ops/top1_assurance/benchmark_latest.json"),
        &json!({
            "metrics": {
                "cold_start_ms": 72,
                "idle_rss_mb": 22,
                "install_size_mb": 126,
                "tasks_per_sec": 7200
            }
        }),
    );

    let binary = root.join("target/x86_64-unknown-linux-musl/release/protheusd");
    if let Some(parent) = binary.parent() {
        fs::create_dir_all(parent).expect("mkdir");
    }
    // 28 MiB fixture binary for size-gate checks.
    fs::write(&binary, vec![0_u8; 28 * 1024 * 1024]).expect("write binary");

    tmp
}

fn latest(root: &Path) -> Value {
    let path = root.join("core/local/state/ops/top1_assurance/latest.json");
    let raw = fs::read_to_string(path).expect("latest");
    serde_json::from_str(&raw).expect("parse")
}

#[test]
fn top1_assurance_strict_lanes_emit_receipts() {
    let fixture = stage_top1_fixture();
    let root = fixture.path();

    let lanes: Vec<Vec<String>> = vec![
        vec![
            "proof-coverage".to_string(),
            "--strict=1".to_string(),
            "--execute-proofs=1".to_string(),
        ],
        vec!["proof-vm".to_string(), "--strict=1".to_string()],
        vec!["size-gate".to_string(), "--strict=1".to_string()],
        vec![
            "benchmark-thresholds".to_string(),
            "--strict=1".to_string(),
            "--refresh=0".to_string(),
        ],
        vec![
            "comparison-matrix".to_string(),
            "--strict=1".to_string(),
            "--apply=1".to_string(),
        ],
        vec!["run-all".to_string(), "--strict=1".to_string()],
    ];

    for argv in lanes {
        let exit = top1_assurance::run(root, &argv);
        assert_eq!(exit, 0, "lane must pass: {:?}", argv);
        let latest = latest(root);
        assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(true));
        assert!(
            latest
                .get("receipt_hash")
                .and_then(Value::as_str)
                .map(|v| v.len() > 12)
                .unwrap_or(false),
            "deterministic receipt hash must be present"
        );
    }

    let matrix = fs::read_to_string(root.join("docs/comparison/protheus_vs_x.md")).expect("matrix");
    assert!(matrix.contains("# Protheus vs X (CI Generated)"));
}

#[test]
fn top1_assurance_proof_coverage_runs_declared_commands() {
    let fixture = stage_top1_fixture();
    let root = fixture.path();
    let exit = top1_assurance::run(
        root,
        &[
            "proof-coverage".to_string(),
            "--strict=1".to_string(),
            "--execute-proofs=1".to_string(),
        ],
    );
    assert_eq!(exit, 0);
    let latest = latest(root);
    let payload = latest.get("payload").expect("payload");
    assert_eq!(
        payload
            .get("execute_proofs")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        true
    );
    assert!(
        payload
            .get("proof_commands")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter().any(|row| {
                    row.get("id").and_then(Value::as_str) == Some("cargo_version")
                        && row.get("executed").and_then(Value::as_bool) == Some(true)
                        && row.get("ok").and_then(Value::as_bool) == Some(true)
                })
            })
            .unwrap_or(false),
        "proof command run rows must include executed cargo_version"
    );
}

#[test]
fn top1_assurance_size_gate_fails_closed_when_binary_missing() {
    let fixture = stage_top1_fixture();
    let root = fixture.path();
    let binary = root.join("target/x86_64-unknown-linux-musl/release/protheusd");
    fs::remove_file(binary).expect("remove");

    let exit = top1_assurance::run(root, &["size-gate".to_string(), "--strict=1".to_string()]);
    assert_eq!(exit, 1);
    let latest = latest(root);
    assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(false));
}
