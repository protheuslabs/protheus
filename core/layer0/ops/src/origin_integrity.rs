// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso, parse_args};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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
    // Run the authoritative CI guard directly to avoid Node/TS loader ambiguity.
    let script = root.join("scripts/ci/dependency_boundary_guard.mjs");
    if !script.exists() {
        return json!({
            "ok": false,
            "error": "dependency_boundary_guard_missing",
            "script": script.display().to_string()
        });
    }

    let policy_path = resolve_path(root, &policy.dependency_boundary_policy_path);
    let output = Command::new("node")
        .arg(script.as_os_str())
        .arg("check")
        .arg("--strict=1")
        .arg(format!("--policy={}", policy_path.display()))
        .current_dir(root)
        .output();

    let Ok(out) = output else {
        return json!({
            "ok": false,
            "error": "dependency_boundary_guard_spawn_failed"
        });
    };

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let payload = parse_last_json(&stdout).unwrap_or_else(|| json!({}));
    let ok = out.status.success() && payload.get("ok").and_then(Value::as_bool) == Some(true);
    json!({
        "ok": ok,
        "status": out.status.code(),
        "policy_path": normalize_rel(&policy_path.to_string_lossy()),
        "payload": payload,
        "stderr": if stderr.is_empty() { Value::Null } else { Value::String(stderr) }
    })
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
}
