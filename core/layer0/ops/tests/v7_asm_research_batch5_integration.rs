// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{asm_plane, research_plane, security_plane};
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

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).expect("mkdir");
    }
    let mut body = serde_json::to_string_pretty(value).expect("encode");
    body.push('\n');
    fs::write(path, body).expect("write");
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
    copy_tree(
        &workspace.join("client").join("runtime").join("config"),
        &root.join("client").join("runtime").join("config"),
    );
    tmp
}

fn asm_latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("asm_plane")
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

#[test]
fn v7_asm_004_to_010_strict_lanes_execute_with_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    write_json(
        &root
            .join("state")
            .join("release")
            .join("provenance_bundle")
            .join("latest.json"),
        &json!({
            "schema_id": "release_provenance_bundle",
            "artifacts": ["protheus-ops", "protheusd"]
        }),
    );
    write_json(
        &root
            .join("state")
            .join("release")
            .join("provenance")
            .join("rekor_entries.json"),
        &json!({
            "entries": [{"uuid":"rekor-1"}]
        }),
    );
    let signatures_dir = root
        .join("state")
        .join("release")
        .join("provenance")
        .join("signatures");
    fs::create_dir_all(&signatures_dir).expect("mkdir signatures");
    fs::write(signatures_dir.join("protheus-ops.sig"), "sig:ops").expect("write sig 1");
    fs::write(signatures_dir.join("protheusd.sig"), "sig:daemon").expect("write sig 2");
    fs::write(signatures_dir.join("conduit_daemon.sig"), "sig:conduit").expect("write sig 3");

    let lanes: Vec<(&str, Vec<String>, &str)> = vec![
        (
            "wasm-dual-meter",
            vec![
                "wasm-dual-meter".to_string(),
                "--strict=1".to_string(),
                "--ticks=4".to_string(),
                "--fuel-budget=1000".to_string(),
                "--epoch-budget=10".to_string(),
                "--fuel-per-tick=100".to_string(),
                "--epoch-step=1".to_string(),
            ],
            "asm_wasm_dual_meter",
        ),
        (
            "hands-runtime-install",
            vec![
                "hands-runtime".to_string(),
                "--strict=1".to_string(),
                "--op=install".to_string(),
            ],
            "asm_hands_runtime",
        ),
        (
            "hands-runtime-start",
            vec![
                "hands-runtime".to_string(),
                "--strict=1".to_string(),
                "--op=start".to_string(),
            ],
            "asm_hands_runtime",
        ),
        (
            "hands-runtime-pause",
            vec![
                "hands-runtime".to_string(),
                "--strict=1".to_string(),
                "--op=pause".to_string(),
            ],
            "asm_hands_runtime",
        ),
        (
            "hands-runtime-rotate",
            vec![
                "hands-runtime".to_string(),
                "--strict=1".to_string(),
                "--op=rotate".to_string(),
                "--version=1.2.3".to_string(),
            ],
            "asm_hands_runtime",
        ),
        (
            "crdt-adapter",
            vec![
                "crdt-adapter".to_string(),
                "--strict=1".to_string(),
                "--op=merge".to_string(),
                "--left-json={\"topic\":{\"value\":\"alpha\",\"clock\":1,\"node\":\"a\"}}"
                    .to_string(),
                "--right-json={\"topic\":{\"value\":\"beta\",\"clock\":2,\"node\":\"b\"}}"
                    .to_string(),
            ],
            "asm_crdt_adapter_merge",
        ),
        (
            "trust-chain",
            vec!["trust-chain".to_string(), "--strict=1".to_string()],
            "asm_trust_chain",
        ),
        (
            "fastpath",
            vec![
                "fastpath".to_string(),
                "--strict=1".to_string(),
                "--workload=1,2,3".to_string(),
            ],
            "asm_fastpath",
        ),
        (
            "industrial-pack",
            vec!["industrial-pack".to_string(), "--strict=1".to_string()],
            "asm_industrial_pack",
        ),
    ];

    for (lane, argv, expected_type) in lanes {
        let exit = asm_plane::run(root, &argv);
        assert_eq!(exit, 0, "lane should pass in strict mode: {lane}");
        let latest = read_json(&asm_latest_path(root));
        assert_eq!(
            latest.get("type").and_then(Value::as_str),
            Some(expected_type)
        );
        assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(true));
        assert!(
            latest
                .get("receipt_hash")
                .and_then(Value::as_str)
                .map(|v| v.len() > 12)
                .unwrap_or(false),
            "lane {lane} must emit deterministic receipt hash"
        );
    }
}

#[test]
fn v6_research_001_1_to_001_3_strict_lanes_execute_with_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let page_path = root.join("fixtures").join("research_page.html");
    if let Some(parent) = page_path.parent() {
        fs::create_dir_all(parent).expect("mkdir fixture");
    }
    fs::write(
        &page_path,
        "<html><body><main>hello graph world</main></body></html>",
    )
    .expect("write page");
    let page_url = format!("file://{}", page_path.display());

    let fetch_exit = research_plane::run(
        root,
        &[
            "fetch".to_string(),
            "--strict=1".to_string(),
            format!("--url={page_url}"),
            "--mode=auto".to_string(),
            "--timeout-ms=2000".to_string(),
        ],
    );
    assert_eq!(fetch_exit, 0);
    let fetch_latest = read_json(&research_latest_path(root));
    assert_eq!(
        fetch_latest.get("type").and_then(Value::as_str),
        Some("research_plane_fetch")
    );
    assert_eq!(fetch_latest.get("ok").and_then(Value::as_bool), Some(true));

    let selector_exit = research_plane::run(
        root,
        &[
            "recover-selectors".to_string(),
            "--strict=1".to_string(),
            "--html=<div>agent memory bridge</div>".to_string(),
            "--selectors=#missing,.missing".to_string(),
            "--target-text=agent memory bridge".to_string(),
        ],
    );
    assert_eq!(selector_exit, 0);
    let selector_latest = read_json(&research_latest_path(root));
    assert_eq!(
        selector_latest.get("type").and_then(Value::as_str),
        Some("research_plane_selector_recovery")
    );
    assert_eq!(
        selector_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );

    let crawl_exit = research_plane::run(
        root,
        &[
            "crawl".to_string(),
            "--strict=1".to_string(),
            format!("--seed-url={page_url}"),
            "--max-pages=1".to_string(),
            "--max-concurrency=1".to_string(),
            "--max-retries=0".to_string(),
            "--per-domain-qps=1".to_string(),
            "--checkpoint-every=1".to_string(),
        ],
    );
    assert_eq!(crawl_exit, 0);
    let crawl_latest = read_json(&research_latest_path(root));
    assert_eq!(
        crawl_latest.get("type").and_then(Value::as_str),
        Some("research_plane_crawl")
    );
    assert_eq!(crawl_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        crawl_latest.get("visited_count").and_then(Value::as_u64),
        Some(1)
    );
}

#[test]
fn v7_asm_006_abac_lane_runs_via_security_plane_and_writes_flight_chain() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    write_json(
        &root
            .join("client")
            .join("runtime")
            .join("config")
            .join("abac_policy_plane.json"),
        &json!({
            "version": "v1",
            "kind": "abac_policy_plane",
            "default_effect": "deny",
            "rules": [
                {
                    "id": "allow_read_public_prod",
                    "effect": "allow",
                    "action": ["read"],
                    "subject": {"role": ["operator"]},
                    "object": {"classification": ["public"]},
                    "context": {"env": ["prod"]}
                }
            ],
            "flight_recorder": {
                "immutable": true,
                "hash_chain": true,
                "redact_subject_fields": []
            }
        }),
    );

    let first = security_plane::run(
        root,
        &[
            "abac-policy-plane".to_string(),
            "evaluate".to_string(),
            "--action=read".to_string(),
            "--subject-role=operator".to_string(),
            "--subject-id=op-1".to_string(),
            "--object-classification=public".to_string(),
            "--context-env=prod".to_string(),
        ],
    );
    assert_eq!(first, 0);
    let second = security_plane::run(
        root,
        &[
            "abac-policy-plane".to_string(),
            "evaluate".to_string(),
            "--action=read".to_string(),
            "--subject-role=operator".to_string(),
            "--subject-id=op-2".to_string(),
            "--object-classification=public".to_string(),
            "--context-env=prod".to_string(),
        ],
    );
    assert_eq!(second, 0);

    let latest_path = root
        .join("client")
        .join("runtime")
        .join("local")
        .join("state")
        .join("security")
        .join("abac_policy_plane_latest.json");
    let latest = read_json(&latest_path);
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("abac_policy_plane_evaluate")
    );
    assert_eq!(
        latest.get("decision").and_then(Value::as_str),
        Some("allow")
    );
    assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(true));

    let flight_path = root
        .join("client")
        .join("runtime")
        .join("local")
        .join("state")
        .join("security")
        .join("abac_flight_recorder.jsonl");
    let raw = fs::read_to_string(&flight_path).expect("read flight chain");
    let rows = raw
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>();
    assert_eq!(rows.len(), 2);
    let first_hash = rows[0]
        .get("hash")
        .and_then(Value::as_str)
        .expect("first hash");
    assert_eq!(
        rows[1]
            .get("prev_hash")
            .and_then(Value::as_str)
            .unwrap_or(""),
        first_hash
    );
}
