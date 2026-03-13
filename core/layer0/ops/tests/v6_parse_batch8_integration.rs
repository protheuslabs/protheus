// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::parse_plane;
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

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read");
    serde_json::from_str(&raw).expect("parse")
}

fn stage_fixture_root() -> TempDir {
    let workspace = workspace_root();
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();
    copy_tree(
        &workspace.join("planes").join("contracts"),
        &root.join("planes").join("contracts"),
    );
    tmp
}

fn latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("parse_plane")
        .join("latest.json")
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
fn v6_parse_batch8_parse_doc_and_visualize_with_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let source_path = root.join("fixtures").join("sample_report.html");
    if let Some(parent) = source_path.parent() {
        fs::create_dir_all(parent).expect("mkdir fixtures");
    }
    fs::write(
        &source_path,
        "<html><head><title>Q1 Filing</title></head><body>\nCompany: Protheus Labs\nSummary: Strong revenue growth and reduced burn. EndSummary\nRisk factor coverage included.\n</body></html>",
    )
    .expect("write source");

    let parse_exit = parse_plane::run(
        root,
        &[
            "parse-doc".to_string(),
            format!("--file={}", source_path.display()),
            "--mapping=default".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(parse_exit, 0);
    let parse_latest = read_json(&latest_path(root));
    assert_eq!(
        parse_latest.get("type").and_then(Value::as_str),
        Some("parse_plane_parse_doc")
    );
    assert_eq!(parse_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert!(parse_latest
        .get("pipeline")
        .and_then(|v| v.get("structured"))
        .and_then(|v| v.get("title"))
        .and_then(Value::as_str)
        .map(|v| v == "Q1 Filing")
        .unwrap_or(false));
    assert_claim(&parse_latest, "V6-PARSE-001.1");

    let parse_artifact = parse_latest
        .get("artifact")
        .and_then(|v| v.get("path"))
        .and_then(Value::as_str)
        .expect("artifact path")
        .to_string();

    let viz_exit = parse_plane::run(
        root,
        &[
            "visualize".to_string(),
            format!("--from-path={parse_artifact}"),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(viz_exit, 0);
    let viz_latest = read_json(&latest_path(root));
    assert_eq!(
        viz_latest.get("type").and_then(Value::as_str),
        Some("parse_plane_visualize")
    );
    assert_eq!(viz_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert!(viz_latest
        .get("visualization")
        .and_then(|v| v.get("diagram"))
        .and_then(Value::as_str)
        .map(|v| v.contains("source -> instructions -> structured_dict"))
        .unwrap_or(false));
    assert_claim(&viz_latest, "V6-PARSE-001.2");
}

#[test]
fn v6_parse_batch8_fails_closed_on_missing_mapping() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let source_path = root.join("fixtures").join("sample_report.txt");
    if let Some(parent) = source_path.parent() {
        fs::create_dir_all(parent).expect("mkdir fixtures");
    }
    fs::write(&source_path, "Company: Missing Mapping").expect("write source");

    let parse_exit = parse_plane::run(
        root,
        &[
            "parse-doc".to_string(),
            format!("--file={}", source_path.display()),
            "--mapping=missing_mapping".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(parse_exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("parse_plane_parse_doc")
    );
    assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(false));
    assert!(latest
        .get("errors")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().any(|row| row
            .as_str()
            .map(|v| v.starts_with("mapping_not_found:"))
            .unwrap_or(false)))
        .unwrap_or(false));
}
