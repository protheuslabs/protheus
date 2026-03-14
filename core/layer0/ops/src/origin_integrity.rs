// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso, parse_args};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

const DEFAULT_POLICY_REL: &str = "client/runtime/config/origin_integrity_policy.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct OriginIntegrityPolicy {
    version: String,
    strict_default: bool,
    verify_script_relpath: String,
    dependency_boundary_policy_path: String,
    safety_plane_paths: Vec<String>,
    constitution: ConstitutionContract,
    paths: OriginIntegrityPaths,
}

impl Default for OriginIntegrityPolicy {
    fn default() -> Self {
        Self {
            version: "1.0".to_string(),
            strict_default: true,
            verify_script_relpath: "verify.sh".to_string(),
            dependency_boundary_policy_path:
                "client/runtime/config/dependency_boundary_manifest.json".to_string(),
            safety_plane_paths: vec![
                "docs/workspace/AGENT-CONSTITUTION.md".to_string(),
                "client/runtime/config/dependency_boundary_manifest.json".to_string(),
                "client/runtime/config/rust_source_of_truth_policy.json".to_string(),
                "client/runtime/config/constitution_guardian_policy.json".to_string(),
                "client/runtime/config/rsi_bootstrap_policy.json".to_string(),
                "core/layer0/ops/src/main.rs".to_string(),
                "core/layer0/ops/src/contract_check.rs".to_string(),
                "core/layer0/ops/src/foundation_contract_gate.rs".to_string(),
                "core/layer0/ops/src/spine.rs".to_string(),
            ],
            constitution: ConstitutionContract::default(),
            paths: OriginIntegrityPaths::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct ConstitutionContract {
    constitution_path: String,
    guardian_policy_path: String,
    rsi_bootstrap_policy_path: String,
}

impl Default for ConstitutionContract {
    fn default() -> Self {
        Self {
            constitution_path: "docs/workspace/AGENT-CONSTITUTION.md".to_string(),
            guardian_policy_path: "client/runtime/config/constitution_guardian_policy.json"
                .to_string(),
            rsi_bootstrap_policy_path: "client/runtime/config/rsi_bootstrap_policy.json"
                .to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
struct OriginIntegrityPaths {
    latest_path: String,
    receipts_path: String,
    certificate_path: String,
}

impl Default for OriginIntegrityPaths {
    fn default() -> Self {
        Self {
            latest_path: "client/runtime/local/state/security/origin_integrity/latest.json".to_string(),
            receipts_path: "client/runtime/local/state/security/origin_integrity/receipts.jsonl".to_string(),
            certificate_path: "client/runtime/local/state/security/origin_integrity/origin_verify_certificate.json"
                .to_string(),
        }
    }
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops origin-integrity run [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops origin-integrity status [--policy=<path>]");
    println!("  protheus-ops origin-integrity certificate [--strict=1|0] [--policy=<path>]");
    println!(
        "  protheus-ops origin-integrity seed-bootstrap-verify --certificate=<path> [--policy=<path>]"
    );
}

fn read_json(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("read_json_failed:{}:{err}", path.display()))?;
    serde_json::from_str::<Value>(&raw)
        .map_err(|err| format!("parse_json_failed:{}:{err}", path.display()))
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create_dir_failed:{}:{err}", parent.display()))?;
    }
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    let payload = serde_json::to_vec_pretty(value)
        .map_err(|err| format!("encode_json_failed:{}:{err}", path.display()))?;
    fs::write(&tmp, &payload).map_err(|err| format!("write_tmp_failed:{}:{err}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|err| {
        format!(
            "rename_tmp_failed:{}:{}:{err}",
            tmp.display(),
            path.display()
        )
    })
}

fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create_dir_failed:{}:{err}", parent.display()))?;
    }
    let line = serde_json::to_string(value)
        .map_err(|err| format!("encode_jsonl_failed:{}:{err}", path.display()))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("open_jsonl_failed:{}:{err}", path.display()))?;
    writeln!(file, "{line}").map_err(|err| format!("append_jsonl_failed:{}:{err}", path.display()))
}

fn normalize_rel(path: &str) -> String {
    path.replace('\\', "/").trim_start_matches('/').to_string()
}

fn resolve_path(root: &Path, raw: &str) -> PathBuf {
    let cleaned = raw.trim();
    if cleaned.is_empty() {
        return root.join(".");
    }
    let candidate = Path::new(cleaned);
    if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        root.join(normalize_rel(cleaned))
    }
}

fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|err| format!("read_file_failed:{}:{err}", path.display()))?;
    Ok(sha256_bytes(&bytes))
}

fn parse_last_json(stdout: &str) -> Option<Value> {
    let raw = stdout.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        return Some(value);
    }
    for line in raw.lines().rev() {
        if let Ok(value) = serde_json::from_str::<Value>(line.trim()) {
            return Some(value);
        }
    }
    None
}

fn parse_bool(v: Option<&str>, fallback: bool) -> bool {
    let Some(raw) = v else {
        return fallback;
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn load_policy(
    root: &Path,
    policy_path: Option<&str>,
) -> Result<(OriginIntegrityPolicy, PathBuf), String> {
    let path = resolve_path(root, policy_path.unwrap_or(DEFAULT_POLICY_REL));
    if !path.exists() {
        return Ok((OriginIntegrityPolicy::default(), path));
    }
    let raw = fs::read_to_string(&path).map_err(|err| {
        format!(
            "read_origin_integrity_policy_failed:{}:{err}",
            path.display()
        )
    })?;
    let parsed = serde_json::from_str::<OriginIntegrityPolicy>(&raw).map_err(|err| {
        format!(
            "parse_origin_integrity_policy_failed:{}:{err}",
            path.display()
        )
    })?;
    Ok((parsed, path))
}

fn collect_safety_plane_state(root: &Path, policy: &OriginIntegrityPolicy) -> Value {
    let mut entries = Vec::<Value>::new();
    let mut digest_parts = Vec::<String>::new();
    let mut missing_count = 0usize;

    for rel in &policy.safety_plane_paths {
        let rel_norm = normalize_rel(rel);
        let abs = resolve_path(root, &rel_norm);
        if !abs.exists() {
            missing_count += 1;
            entries.push(json!({
                "path": rel_norm,
                "exists": false,
                "sha256": null,
                "missing": true
            }));
            digest_parts.push(format!("{}:missing", rel_norm));
            continue;
        }
        if !abs.is_file() {
            missing_count += 1;
            entries.push(json!({
                "path": rel_norm,
                "exists": true,
                "is_file": false,
                "sha256": null,
                "missing": true
            }));
            digest_parts.push(format!("{}:not_file", rel_norm));
            continue;
        }
        let sha = sha256_file(&abs).unwrap_or_default();
        entries.push(json!({
            "path": rel_norm,
            "exists": true,
            "sha256": sha,
            "missing": false
        }));
        digest_parts.push(format!("{}:{}", rel_norm, sha));
    }

    digest_parts.sort();
    let state_hash = sha256_bytes(digest_parts.join("|").as_bytes());

    json!({
        "state_hash": state_hash,
        "missing_count": missing_count,
        "paths": entries
    })
}

fn run_dependency_boundary_check(root: &Path, policy: &OriginIntegrityPolicy) -> Value {
    let policy_path = resolve_path(root, &policy.dependency_boundary_policy_path);
    let script = root.join("scripts/ci/dependency_boundary_guard.mjs");

    if script.exists() {
        let output = Command::new("node")
            .arg(script.as_os_str())
            .arg("check")
            .arg("--strict=1")
            .arg(format!("--policy={}", policy_path.display()))
            .current_dir(root)
            .output();

        if let Ok(out) = output {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
            let payload = parse_last_json(&stdout).unwrap_or_else(|| json!({}));
            let ok =
                out.status.success() && payload.get("ok").and_then(Value::as_bool) == Some(true);
            return json!({
                "ok": ok,
                "status": out.status.code(),
                "policy_path": normalize_rel(&policy_path.to_string_lossy()),
                "payload": payload,
                "stderr": if stderr.is_empty() { Value::Null } else { Value::String(stderr) },
                "engine": "node"
            });
        }
    }

    match run_dependency_boundary_check_native(root, &policy_path) {
        Ok(payload) => json!({
            "ok": payload.get("ok").and_then(Value::as_bool) == Some(true),
            "status": Value::Null,
            "policy_path": normalize_rel(&policy_path.to_string_lossy()),
            "payload": payload,
            "stderr": Value::Null,
            "engine": "native"
        }),
        Err(err) => json!({
            "ok": false,
            "error": "dependency_boundary_guard_spawn_failed",
            "detail": err,
            "policy_path": normalize_rel(&policy_path.to_string_lossy()),
            "engine": "native"
        }),
    }
}

fn json_string_vec(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(normalize_rel)
                .filter(|row| !row.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

fn json_string_map(value: Option<&Value>) -> BTreeMap<String, Vec<String>> {
    value
        .and_then(Value::as_object)
        .map(|rows| {
            rows.iter()
                .map(|(key, entry)| (key.trim().to_string(), json_string_vec(Some(entry))))
                .collect()
        })
        .unwrap_or_default()
}

fn list_boundary_files(
    root: &Path,
    include_dirs: &[String],
    include_ext: &BTreeSet<String>,
    exclude_contains: &[String],
) -> Result<Vec<PathBuf>, String> {
    let mut out = Vec::<PathBuf>::new();
    let mut stack = include_dirs
        .iter()
        .map(|dir| resolve_path(root, dir))
        .filter(|dir| dir.exists())
        .collect::<Vec<_>>();

    while let Some(cur) = stack.pop() {
        let entries = fs::read_dir(&cur).map_err(|err| {
            format!(
                "dependency_boundary_read_dir_failed:{}:{err}",
                cur.display()
            )
        })?;
        for entry in entries {
            let entry = entry.map_err(|err| {
                format!(
                    "dependency_boundary_read_dir_entry_failed:{}:{err}",
                    cur.display()
                )
            })?;
            let path = entry.path();
            let rel = normalize_rel(&path.strip_prefix(root).unwrap_or(&path).to_string_lossy());
            if exclude_contains.iter().any(|token| rel.contains(token)) {
                continue;
            }
            let file_type = entry.file_type().map_err(|err| {
                format!(
                    "dependency_boundary_file_type_failed:{}:{err}",
                    path.display()
                )
            })?;
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let ext = path
                .extension()
                .map(|v| format!(".{}", v.to_string_lossy().to_ascii_lowercase()))
                .unwrap_or_default();
            if include_ext.contains(&ext) {
                out.push(path);
            }
        }
    }

    out.sort();
    Ok(out)
}

fn detect_layer(rel_path: &str, layers: &BTreeMap<String, Vec<String>>) -> Option<String> {
    for (layer, roots) in layers {
        for root in roots {
            let normalized = normalize_rel(root).trim_end_matches('/').to_string();
            if rel_path == normalized || rel_path.starts_with(&format!("{normalized}/")) {
                return Some(layer.clone());
            }
        }
    }
    None
}

fn resolve_local_spec(from_file: &Path, spec: &str) -> Option<PathBuf> {
    let base = from_file
        .parent()
        .unwrap_or_else(|| Path::new(""))
        .join(spec);
    let candidates = [
        base.clone(),
        PathBuf::from(format!("{}.ts", base.display())),
        PathBuf::from(format!("{}.js", base.display())),
        PathBuf::from(format!("{}.mjs", base.display())),
        base.join("index.ts"),
        base.join("index.js"),
        base.join("index.mjs"),
    ];
    candidates.into_iter().find(|candidate| candidate.is_file())
}

fn parse_import_specs(source: &str) -> Vec<String> {
    let mut specs = Vec::<String>::new();
    for (needle, quote) in [
        ("from '", '\''),
        ("from \"", '"'),
        ("import('", '\''),
        ("import(\"", '"'),
        ("require('", '\''),
        ("require(\"", '"'),
    ] {
        let mut offset = 0usize;
        while let Some(idx) = source[offset..].find(needle) {
            let start = offset + idx + needle.len();
            let Some(end_rel) = source[start..].find(quote) else {
                break;
            };
            let spec = source[start..start + end_rel].trim();
            if !spec.is_empty() {
                specs.push(spec.to_string());
            }
            offset = start + end_rel + 1;
        }
    }
    specs
}

fn run_dependency_boundary_check_native(root: &Path, policy_path: &Path) -> Result<Value, String> {
    let policy = read_json(policy_path)?;
    let scan = policy.get("scan").cloned().unwrap_or_else(|| json!({}));
    let include_dirs = json_string_vec(scan.get("include_dirs"));
    let include_ext = json_string_vec(scan.get("include_ext"))
        .into_iter()
        .map(|v| v.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let exclude_contains = json_string_vec(scan.get("exclude_contains"));
    let layers = json_string_map(policy.get("layers"));
    let allow_imports = json_string_map(policy.get("allow_imports"));
    let enforce_layers = json_string_vec(policy.get("enforce_layers"))
        .into_iter()
        .collect::<BTreeSet<_>>();

    let conduit = policy
        .get("conduit_boundary")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let conduit_dirs = json_string_vec(conduit.get("include_dirs"));
    let conduit_ext = json_string_vec(conduit.get("include_ext"))
        .into_iter()
        .map(|v| v.to_ascii_lowercase())
        .collect::<BTreeSet<_>>();
    let conduit_excludes = json_string_vec(conduit.get("exclude_contains"));
    let conduit_allow = json_string_vec(conduit.get("allowlisted_files"))
        .into_iter()
        .collect::<BTreeSet<_>>();
    let forbidden_patterns = json_string_vec(conduit.get("forbidden_patterns"));

    let files = list_boundary_files(root, &include_dirs, &include_ext, &exclude_contains)?;
    let conduit_roots = conduit_dirs
        .iter()
        .map(|v| normalize_rel(v).trim_end_matches('/').to_string())
        .collect::<Vec<_>>();

    let mut layer_violations = Vec::<Value>::new();
    let mut conduit_violations = Vec::<Value>::new();
    let mut missing_local_imports = Vec::<Value>::new();

    for file_path in &files {
        let rel_path = normalize_rel(
            &file_path
                .strip_prefix(root)
                .unwrap_or(file_path)
                .to_string_lossy(),
        );
        let source = fs::read_to_string(file_path).map_err(|err| {
            format!(
                "dependency_boundary_read_source_failed:{}:{err}",
                file_path.display()
            )
        })?;
        let source_layer = detect_layer(&rel_path, &layers);

        for spec in parse_import_specs(&source) {
            if !spec.starts_with('.') {
                continue;
            }
            let Some(resolved) = resolve_local_spec(file_path, &spec) else {
                missing_local_imports.push(json!({
                    "file": rel_path,
                    "spec": spec
                }));
                continue;
            };
            let target_rel = normalize_rel(
                &resolved
                    .strip_prefix(root)
                    .unwrap_or(&resolved)
                    .to_string_lossy(),
            );
            let target_layer = detect_layer(&target_rel, &layers);
            let Some(source_layer) = source_layer.clone() else {
                continue;
            };
            let Some(target_layer) = target_layer else {
                continue;
            };
            if !enforce_layers.contains(&source_layer) {
                continue;
            }
            let allowed = allow_imports
                .get(&source_layer)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .collect::<BTreeSet<_>>();
            if !allowed.contains(&target_layer) {
                layer_violations.push(json!({
                    "file": rel_path,
                    "source_layer": source_layer,
                    "spec": spec,
                    "resolved": target_rel,
                    "target_layer": target_layer
                }));
            }
        }

        let ext = file_path
            .extension()
            .map(|v| format!(".{}", v.to_string_lossy().to_ascii_lowercase()))
            .unwrap_or_default();
        let in_conduit_scope = conduit_roots
            .iter()
            .any(|root| rel_path == *root || rel_path.starts_with(&format!("{root}/")))
            && conduit_ext.contains(&ext)
            && !conduit_excludes
                .iter()
                .any(|token| rel_path.contains(token));

        if !in_conduit_scope || conduit_allow.contains(&rel_path) {
            continue;
        }
        for token in &forbidden_patterns {
            if !token.is_empty() && source.contains(token) {
                conduit_violations.push(json!({
                    "file": rel_path,
                    "forbidden_pattern": token
                }));
            }
        }
    }

    let ok = layer_violations.is_empty()
        && conduit_violations.is_empty()
        && missing_local_imports.is_empty();

    Ok(json!({
        "ok": ok,
        "type": "dependency_boundary_guard",
        "ts": now_iso(),
        "strict": true,
        "scanned_files": files.len(),
        "layer_violations": layer_violations,
        "conduit_violations": conduit_violations,
        "missing_local_imports": missing_local_imports
    }))
}

fn bool_from_path(value: &Value, path: &[&str]) -> bool {
    let mut cursor = value;
    for key in path {
        let Some(next) = cursor.get(*key) else {
            return false;
        };
        cursor = next;
    }
    cursor.as_bool().unwrap_or(false)
}

fn string_from_path(value: &Value, path: &[&str]) -> Option<String> {
    let mut cursor = value;
    for key in path {
        let Some(next) = cursor.get(*key) else {
            return None;
        };
        cursor = next;
    }
    cursor
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn check_constitution_contract(root: &Path, policy: &OriginIntegrityPolicy) -> Value {
    let constitution_path = resolve_path(root, &policy.constitution.constitution_path);
    let guardian_policy_path = resolve_path(root, &policy.constitution.guardian_policy_path);
    let rsi_policy_path = resolve_path(root, &policy.constitution.rsi_bootstrap_policy_path);

    let constitution_exists = constitution_path.is_file();
    let constitution_hash = if constitution_exists {
        sha256_file(&constitution_path).ok()
    } else {
        None
    };

    let guardian = read_json(&guardian_policy_path).unwrap_or_else(|_| json!({}));
    let require_dual_approval = bool_from_path(&guardian, &["require_dual_approval"]);
    let require_emergency_approval =
        bool_from_path(&guardian, &["emergency_rollback_requires_approval"]);

    let rsi = read_json(&rsi_policy_path).unwrap_or_else(|_| json!({}));
    let require_constitution_status =
        bool_from_path(&rsi, &["gating", "require_constitution_status"]);
    let merkle_path = string_from_path(&rsi, &["paths", "merkle_path"]);
    let resurrection_script = string_from_path(&rsi, &["scripts", "continuity_resurrection"]);
    let resurrection_exists = resurrection_script
        .as_ref()
        .map(|rel| resolve_path(root, rel).exists())
        .unwrap_or(false);

    let ok = constitution_exists
        && require_dual_approval
        && require_emergency_approval
        && require_constitution_status
        && merkle_path.is_some()
        && resurrection_script.is_some()
        && resurrection_exists;

    json!({
        "ok": ok,
        "constitution_path": normalize_rel(&policy.constitution.constitution_path),
        "constitution_exists": constitution_exists,
        "constitution_hash": constitution_hash,
        "guardian_policy_path": normalize_rel(&policy.constitution.guardian_policy_path),
        "guardian_require_dual_approval": require_dual_approval,
        "guardian_emergency_rollback_requires_approval": require_emergency_approval,
        "rsi_bootstrap_policy_path": normalize_rel(&policy.constitution.rsi_bootstrap_policy_path),
        "rsi_require_constitution_status": require_constitution_status,
        "rsi_merkle_path": merkle_path,
        "rsi_resurrection_script": resurrection_script,
        "rsi_resurrection_script_exists": resurrection_exists
    })
}

fn evaluate_invariants(root: &Path, policy: &OriginIntegrityPolicy, command: &str) -> Value {
    let safety_plane = collect_safety_plane_state(root, policy);
    let conduit_only = run_dependency_boundary_check(root, policy);
    let constitution = check_constitution_contract(root, policy);

    let safety_hash = safety_plane
        .get("state_hash")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let binding_material = json!({
        "safety_plane_state_hash": safety_hash,
        "conduit_only_ok": conduit_only.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "constitution_ok": constitution.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "command": command
    });
    let state_binding_hash = deterministic_receipt_hash(&binding_material);

    let ok = conduit_only.get("ok").and_then(Value::as_bool) == Some(true)
        && constitution.get("ok").and_then(Value::as_bool) == Some(true)
        && safety_plane
            .get("missing_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0;

    let mut out = json!({
        "ok": ok,
        "type": "origin_integrity_enforcer",
        "ts": now_iso(),
        "command": command,
        "policy_version": policy.version,
        "checks": {
            "conduit_only": conduit_only,
            "constitution": constitution
        },
        "safety_plane": safety_plane,
        "state_binding": {
            "safety_plane_state_hash": safety_hash,
            "state_binding_hash": state_binding_hash
        },
        "claim_evidence": [
            {
                "id": "conduit_only_enforced",
                "claim": "conduit is the only allowed client-to-core path",
                "evidence": {
                    "check_ok": binding_material.get("conduit_only_ok").cloned().unwrap_or(Value::Bool(false))
                }
            },
            {
                "id": "constitution_non_weakening_guard",
                "claim": "constitution weakening requires guardian + resurrection lanes",
                "evidence": {
                    "check_ok": binding_material.get("constitution_ok").cloned().unwrap_or(Value::Bool(false))
                }
            },
            {
                "id": "receipt_state_binding",
                "claim": "receipt is cryptographically bound to safety-plane state",
                "evidence": binding_material
            }
        ],
        "persona_lenses": {
            "guardian": {
                "origin_integrity_ok": ok,
                "safety_plane_hash": safety_hash
            }
        }
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn build_certificate(root: &Path, policy: &OriginIntegrityPolicy, run_receipt: &Value) -> Value {
    let verify_script_path = resolve_path(root, &policy.verify_script_relpath);
    let verify_sha = if verify_script_path.is_file() {
        sha256_file(&verify_script_path).ok()
    } else {
        None
    };

    let safety_hash = run_receipt
        .get("state_binding")
        .and_then(|v| v.get("safety_plane_state_hash"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let mut out = json!({
        "ok": run_receipt.get("ok").and_then(Value::as_bool) == Some(true) && verify_sha.is_some(),
        "type": "origin_verify_certificate",
        "ts": now_iso(),
        "verify_script": normalize_rel(&policy.verify_script_relpath),
        "verify_script_sha256": verify_sha,
        "safety_plane_state_hash": safety_hash,
        "origin_integrity_receipt_hash": run_receipt.get("receipt_hash").cloned().unwrap_or(Value::Null),
        "policy_version": policy.version
    });
    out["certificate_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn check_seed_certificate(
    root: &Path,
    policy: &OriginIntegrityPolicy,
    certificate_path: &Path,
) -> Value {
    let remote = read_json(certificate_path).unwrap_or_else(|_| json!({}));
    let local = evaluate_invariants(root, policy, "seed-bootstrap-verify-local");

    let remote_verify_sha = remote
        .get("verify_script_sha256")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let local_verify_sha = {
        let verify_path = resolve_path(root, &policy.verify_script_relpath);
        if verify_path.is_file() {
            sha256_file(&verify_path).unwrap_or_default()
        } else {
            String::new()
        }
    };

    let remote_safety_hash = remote
        .get("safety_plane_state_hash")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let local_safety_hash = local
        .get("state_binding")
        .and_then(|v| v.get("safety_plane_state_hash"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let certificate_type_ok = remote
        .get("type")
        .and_then(Value::as_str)
        .map(|v| v == "origin_verify_certificate")
        .unwrap_or(false);

    let mut out = json!({
        "ok": certificate_type_ok
            && !remote_verify_sha.is_empty()
            && !local_verify_sha.is_empty()
            && remote_verify_sha == local_verify_sha
            && !remote_safety_hash.is_empty()
            && !local_safety_hash.is_empty()
            && remote_safety_hash == local_safety_hash
            && local.get("ok").and_then(Value::as_bool) == Some(true),
        "type": "seed_bootstrap_verify",
        "ts": now_iso(),
        "certificate_path": certificate_path.display().to_string(),
        "certificate_type_ok": certificate_type_ok,
        "verify_script_sha256": {
            "remote": remote_verify_sha,
            "local": local_verify_sha,
            "match": remote_verify_sha == local_verify_sha
        },
        "safety_plane_state_hash": {
            "remote": remote_safety_hash,
            "local": local_safety_hash,
            "match": remote_safety_hash == local_safety_hash
        },
        "local_origin_integrity_ok": local.get("ok").and_then(Value::as_bool) == Some(true)
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
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

    let policy_path = parsed.flags.get("policy").map(String::as_str);
    let (policy, resolved_policy_path) = match load_policy(root, policy_path) {
        Ok(v) => v,
        Err(err) => {
            let mut out = json!({
                "ok": false,
                "type": "origin_integrity_enforcer",
                "command": command,
                "error": err,
                "ts": now_iso()
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            println!(
                "{}",
                serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".to_string())
            );
            return 1;
        }
    };

    let strict = parse_bool(
        parsed.flags.get("strict").map(String::as_str),
        policy.strict_default,
    );
    let latest_path = resolve_path(root, &policy.paths.latest_path);
    let receipts_path = resolve_path(root, &policy.paths.receipts_path);
    let certificate_path = resolve_path(root, &policy.paths.certificate_path);

    match command.as_str() {
        "run" => {
            let mut out = evaluate_invariants(root, &policy, "run");
            out["policy_path"] = Value::String(resolved_policy_path.display().to_string());
            let _ = write_json_atomic(&latest_path, &out);
            let _ = append_jsonl(&receipts_path, &out);
            println!(
                "{}",
                serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".to_string())
            );
            if out.get("ok").and_then(Value::as_bool) == Some(true) {
                0
            } else if strict {
                1
            } else {
                0
            }
        }
        "status" => {
            let latest = read_json(&latest_path).ok();
            let mut out = json!({
                "ok": latest
                    .as_ref()
                    .and_then(|v| v.get("ok"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                "type": "origin_integrity_status",
                "ts": now_iso(),
                "policy_path": resolved_policy_path.display().to_string(),
                "latest_path": latest_path.display().to_string(),
                "latest": latest
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            println!(
                "{}",
                serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".to_string())
            );
            0
        }
        "certificate" => {
            let mut run_receipt = evaluate_invariants(root, &policy, "certificate");
            run_receipt["policy_path"] = Value::String(resolved_policy_path.display().to_string());
            let _ = write_json_atomic(&latest_path, &run_receipt);
            let _ = append_jsonl(&receipts_path, &run_receipt);

            if run_receipt.get("ok").and_then(Value::as_bool) != Some(true) {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&run_receipt).unwrap_or_else(|_| "{}".to_string())
                );
                return if strict { 1 } else { 0 };
            }

            let cert = build_certificate(root, &policy, &run_receipt);
            let _ = write_json_atomic(&certificate_path, &cert);
            let _ = append_jsonl(&receipts_path, &cert);
            println!(
                "{}",
                serde_json::to_string_pretty(&cert).unwrap_or_else(|_| "{}".to_string())
            );
            if cert.get("ok").and_then(Value::as_bool) == Some(true) {
                0
            } else if strict {
                1
            } else {
                0
            }
        }
        "seed-bootstrap-verify" => {
            let certificate = parsed.flags.get("certificate").map(String::as_str);
            let Some(certificate_raw) = certificate else {
                let mut out = json!({
                    "ok": false,
                    "type": "seed_bootstrap_verify",
                    "ts": now_iso(),
                    "error": "certificate_required"
                });
                out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
                println!(
                    "{}",
                    serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".to_string())
                );
                return 1;
            };
            let cert_path = resolve_path(root, certificate_raw);
            let out = check_seed_certificate(root, &policy, &cert_path);
            let _ = write_json_atomic(&latest_path, &out);
            let _ = append_jsonl(&receipts_path, &out);
            println!(
                "{}",
                serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".to_string())
            );
            if out.get("ok").and_then(Value::as_bool) == Some(true) {
                0
            } else if strict {
                1
            } else {
                0
            }
        }
        _ => {
            let mut out = json!({
                "ok": false,
                "type": "origin_integrity_enforcer",
                "ts": now_iso(),
                "error": format!("unknown_command:{}", command)
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            println!(
                "{}",
                serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".to_string())
            );
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_json_fixture(path: &Path, value: &Value) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(
            path,
            serde_json::to_string_pretty(value).expect("encode fixture"),
        )
        .expect("write fixture");
    }

    #[test]
    fn safety_plane_hash_is_stable_for_same_input() {
        let mut hasher = Sha256::new();
        hasher.update(b"a|b|c");
        let first = hex::encode(hasher.finalize());
        let second = sha256_bytes(b"a|b|c");
        assert_eq!(first, second);
    }

    #[test]
    fn parse_last_json_uses_last_json_line() {
        let payload = parse_last_json("line one\n{\"ok\":false}\n{\"ok\":true,\"x\":1}\n")
            .expect("json payload");
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(payload.get("x").and_then(Value::as_i64), Some(1));
    }

    #[test]
    fn native_dependency_boundary_check_detects_allowed_relative_imports() {
        let root = tempdir().expect("tempdir");
        let policy_path = root
            .path()
            .join("client/runtime/config/dependency_boundary_manifest.json");
        write_json_fixture(
            &policy_path,
            &json!({
                "layers": {
                    "core": ["client/runtime/lib"],
                    "systems": ["client/runtime/systems"]
                },
                "allow_imports": {
                    "systems": ["core", "systems"]
                },
                "enforce_layers": ["systems"],
                "scan": {
                    "include_dirs": ["client/runtime/lib", "client/runtime/systems"],
                    "include_ext": [".ts"],
                    "exclude_contains": []
                },
                "conduit_boundary": {
                    "include_dirs": ["client/runtime/systems"],
                    "include_ext": [".ts"],
                    "exclude_contains": [],
                    "allowlisted_files": [],
                    "forbidden_patterns": ["spawnSync('cargo'"]
                }
            }),
        );
        let helper = root.path().join("client/runtime/lib/helper.ts");
        let system = root.path().join("client/runtime/systems/agent.ts");
        fs::create_dir_all(helper.parent().expect("helper parent")).expect("helper parent");
        fs::create_dir_all(system.parent().expect("system parent")).expect("system parent");
        fs::write(&helper, "export const helper = 1;\n").expect("write helper");
        fs::write(
            &system,
            "import { helper } from '../lib/helper';\nexport { helper };\n",
        )
        .expect("write system");

        let payload =
            run_dependency_boundary_check_native(root.path(), &policy_path).expect("native check");
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            payload.get("scanned_files").and_then(Value::as_u64),
            Some(2)
        );
    }

    #[test]
    fn run_dependency_boundary_check_falls_back_to_native_when_script_is_missing() {
        let root = tempdir().expect("tempdir");
        let manifest_path = root
            .path()
            .join("client/runtime/config/dependency_boundary_manifest.json");
        write_json_fixture(
            &manifest_path,
            &json!({
                "layers": {
                    "core": ["client/runtime/lib"],
                    "systems": ["client/runtime/systems"]
                },
                "allow_imports": {
                    "systems": ["core", "systems"]
                },
                "enforce_layers": ["systems"],
                "scan": {
                    "include_dirs": ["client/runtime/lib", "client/runtime/systems"],
                    "include_ext": [".ts"],
                    "exclude_contains": []
                },
                "conduit_boundary": {
                    "include_dirs": ["client/runtime/systems"],
                    "include_ext": [".ts"],
                    "exclude_contains": [],
                    "allowlisted_files": [],
                    "forbidden_patterns": []
                }
            }),
        );
        let helper = root.path().join("client/runtime/lib/helper.ts");
        let system = root.path().join("client/runtime/systems/agent.ts");
        fs::create_dir_all(helper.parent().expect("helper parent")).expect("helper parent");
        fs::create_dir_all(system.parent().expect("system parent")).expect("system parent");
        fs::write(&helper, "export const helper = 1;\n").expect("write helper");
        fs::write(
            &system,
            "import { helper } from '../lib/helper';\nexport { helper };\n",
        )
        .expect("write system");

        let policy = OriginIntegrityPolicy {
            dependency_boundary_policy_path: manifest_path.display().to_string(),
            ..OriginIntegrityPolicy::default()
        };
        let payload = run_dependency_boundary_check(root.path(), &policy);
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            payload.get("engine").and_then(Value::as_str),
            Some("native")
        );
        assert_eq!(
            payload
                .get("payload")
                .and_then(|v| v.get("scanned_files"))
                .and_then(Value::as_u64),
            Some(2)
        );
    }
}
