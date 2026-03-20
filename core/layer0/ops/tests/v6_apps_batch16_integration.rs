// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::app_plane;
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
        .join("app_plane")
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
fn v6_apps_batch16_chat_surfaces_and_code_engineer_are_receipted() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let chat_starter_run = app_plane::run(
        root,
        &[
            "run".to_string(),
            "--strict=1".to_string(),
            "--app=chat-starter".to_string(),
            "--session-id=s1".to_string(),
            "--message=hello starter".to_string(),
            "--tool=memory.lookup".to_string(),
        ],
    );
    assert_eq!(chat_starter_run, 0);
    let chat_starter_history = app_plane::run(
        root,
        &[
            "history".to_string(),
            "--strict=1".to_string(),
            "--app=chat-starter".to_string(),
            "--session-id=s1".to_string(),
        ],
    );
    assert_eq!(chat_starter_history, 0);
    let chat_starter_replay = app_plane::run(
        root,
        &[
            "replay".to_string(),
            "--strict=1".to_string(),
            "--app=chat-starter".to_string(),
            "--session-id=s1".to_string(),
            "--turn=0".to_string(),
        ],
    );
    assert_eq!(chat_starter_replay, 0);
    let starter_latest = read_json(&latest_path(root));
    assert_eq!(
        starter_latest.get("type").and_then(Value::as_str),
        Some("app_plane_chat_starter")
    );
    assert_claim(&starter_latest, "V6-APP-008.1");

    let switch_provider = app_plane::run(
        root,
        &[
            "switch-provider".to_string(),
            "--strict=1".to_string(),
            "--app=chat-ui".to_string(),
            "--provider=anthropic".to_string(),
            "--model=claude-sonnet".to_string(),
        ],
    );
    assert_eq!(switch_provider, 0);
    let chat_ui_run = app_plane::run(
        root,
        &[
            "run".to_string(),
            "--strict=1".to_string(),
            "--app=chat-ui".to_string(),
            "--session-id=ui-s1".to_string(),
            "--message=hello ui".to_string(),
        ],
    );
    assert_eq!(chat_ui_run, 0);
    let chat_ui_status = app_plane::run(
        root,
        &[
            "status".to_string(),
            "--strict=1".to_string(),
            "--app=chat-ui".to_string(),
            "--session-id=ui-s1".to_string(),
        ],
    );
    assert_eq!(chat_ui_status, 0);
    let ui_latest = read_json(&latest_path(root));
    assert_eq!(
        ui_latest.get("type").and_then(Value::as_str),
        Some("app_plane_chat_ui")
    );

    let output_root = root
        .join("apps")
        .join("code_engineer")
        .join("generated")
        .join("batch16");
    let code_engineer_run = app_plane::run(
        root,
        &[
            "run".to_string(),
            "--strict=1".to_string(),
            "--app=code-engineer".to_string(),
            "--prompt=build task tracker api".to_string(),
            "--max-iterations=3".to_string(),
            format!("--output-root={}", output_root.display()),
        ],
    );
    assert_eq!(code_engineer_run, 0);
    let code_latest = read_json(&latest_path(root));
    assert_eq!(
        code_latest.get("type").and_then(Value::as_str),
        Some("app_plane_code_engineer")
    );
    assert_claim(&code_latest, "V6-APP-006.1");
    assert_claim(&code_latest, "V6-APP-006.2");
    assert_claim(&code_latest, "V6-APP-006.3");
    assert!(output_root.join("spec.json").exists());
    assert!(output_root.join("README.md").exists());
    assert!(output_root.join("src").join("main.ts").exists());
}

#[test]
fn v6_apps_batch16_chat_ui_run_accepts_input_flag() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let msg = "dashboard input path smoke";
    let exit = app_plane::run(
        root,
        &[
            "run".to_string(),
            "--strict=1".to_string(),
            "--app=chat-ui".to_string(),
            "--session-id=ui-input-flag".to_string(),
            format!("--input={msg}"),
        ],
    );
    assert_eq!(exit, 0);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("app_plane_chat_ui")
    );
    let turn = latest.get("turn").cloned().unwrap_or(Value::Null);
    assert_eq!(turn.get("user").and_then(Value::as_str), Some(msg));
    let assistant = turn
        .get("assistant")
        .and_then(Value::as_str)
        .unwrap_or_default();
    assert!(
        assistant.contains(msg),
        "assistant response should include routed input text"
    );
}

#[test]
fn v6_apps_batch16_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = app_plane::run(
        root,
        &[
            "run".to_string(),
            "--strict=1".to_string(),
            "--app=chat-starter".to_string(),
            "--message=hello".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("app_plane_conduit_gate")
    );
}
