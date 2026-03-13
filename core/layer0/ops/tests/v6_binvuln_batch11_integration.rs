// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::binary_vuln_plane;
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

fn latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("binary_vuln_plane")
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
fn v6_binvuln_batch11_core_lanes_execute_with_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let sample = root.join("tmp").join("firmware.bin");
    fs::create_dir_all(sample.parent().expect("parent")).expect("mkdir");
    fs::write(
        &sample,
        b"firmware-start\npassword=supersecret\n/bin/sh\nhttp://example.local\n",
    )
    .expect("write sample");

    let scan_exit = binary_vuln_plane::run(
        root,
        &[
            "scan".to_string(),
            "--strict=1".to_string(),
            format!("--input={}", sample.display()),
            "--format=json".to_string(),
        ],
    );
    assert_eq!(scan_exit, 0);
    let scan_latest = read_json(&latest_path(root));
    assert_eq!(
        scan_latest.get("type").and_then(Value::as_str),
        Some("binary_vuln_plane_scan")
    );
    assert_eq!(scan_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert!(
        scan_latest
            .get("output")
            .and_then(|v| v.get("finding_count"))
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0
    );
    assert!(
        scan_latest
            .get("input")
            .and_then(|v| v.get("path_redacted"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        "strict scan should redact input paths by default"
    );
    assert_claim(&scan_latest, "V6-BINVULN-001.1");
    assert_claim(&scan_latest, "V6-BINVULN-001.3");
    assert_claim(&scan_latest, "V6-BINVULN-001.4");

    let jsonl_exit = binary_vuln_plane::run(
        root,
        &[
            "scan".to_string(),
            "--strict=1".to_string(),
            format!("--input={}", sample.display()),
            "--format=jsonl".to_string(),
        ],
    );
    assert_eq!(jsonl_exit, 0);
    let jsonl_latest = read_json(&latest_path(root));
    assert_eq!(
        jsonl_latest
            .get("output")
            .and_then(|v| v.get("format"))
            .and_then(Value::as_str),
        Some("jsonl")
    );
    assert_claim(&jsonl_latest, "V6-BINVULN-001.3");

    let mcp_exit = binary_vuln_plane::run(
        root,
        &[
            "mcp-analyze".to_string(),
            "--strict=1".to_string(),
            format!("--input={}", sample.display()),
            "--transport=stdio".to_string(),
        ],
    );
    assert_eq!(mcp_exit, 0);
    let mcp_latest = read_json(&latest_path(root));
    assert_eq!(
        mcp_latest.get("type").and_then(Value::as_str),
        Some("binary_vuln_plane_mcp_analyze")
    );
    assert_eq!(mcp_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&mcp_latest, "V6-BINVULN-001.2");
    assert_claim(&mcp_latest, "V6-BINVULN-001.4");
}

#[test]
fn v6_binvuln_batch11_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = binary_vuln_plane::run(
        root,
        &[
            "scan".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
            "--input=missing.bin".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("binary_vuln_plane_conduit_gate")
    );
    assert!(
        latest
            .get("conduit_enforcement")
            .and_then(|v| v.get("claim_evidence"))
            .and_then(Value::as_array)
            .map(|rows| rows
                .iter()
                .any(|row| row.get("id").and_then(Value::as_str) == Some("V6-BINVULN-001.4")))
            .unwrap_or(false),
        "conduit bypass rejection should emit sandbox safety claim evidence"
    );
}
