// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::skills_plane;
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

#[test]
fn v6_skills_batch10_core_lanes_execute_with_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let skills_root = root
        .join("client")
        .join("runtime")
        .join("systems")
        .join("skills")
        .join("packages");
    fs::create_dir_all(&skills_root).expect("mkdir skills root");

    let create_exit = skills_plane::run(
        root,
        &[
            "create".to_string(),
            "--strict=1".to_string(),
            "--name=research-helper".to_string(),
            format!("--skills-root={}", skills_root.display()),
        ],
    );
    assert_eq!(create_exit, 0);
    let create_latest = read_json(&latest_path(root));
    assert_eq!(
        create_latest.get("type").and_then(Value::as_str),
        Some("skills_plane_create")
    );
    assert_eq!(create_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&create_latest, "V6-SKILLS-001.1");

    let skill_dir = skills_root.join("research-helper");
    assert!(skill_dir.join("SKILL.md").exists());
    assert!(skill_dir.join("skill.yaml").exists());
    assert!(skill_dir.join("scripts").join("run.sh").exists());
    assert!(skill_dir.join("tests").join("smoke.sh").exists());

    let activate_exit = skills_plane::run(
        root,
        &[
            "activate".to_string(),
            "--strict=1".to_string(),
            "--skill=research-helper".to_string(),
            "--trigger=mention:research-helper".to_string(),
            format!("--skills-root={}", skills_root.display()),
        ],
    );
    assert_eq!(activate_exit, 0);
    let activate_latest = read_json(&latest_path(root));
    assert_eq!(
        activate_latest.get("type").and_then(Value::as_str),
        Some("skills_plane_activate")
    );
    assert_eq!(
        activate_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        activate_latest
            .get("activation")
            .and_then(|v| v.get("activated"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&activate_latest, "V6-SKILLS-001.2");
    assert_claim(&activate_latest, "V6-SKILLS-001.4");

    let chain_exit = skills_plane::run(
        root,
        &[
            "chain-validate".to_string(),
            "--strict=1".to_string(),
            "--chain-json={\"version\":\"v1\",\"skills\":[{\"id\":\"research-helper\",\"version\":\"v1\"}]}"
                .to_string(),
            format!("--skills-root={}", skills_root.display()),
        ],
    );
    assert_eq!(chain_exit, 0);
    let chain_latest = read_json(&latest_path(root));
    assert_eq!(
        chain_latest.get("type").and_then(Value::as_str),
        Some("skills_plane_chain_validate")
    );
    assert_eq!(chain_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&chain_latest, "V6-SKILLS-001.3");
    assert_claim(&chain_latest, "V6-SKILLS-001.4");

    let install_exit = skills_plane::run(
        root,
        &[
            "install".to_string(),
            "--strict=1".to_string(),
            format!("--skill-path={}", skill_dir.display()),
        ],
    );
    assert_eq!(install_exit, 0);
    let install_latest = read_json(&latest_path(root));
    assert_eq!(
        install_latest.get("type").and_then(Value::as_str),
        Some("skills_plane_install")
    );
    assert_eq!(
        install_latest.get("ok").and_then(Value::as_bool),
        Some(true)
    );
    assert_claim(&install_latest, "V6-SKILLS-001.4");

    let run_exit = skills_plane::run(
        root,
        &[
            "run".to_string(),
            "--strict=1".to_string(),
            "--skill=research-helper".to_string(),
            "--input=smoke".to_string(),
        ],
    );
    assert_eq!(run_exit, 0);
    let run_latest = read_json(&latest_path(root));
    assert_eq!(
        run_latest.get("type").and_then(Value::as_str),
        Some("skills_plane_run")
    );
    assert_eq!(run_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&run_latest, "V6-SKILLS-001.4");

    let share_exit = skills_plane::run(
        root,
        &[
            "share".to_string(),
            "--strict=1".to_string(),
            "--skill=research-helper".to_string(),
            "--target=team-alpha".to_string(),
        ],
    );
    assert_eq!(share_exit, 0);
    let share_latest = read_json(&latest_path(root));
    assert_eq!(
        share_latest.get("type").and_then(Value::as_str),
        Some("skills_plane_share")
    );
    assert_eq!(share_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&share_latest, "V6-SKILLS-001.4");
}

#[test]
fn v6_skills_batch10_rejects_bypass_when_strict() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let exit = skills_plane::run(
        root,
        &[
            "run".to_string(),
            "--strict=1".to_string(),
            "--bypass=1".to_string(),
            "--skill=research-helper".to_string(),
        ],
    );
    assert_eq!(exit, 1);
    let latest = read_json(&latest_path(root));
    assert_eq!(
        latest.get("type").and_then(Value::as_str),
        Some("skills_plane_conduit_gate")
    );
    assert!(latest
        .get("conduit_enforcement")
        .and_then(|v| v.get("claim_evidence"))
        .and_then(Value::as_array)
        .map(|rows| rows
            .iter()
            .any(|row| row.get("id").and_then(Value::as_str) == Some("V6-SKILLS-001.4")))
        .unwrap_or(false));
}

#[test]
fn v8_skill_002_enforces_backward_compatibility_and_forced_migration_receipts() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let skills_root = root
        .join("client")
        .join("runtime")
        .join("systems")
        .join("skills")
        .join("packages");
    fs::create_dir_all(&skills_root).expect("mkdir skills root");

    let create_exit = skills_plane::run(
        root,
        &[
            "create".to_string(),
            "--strict=1".to_string(),
            "--name=compat-skill".to_string(),
            format!("--skills-root={}", skills_root.display()),
        ],
    );
    assert_eq!(create_exit, 0);

    let skill_dir = skills_root.join("compat-skill");
    let skill_yaml = skill_dir.join("skill.yaml");

    // Initial install at v1 establishes previous_version for compat checks.
    let install_v1_exit = skills_plane::run(
        root,
        &[
            "install".to_string(),
            "--strict=1".to_string(),
            format!("--skill-path={}", skill_dir.display()),
        ],
    );
    assert_eq!(install_v1_exit, 0);

    // Upgrade to v2 without force migration must fail-closed.
    let yaml_v2 = fs::read_to_string(&skill_yaml)
        .expect("read skill yaml")
        .replace("version: v1", "version: v2");
    fs::write(&skill_yaml, yaml_v2).expect("write upgraded yaml");

    let install_v2_without_force = skills_plane::run(
        root,
        &[
            "install".to_string(),
            "--strict=1".to_string(),
            format!("--skill-path={}", skill_dir.display()),
        ],
    );
    assert_eq!(install_v2_without_force, 1);
    let blocked_latest = read_json(&latest_path(root));
    assert_eq!(blocked_latest.get("ok").and_then(Value::as_bool), Some(false));
    assert!(blocked_latest
        .get("errors")
        .and_then(Value::as_array)
        .map(|rows| rows
            .iter()
            .any(|row| row.as_str() == Some("backward_compat_break_requires_force_migration")))
        .unwrap_or(false));
    assert_eq!(
        blocked_latest
            .get("compatibility")
            .and_then(|v| v.get("migration_required"))
            .and_then(Value::as_bool),
        Some(true)
    );

    // Forced migration with explicit reason and ticket must pass and emit receipts.
    let install_v2_forced = skills_plane::run(
        root,
        &[
            "install".to_string(),
            "--strict=1".to_string(),
            "--force-migration=1".to_string(),
            "--deprecation-policy=enforce".to_string(),
            "--deprecation-ticket=SEC-123".to_string(),
            "--migration-reason=major_api_upgrade".to_string(),
            format!("--skill-path={}", skill_dir.display()),
        ],
    );
    assert_eq!(install_v2_forced, 0);
    let forced_latest = read_json(&latest_path(root));
    assert_eq!(forced_latest.get("ok").and_then(Value::as_bool), Some(true));
    assert_claim(&forced_latest, "V8-SKILL-002");
    assert_eq!(
        forced_latest
            .get("compatibility")
            .and_then(|v| v.get("migration_required"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        forced_latest
            .get("compatibility")
            .and_then(|v| v.get("forced_migration"))
            .and_then(Value::as_bool),
        Some(true)
    );
    assert_eq!(
        forced_latest
            .get("compatibility")
            .and_then(|v| v.get("migration_receipt_emitted"))
            .and_then(Value::as_bool),
        Some(true)
    );

    let migration_latest_path = forced_latest
        .get("compatibility")
        .and_then(|v| v.get("migration_latest_path"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .expect("migration_latest_path");
    let migration_latest = read_json(&migration_latest_path);
    assert_eq!(
        migration_latest.get("type").and_then(Value::as_str),
        Some("skills_plane_migration_receipt")
    );
    assert_eq!(
        migration_latest.get("skill_id").and_then(Value::as_str),
        Some("compat-skill")
    );
}

#[test]
fn v8_skill_002_run_gate_fails_closed_on_registry_version_drift() {
    let fixture = stage_fixture_root();
    let root = fixture.path();
    let skills_root = root
        .join("client")
        .join("runtime")
        .join("systems")
        .join("skills")
        .join("packages");
    fs::create_dir_all(&skills_root).expect("mkdir skills root");

    let create_exit = skills_plane::run(
        root,
        &[
            "create".to_string(),
            "--strict=1".to_string(),
            "--name=run-gate-skill".to_string(),
            format!("--skills-root={}", skills_root.display()),
        ],
    );
    assert_eq!(create_exit, 0);

    let skill_dir = skills_root.join("run-gate-skill");
    let install_exit = skills_plane::run(
        root,
        &[
            "install".to_string(),
            "--strict=1".to_string(),
            format!("--skill-path={}", skill_dir.display()),
        ],
    );
    assert_eq!(install_exit, 0);

    let registry_path = root
        .join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("skills_plane")
        .join("registry.json");
    let mut registry = read_json(&registry_path);
    registry["installed"]["run-gate-skill"]["version"] = Value::String("v0".to_string());
    fs::write(
        &registry_path,
        serde_json::to_string_pretty(&registry).expect("encode registry"),
    )
    .expect("write registry");

    let run_exit = skills_plane::run(
        root,
        &[
            "run".to_string(),
            "--strict=1".to_string(),
            "--skill=run-gate-skill".to_string(),
            "--input=smoke".to_string(),
        ],
    );
    assert_eq!(run_exit, 1, "strict run should fail on compat gate drift");
    let latest = read_json(&latest_path(root));
    assert_eq!(latest.get("type").and_then(Value::as_str), Some("skills_plane_run"));
    assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(false));
    assert!(
        latest
            .get("errors")
            .and_then(Value::as_array)
            .map(|rows| rows
                .iter()
                .any(|row| row
                    .as_str()
                    .unwrap_or_default()
                    .starts_with("backward_compat_gate_failed:")))
            .unwrap_or(false),
        "run should fail with backward compatibility gate error"
    );
    assert_claim(&latest, "V8-SKILL-002");
}
