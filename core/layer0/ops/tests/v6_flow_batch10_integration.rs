// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{flow_plane, v8_kernel::sha256_hex_str};
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
        .join("flow_plane")
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
fn v6_flow_batch10_core_lanes_execute_with_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let compile_exit = flow_plane::run(
        root,
        &[
            "compile".to_string(),
            "--strict=1".to_string(),
            "--canvas-json={\"version\":\"v1\",\"kind\":\"flow_canvas_graph\",\"nodes\":[{\"id\":\"src\",\"type\":\"source\"},{\"id\":\"tx\",\"type\":\"transform\"},{\"id\":\"sink\",\"type\":\"sink\"}],\"edges\":[{\"from\":\"src\",\"to\":\"tx\"},{\"from\":\"tx\",\"to\":\"sink\"}]}"
                .to_string(),
        ],
    );
    assert_eq!(compile_exit, 0);
    let compile_latest = read_json(&latest_path(root));
    assert_eq!(
        compile_latest.get("type").and_then(Value::as_str),
        Some("flow_plane_compile")
    );
    assert_eq!(
        compile_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&compile_latest, "V6-FLOW-001.1");
    assert_claim(&compile_latest, "V6-FLOW-001.6");

    let playground_exit = flow_plane::run(
        root,
        &[
            "playground".to_string(),
            "--strict=1".to_string(),
            "--op=step".to_string(),
            "--run-id=batch10-flow".to_string(),
        ],
    );
    assert_eq!(playground_exit, 0);
    let playground_latest = read_json(&latest_path(root));
    assert_eq!(
        playground_latest.get("type").and_then(Value::as_str),
        Some("flow_plane_playground")
    );
    assert_eq!(
        playground_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&playground_latest, "V6-FLOW-001.2");
    assert_claim(&playground_latest, "V6-FLOW-001.6");

    let components_root = root
        .join("planes")
        .join("contracts")
        .join("flow")
        .join("batch10_components");
    fs::create_dir_all(&components_root).expect("mkdir components");
    let component_path = components_root.join("sum_component.py");
    fs::write(
        &component_path,
        "def run(payload):\n    return {\"ok\": True, \"payload\": payload}\n",
    )
    .expect("write component");
    let component_sha =
        sha256_hex_str(&fs::read_to_string(&component_path).expect("read component"));

    let custom_source = root
        .join("planes")
        .join("contracts")
        .join("flow")
        .join("batch10_custom.py");
    fs::write(
        &custom_source,
        "def run(payload):\n    return {\"ok\": True, \"kind\": \"custom\", \"payload\": payload}\n",
    )
    .expect("write custom source");

    let mut component_manifest = json!({
        "version": "v1",
        "kind": "flow_component_marketplace_manifest",
        "updated_at": "2026-03-13T00:00:00Z",
        "components": [
            {
                "id": "sum-component",
                "path": "sum_component.py",
                "language": "python",
                "sha256": component_sha
            }
        ],
        "signature": ""
    });
    let component_signing_key = "batch10-flow-component-signing-key";
    let mut component_basis = component_manifest.clone();
    if let Some(obj) = component_basis.as_object_mut() {
        obj.remove("signature");
    }
    component_manifest["signature"] = Value::String(format!(
        "sig:{}",
        sha256_hex_str(&format!(
            "{}:{}",
            component_signing_key,
            canonical_json_string(&component_basis)
        ))
    ));
    let component_manifest_path = root
        .join("planes")
        .join("contracts")
        .join("flow")
        .join("batch10_component_manifest.json");
    fs::write(
        &component_manifest_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&component_manifest).expect("encode manifest")
        ),
    )
    .expect("write component manifest");
    std::env::set_var("FLOW_COMPONENT_SIGNING_KEY", component_signing_key);

    let component_exit = flow_plane::run(
        root,
        &[
            "component-marketplace".to_string(),
            "--strict=1".to_string(),
            format!("--manifest={}", component_manifest_path.display()),
            format!("--components-root={}", components_root.display()),
            "--component-id=sum-component".to_string(),
            format!("--custom-source-path={}", custom_source.display()),
        ],
    );
    assert_eq!(component_exit, 0);
    let component_latest = read_json(&latest_path(root));
    assert_eq!(
        component_latest.get("type").and_then(Value::as_str),
        Some("flow_plane_component_marketplace")
    );
    assert_eq!(
        component_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&component_latest, "V6-FLOW-001.3");
    assert_claim(&component_latest, "V6-FLOW-001.6");

    let compiled_path = compile_latest
        .get("artifact")
        .and_then(|v| v.get("path"))
        .and_then(Value::as_str)
        .expect("compiled path")
        .to_string();
    let export_exit = flow_plane::run(
        root,
        &[
            "export".to_string(),
            "--strict=1".to_string(),
            "--format=mcp".to_string(),
            format!("--from-path={compiled_path}"),
            "--package-version=v1.0.0".to_string(),
        ],
    );
    assert_eq!(export_exit, 0);
    let export_latest = read_json(&latest_path(root));
    assert_eq!(
        export_latest.get("type").and_then(Value::as_str),
        Some("flow_plane_export")
    );
    assert_eq!(export_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&export_latest, "V6-FLOW-001.4");
    assert_claim(&export_latest, "V6-FLOW-001.6");

    let templates_root = root
        .join("planes")
        .join("contracts")
        .join("flow")
        .join("batch10_templates");
    fs::create_dir_all(&templates_root).expect("mkdir templates");
    let template_path = templates_root.join("analytics_template.json");
    fs::write(
        &template_path,
        "{\"version\":\"v1\",\"kind\":\"flow_canvas_graph\",\"nodes\":[],\"edges\":[]}\n",
    )
    .expect("write template");
    let template_sha = sha256_hex_str(&fs::read_to_string(&template_path).expect("read template"));

    let mut template_manifest = json!({
        "version": "v1",
        "kind": "flow_template_pack_manifest",
        "pack": "batch10",
        "updated_at": "2026-03-13T00:00:00Z",
        "templates": [
            {
                "name": "analytics_template",
                "path": "analytics_template.json",
                "sha256": template_sha,
                "human_reviewed": true,
                "reviewed_by": "operator",
                "review_cadence_days": 90,
                "compatibility": { "canvas_version": "v1" }
            }
        ],
        "signature": ""
    });
    let template_signing_key = "batch10-flow-template-signing-key";
    let mut template_basis = template_manifest.clone();
    if let Some(obj) = template_basis.as_object_mut() {
        obj.remove("signature");
    }
    template_manifest["signature"] = Value::String(format!(
        "sig:{}",
        sha256_hex_str(&format!(
            "{}:{}",
            template_signing_key,
            canonical_json_string(&template_basis)
        ))
    ));
    let template_manifest_path = root
        .join("planes")
        .join("contracts")
        .join("flow")
        .join("batch10_template_manifest.json");
    fs::write(
        &template_manifest_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&template_manifest).expect("encode manifest")
        ),
    )
    .expect("write template manifest");
    std::env::set_var("FLOW_TEMPLATE_SIGNING_KEY", template_signing_key);

    let template_exit = flow_plane::run(
        root,
        &[
            "template-governance".to_string(),
            "--strict=1".to_string(),
            format!("--manifest={}", template_manifest_path.display()),
            format!("--templates-root={}", templates_root.display()),
        ],
    );
    assert_eq!(template_exit, 0);
    let template_latest = read_json(&latest_path(root));
    assert_eq!(
        template_latest.get("type").and_then(Value::as_str),
        Some("flow_plane_template_governance")
    );
    assert_eq!(
        template_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&template_latest, "V6-FLOW-001.5");
    assert_claim(&template_latest, "V6-FLOW-001.6");
}

#[test]
fn v6_flow_batch10_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = flow_plane::run(
        root,
        &[
            "compile".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
            "--canvas-json={\"version\":\"v1\",\"kind\":\"flow_canvas_graph\",\"nodes\":[{\"id\":\"a\",\"type\":\"source\"}],\"edges\":[]}"
                .to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("flow_plane_conduit_gate")
    );
    assert!(latest
        .get("conduit_enforcement")
        .and_then(|v| v.get("claim_evidence"))
        .and_then(Value::as_array)
        .map(|rows| rows
            .iter()
            .any(|row| row.get("id").and_then(Value::as_str) == Some("V6-FLOW-001.6")))
        .unwrap_or(false));
}
