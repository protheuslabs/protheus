// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{assimilation_controller, research_plane};
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

fn read_json_lines(path: &Path) -> Vec<Value> {
    let raw = fs::read_to_string(path).expect("read jsonl");
    raw.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn write_json_lines(path: &Path, rows: &[Value]) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("mkdir");
    }
    let body = rows
        .iter()
        .map(|row| serde_json::to_string(row).expect("encode row"))
        .collect::<Vec<_>>()
        .join("\n");
    fs::write(path, format!("{body}\n")).expect("write jsonl");
}

fn stage_fixture_root() -> TempDir {
    let workspace = workspace_root();
    let tmp = tempfile::tempdir().expect("tempdir");
    let root = tmp.path();

    copy_tree(
        &workspace.join("planes").join("contracts"),
        &root.join("planes").join("contracts"),
    );
    copy_tree(
        &workspace.join("client").join("runtime").join("config"),
        &root.join("client").join("runtime").join("config"),
    );
    tmp
}

fn assimilation_latest_path(root: &Path) -> PathBuf {
    root.join("state")
        .join("ops")
        .join("assimilation_controller")
        .join("latest.json")
}

fn research_latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("research_plane")
        .join("latest.json")
}

fn assert_claim(payload: &Value, claim_id: &str) {
    let ok = payload
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some(claim_id));
    assert!(ok, "claim {claim_id} missing");
}

#[test]
fn v7_assimilate_001_1_to_001_5_lanes_are_runtime_proven() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let exit_variant = assimilation_controller::run(
        root,
        &["variant-profiles".to_string(), "--strict=1".to_string()],
    );
    assert_eq!(exit_variant, 0);
    let variant_latest = read_json(&assimilation_latest_path(root));
    assert_eq!(
        variant_latest.get("type").and_then(Value::as_str),
        Some("assimilation_controller_variant_profiles")
    );
    assert_eq!(
        variant_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&variant_latest, "V7-ASSIMILATE-001.1");

    let exit_mpu = assimilation_controller::run(
        root,
        &["mpu-compartments".to_string(), "--strict=1".to_string()],
    );
    assert_eq!(exit_mpu, 0);
    let mpu_latest = read_json(&assimilation_latest_path(root));
    assert_eq!(
        mpu_latest.get("type").and_then(Value::as_str),
        Some("assimilation_controller_mpu_compartments")
    );
    assert_eq!(mpu_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&mpu_latest, "V7-ASSIMILATE-001.2");

    for (op, expected_exit) in [("grant", 0), ("revoke", 0), ("verify", 0)] {
        let exit = assimilation_controller::run(
            root,
            &[
                "capability-ledger".to_string(),
                format!("--op={op}"),
                "--capability=observe".to_string(),
                "--subject=edge_node".to_string(),
                "--strict=1".to_string(),
            ],
        );
        assert_eq!(exit, expected_exit, "capability-ledger op={op}");
    }
    let cap_latest = read_json(&assimilation_latest_path(root));
    assert_eq!(
        cap_latest.get("type").and_then(Value::as_str),
        Some("assimilation_controller_capability_ledger")
    );
    assert_eq!(cap_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        cap_latest.get("chain_valid").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&cap_latest, "V7-ASSIMILATE-001.3");

    let events_path = PathBuf::from(
        cap_latest
            .get("events_path")
            .and_then(Value::as_str)
            .expect("events path"),
    );
    let mut rows = read_json_lines(&events_path);
    assert!(
        rows.len() >= 2,
        "capability ledger should emit at least two events for tamper check"
    );
    rows[1]["previous_hash"] = Value::String("tampered".to_string());
    write_json_lines(&events_path, &rows);

    let verify_exit = assimilation_controller::run(
        root,
        &[
            "capability-ledger".to_string(),
            "--op=verify".to_string(),
            "--strict=1".to_string(),
        ],
    );
    assert_eq!(verify_exit, 1);
    let verify_latest = read_json(&assimilation_latest_path(root));
    assert_eq!(verify_latest.get("ok").and_then(Value::as_bool), Some(false));
    assert_eq!(
        verify_latest.get("chain_valid").and_then(Value::as_bool),
        Some(false)
    );
    assert_claim(&verify_latest, "V7-ASSIMILATE-001.3");
    assert!(
        verify_latest
            .get("verify_errors")
            .and_then(Value::as_array)
            .map(|rows| rows
                .iter()
                .filter_map(Value::as_str)
                .any(|row| row.starts_with("previous_hash_mismatch_at:")))
            .unwrap_or(false),
        "tampered capability ledger should fail previous_hash verification"
    );

    let exit_wasm = assimilation_controller::run(
        root,
        &[
            "wasm-dual-meter".to_string(),
            "--strict=1".to_string(),
            "--ticks=4".to_string(),
            "--fuel-budget=1000".to_string(),
            "--epoch-budget=10".to_string(),
            "--fuel-per-tick=100".to_string(),
            "--epoch-step=1".to_string(),
        ],
    );
    assert_eq!(exit_wasm, 0);
    let wasm_latest = read_json(&assimilation_latest_path(root));
    assert_eq!(
        wasm_latest.get("type").and_then(Value::as_str),
        Some("assimilation_controller_wasm_dual_meter")
    );
    assert_eq!(wasm_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&wasm_latest, "V7-ASSIMILATE-001.4");

    for (op, expected_exit) in [
        ("install", 0),
        ("start", 0),
        ("pause", 0),
        ("rotate", 0),
        ("status", 0),
    ] {
        let mut argv = vec![
            "hands-runtime".to_string(),
            format!("--op={op}"),
            "--strict=1".to_string(),
        ];
        if op == "rotate" {
            argv.push("--version=3.2.1".to_string());
        }
        let exit = assimilation_controller::run(root, &argv);
        assert_eq!(exit, expected_exit, "hands-runtime op={op}");
    }
    let hands_latest = read_json(&assimilation_latest_path(root));
    assert_eq!(
        hands_latest.get("type").and_then(Value::as_str),
        Some("assimilation_controller_hands_runtime")
    );
    assert_eq!(hands_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&hands_latest, "V7-ASSIMILATE-001.5");

    // Sovereignty/security gate proof: strict mode rejects explicit bypass.
    let bypass_exit = assimilation_controller::run(
        root,
        &[
            "capability-ledger".to_string(),
            "--op=status".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
        ],
    );
    assert_eq!(bypass_exit, 1, "bypass must fail closed in strict mode");
}

#[test]
fn v6_research_002_1_to_002_5_lanes_remain_runtime_proven() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let spider_exit = research_plane::run(
        root,
        &[
            "spider".to_string(),
            "--strict=1".to_string(),
            "--graph-json={\"https://a.test\":{\"links\":[\"https://a.test/alpha\",\"https://b.test/beta\"]},\"https://a.test/alpha\":{\"links\":[]},\"https://b.test/beta\":{\"links\":[]}}".to_string(),
            "--seed-urls=https://a.test".to_string(),
            "--allowed-domains=a.test".to_string(),
        ],
    );
    assert_eq!(spider_exit, 0);
    let spider_latest = read_json(&research_latest_path(root));
    assert_eq!(
        spider_latest.get("type").and_then(Value::as_str),
        Some("research_plane_rule_spider")
    );
    assert_eq!(spider_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&spider_latest, "V6-RESEARCH-002.1");

    let middleware_exit = research_plane::run(
        root,
        &[
            "middleware".to_string(),
            "--strict=1".to_string(),
            "--request-json={\"url\":\"https://example.com\",\"headers\":{}}".to_string(),
            "--response-json={\"status\":200,\"body\":\"<html><body>ok</body></html>\"}".to_string(),
            "--stack-json=[{\"id\":\"ua\",\"hook\":\"before_request\",\"set_header\":{\"X-Test\":\"batch26\"}},{\"id\":\"compact\",\"hook\":\"after_response\",\"compact_body\":true}]".to_string(),
        ],
    );
    assert_eq!(middleware_exit, 0);
    let middleware_latest = read_json(&research_latest_path(root));
    assert_eq!(
        middleware_latest.get("type").and_then(Value::as_str),
        Some("research_plane_middleware")
    );
    assert_eq!(
        middleware_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&middleware_latest, "V6-RESEARCH-002.2");

    let export_path = root
        .join("state")
        .join("research")
        .join("batch26_pipeline.json");
    let pipeline_exit = research_plane::run(
        root,
        &[
            "pipeline".to_string(),
            "--strict=1".to_string(),
            "--items-json=[{\"url\":\"https://a.test\",\"title\":\"alpha\"},{\"url\":\"https://a.test\",\"title\":\"duplicate\"},{\"url\":\"https://b.test\",\"title\":\"beta\"}]".to_string(),
            "--pipeline-json=[{\"stage\":\"validate\",\"required_fields\":[\"url\",\"title\"]},{\"stage\":\"dedupe\",\"key\":\"url\"},{\"stage\":\"enrich\",\"add\":{\"source\":\"batch26\"}}]".to_string(),
            format!("--export-path={}", export_path.display()),
            "--export-format=json".to_string(),
        ],
    );
    assert_eq!(pipeline_exit, 0);
    let pipeline_latest = read_json(&research_latest_path(root));
    assert_eq!(
        pipeline_latest.get("type").and_then(Value::as_str),
        Some("research_plane_item_pipeline")
    );
    assert_eq!(
        pipeline_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert!(export_path.exists(), "pipeline exporter must emit artifact");
    assert_claim(&pipeline_latest, "V6-RESEARCH-002.3");

    let signals_exit = research_plane::run(
        root,
        &[
            "signals".to_string(),
            "--strict=1".to_string(),
            "--events-json=[{\"signal\":\"spider_opened\",\"payload\":{}},{\"signal\":\"item_scraped\",\"payload\":{\"url\":\"https://a.test\"}}]".to_string(),
            "--handlers-json=[{\"id\":\"metrics\",\"signal\":\"item_scraped\"},{\"id\":\"lifecycle\",\"signal\":\"spider_opened\"}]".to_string(),
        ],
    );
    assert_eq!(signals_exit, 0);
    let signals_latest = read_json(&research_latest_path(root));
    assert_eq!(
        signals_latest.get("type").and_then(Value::as_str),
        Some("research_plane_signal_bus")
    );
    assert_eq!(
        signals_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&signals_latest, "V6-RESEARCH-002.4");

    std::env::set_var("RESEARCH_CONSOLE_TOKEN", "batch26-console-token");
    let console_exit = research_plane::run(
        root,
        &[
            "console".to_string(),
            "--strict=1".to_string(),
            "--op=pause".to_string(),
            "--auth-token=batch26-console-token".to_string(),
        ],
    );
    assert_eq!(console_exit, 0);
    let console_latest = read_json(&research_latest_path(root));
    assert_eq!(
        console_latest.get("type").and_then(Value::as_str),
        Some("research_plane_console")
    );
    assert_eq!(
        console_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&console_latest, "V6-RESEARCH-002.5");
}
