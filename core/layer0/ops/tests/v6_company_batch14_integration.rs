// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{company_plane, health_status};
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
        .join("company_plane")
        .join("latest.json")
}

fn health_latest_path(root: &Path) -> PathBuf {
    root.join("client")
        .join("local")
        .join("state")
        .join("ops")
        .join("health_status")
        .join("latest.json")
}

fn ticket_history_path(root: &Path, team: &str) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("company_plane")
        .join("tickets")
        .join("history")
        .join(format!("{team}.jsonl"))
}

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read");
    serde_json::from_str(&raw).expect("parse")
}

fn read_json_lines(path: &Path) -> Vec<Value> {
    let raw = fs::read_to_string(path).expect("read jsonl");
    raw.lines()
        .filter_map(|row| serde_json::from_str::<Value>(row).ok())
        .collect()
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
fn v6_company_batch14_ticket_chain_and_heartbeat_are_receipted() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let team = "research";

    let create_exit = company_plane::run(
        root,
        &[
            "ticket".to_string(),
            "--strict=1".to_string(),
            "--op=create".to_string(),
            "--team=research".to_string(),
            "--ticket-id=TKT-100".to_string(),
            "--title=stabilize telemetry".to_string(),
            "--assignee=alpha".to_string(),
            "--tool-call-id=tool-create-1".to_string(),
        ],
    );
    assert_eq!(create_exit, 0);
    let create_latest = read_json(&latest_path(root));
    assert_eq!(
        create_latest.get("type").and_then(Value::as_str),
        Some("company_plane_ticket")
    );
    assert_claim(&create_latest, "V6-COMPANY-001.3");
    assert_claim(&create_latest, "V6-COMPANY-001.5");

    let assign_exit = company_plane::run(
        root,
        &[
            "ticket".to_string(),
            "--strict=1".to_string(),
            "--op=assign".to_string(),
            "--team=research".to_string(),
            "--ticket-id=TKT-100".to_string(),
            "--assignee=beta".to_string(),
            "--tool-call-id=tool-assign-1".to_string(),
        ],
    );
    assert_eq!(assign_exit, 0);
    let transition_exit = company_plane::run(
        root,
        &[
            "ticket".to_string(),
            "--strict=1".to_string(),
            "--op=transition".to_string(),
            "--team=research".to_string(),
            "--ticket-id=TKT-100".to_string(),
            "--to=in_review".to_string(),
            "--tool-call-id=tool-transition-1".to_string(),
        ],
    );
    assert_eq!(transition_exit, 0);
    let handoff_exit = company_plane::run(
        root,
        &[
            "ticket".to_string(),
            "--strict=1".to_string(),
            "--op=handoff".to_string(),
            "--team=research".to_string(),
            "--ticket-id=TKT-100".to_string(),
            "--from=beta".to_string(),
            "--to=gamma".to_string(),
            "--tool-call-id=tool-handoff-1".to_string(),
        ],
    );
    assert_eq!(handoff_exit, 0);
    let close_exit = company_plane::run(
        root,
        &[
            "ticket".to_string(),
            "--strict=1".to_string(),
            "--op=close".to_string(),
            "--team=research".to_string(),
            "--ticket-id=TKT-100".to_string(),
            "--tool-call-id=tool-close-1".to_string(),
        ],
    );
    assert_eq!(close_exit, 0);

    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest
            .get("ticket")
            .and_then(|v| v.get("state"))
            .and_then(Value::as_str),
        Some("closed")
    );
    let history = read_json_lines(&ticket_history_path(root, team));
    assert!(history.len() >= 5);
    for pair in history.windows(2) {
        let prev_hash = pair[0]
            .get("event_hash")
            .and_then(Value::as_str)
            .unwrap_or("");
        let claimed_prev = pair[1]
            .get("prev_event_hash")
            .and_then(Value::as_str)
            .unwrap_or("");
        assert_eq!(claimed_prev, prev_hash);
    }

    let heartbeat_tick_exit = company_plane::run(
        root,
        &[
            "heartbeat".to_string(),
            "--strict=1".to_string(),
            "--op=tick".to_string(),
            "--team=research".to_string(),
            "--status=healthy".to_string(),
            "--agents-online=6".to_string(),
            "--queue-depth=4".to_string(),
        ],
    );
    assert_eq!(heartbeat_tick_exit, 0);
    let heartbeat_latest = read_json(&latest_path(root));
    assert_eq!(
        heartbeat_latest.get("type").and_then(Value::as_str),
        Some("company_plane_heartbeat")
    );
    assert_claim(&heartbeat_latest, "V6-COMPANY-001.4");
    assert_claim(&heartbeat_latest, "V6-COMPANY-001.5");

    let feed_exit = company_plane::run(
        root,
        &[
            "heartbeat".to_string(),
            "--strict=1".to_string(),
            "--op=remote-feed".to_string(),
        ],
    );
    assert_eq!(feed_exit, 0);
    let feed_latest = read_json(&latest_path(root));
    assert_eq!(
        feed_latest
            .get("remote_feed")
            .and_then(|v| v.get("teams"))
            .and_then(Value::as_object)
            .map(|m| m.len())
            .unwrap_or(0)
            > 0,
        true
    );

    let health_exit = health_status::run(root, &["dashboard".to_string()]);
    assert_eq!(health_exit, 0);
    let health_latest = read_json(&health_latest_path(root));
    let metric = health_latest
        .get("dashboard_metrics")
        .and_then(|v| v.get("company_heartbeat_surface"));
    assert!(metric.is_some(), "missing company heartbeat metric");
}

#[test]
fn v6_company_batch14_rejects_ticket_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = company_plane::run(
        root,
        &[
            "ticket".to_string(),
            "--strict=1".to_string(),
            "--op=create".to_string(),
            "--title=bypass-attempt".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("company_plane_conduit_gate")
    );
}
