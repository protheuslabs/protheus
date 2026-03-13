// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{parse_plane, v8_kernel::sha256_hex_str};
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

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read");
    serde_json::from_str(&raw).expect("parse")
}

fn latest_path(root: &Path) -> PathBuf {
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("parse_plane")
        .join("latest.json")
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
fn v6_parse_batch9_table_flatten_and_template_governance_lanes_work() {
    let fixture = stage_fixture_root();
    let root = fixture.path();

    let post_exit = parse_plane::run(
        root,
        &[
            "postprocess-table".to_string(),
            "--strict=1".to_string(),
            "--table-json=[[\"Item\",\"Value\"],[\"---\",\"---\"],[\"Revenue [1]\",\"100\"],[\"\",\"USD\"]]"
                .to_string(),
        ],
    );
    assert_eq!(post_exit, 0);
    let post_latest = read_json(&latest_path(root));
    assert_eq!(
        post_latest.get("type").and_then(Value::as_str),
        Some("parse_plane_postprocess_table")
    );
    assert_eq!(post_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&post_latest, "V6-PARSE-001.3");
    assert_claim(&post_latest, "V6-PARSE-001.6");

    let flat_exit = parse_plane::run(
        root,
        &[
            "flatten".to_string(),
            "--strict=1".to_string(),
            "--format=dot".to_string(),
            "--json={\"alpha\":{\"beta\":3,\"rows\":[{\"id\":\"a\",\"score\":1},{\"id\":\"b\",\"score\":2}]}}"
                .to_string(),
        ],
    );
    assert_eq!(flat_exit, 0);
    let flat_latest = read_json(&latest_path(root));
    assert_eq!(
        flat_latest.get("type").and_then(Value::as_str),
        Some("parse_plane_flatten_transform")
    );
    assert_eq!(flat_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert!(flat_latest
        .get("result")
        .and_then(|v| v.get("flattened"))
        .and_then(|v| v.get("root.alpha.beta"))
        .and_then(Value::as_i64)
        .map(|v| v == 3)
        .unwrap_or(false));
    assert_claim(&flat_latest, "V6-PARSE-001.4");
    assert_claim(&flat_latest, "V6-PARSE-001.6");

    let export_out = root
        .join("artifacts")
        .join("parse")
        .join("batch9_export.json");
    let export_exit = parse_plane::run(
        root,
        &[
            "export".to_string(),
            "--strict=1".to_string(),
            format!("--from-path={}", latest_path(root).display()),
            format!("--output-path={}", export_out.display()),
            "--format=json".to_string(),
        ],
    );
    assert_eq!(export_exit, 0);
    let export_latest = read_json(&latest_path(root));
    assert_eq!(
        export_latest.get("type").and_then(Value::as_str),
        Some("parse_plane_export")
    );
    assert_eq!(export_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert!(
        export_out.exists(),
        "parse export must write the requested output artifact"
    );
    assert_claim(&export_latest, "V6-PARSE-001.6");

    let templates_root = root
        .join("planes")
        .join("contracts")
        .join("parse")
        .join("batch9_templates");
    fs::create_dir_all(&templates_root).expect("mkdir templates");
    let template_path = templates_root.join("batch9_template.json");
    fs::write(
        &template_path,
        "{\"name\":\"batch9_template\",\"mapping_id\":\"default\"}\n",
    )
    .expect("write template");
    let template_sha = sha256_hex_str(&fs::read_to_string(&template_path).expect("read template"));

    let mut manifest = json!({
        "version": "v1",
        "kind": "parser_template_pack_manifest",
        "pack": "batch9",
        "updated_at": "2026-03-13T00:00:00Z",
        "templates": [
            {
                "name": "batch9_template",
                "path": "batch9_template.json",
                "sha256": template_sha,
                "human_reviewed": true,
                "reviewed_by": "operator",
                "review_cadence_days": 90,
                "compatibility": { "mapping_contract_version": "v1" }
            }
        ],
        "signature": ""
    });
    let signing_key = "batch9-parse-signing-key";
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
        .join("parse")
        .join("batch9_manifest.json");
    fs::write(
        &manifest_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&manifest).expect("encode manifest")
        ),
    )
    .expect("write manifest");
    std::env::set_var("PARSER_TEMPLATE_SIGNING_KEY", signing_key);

    let template_exit = parse_plane::run(
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
        Some("parse_plane_template_governance")
    );
    assert_eq!(
        template_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&template_latest, "V6-PARSE-001.5");
    assert_claim(&template_latest, "V6-PARSE-001.6");
}

#[test]
fn v6_parse_batch9_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    for action in [
        "parse-doc",
        "visualize",
        "postprocess-table",
        "flatten",
        "export",
        "template-governance",
    ] {
        let exit = parse_plane::run(
            root,
            &[
                action.to_string(),
                "--strict=1".to_string(),
                "--bypass=1".to_string(),
            ],
        );
        assert_eq!(exit, 1, "action={action} should fail closed on bypass");
        let latest = read_json(&latest_path(root));
        assert_eq!(
            latest.get("type").and_then(Value::as_str),
            Some("parse_plane_conduit_gate"),
            "action={action} should emit conduit gate payload"
        );
        assert!(latest
            .get("conduit_enforcement")
            .and_then(|v| v.get("claim_evidence"))
            .and_then(Value::as_array)
            .map(|rows| rows
                .iter()
                .any(|row| row.get("id").and_then(Value::as_str) == Some("V6-PARSE-001.6")))
            .unwrap_or(false),
            "action={action} should tag V6-PARSE-001.6");
    }
}
