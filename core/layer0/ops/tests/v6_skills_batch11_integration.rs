// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{skills_plane, v8_kernel::sha256_hex_str};
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
        .join("skills_plane")
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
fn v6_skills_batch11_core_lanes_execute_with_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let skills_root = root
        .join("client")
        .join("runtime")
        .join("systems")
        .join("skills")
        .join("packages");
    fs::create_dir_all(&skills_root).expect("mkdir skills root");

    let gallery_root = root
        .join("client")
        .join("runtime")
        .join("systems")
        .join("skills")
        .join("gallery");
    let gallery_skill = gallery_root.join("graph-analyst");
    fs::create_dir_all(gallery_skill.join("scripts")).expect("mkdir scripts");
    fs::create_dir_all(gallery_skill.join("tests")).expect("mkdir tests");
    fs::write(
        gallery_skill.join("skill.yaml"),
        "name: graph-analyst\nversion: v1\ntriggers:\n  - mention:graph-analyst\nentrypoint: scripts/run.sh\n",
    )
    .expect("write yaml");
    fs::write(gallery_skill.join("SKILL.md"), "# Graph Analyst\n").expect("write skill md");
    fs::write(
        gallery_skill.join("scripts/run.sh"),
        "#!/usr/bin/env bash\necho ok\n",
    )
    .expect("write run");
    fs::write(
        gallery_skill.join("tests/smoke.sh"),
        "#!/usr/bin/env bash\necho smoke\n",
    )
    .expect("write smoke");

    let mut manifest = json!({
        "version": "v1",
        "kind": "skill_gallery_manifest",
        "templates": [
            {
                "id": "graph-analyst",
                "version": "v1",
                "package_rel": gallery_skill.display().to_string(),
                "human_reviewed": true,
                "reviewed_by": "operator"
            }
        ],
        "signature": ""
    });
    let signing_key = "batch11-skills-gallery-signing-key";
    let mut signature_basis = manifest.clone();
    if let Some(obj) = signature_basis.as_object_mut() {
        obj.remove("signature");
    }
    manifest["signature"] = Value::String(format!(
        "sig:{}",
        sha256_hex_str(&format!(
            "{}:{}",
            signing_key,
            canonical_json_string(&signature_basis)
        ))
    ));
    let manifest_path = root
        .join("planes")
        .join("contracts")
        .join("skills")
        .join("batch11_gallery_manifest.json");
    fs::write(
        &manifest_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&manifest).expect("encode manifest")
        ),
    )
    .expect("write manifest");
    std::env::set_var("SKILLS_GALLERY_SIGNING_KEY", signing_key);

    let ingest_exit = skills_plane::run(
        root,
        &[
            "gallery".to_string(),
            "--strict=1".to_string(),
            "--op=ingest".to_string(),
            format!("--manifest={}", manifest_path.display()),
            format!("--gallery-root={}", gallery_root.display()),
        ],
    );
    assert_eq!(ingest_exit, 0);
    let ingest_latest = read_json(&latest_path(root));
    assert_eq!(
        ingest_latest.get("type").and_then(Value::as_str),
        Some("skills_plane_gallery")
    );
    assert_eq!(ingest_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_eq!(
        ingest_latest.get("op").and_then(Value::as_str),
        Some("ingest")
    );
    assert_claim(&ingest_latest, "V6-SKILLS-001.6");

    let load_exit = skills_plane::run(
        root,
        &[
            "gallery".to_string(),
            "--strict=1".to_string(),
            "--op=load".to_string(),
            "--skill=graph-analyst".to_string(),
        ],
    );
    assert_eq!(load_exit, 0);
    let load_latest = read_json(&latest_path(root));
    assert_eq!(
        load_latest.get("type").and_then(Value::as_str),
        Some("skills_plane_gallery")
    );
    assert_eq!(load_latest.get("op").and_then(Value::as_str), Some("load"));
    assert_claim(&load_latest, "V6-SKILLS-001.6");

    let list_exit = skills_plane::run(
        root,
        &[
            "list".to_string(),
            "--strict=1".to_string(),
            format!("--skills-root={}", skills_root.display()),
        ],
    );
    assert_eq!(list_exit, 0);
    let list_latest = read_json(&latest_path(root));
    assert_eq!(
        list_latest.get("type").and_then(Value::as_str),
        Some("skills_plane_list")
    );
    assert_eq!(list_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&list_latest, "V6-SKILLS-001.5");

    let dashboard_exit = skills_plane::run(
        root,
        &[
            "dashboard".to_string(),
            "--strict=1".to_string(),
            format!("--skills-root={}", skills_root.display()),
        ],
    );
    assert_eq!(dashboard_exit, 0);
    let dashboard_latest = read_json(&latest_path(root));
    assert_eq!(
        dashboard_latest.get("type").and_then(Value::as_str),
        Some("skills_plane_dashboard")
    );
    assert_eq!(
        dashboard_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&dashboard_latest, "V6-SKILLS-001.5");

    let react_exit = skills_plane::run(
        root,
        &[
            "react-minimal".to_string(),
            "--strict=1".to_string(),
            "--task=triage anomalous receipts".to_string(),
            "--max-steps=4".to_string(),
        ],
    );
    assert_eq!(react_exit, 0);
    let react_latest = read_json(&latest_path(root));
    assert_eq!(
        react_latest.get("type").and_then(Value::as_str),
        Some("skills_plane_react_minimal")
    );
    assert_eq!(react_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&react_latest, "V6-SKILLS-001.7");

    let tot_exit = skills_plane::run(
        root,
        &[
            "tot-deliberate".to_string(),
            "--strict=1".to_string(),
            "--task=design fallback strategy".to_string(),
            "--strategy=bfs".to_string(),
            "--max-depth=3".to_string(),
            "--branching=3".to_string(),
        ],
    );
    assert_eq!(tot_exit, 0);
    let tot_latest = read_json(&latest_path(root));
    assert_eq!(
        tot_latest.get("type").and_then(Value::as_str),
        Some("skills_plane_tot_deliberate")
    );
    assert_eq!(tot_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&tot_latest, "V6-SKILLS-001.8");
}

#[test]
fn v6_skills_batch11_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = skills_plane::run(
        root,
        &[
            "gallery".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
            "--op=list".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("skills_plane_conduit_gate")
    );
}
