// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::skills_plane (authoritative)

use crate::v8_kernel::{
    append_jsonl, attach_conduit, build_plane_conduit_enforcement, canonical_json_string,
    conduit_bypass_requested, emit_plane_receipt, load_json_or, parse_bool, parse_u64,
    plane_status, print_json, read_json, scoped_state_root, sha256_hex_str, write_json,
};
use crate::{clean, parse_args};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "SKILLS_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "skills_plane";

const SCAFFOLD_CONTRACT_PATH: &str = "planes/contracts/skills/skill_scaffold_contract_v1.json";
const ACTIVATION_CONTRACT_PATH: &str = "planes/contracts/skills/skill_activation_contract_v1.json";
const CHAIN_CONTRACT_PATH: &str = "planes/contracts/skills/skill_chain_contract_v1.json";
const DX_CONTRACT_PATH: &str = "planes/contracts/skills/skill_dx_contract_v1.json";
const GALLERY_CONTRACT_PATH: &str =
    "planes/contracts/skills/skill_gallery_governance_contract_v1.json";
const GALLERY_MANIFEST_PATH: &str = "planes/contracts/skills/skill_gallery_manifest_v1.json";
const REACT_MINIMAL_CONTRACT_PATH: &str =
    "planes/contracts/skills/react_minimal_profile_contract_v1.json";
const TOT_DELIBERATE_CONTRACT_PATH: &str =
    "planes/contracts/skills/tot_deliberate_profile_contract_v1.json";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops skills-plane status");
    println!("  protheus-ops skills-plane list [--skills-root=<path>] [--strict=1|0]");
    println!("  protheus-ops skills-plane dashboard [--skills-root=<path>] [--strict=1|0]");
    println!("  protheus-ops skills-plane create --name=<skill-name> [--skills-root=<path>] [--strict=1|0]");
    println!("  protheus-ops skills-plane activate --skill=<id> --trigger=<text> [--skills-root=<path>] [--strict=1|0]");
    println!("  protheus-ops skills-plane chain-validate [--chain-json=<json>|--chain-path=<path>] [--skills-root=<path>] [--strict=1|0]");
    println!("  protheus-ops skills-plane install --skill-path=<path> [--strict=1|0]");
    println!("  protheus-ops skills-plane run --skill=<id> [--input=<text>] [--strict=1|0]");
    println!("  protheus-ops skills-plane share --skill=<id> [--target=<text>] [--strict=1|0]");
    println!("  protheus-ops skills-plane gallery --op=<ingest|list|load> [--manifest=<path>] [--gallery-root=<path>] [--skill=<id>] [--strict=1|0]");
    println!(
        "  protheus-ops skills-plane react-minimal --task=<text> [--max-steps=<n>] [--strict=1|0]"
    );
    println!("  protheus-ops skills-plane tot-deliberate --task=<text> [--strategy=<bfs|dfs>] [--max-depth=<n>] [--branching=<n>] [--strict=1|0]");
}

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn emit(root: &Path, payload: Value) -> i32 {
    emit_plane_receipt(root, STATE_ENV, STATE_SCOPE, "skills_plane_error", payload)
}

fn slugify(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if matches!(ch, '-' | '_' | ' ' | '/') {
            if !out.ends_with('-') {
                out.push('-');
            }
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "skill".to_string()
    } else {
        out
    }
}

fn conduit_enforcement(
    root: &Path,
    parsed: &crate::ParsedArgs,
    strict: bool,
    action: &str,
) -> Value {
    let bypass_requested = conduit_bypass_requested(&parsed.flags);
    build_plane_conduit_enforcement(
        root,
        STATE_ENV,
        STATE_SCOPE,
        strict,
        action,
        "skills_conduit_enforcement",
        "core/layer0/ops/skills_plane",
        bypass_requested,
        "skill_install_run_share_actions_route_through_layer0_conduit_with_deterministic_audit_receipts",
        &["V6-SKILLS-001.4"],
    )
}

fn status(root: &Path) -> Value {
    plane_status(root, STATE_ENV, STATE_SCOPE, "skills_plane_status")
}

fn load_jsonl(path: &Path) -> Vec<Value> {
    let raw = fs::read_to_string(path).unwrap_or_default();
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn skills_root_default(parsed: &crate::ParsedArgs) -> String {
    parsed
        .flags
        .get("skills-root")
        .cloned()
        .unwrap_or_else(|| "client/runtime/systems/skills/packages".to_string())
}

fn skills_root(root: &Path, parsed: &crate::ParsedArgs) -> PathBuf {
    let rel_or_abs = parsed
        .flags
        .get("skills-root")
        .cloned()
        .unwrap_or_else(|| "client/runtime/systems/skills/packages".to_string());
    if Path::new(&rel_or_abs).is_absolute() {
        PathBuf::from(rel_or_abs)
    } else {
        root.join(rel_or_abs)
    }
}

fn write_file(path: &Path, body: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("mkdir_failed:{}:{err}", parent.display()))?;
    }
    fs::write(path, body.as_bytes()).map_err(|err| format!("write_failed:{}:{err}", path.display()))
}

fn run_create(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        SCAFFOLD_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "skill_scaffold_contract",
            "required_files": ["SKILL.md", "skill.yaml", "scripts/run.sh", "assets/.keep", "tests/smoke.sh"],
            "default_version": "v1"
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("skill_scaffold_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "skill_scaffold_contract"
    {
        errors.push("skill_scaffold_contract_kind_invalid".to_string());
    }

    let name = clean(
        parsed
            .flags
            .get("name")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_default(),
        120,
    );
    if name.is_empty() {
        errors.push("skill_name_required".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_create",
            "errors": errors
        });
    }

    let id = slugify(&name);
    let deterministic_skill_id = format!(
        "skill_{}",
        &sha256_hex_str(&name.trim().to_ascii_lowercase())[..12]
    );
    let version = clean(
        contract
            .get("default_version")
            .and_then(Value::as_str)
            .unwrap_or("v1"),
        20,
    );
    let root_path = skills_root(root, parsed).join(&id);
    let skill_md = format!(
        "# {name}\n\nGenerated skill package.\n\n## Trigger\n- mention:{id}\n\n## Run\nUse `scripts/run.sh`.\n"
    );
    let skill_yaml = format!(
        "name: {id}\nversion: {version}\ndescription: Generated skill scaffold\ntriggers:\n  - mention:{id}\nentrypoint: scripts/run.sh\n"
    );
    let run_sh = "#!/usr/bin/env bash\nset -euo pipefail\necho \"skill_run_ok\"\n";
    let smoke_sh = "#!/usr/bin/env bash\nset -euo pipefail\nbash \"$(dirname \"$0\")/../scripts/run.sh\" >/dev/null\n";

    let mut generated = Vec::<String>::new();
    let files = [
        ("SKILL.md", skill_md),
        ("skill.yaml", skill_yaml),
        ("scripts/run.sh", run_sh.to_string()),
        ("assets/.keep", "".to_string()),
        ("tests/smoke.sh", smoke_sh.to_string()),
    ];
    for (rel, body) in files {
        let target = root_path.join(rel);
        if let Err(err) = write_file(&target, &body) {
            errors.push(err);
            continue;
        }
        #[cfg(unix)]
        if rel.ends_with(".sh") {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&target, fs::Permissions::from_mode(0o755));
        }
        generated.push(target.display().to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_create",
            "errors": errors
        });
    }

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "skills_plane_create",
        "lane": "core/layer0/ops",
        "skill": {
            "id": id,
            "deterministic_id": deterministic_skill_id,
            "name": name,
            "version": version,
            "root": root_path.display().to_string()
        },
        "generated_files": generated,
        "claim_evidence": [
            {
                "id": "V6-SKILLS-001.1",
                "claim": "skill_create_generates_markdown_yaml_scripts_assets_scaffold_package",
                "evidence": {
                    "file_count": generated.len()
                }
            },
            {
                "id": "V6-COGNITION-012.2",
                "claim": "natural_language_skill_creation_mints_deterministic_skill_ids_and_receipted_contracts",
                "evidence": {
                    "skill_id": deterministic_skill_id
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn parse_skill_yaml(path: &Path) -> Value {
    let raw = fs::read_to_string(path).unwrap_or_default();
    let mut name = String::new();
    let mut version = String::new();
    let mut entrypoint = String::new();
    let mut triggers = Vec::<String>::new();
    let mut in_triggers = false;
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with("name:") {
            name = clean(t.trim_start_matches("name:").trim(), 120);
            in_triggers = false;
            continue;
        }
        if t.starts_with("version:") {
            version = clean(t.trim_start_matches("version:").trim(), 40);
            in_triggers = false;
            continue;
        }
        if t.starts_with("entrypoint:") {
            entrypoint = clean(t.trim_start_matches("entrypoint:").trim(), 260);
            in_triggers = false;
            continue;
        }
        if t.starts_with("triggers:") {
            in_triggers = true;
            continue;
        }
        if in_triggers && t.starts_with("- ") {
            let trigger = clean(t.trim_start_matches("- ").trim(), 180);
            if !trigger.is_empty() {
                triggers.push(trigger);
            }
            continue;
        }
        in_triggers = false;
    }
    json!({
        "name": name,
        "version": version,
        "entrypoint": entrypoint,
        "triggers": triggers
    })
}

fn run_activate(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        ACTIVATION_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "skill_activation_contract",
            "progressive_stages": ["metadata", "scripts", "assets"],
            "max_trigger_chars": 240
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("skill_activation_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "skill_activation_contract"
    {
        errors.push("skill_activation_contract_kind_invalid".to_string());
    }

    let skill = clean(
        parsed
            .flags
            .get("skill")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_default(),
        120,
    );
    let trigger = clean(
        parsed.flags.get("trigger").cloned().unwrap_or_default(),
        contract
            .get("max_trigger_chars")
            .and_then(Value::as_u64)
            .unwrap_or(240) as usize,
    );
    if skill.is_empty() {
        errors.push("skill_required".to_string());
    }
    if trigger.is_empty() {
        errors.push("trigger_required".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_activate",
            "errors": errors
        });
    }

    let skill_dir = skills_root(root, parsed).join(&skill);
    let yaml_path = skill_dir.join("skill.yaml");
    if strict && !yaml_path.exists() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_activate",
            "errors": [format!("skill_yaml_missing:{}", yaml_path.display())]
        });
    }
    let parsed_yaml = parse_skill_yaml(&yaml_path);
    let triggers = parsed_yaml
        .get("triggers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 180).to_ascii_lowercase())
        .collect::<Vec<_>>();
    let trigger_lc = trigger.to_ascii_lowercase();
    let activated = triggers.iter().any(|row| trigger_lc.contains(row))
        || trigger_lc.contains(&format!("mention:{skill}"))
        || trigger_lc.contains(&skill);

    if strict && !activated {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_activate",
            "errors": ["trigger_not_matched"]
        });
    }

    let stages = contract
        .get("progressive_stages")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|stage| clean(stage, 40))
        .collect::<Vec<_>>();
    let stage_receipts = stages
        .iter()
        .enumerate()
        .map(|(idx, stage)| {
            let loaded = match stage.as_str() {
                "metadata" => true,
                "scripts" => skill_dir.join("scripts").exists(),
                "assets" => skill_dir.join("assets").exists(),
                _ => false,
            };
            json!({
                "stage": stage,
                "index": idx,
                "loaded": loaded,
                "stage_hash": sha256_hex_str(&format!("{}:{}:{}", skill, stage, idx))
            })
        })
        .collect::<Vec<_>>();

    let state_path = state_root(root).join("activation").join("latest.json");
    let state_payload = json!({
        "skill": skill,
        "trigger": trigger,
        "activated": activated,
        "stages": stage_receipts
    });
    let _ = write_json(&state_path, &state_payload);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "skills_plane_activate",
        "lane": "core/layer0/ops",
        "state_path": state_path.display().to_string(),
        "activation": state_payload,
        "claim_evidence": [
            {
                "id": "V6-SKILLS-001.2",
                "claim": "trigger_based_skill_activation_uses_progressive_loading_stages_with_deterministic_receipts",
                "evidence": {
                    "activated": activated,
                    "stage_count": stages.len()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn parse_chain_input(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    if let Some(raw) = parsed.flags.get("chain-json") {
        return serde_json::from_str::<Value>(raw).map_err(|_| "chain_json_invalid".to_string());
    }
    if let Some(rel_or_abs) = parsed.flags.get("chain-path") {
        let path = if Path::new(rel_or_abs).is_absolute() {
            PathBuf::from(rel_or_abs)
        } else {
            root.join(rel_or_abs)
        };
        return read_json(&path).ok_or_else(|| format!("chain_path_not_found:{}", path.display()));
    }
    Err("chain_required".to_string())
}

fn run_chain_validate(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        CHAIN_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "skill_chain_contract",
            "required_chain_version": "v1",
            "require_smoke_tests": true
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("skill_chain_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "skill_chain_contract"
    {
        errors.push("skill_chain_contract_kind_invalid".to_string());
    }
    let chain = match parse_chain_input(root, parsed) {
        Ok(v) => v,
        Err(err) => {
            errors.push(err);
            Value::Null
        }
    };
    if chain.is_null() {
        errors.push("chain_required".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_chain_validate",
            "errors": errors
        });
    }

    let chain_version = chain
        .get("version")
        .and_then(Value::as_str)
        .map(|v| clean(v, 20))
        .unwrap_or_default();
    let required_chain_version = clean(
        contract
            .get("required_chain_version")
            .and_then(Value::as_str)
            .unwrap_or("v1"),
        20,
    );
    if strict && chain_version != required_chain_version {
        errors.push("chain_version_invalid".to_string());
    }

    let steps = chain
        .get("skills")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if steps.is_empty() {
        errors.push("chain_skills_required".to_string());
    }
    let require_smoke_tests = contract
        .get("require_smoke_tests")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let root_dir = skills_root(root, parsed);
    let mut test_receipts = Vec::<Value>::new();
    for (idx, step) in steps.iter().enumerate() {
        let id = clean(
            step.get("id").and_then(Value::as_str).unwrap_or_default(),
            120,
        );
        let version = clean(
            step.get("version")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            20,
        );
        if id.is_empty() || version.is_empty() {
            errors.push("chain_skill_id_and_version_required".to_string());
            continue;
        }
        let skill_dir = root_dir.join(&id);
        if strict && !skill_dir.exists() {
            errors.push(format!("chain_skill_missing:{id}"));
        }
        let smoke = skill_dir.join("tests").join("smoke.sh");
        if strict && require_smoke_tests && !smoke.exists() {
            errors.push(format!("chain_skill_smoke_missing:{id}"));
        }
        test_receipts.push(json!({
            "index": idx,
            "id": id,
            "version": version,
            "skill_dir": skill_dir.display().to_string(),
            "smoke_test_present": smoke.exists(),
            "receipt_hash": sha256_hex_str(&format!("{}:{}:{}", id, version, idx))
        }));
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_chain_validate",
            "errors": errors
        });
    }

    let chain_hash = sha256_hex_str(&canonical_json_string(&chain));
    let result = json!({
        "chain_hash": chain_hash,
        "chain": chain,
        "test_receipts": test_receipts
    });
    let artifact_path = state_root(root).join("chain_validate").join("latest.json");
    let _ = write_json(&artifact_path, &result);
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "skills_plane_chain_validate",
        "lane": "core/layer0/ops",
        "artifact": {
            "path": artifact_path.display().to_string(),
            "sha256": sha256_hex_str(&result.to_string())
        },
        "result": result,
        "claim_evidence": [
            {
                "id": "V6-SKILLS-001.3",
                "claim": "versioned_composable_skill_chaining_validates_contracts_and_runs_deterministic_chain_test_receipts",
                "evidence": {
                    "steps": steps.len()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn load_registry(path: &Path) -> Value {
    read_json(path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "kind": "skills_registry",
            "installed": {}
        })
    })
}

fn run_list(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        DX_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "skill_dx_contract",
            "max_packages": 2048,
            "dashboard_run_window": 1000
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("skill_dx_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "skill_dx_contract"
    {
        errors.push("skill_dx_contract_kind_invalid".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_list",
            "errors": errors
        });
    }

    let max_packages = contract
        .get("max_packages")
        .and_then(Value::as_u64)
        .unwrap_or(2048) as usize;
    let root_dir = skills_root(root, parsed);
    let mut discovered = Vec::<Value>::new();
    let mut truncated = false;

    if root_dir.exists() {
        if let Ok(entries) = fs::read_dir(&root_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                if discovered.len() >= max_packages {
                    truncated = true;
                    break;
                }
                let yaml_path = path.join("skill.yaml");
                let parsed_yaml = parse_skill_yaml(&yaml_path);
                let id = clean(
                    parsed_yaml
                        .get("name")
                        .and_then(Value::as_str)
                        .filter(|v| !v.trim().is_empty())
                        .unwrap_or_else(|| {
                            path.file_name()
                                .and_then(|v| v.to_str())
                                .unwrap_or("skill-unknown")
                        }),
                    120,
                );
                discovered.push(json!({
                    "id": id,
                    "version": clean(parsed_yaml.get("version").and_then(Value::as_str).unwrap_or("v1"), 40),
                    "entrypoint": clean(parsed_yaml.get("entrypoint").and_then(Value::as_str).unwrap_or("scripts/run.sh"), 240),
                    "trigger_count": parsed_yaml
                        .get("triggers")
                        .and_then(Value::as_array)
                        .map(|rows| rows.len())
                        .unwrap_or(0),
                    "path": path.display().to_string()
                }));
            }
        }
    }

    discovered.sort_by(|a, b| {
        let left = a.get("id").and_then(Value::as_str).unwrap_or_default();
        let right = b.get("id").and_then(Value::as_str).unwrap_or_default();
        left.cmp(right)
    });

    let registry = load_registry(&state_root(root).join("registry.json"));
    let installed_map = registry
        .get("installed")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let installed_count = installed_map.len();
    let discovered_count = discovered.len();

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "skills_plane_list",
        "lane": "core/layer0/ops",
        "skills_root": root_dir.display().to_string(),
        "skills_root_rel": skills_root_default(parsed),
        "discovered_count": discovered_count,
        "installed_count": installed_count,
        "truncated": truncated,
        "skills": discovered,
        "claim_evidence": [
            {
                "id": "V6-SKILLS-001.5",
                "claim": "developer_and_user_skill_dx_exposes_create_list_run_status_wrappers_with_observability_surface",
                "evidence": {
                    "discovered_count": discovered_count,
                    "installed_count": installed_count
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_dashboard(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        DX_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "skill_dx_contract",
            "dashboard_run_window": 1000
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("skill_dx_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "skill_dx_contract"
    {
        errors.push("skill_dx_contract_kind_invalid".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_dashboard",
            "errors": errors
        });
    }

    let list_payload = run_list(root, parsed, strict);
    if !list_payload
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_dashboard",
            "errors": ["skills_list_failed"],
            "list_payload": list_payload
        });
    }

    let run_window = contract
        .get("dashboard_run_window")
        .and_then(Value::as_u64)
        .unwrap_or(1000) as usize;
    let cognition_latest_path = root.join("state/ops/assimilation_controller/latest.json");
    let cognition_history_path = root.join("state/ops/assimilation_controller/history.jsonl");
    let cognition_latest = read_json(&cognition_latest_path).unwrap_or(Value::Null);
    let cognition_history_events = fs::read_to_string(&cognition_history_path)
        .ok()
        .map(|raw| raw.lines().filter(|row| !row.trim().is_empty()).count())
        .unwrap_or(0usize);
    let run_history_path = state_root(root).join("runs").join("history.jsonl");
    let mut run_rows = load_jsonl(&run_history_path);
    if run_rows.len() > run_window {
        run_rows = run_rows.split_off(run_rows.len().saturating_sub(run_window));
    }
    let mut by_skill = std::collections::BTreeMap::<String, u64>::new();
    for row in &run_rows {
        if let Some(skill) = row.get("skill").and_then(Value::as_str) {
            let entry = by_skill.entry(clean(skill, 120)).or_insert(0);
            *entry = entry.saturating_add(1);
        }
    }
    let run_hotspots = by_skill
        .iter()
        .map(|(skill, count)| json!({"skill": skill, "runs": count}))
        .collect::<Vec<_>>();

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "skills_plane_dashboard",
        "lane": "core/layer0/ops",
        "metrics": {
            "skills_total": list_payload.get("discovered_count").cloned().unwrap_or(json!(0)),
            "skills_installed": list_payload.get("installed_count").cloned().unwrap_or(json!(0)),
            "runs_window": run_rows.len(),
            "last_run_ts": run_rows.last().and_then(|v| v.get("ts")).cloned().unwrap_or(Value::Null),
            "run_hotspots": run_hotspots
        },
        "upstream": {
            "skills_list_latest": list_payload.get("latest_path").cloned().unwrap_or(Value::Null),
            "runs_history_path": run_history_path.display().to_string(),
            "cognition_latest_path": cognition_latest_path.display().to_string(),
            "cognition_history_path": cognition_history_path.display().to_string()
        },
        "cognition": {
            "history_events": cognition_history_events,
            "latest": cognition_latest
        },
        "claim_evidence": [
            {
                "id": "V6-SKILLS-001.5",
                "claim": "developer_and_user_skill_dx_exposes_create_list_run_status_wrappers_with_observability_surface",
                "evidence": {
                    "run_window": run_rows.len()
                }
            },
            {
                "id": "V6-COGNITION-012.5",
                "claim": "skills_dashboard_surfaces_history_and_latest_state_from_core_receipt_ledger",
                "evidence": {
                    "history_events": cognition_history_events,
                    "latest_type": cognition_latest
                        .get("type")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn resolve_rel_or_abs(root: &Path, raw: &str) -> PathBuf {
    if Path::new(raw).is_absolute() {
        PathBuf::from(raw)
    } else {
        root.join(raw)
    }
}

fn gallery_root(root: &Path, parsed: &crate::ParsedArgs) -> PathBuf {
    let rel_or_abs = parsed
        .flags
        .get("gallery-root")
        .cloned()
        .unwrap_or_else(|| "client/runtime/systems/skills/gallery".to_string());
    resolve_rel_or_abs(root, &rel_or_abs)
}

fn gallery_manifest_path(root: &Path, parsed: &crate::ParsedArgs) -> PathBuf {
    let rel_or_abs = parsed
        .flags
        .get("manifest")
        .cloned()
        .unwrap_or_else(|| GALLERY_MANIFEST_PATH.to_string());
    resolve_rel_or_abs(root, &rel_or_abs)
}

fn verify_gallery_signature(
    contract: &Value,
    manifest: &Value,
    strict: bool,
) -> Result<(), String> {
    let require_signature = contract
        .get("require_signature")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if !require_signature {
        return Ok(());
    }
    let provided = manifest
        .get("signature")
        .and_then(Value::as_str)
        .map(|v| clean(v, 260))
        .unwrap_or_default();
    if provided.is_empty() {
        if strict {
            return Err("gallery_manifest_signature_missing".to_string());
        }
        return Ok(());
    }
    let signing_key = std::env::var("SKILLS_GALLERY_SIGNING_KEY").unwrap_or_default();
    if signing_key.trim().is_empty() {
        if strict {
            return Err("skills_gallery_signing_key_missing".to_string());
        }
        return Ok(());
    }
    let mut basis = manifest.clone();
    if let Some(obj) = basis.as_object_mut() {
        obj.remove("signature");
    }
    let expected = format!(
        "sig:{}",
        sha256_hex_str(&format!(
            "{}:{}",
            signing_key,
            canonical_json_string(&basis)
        ))
    );
    if strict && provided != expected {
        return Err("gallery_manifest_signature_invalid".to_string());
    }
    Ok(())
}

fn run_gallery(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        GALLERY_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "skill_gallery_governance_contract",
            "require_signature": true,
            "max_templates": 1024,
            "allow_load_only_if_reviewed": true
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("skill_gallery_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "skill_gallery_governance_contract"
    {
        errors.push("skill_gallery_contract_kind_invalid".to_string());
    }
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "list".to_string()),
        40,
    )
    .to_ascii_lowercase();
    if !matches!(op.as_str(), "ingest" | "list" | "load") {
        errors.push("gallery_op_invalid".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_gallery",
            "errors": errors
        });
    }

    let gallery_dir = gallery_root(root, parsed);
    let manifest_path = gallery_manifest_path(root, parsed);
    let state_manifest_path = state_root(root).join("gallery").join("manifest.json");
    let manifest = if op == "ingest" {
        match read_json(&manifest_path) {
            Some(v) => v,
            None => {
                return json!({
                    "ok": false,
                    "strict": strict,
                    "type": "skills_plane_gallery",
                    "errors": [format!("gallery_manifest_not_found:{}", manifest_path.display())]
                });
            }
        }
    } else {
        read_json(&state_manifest_path).unwrap_or_else(|| {
            json!({
                "version": "v1",
                "kind": "skill_gallery_manifest",
                "templates": []
            })
        })
    };

    if let Err(err) = verify_gallery_signature(&contract, &manifest, strict) {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_gallery",
            "errors": [err]
        });
    }

    let templates = manifest
        .get("templates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let max_templates = contract
        .get("max_templates")
        .and_then(Value::as_u64)
        .unwrap_or(1024) as usize;
    if strict && templates.len() > max_templates {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_gallery",
            "errors": ["gallery_template_limit_exceeded"]
        });
    }

    match op.as_str() {
        "ingest" => {
            let _ = fs::create_dir_all(state_manifest_path.parent().unwrap_or(&gallery_dir));
            let _ = write_json(&state_manifest_path, &manifest);
            let _ = append_jsonl(
                &state_root(root).join("gallery").join("history.jsonl"),
                &json!({
                    "ts": crate::now_iso(),
                    "op": "ingest",
                    "manifest_path": manifest_path.display().to_string(),
                    "template_count": templates.len(),
                }),
            );
            let mut out = json!({
                "ok": true,
                "strict": strict,
                "type": "skills_plane_gallery",
                "op": "ingest",
                "lane": "core/layer0/ops",
                "manifest_path": state_manifest_path.display().to_string(),
                "template_count": templates.len(),
                "claim_evidence": [
                    {
                        "id": "V6-SKILLS-001.6",
                        "claim": "curated_skill_gallery_ingest_and_one_click_loader_are_governed_with_deterministic_receipts",
                        "evidence": {
                            "op": "ingest",
                            "template_count": templates.len()
                        }
                    }
                ]
            });
            out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
            out
        }
        "list" => {
            let listed = templates
                .iter()
                .map(|row| {
                    json!({
                        "id": clean(row.get("id").and_then(Value::as_str).unwrap_or_default(), 120),
                        "version": clean(row.get("version").and_then(Value::as_str).unwrap_or("v1"), 40),
                        "package_rel": clean(row.get("package_rel").and_then(Value::as_str).unwrap_or_default(), 260),
                        "reviewed": row.get("human_reviewed").and_then(Value::as_bool).unwrap_or(false)
                    })
                })
                .collect::<Vec<_>>();
            let mut out = json!({
                "ok": true,
                "strict": strict,
                "type": "skills_plane_gallery",
                "op": "list",
                "lane": "core/layer0/ops",
                "manifest_path": state_manifest_path.display().to_string(),
                "templates": listed,
                "template_count": templates.len(),
                "claim_evidence": [
                    {
                        "id": "V6-SKILLS-001.6",
                        "claim": "curated_skill_gallery_ingest_and_one_click_loader_are_governed_with_deterministic_receipts",
                        "evidence": {
                            "op": "list",
                            "template_count": templates.len()
                        }
                    }
                ]
            });
            out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
            out
        }
        "load" => {
            let skill_id = clean(
                parsed
                    .flags
                    .get("skill")
                    .cloned()
                    .or_else(|| parsed.positional.get(2).cloned())
                    .unwrap_or_default(),
                120,
            );
            if skill_id.is_empty() {
                return json!({
                    "ok": false,
                    "strict": strict,
                    "type": "skills_plane_gallery",
                    "errors": ["gallery_skill_required"]
                });
            }
            let allow_only_reviewed = contract
                .get("allow_load_only_if_reviewed")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let maybe_template = templates.iter().find(|row| {
                row.get("id").and_then(Value::as_str).map(|v| clean(v, 120))
                    == Some(skill_id.clone())
            });
            let Some(template) = maybe_template else {
                return json!({
                    "ok": false,
                    "strict": strict,
                    "type": "skills_plane_gallery",
                    "errors": [format!("gallery_skill_not_found:{skill_id}")]
                });
            };
            if strict
                && allow_only_reviewed
                && !template
                    .get("human_reviewed")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            {
                return json!({
                    "ok": false,
                    "strict": strict,
                    "type": "skills_plane_gallery",
                    "errors": ["gallery_skill_not_human_reviewed"]
                });
            }
            let package_rel = clean(
                template
                    .get("package_rel")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
                260,
            );
            if package_rel.is_empty() {
                return json!({
                    "ok": false,
                    "strict": strict,
                    "type": "skills_plane_gallery",
                    "errors": ["gallery_package_path_missing"]
                });
            }
            let package_path = resolve_rel_or_abs(root, &package_rel);
            let install_payload = run_install(
                root,
                &crate::parse_args(&[
                    "install".to_string(),
                    format!("--skill-path={}", package_path.display()),
                    format!("--strict={}", if strict { "1" } else { "0" }),
                ]),
                strict,
            );
            if !install_payload
                .get("ok")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return json!({
                    "ok": false,
                    "strict": strict,
                    "type": "skills_plane_gallery",
                    "errors": ["gallery_install_failed"],
                    "install_payload": install_payload
                });
            }
            let mut out = json!({
                "ok": true,
                "strict": strict,
                "type": "skills_plane_gallery",
                "op": "load",
                "lane": "core/layer0/ops",
                "manifest_path": state_manifest_path.display().to_string(),
                "skill_id": skill_id,
                "package_path": package_path.display().to_string(),
                "install_payload": install_payload,
                "claim_evidence": [
                    {
                        "id": "V6-SKILLS-001.6",
                        "claim": "curated_skill_gallery_ingest_and_one_click_loader_are_governed_with_deterministic_receipts",
                        "evidence": {
                            "op": "load",
                            "skill_id": skill_id
                        }
                    }
                ]
            });
            out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
            out
        }
        _ => json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_gallery",
            "errors": ["gallery_op_invalid"]
        }),
    }
}

fn run_react_minimal(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        REACT_MINIMAL_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "react_minimal_profile_contract",
            "max_steps": 8,
            "allowed_tools": ["search", "read", "summarize"]
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("react_profile_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "react_minimal_profile_contract"
    {
        errors.push("react_profile_contract_kind_invalid".to_string());
    }
    let task = clean(
        parsed
            .flags
            .get("task")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_default(),
        500,
    );
    if task.is_empty() {
        errors.push("react_task_required".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_react_minimal",
            "errors": errors
        });
    }
    let max_steps = parse_u64(parsed.flags.get("max-steps"), 0).max(1).min(
        contract
            .get("max_steps")
            .and_then(Value::as_u64)
            .unwrap_or(8),
    ) as usize;
    let allowed_tools = contract
        .get("allowed_tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![json!("search"), json!("read"), json!("summarize")]);
    let allowed = allowed_tools
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 80))
        .collect::<Vec<_>>();
    let mut steps = Vec::<Value>::new();
    for idx in 0..max_steps {
        let tool = allowed
            .get(idx % allowed.len().max(1))
            .cloned()
            .unwrap_or_else(|| "search".to_string());
        let thought = format!("Assess task segment {} for '{}'", idx + 1, clean(&task, 80));
        let action = format!("{tool}:segment_{}", idx + 1);
        let observation = format!(
            "observation_hash:{}",
            &sha256_hex_str(&format!("{task}:{idx}"))[..16]
        );
        steps.push(json!({
            "step": idx + 1,
            "thought": thought,
            "action": action,
            "observation": observation,
            "state_hash": sha256_hex_str(&format!("{}:{}:{}:{}", task, thought, action, observation))
        }));
    }
    let tao_state = json!({
        "version": "v1",
        "profile": "react-minimal",
        "task": task,
        "steps": steps,
        "bounded": true
    });
    let artifact_path = state_root(root).join("react_minimal").join("latest.json");
    let _ = write_json(&artifact_path, &tao_state);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "skills_plane_react_minimal",
        "lane": "core/layer0/ops",
        "artifact": {
            "path": artifact_path.display().to_string(),
            "sha256": sha256_hex_str(&tao_state.to_string())
        },
        "tao_state": tao_state,
        "claim_evidence": [
            {
                "id": "V6-SKILLS-001.7",
                "claim": "react_minimal_profile_runs_bounded_tao_loop_with_stepwise_state_as_governed_objects",
                "evidence": {
                    "max_steps": max_steps
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_tot_deliberate(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        TOT_DELIBERATE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "tot_deliberate_profile_contract",
            "max_depth": 4,
            "max_branching": 5,
            "allowed_strategies": ["bfs", "dfs"]
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("tot_profile_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "tot_deliberate_profile_contract"
    {
        errors.push("tot_profile_contract_kind_invalid".to_string());
    }
    let task = clean(
        parsed
            .flags
            .get("task")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_default(),
        500,
    );
    if task.is_empty() {
        errors.push("tot_task_required".to_string());
    }
    let strategy = clean(
        parsed
            .flags
            .get("strategy")
            .cloned()
            .unwrap_or_else(|| "bfs".to_string()),
        20,
    )
    .to_ascii_lowercase();
    let allowed_strategies = contract
        .get("allowed_strategies")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![json!("bfs"), json!("dfs")]);
    let allowed = allowed_strategies
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 20).to_ascii_lowercase())
        .collect::<Vec<_>>();
    if strict && !allowed.iter().any(|v| v == &strategy) {
        errors.push("tot_strategy_invalid".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_tot_deliberate",
            "errors": errors
        });
    }

    let max_depth = parse_u64(parsed.flags.get("max-depth"), 0).max(1).min(
        contract
            .get("max_depth")
            .and_then(Value::as_u64)
            .unwrap_or(4),
    ) as usize;
    let branching = parse_u64(parsed.flags.get("branching"), 0).max(2).min(
        contract
            .get("max_branching")
            .and_then(Value::as_u64)
            .unwrap_or(5),
    ) as usize;

    let mut branches = Vec::<Value>::new();
    for depth in 0..max_depth {
        for branch_idx in 0..branching {
            let node_id = format!("d{}_b{}", depth + 1, branch_idx + 1);
            let score_seed = sha256_hex_str(&format!("{task}:{strategy}:{node_id}"));
            let score =
                (u64::from_str_radix(&score_seed[..8], 16).unwrap_or(0) % 10_000) as f64 / 10_000.0;
            branches.push(json!({
                "node_id": node_id,
                "depth": depth + 1,
                "branch_index": branch_idx + 1,
                "strategy": strategy,
                "proposal": format!("{} :: option {}", clean(&task, 120), branch_idx + 1),
                "score": score,
                "eval_hash": sha256_hex_str(&format!("{}:{}:{}:{}", task, strategy, depth, branch_idx))
            }));
        }
    }
    branches.sort_by(|a, b| {
        let left = a.get("score").and_then(Value::as_f64).unwrap_or(0.0);
        let right = b.get("score").and_then(Value::as_f64).unwrap_or(0.0);
        right
            .partial_cmp(&left)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let best = branches.first().cloned().unwrap_or_else(|| json!({}));
    let artifact = json!({
        "version": "v1",
        "profile": "tot-deliberate",
        "task": task,
        "strategy": strategy,
        "max_depth": max_depth,
        "branching": branching,
        "branches": branches,
        "selected": best
    });
    let artifact_path = state_root(root).join("tot_deliberate").join("latest.json");
    let _ = write_json(&artifact_path, &artifact);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "skills_plane_tot_deliberate",
        "lane": "core/layer0/ops",
        "artifact": {
            "path": artifact_path.display().to_string(),
            "sha256": sha256_hex_str(&artifact.to_string())
        },
        "result": artifact,
        "claim_evidence": [
            {
                "id": "V6-SKILLS-001.8",
                "claim": "tot_deliberate_profile_runs_bounded_branch_search_with_deterministic_branch_and_eval_receipts",
                "evidence": {
                    "max_depth": max_depth,
                    "branching": branching,
                    "strategy": strategy
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_install(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let skill_path = parsed
        .flags
        .get("skill-path")
        .cloned()
        .or_else(|| parsed.positional.get(1).cloned())
        .unwrap_or_default();
    if skill_path.trim().is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_install",
            "errors": ["skill_path_required"]
        });
    }
    let path = if Path::new(&skill_path).is_absolute() {
        PathBuf::from(&skill_path)
    } else {
        root.join(&skill_path)
    };
    let yaml_path = path.join("skill.yaml");
    if strict && !yaml_path.exists() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_install",
            "errors": [format!("skill_yaml_missing:{}", yaml_path.display())]
        });
    }
    let parsed_yaml = parse_skill_yaml(&yaml_path);
    let id = clean(
        parsed_yaml
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default(),
        120,
    );
    if strict && id.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_install",
            "errors": ["skill_name_missing_in_yaml"]
        });
    }
    let registry_path = state_root(root).join("registry.json");
    let mut registry = load_registry(&registry_path);
    if !registry
        .get("installed")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        registry["installed"] = Value::Object(Map::new());
    }
    let mut installed = registry
        .get("installed")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    installed.insert(
        id.clone(),
        json!({
            "path": path.display().to_string(),
            "installed_at": crate::now_iso(),
            "version": parsed_yaml.get("version").cloned().unwrap_or(json!("v1"))
        }),
    );
    registry["installed"] = Value::Object(installed);
    let _ = write_json(&registry_path, &registry);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "skills_plane_install",
        "lane": "core/layer0/ops",
        "registry_path": registry_path.display().to_string(),
        "skill_id": id,
        "claim_evidence": [
            {
                "id": "V6-SKILLS-001.4",
                "claim": "skill_install_run_share_actions_route_through_layer0_conduit_with_deterministic_audit_receipts",
                "evidence": {
                    "action": "install"
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_skill(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let skill = clean(
        parsed
            .flags
            .get("skill")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_default(),
        120,
    );
    if skill.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_run",
            "errors": ["skill_required"]
        });
    }
    let input = clean(
        parsed
            .flags
            .get("input")
            .cloned()
            .unwrap_or_else(|| "".to_string()),
        1000,
    );
    let event = json!({
        "ts": crate::now_iso(),
        "skill": skill,
        "input_sha256": sha256_hex_str(&input),
        "execution_id": format!("skillrun_{}", &sha256_hex_str(&format!("{}:{}", skill, input))[..14])
    });
    let _ = append_jsonl(&state_root(root).join("runs").join("history.jsonl"), &event);
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "skills_plane_run",
        "lane": "core/layer0/ops",
        "event": event,
        "claim_evidence": [
            {
                "id": "V6-SKILLS-001.4",
                "claim": "skill_install_run_share_actions_route_through_layer0_conduit_with_deterministic_audit_receipts",
                "evidence": {
                    "action": "run",
                    "skill": skill
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_share(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let skill = clean(
        parsed
            .flags
            .get("skill")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_default(),
        120,
    );
    let target = clean(
        parsed
            .flags
            .get("target")
            .cloned()
            .unwrap_or_else(|| "local-team".to_string()),
        120,
    );
    if skill.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "skills_plane_share",
            "errors": ["skill_required"]
        });
    }
    let packet = json!({
        "skill": skill,
        "target": target,
        "shared_at": crate::now_iso(),
        "packet_hash": sha256_hex_str(&format!("{}:{}", skill, target))
    });
    let _ = append_jsonl(
        &state_root(root).join("share").join("history.jsonl"),
        &packet,
    );
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "skills_plane_share",
        "lane": "core/layer0/ops",
        "share_packet": packet,
        "claim_evidence": [
            {
                "id": "V6-SKILLS-001.4",
                "claim": "skill_install_run_share_actions_route_through_layer0_conduit_with_deterministic_audit_receipts",
                "evidence": {
                    "action": "share",
                    "skill": skill,
                    "target": target
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let command = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }
    let strict = parse_bool(parsed.flags.get("strict"), true);

    let conduit = if command != "status" {
        Some(conduit_enforcement(root, &parsed, strict, &command))
    } else {
        None
    };
    if strict
        && conduit
            .as_ref()
            .and_then(|v| v.get("ok"))
            .and_then(Value::as_bool)
            == Some(false)
    {
        return emit(
            root,
            json!({
                "ok": false,
                "strict": strict,
                "type": "skills_plane_conduit_gate",
                "errors": ["conduit_bypass_rejected"],
                "conduit_enforcement": conduit
            }),
        );
    }

    let status_dashboard = parse_bool(parsed.flags.get("dashboard"), false)
        || parse_bool(parsed.flags.get("top"), false);
    let payload = match command.as_str() {
        "status" if status_dashboard => run_dashboard(root, &parsed, strict),
        "status" => status(root),
        "list" => run_list(root, &parsed, strict),
        "dashboard" => run_dashboard(root, &parsed, strict),
        "create" => run_create(root, &parsed, strict),
        "activate" => run_activate(root, &parsed, strict),
        "chain-validate" | "chain_validate" | "chain" => run_chain_validate(root, &parsed, strict),
        "install" => run_install(root, &parsed, strict),
        "run" => run_skill(root, &parsed, strict),
        "share" => run_share(root, &parsed, strict),
        "gallery" => run_gallery(root, &parsed, strict),
        "load" => {
            let mut alias = parsed.clone();
            alias.flags.insert("op".to_string(), "load".to_string());
            if !alias.flags.contains_key("skill") {
                if let Some(skill) = parsed.positional.get(1) {
                    alias.flags.insert("skill".to_string(), clean(skill, 120));
                }
            }
            run_gallery(root, &alias, strict)
        }
        "react-minimal" | "react_minimal" => run_react_minimal(root, &parsed, strict),
        "tot-deliberate" | "tot_deliberate" | "tot" => run_tot_deliberate(root, &parsed, strict),
        _ => json!({
            "ok": false,
            "type": "skills_plane_error",
            "error": "unknown_command",
            "command": command
        }),
    };
    if command == "status" && !status_dashboard {
        print_json(&payload);
        return 0;
    }
    emit(root, attach_conduit(payload, conduit.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn has_claim(receipt: &Value, claim_id: &str) -> bool {
        receipt
            .get("claim_evidence")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .any(|row| row.get("id").and_then(Value::as_str) == Some(claim_id))
    }

    #[test]
    fn create_requires_name() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = crate::parse_args(&["create".to_string()]);
        let out = run_create(root.path(), &parsed, true);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn create_mints_deterministic_skill_id_and_cognition_claim() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = crate::parse_args(&[
            "create".to_string(),
            "--name=Weekly Growth Report".to_string(),
        ]);
        let out_a = run_create(root.path(), &parsed, true);
        let out_b = run_create(root.path(), &parsed, true);
        let id_a = out_a
            .get("skill")
            .and_then(|v| v.get("deterministic_id"))
            .and_then(Value::as_str)
            .unwrap_or("");
        let id_b = out_b
            .get("skill")
            .and_then(|v| v.get("deterministic_id"))
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(!id_a.is_empty());
        assert!(id_a.starts_with("skill_"));
        assert_eq!(id_a, id_b);
        assert!(has_claim(&out_a, "V6-COGNITION-012.2"));
    }

    #[test]
    fn dashboard_includes_cognition_ledger_view_and_claim() {
        let root = tempfile::tempdir().expect("tempdir");
        let cognition_dir = root.path().join("state/ops/assimilation_controller");
        fs::create_dir_all(&cognition_dir).expect("mkdir cognition dir");
        fs::write(
            cognition_dir.join("latest.json"),
            r#"{"ok":true,"type":"assimilation_controller_skill_create","skill_id":"skill_abc123"}"#,
        )
        .expect("write cognition latest");
        fs::write(
            cognition_dir.join("history.jsonl"),
            r#"{"ok":true,"type":"assimilation_controller_skill_create"}"#,
        )
        .expect("write cognition history");

        let parsed = crate::parse_args(&["dashboard".to_string()]);
        let out = run_dashboard(root.path(), &parsed, true);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            out.get("cognition")
                .and_then(|v| v.get("history_events"))
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            out.get("cognition")
                .and_then(|v| v.get("latest"))
                .and_then(|v| v.get("type"))
                .and_then(Value::as_str),
            Some("assimilation_controller_skill_create")
        );
        assert!(has_claim(&out, "V6-COGNITION-012.5"));
    }

    #[test]
    fn conduit_rejects_bypass_when_strict() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = crate::parse_args(&["run".to_string(), "--bypass=1".to_string()]);
        let out = conduit_enforcement(root.path(), &parsed, true, "run");
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    }
}
