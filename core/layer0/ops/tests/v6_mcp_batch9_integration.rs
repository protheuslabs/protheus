// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{mcp_plane, v8_kernel::sha256_hex_str};
use serde_json::{json, Map, Value};
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
        .join("mcp_plane")
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

fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let mut out = Map::new();
            for key in keys {
                if let Some(v) = map.get(&key) {
                    out.insert(key, canonicalize_json(v));
                }
            }
            Value::Object(out)
        }
        Value::Array(rows) => Value::Array(rows.iter().map(canonicalize_json).collect()),
        _ => value.clone(),
    }
}

fn canonical_json_string(value: &Value) -> String {
    serde_json::to_string(&canonicalize_json(value)).expect("encode canonical")
}

#[test]
fn v6_mcp_batch9_core_lanes_execute_with_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let matrix_exit = mcp_plane::run(
        root,
        &[
            "capability-matrix".to_string(),
            "--strict=1".to_string(),
            "--server-capabilities=tools.call,resources.read,server.expose".to_string(),
        ],
    );
    assert_eq!(matrix_exit, 0);
    let matrix_latest = read_json(&latest_path(root));
    assert_eq!(
        matrix_latest.get("type").and_then(Value::as_str),
        Some("mcp_plane_capability_matrix")
    );
    assert_eq!(matrix_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&matrix_latest, "V6-MCP-001.1");
    assert_claim(&matrix_latest, "V6-MCP-001.6");

    let start_exit = mcp_plane::run(
        root,
        &[
            "workflow".to_string(),
            "--strict=1".to_string(),
            "--op=start".to_string(),
            "--workflow-id=batch9".to_string(),
            "--checkpoint-json={\"step\":\"init\"}".to_string(),
        ],
    );
    assert_eq!(start_exit, 0);
    let start_latest = read_json(&latest_path(root));
    assert_eq!(
        start_latest.get("type").and_then(Value::as_str),
        Some("mcp_plane_workflow_runtime")
    );
    assert_eq!(
        start_latest
            .get("workflow")
            .and_then(|v| v.get("status"))
            .and_then(Value::as_str),
        Some("running")
    );
    assert_claim(&start_latest, "V6-MCP-001.2");
    assert_claim(&start_latest, "V6-MCP-001.6");

    let pause_exit = mcp_plane::run(
        root,
        &[
            "workflow".to_string(),
            "--strict=1".to_string(),
            "--op=pause".to_string(),
            "--workflow-id=batch9".to_string(),
        ],
    );
    assert_eq!(pause_exit, 0);
    let resume_exit = mcp_plane::run(
        root,
        &[
            "workflow".to_string(),
            "--strict=1".to_string(),
            "--op=resume".to_string(),
            "--workflow-id=batch9".to_string(),
        ],
    );
    assert_eq!(resume_exit, 0);
    let retry_exit = mcp_plane::run(
        root,
        &[
            "workflow".to_string(),
            "--strict=1".to_string(),
            "--op=retry".to_string(),
            "--workflow-id=batch9".to_string(),
            "--reason=network_error".to_string(),
        ],
    );
    assert_eq!(retry_exit, 0);

    let expose_exit = mcp_plane::run(
        root,
        &[
            "expose".to_string(),
            "--strict=1".to_string(),
            "--agent=research-agent".to_string(),
            "--tools=fetch,extract".to_string(),
            "--max-rps=20".to_string(),
        ],
    );
    assert_eq!(expose_exit, 0);
    let expose_latest = read_json(&latest_path(root));
    assert_eq!(
        expose_latest.get("type").and_then(Value::as_str),
        Some("mcp_plane_expose")
    );
    assert_eq!(expose_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&expose_latest, "V6-MCP-001.3");
    assert_claim(&expose_latest, "V6-MCP-001.6");

    let pattern_exit = mcp_plane::run(
        root,
        &[
            "pattern-pack".to_string(),
            "--strict=1".to_string(),
            "--pattern=map-reduce".to_string(),
            "--tasks=collect,aggregate".to_string(),
        ],
    );
    assert_eq!(pattern_exit, 0);
    let pattern_latest = read_json(&latest_path(root));
    assert_eq!(
        pattern_latest.get("type").and_then(Value::as_str),
        Some("mcp_plane_pattern_pack")
    );
    assert_eq!(
        pattern_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&pattern_latest, "V6-MCP-001.4");
    assert_claim(&pattern_latest, "V6-MCP-001.6");

    let templates_root = root
        .join("planes")
        .join("contracts")
        .join("mcp")
        .join("batch9_templates");
    fs::create_dir_all(&templates_root).expect("mkdir templates");
    let template_path = templates_root.join("batch9_router.json");
    fs::write(
        &template_path,
        "{\"name\":\"batch9_router\",\"pattern\":\"router\"}\n",
    )
    .expect("write template");
    let template_sha = sha256_hex_str(&fs::read_to_string(&template_path).expect("read template"));
    let mut manifest = json!({
        "version": "v1",
        "kind": "mcp_template_pack_manifest",
        "pack": "batch9-mcp",
        "updated_at": "2026-03-13T00:00:00Z",
        "templates": [
            {
                "name": "batch9_router",
                "path": "batch9_router.json",
                "sha256": template_sha,
                "human_reviewed": true,
                "reviewed_by": "operator",
                "review_cadence_days": 90,
                "compatibility": { "mcp_version": "v1" }
            }
        ],
        "signature": ""
    });
    let signing_key = "batch9-mcp-signing-key";
    let mut basis = manifest.clone();
    if let Some(obj) = basis.as_object_mut() {
        obj.remove("signature");
    }
    manifest["signature"] = Value::String(format!(
        "sig:{}",
        sha256_hex_str(&format!(
            "{}:{}",
            signing_key,
            canonical_json_string(&basis)
        ))
    ));
    let manifest_path = root
        .join("planes")
        .join("contracts")
        .join("mcp")
        .join("batch9_manifest.json");
    fs::write(
        &manifest_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&manifest).expect("encode manifest")
        ),
    )
    .expect("write manifest");
    std::env::set_var("MCP_TEMPLATE_SIGNING_KEY", signing_key);

    let template_exit = mcp_plane::run(
        root,
        &[
            "template-governance".to_string(),
            "--strict=1".to_string(),
            format!("--manifest={}", manifest_path.display()),
            format!("--templates-root={}", templates_root.display()),
        ],
    );
    assert_eq!(template_exit, 0);
    let template_latest = read_json(&latest_path(root));
    assert_eq!(
        template_latest.get("type").and_then(Value::as_str),
        Some("mcp_plane_template_governance")
    );
    assert_eq!(
        template_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&template_latest, "V6-MCP-001.5");
    assert_claim(&template_latest, "V6-MCP-001.6");
}

#[test]
fn v6_mcp_batch9_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = mcp_plane::run(
        root,
        &[
            "capability-matrix".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
            "--server-capabilities=tools.call,resources.read".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("mcp_plane_conduit_gate")
    );
    assert!(latest
        .get("conduit_enforcement")
        .and_then(|v| v.get("claim_evidence"))
        .and_then(Value::as_array)
        .map(|rows| rows
            .iter()
            .any(|row| row.get("id").and_then(Value::as_str) == Some("V6-MCP-001.6")))
        .unwrap_or(false));
}
