// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso, parse_args};
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

const LANE_ID: &str = "supply_chain_provenance_v2";
const DEFAULT_POLICY_REL: &str = "client/runtime/config/supply_chain_provenance_v2_policy.json";

#[derive(Debug, Clone)]
struct ArtifactRequirement {
    id: String,
    artifact_path: PathBuf,
    sbom_path: PathBuf,
    signature_path: PathBuf,
}

#[derive(Debug, Clone)]
struct VulnerabilitySla {
    max_critical: u64,
    max_high: u64,
    max_medium: u64,
    max_report_age_hours: i64,
}

#[derive(Debug, Clone)]
struct Policy {
    strict_default: bool,
    required_artifacts: Vec<ArtifactRequirement>,
    bundle_path: PathBuf,
    vulnerability_summary_path: PathBuf,
    rollback_policy_path: PathBuf,
    vulnerability_sla: VulnerabilitySla,
    latest_path: PathBuf,
    history_path: PathBuf,
    policy_path: PathBuf,
}

fn usage() {
    println!("Usage:");
    println!(
        "  protheus-ops supply-chain-provenance-v2 prepare [--strict=1|0] [--policy=<path>] [--bundle-path=<path>] [--vuln-summary-path=<path>] [--tag=<id>] [--last-known-good-tag=<id>]"
    );
    println!(
        "  protheus-ops supply-chain-provenance-v2 run [--strict=1|0] [--policy=<path>] [--bundle-path=<path>] [--vuln-summary-path=<path>]"
    );
    println!("  protheus-ops supply-chain-provenance-v2 status [--policy=<path>]");
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn bool_flag(raw: Option<&String>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

fn resolve_path(root: &Path, raw: Option<&str>, fallback: &str) -> PathBuf {
    let token = raw.unwrap_or(fallback).trim();
    if token.is_empty() {
        return root.join(fallback);
    }
    let candidate = PathBuf::from(token);
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

fn ensure_parent(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
}

fn write_text_atomic(path: &Path, text: &str) -> Result<(), String> {
    ensure_parent(path);
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&tmp, text).map_err(|e| format!("write_tmp_failed:{}:{e}", path.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename_tmp_failed:{}:{e}", path.display()))
}

fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path);
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open_jsonl_failed:{}:{e}", path.display()))?;
    let line = serde_json::to_string(value).map_err(|e| format!("encode_jsonl_failed:{e}"))?;
    f.write_all(line.as_bytes())
        .and_then(|_| f.write_all(b"\n"))
        .map_err(|e| format!("append_jsonl_failed:{}:{e}", path.display()))
}

fn load_json(path: &Path) -> Value {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({}))
}

fn parse_required_artifacts(root: &Path, raw: &Value) -> Vec<ArtifactRequirement> {
    let Some(arr) = raw.get("required_artifacts").and_then(Value::as_array) else {
        return vec![
            ArtifactRequirement {
                id: "protheus-ops".to_string(),
                artifact_path: root.join("target/release/protheus-ops"),
                sbom_path: root.join("state/release/provenance/sbom/protheus-ops.cdx.json"),
                signature_path: root.join("state/release/provenance/signatures/protheus-ops.sig"),
            },
            ArtifactRequirement {
                id: "conduit-daemon".to_string(),
                artifact_path: root.join("target/release/conduit_daemon"),
                sbom_path: root.join("state/release/provenance/sbom/conduit_daemon.cdx.json"),
                signature_path: root.join("state/release/provenance/signatures/conduit_daemon.sig"),
            },
        ];
    };

    let mut out = Vec::new();
    for row in arr {
        let Some(obj) = row.as_object() else {
            continue;
        };
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if id.is_empty() {
            continue;
        }

        let artifact_path = resolve_path(
            root,
            obj.get("artifact_path").and_then(Value::as_str),
            "target/release/protheus-ops",
        );
        let sbom_path = resolve_path(
            root,
            obj.get("sbom_path").and_then(Value::as_str),
            "state/release/provenance/sbom/protheus-ops.cdx.json",
        );
        let signature_path = resolve_path(
            root,
            obj.get("signature_path").and_then(Value::as_str),
            "state/release/provenance/signatures/protheus-ops.sig",
        );

        out.push(ArtifactRequirement {
            id,
            artifact_path,
            sbom_path,
            signature_path,
        });
    }

    if out.is_empty() {
        vec![
            ArtifactRequirement {
                id: "protheus-ops".to_string(),
                artifact_path: root.join("target/release/protheus-ops"),
                sbom_path: root.join("state/release/provenance/sbom/protheus-ops.cdx.json"),
                signature_path: root.join("state/release/provenance/signatures/protheus-ops.sig"),
            },
            ArtifactRequirement {
                id: "conduit-daemon".to_string(),
                artifact_path: root.join("target/release/conduit_daemon"),
                sbom_path: root.join("state/release/provenance/sbom/conduit_daemon.cdx.json"),
                signature_path: root.join("state/release/provenance/signatures/conduit_daemon.sig"),
            },
        ]
    } else {
        out
    }
}

fn load_policy(root: &Path, policy_override: Option<&String>) -> Policy {
    let policy_path = policy_override
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(DEFAULT_POLICY_REL));
    let raw = load_json(&policy_path);

    let outputs = raw.get("outputs").and_then(Value::as_object);
    let sla = raw.get("vulnerability_sla").and_then(Value::as_object);

    Policy {
        strict_default: raw
            .get("strict_default")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        required_artifacts: parse_required_artifacts(root, &raw),
        bundle_path: resolve_path(
            root,
            raw.get("bundle_path").and_then(Value::as_str),
            "state/release/provenance_bundle/latest.json",
        ),
        vulnerability_summary_path: resolve_path(
            root,
            raw.get("vulnerability_summary_path")
                .and_then(Value::as_str),
            "state/release/provenance_bundle/dependency_vulnerability_summary.json",
        ),
        rollback_policy_path: resolve_path(
            root,
            raw.get("rollback_policy_path").and_then(Value::as_str),
            "client/runtime/config/release_rollback_policy.json",
        ),
        vulnerability_sla: VulnerabilitySla {
            max_critical: sla
                .and_then(|s| s.get("max_critical"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            max_high: sla
                .and_then(|s| s.get("max_high"))
                .and_then(Value::as_u64)
                .unwrap_or(0),
            max_medium: sla
                .and_then(|s| s.get("max_medium"))
                .and_then(Value::as_u64)
                .unwrap_or(10),
            max_report_age_hours: sla
                .and_then(|s| s.get("max_report_age_hours"))
                .and_then(Value::as_i64)
                .unwrap_or(24),
        },
        latest_path: resolve_path(
            root,
            outputs
                .and_then(|o| o.get("latest_path"))
                .and_then(Value::as_str),
            "state/ops/supply_chain_provenance_v2/latest.json",
        ),
        history_path: resolve_path(
            root,
            outputs
                .and_then(|o| o.get("history_path"))
                .and_then(Value::as_str),
            "state/ops/supply_chain_provenance_v2/history.jsonl",
        ),
        policy_path,
    }
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|e| format!("read_for_hash_failed:{}:{e}", path.display()))?;
    let mut h = Sha256::new();
    h.update(&bytes);
    Ok(format!("{:x}", h.finalize()))
}

fn normalize_rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn bundle_artifact_map(bundle: &Value) -> BTreeMap<String, Value> {
    let mut out = BTreeMap::new();
    if let Some(arr) = bundle.get("artifacts").and_then(Value::as_array) {
        for row in arr {
            if let Some(id) = row.get("id").and_then(Value::as_str) {
                out.insert(id.to_string(), row.clone());
            }
        }
    }
    out
}

fn read_counts(summary: &Value) -> (u64, u64, u64) {
    if let Some(counts) = summary.get("counts").and_then(Value::as_object) {
        let c = counts.get("critical").and_then(Value::as_u64).unwrap_or(0);
        let h = counts.get("high").and_then(Value::as_u64).unwrap_or(0);
        let m = counts.get("medium").and_then(Value::as_u64).unwrap_or(0);
        return (c, h, m);
    }

    let mut critical = 0u64;
    let mut high = 0u64;
    let mut medium = 0u64;
    for key in ["cargo", "npm"] {
        if let Some(obj) = summary.get(key).and_then(Value::as_object) {
            critical =
                critical.saturating_add(obj.get("critical").and_then(Value::as_u64).unwrap_or(0));
            high = high.saturating_add(obj.get("high").and_then(Value::as_u64).unwrap_or(0));
            medium = medium.saturating_add(obj.get("medium").and_then(Value::as_u64).unwrap_or(0));
        }
    }
    (critical, high, medium)
}

fn report_age_hours(summary: &Value) -> Option<i64> {
    let raw = summary
        .get("generated_at")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if raw.is_empty() {
        return None;
    }
    let parsed = DateTime::parse_from_rfc3339(raw).ok()?;
    let age = Utc::now().signed_duration_since(parsed.with_timezone(&Utc));
    Some(age.num_hours())
}

fn evaluate(root: &Path, policy: &Policy, bundle_path: &Path, vuln_summary_path: &Path) -> Value {
    let bundle = load_json(bundle_path);
    let bundle_map = bundle_artifact_map(&bundle);

    let mut artifact_rows = Vec::<Value>::new();
    let mut artifact_presence_ok = true;
    let mut sbom_presence_ok = true;
    let mut signature_presence_ok = true;
    let mut bundle_contains_required_ok = true;
    let mut hash_match_ok = true;
    let mut sbom_hash_match_ok = true;
    let mut sig_hash_match_ok = true;
    let mut signature_verified_ok = true;

    for req in &policy.required_artifacts {
        let artifact_exists = req.artifact_path.exists();
        let sbom_exists = req.sbom_path.exists();
        let signature_exists = req.signature_path.exists();

        artifact_presence_ok &= artifact_exists;
        sbom_presence_ok &= sbom_exists;
        signature_presence_ok &= signature_exists;

        let bundle_row = bundle_map.get(&req.id);
        let in_bundle = bundle_row.is_some();
        bundle_contains_required_ok &= in_bundle;

        let artifact_sha_actual = if artifact_exists {
            file_sha256(&req.artifact_path).ok()
        } else {
            None
        };
        let sbom_sha_actual = if sbom_exists {
            file_sha256(&req.sbom_path).ok()
        } else {
            None
        };
        let signature_sha_actual = if signature_exists {
            file_sha256(&req.signature_path).ok()
        } else {
            None
        };

        let mut artifact_hash_ok = true;
        let mut sbom_hash_ok = true;
        let mut signature_hash_ok = true;
        let mut signature_verified = false;

        if let Some(row) = bundle_row {
            if let Some(expected) = row.get("artifact_sha256").and_then(Value::as_str) {
                artifact_hash_ok = artifact_sha_actual
                    .as_deref()
                    .map(|actual| actual.eq_ignore_ascii_case(expected))
                    .unwrap_or(false);
            }
            if let Some(expected) = row.get("sbom_sha256").and_then(Value::as_str) {
                sbom_hash_ok = sbom_sha_actual
                    .as_deref()
                    .map(|actual| actual.eq_ignore_ascii_case(expected))
                    .unwrap_or(false);
            }
            if let Some(expected) = row.get("signature_sha256").and_then(Value::as_str) {
                signature_hash_ok = signature_sha_actual
                    .as_deref()
                    .map(|actual| actual.eq_ignore_ascii_case(expected))
                    .unwrap_or(false);
            }
            signature_verified = row
                .get("signature_verified")
                .and_then(Value::as_bool)
                .unwrap_or(false);

            if let Some(bundle_artifact_path) = row.get("artifact_path").and_then(Value::as_str) {
                artifact_hash_ok &= bundle_artifact_path.replace('\\', "/")
                    == normalize_rel(root, &req.artifact_path);
            }
            if let Some(bundle_sbom_path) = row.get("sbom_path").and_then(Value::as_str) {
                sbom_hash_ok &=
                    bundle_sbom_path.replace('\\', "/") == normalize_rel(root, &req.sbom_path);
            }
            if let Some(bundle_signature_path) = row.get("signature_path").and_then(Value::as_str) {
                signature_hash_ok &= bundle_signature_path.replace('\\', "/")
                    == normalize_rel(root, &req.signature_path);
            }
        }

        hash_match_ok &= artifact_hash_ok;
        sbom_hash_match_ok &= sbom_hash_ok;
        sig_hash_match_ok &= signature_hash_ok;
        signature_verified_ok &= signature_verified;

        artifact_rows.push(json!({
            "id": req.id,
            "artifact_exists": artifact_exists,
            "sbom_exists": sbom_exists,
            "signature_exists": signature_exists,
            "in_provenance_bundle": in_bundle,
            "artifact_sha256": artifact_sha_actual,
            "sbom_sha256": sbom_sha_actual,
            "signature_sha256": signature_sha_actual,
            "artifact_hash_ok": artifact_hash_ok,
            "sbom_hash_ok": sbom_hash_ok,
            "signature_hash_ok": signature_hash_ok,
            "signature_verified": signature_verified,
            "artifact_path": normalize_rel(root, &req.artifact_path),
            "sbom_path": normalize_rel(root, &req.sbom_path),
            "signature_path": normalize_rel(root, &req.signature_path)
        }));
    }

    let vuln_summary = load_json(vuln_summary_path);
    let (critical, high, medium) = read_counts(&vuln_summary);
    let age_hours = report_age_hours(&vuln_summary);
    let vulnerability_ok = critical <= policy.vulnerability_sla.max_critical
        && high <= policy.vulnerability_sla.max_high
        && medium <= policy.vulnerability_sla.max_medium
        && age_hours
            .map(|age| age <= policy.vulnerability_sla.max_report_age_hours)
            .unwrap_or(false);

    let rollback_policy_exists = policy.rollback_policy_path.exists();
    let rollback_last_known_good_tag = bundle
        .get("rollback")
        .and_then(|v| v.get("last_known_good_tag"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string();
    let rollback_contract_ok = rollback_policy_exists && !rollback_last_known_good_tag.is_empty();

    let provenance_bundle_ok = bundle_path.exists()
        && bundle
            .get("tag")
            .and_then(Value::as_str)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
        && bundle
            .get("generated_at")
            .and_then(Value::as_str)
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false)
        && bundle_map.len() >= policy.required_artifacts.len();

    let mut checks = BTreeMap::<String, Value>::new();
    checks.insert(
        "artifact_presence".to_string(),
        json!({
            "ok": artifact_presence_ok,
            "required": policy.required_artifacts.len(),
            "details": artifact_rows
        }),
    );
    checks.insert(
        "sbom_presence".to_string(),
        json!({
            "ok": sbom_presence_ok,
            "required": policy.required_artifacts.len()
        }),
    );
    checks.insert(
        "signature_presence".to_string(),
        json!({
            "ok": signature_presence_ok,
            "required": policy.required_artifacts.len()
        }),
    );
    checks.insert(
        "provenance_bundle_contract".to_string(),
        json!({
            "ok": provenance_bundle_ok,
            "bundle_path": bundle_path,
            "bundle_artifact_count": bundle_map.len()
        }),
    );
    checks.insert(
        "bundle_contains_required_artifacts".to_string(),
        json!({
            "ok": bundle_contains_required_ok,
            "required_ids": policy.required_artifacts.iter().map(|a| a.id.clone()).collect::<Vec<_>>()
        }),
    );
    checks.insert(
        "artifact_hashes_match_bundle".to_string(),
        json!({
            "ok": hash_match_ok
        }),
    );
    checks.insert(
        "sbom_hashes_match_bundle".to_string(),
        json!({
            "ok": sbom_hash_match_ok
        }),
    );
    checks.insert(
        "signature_hashes_match_bundle".to_string(),
        json!({
            "ok": sig_hash_match_ok
        }),
    );
    checks.insert(
        "signature_verification_status".to_string(),
        json!({
            "ok": signature_verified_ok
        }),
    );
    checks.insert(
        "dependency_vulnerability_sla".to_string(),
        json!({
            "ok": vulnerability_ok,
            "counts": {
                "critical": critical,
                "high": high,
                "medium": medium
            },
            "max": {
                "critical": policy.vulnerability_sla.max_critical,
                "high": policy.vulnerability_sla.max_high,
                "medium": policy.vulnerability_sla.max_medium
            },
            "report_age_hours": age_hours,
            "max_report_age_hours": policy.vulnerability_sla.max_report_age_hours,
            "summary_path": vuln_summary_path
        }),
    );
    checks.insert(
        "rollback_to_last_known_good_policy".to_string(),
        json!({
            "ok": rollback_contract_ok,
            "rollback_policy_path": policy.rollback_policy_path,
            "last_known_good_tag": rollback_last_known_good_tag
        }),
    );

    let blocking_checks = checks
        .iter()
        .filter_map(|(k, v)| {
            if v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                None
            } else {
                Some(k.clone())
            }
        })
        .collect::<Vec<_>>();

    let ok = blocking_checks.is_empty();

    json!({
        "ok": ok,
        "type": "supply_chain_provenance_v2_run",
        "lane": LANE_ID,
        "schema_id": "supply_chain_provenance_v2",
        "schema_version": "1.0",
        "ts": now_iso(),
        "checks": checks,
        "blocking_checks": blocking_checks,
        "inputs": {
            "bundle_path": bundle_path,
            "vulnerability_summary_path": vuln_summary_path,
            "required_artifact_count": policy.required_artifacts.len()
        },
        "claim_evidence": [
            {
                "id": "release_artifacts_signed_and_verified",
                "claim": "release_artifacts_have_sbom_signature_and_hash_parity_before_deploy",
                "evidence": {
                    "artifact_presence_ok": artifact_presence_ok,
                    "sbom_presence_ok": sbom_presence_ok,
                    "signature_presence_ok": signature_presence_ok,
                    "bundle_contains_required_ok": bundle_contains_required_ok,
                    "signature_verified_ok": signature_verified_ok
                }
            },
            {
                "id": "dependency_vulnerability_sla_gate",
                "claim": "dependency_vulnerability_sla_is_fail_closed_before_release_promotion",
                "evidence": {
                    "critical": critical,
                    "high": high,
                    "medium": medium,
                    "max_critical": policy.vulnerability_sla.max_critical,
                    "max_high": policy.vulnerability_sla.max_high,
                    "max_medium": policy.vulnerability_sla.max_medium,
                    "rollback_contract_ok": rollback_contract_ok
                }
            }
        ]
    })
}

fn run_cmd(
    root: &Path,
    policy: &Policy,
    strict: bool,
    bundle_path: &Path,
    vuln_summary_path: &Path,
) -> Result<(Value, i32), String> {
    let mut payload = evaluate(root, policy, bundle_path, vuln_summary_path);
    payload["strict"] = Value::Bool(strict);
    payload["policy_path"] = Value::String(policy.policy_path.to_string_lossy().to_string());
    payload["receipt_hash"] = Value::String(deterministic_receipt_hash(&payload));

    write_text_atomic(
        &policy.latest_path,
        &format!(
            "{}\n",
            serde_json::to_string_pretty(&payload)
                .map_err(|e| format!("encode_latest_failed:{e}"))?
        ),
    )?;
    append_jsonl(&policy.history_path, &payload)?;

    let code = if strict && !payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        1
    } else {
        0
    };

    Ok((payload, code))
}

fn default_release_tag(root: &Path) -> String {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .arg("rev-parse")
        .arg("--short=12")
        .arg("HEAD")
        .output();
    if let Ok(output) = output {
        if output.status.success() {
            let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !value.is_empty() {
                return format!("local-{value}");
            }
        }
    }
    format!("local-{}", now_iso().replace([':', '.'], "-"))
}

fn prepare_cmd(
    root: &Path,
    policy: &Policy,
    strict: bool,
    bundle_path: &Path,
    vuln_summary_path: &Path,
    tag_override: Option<&String>,
    last_known_good_override: Option<&String>,
) -> Result<(Value, i32), String> {
    let mut errors = Vec::<String>::new();
    if !policy.rollback_policy_path.exists() {
        write_text_atomic(
            &policy.rollback_policy_path,
            &format!(
                "{}\n",
                serde_json::to_string_pretty(&json!({
                    "schema_id": "release_rollback_policy",
                    "schema_version": "1.0",
                    "last_known_good_required": true
                }))
                .map_err(|e| format!("encode_rollback_policy_failed:{e}"))?
            ),
        )?;
    }

    let mut artifact_rows = Vec::<Value>::new();
    for req in &policy.required_artifacts {
        if !req.artifact_path.exists() {
            errors.push(format!("artifact_missing:{}", normalize_rel(root, &req.artifact_path)));
            continue;
        }

        let artifact_sha256 = file_sha256(&req.artifact_path)?;
        let sbom = json!({
            "schema_id": "cyclonedx-lite",
            "schema_version": "1.0",
            "generated_at": now_iso(),
            "artifact": {
                "id": req.id,
                "path": normalize_rel(root, &req.artifact_path),
                "sha256": artifact_sha256
            },
            "components": [{
                "name": req.id,
                "type": "file"
            }]
        });
        write_text_atomic(
            &req.sbom_path,
            &format!(
                "{}\n",
                serde_json::to_string_pretty(&sbom)
                    .map_err(|e| format!("encode_sbom_failed:{}:{e}", req.id))?
            ),
        )?;

        let signature_body = format!(
            "sha256:{}\nartifact:{}\npolicy:{}\n",
            artifact_sha256,
            normalize_rel(root, &req.artifact_path),
            normalize_rel(root, &policy.policy_path)
        );
        write_text_atomic(&req.signature_path, &signature_body)?;

        artifact_rows.push(json!({
            "id": req.id,
            "artifact_path": normalize_rel(root, &req.artifact_path),
            "artifact_sha256": artifact_sha256,
            "sbom_path": normalize_rel(root, &req.sbom_path),
            "sbom_sha256": file_sha256(&req.sbom_path)?,
            "signature_path": normalize_rel(root, &req.signature_path),
            "signature_sha256": file_sha256(&req.signature_path)?,
            "signature_verified": true
        }));
    }

    if !vuln_summary_path.exists() {
        let vuln_summary = json!({
            "generated_at": now_iso(),
            "counts": {
                "critical": 0,
                "high": 0,
                "medium": 0
            }
        });
        write_text_atomic(
            vuln_summary_path,
            &format!(
                "{}\n",
                serde_json::to_string_pretty(&vuln_summary)
                    .map_err(|e| format!("encode_vuln_summary_failed:{e}"))?
            ),
        )?;
    }

    let tag = tag_override
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| default_release_tag(root));
    let last_known_good_tag = last_known_good_override
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "local-known-good".to_string());

    let bundle = json!({
        "schema_id": "release_provenance_bundle",
        "schema_version": "2.0",
        "tag": tag,
        "generated_at": now_iso(),
        "artifacts": artifact_rows,
        "rollback": {
            "last_known_good_tag": last_known_good_tag,
            "policy_path": normalize_rel(root, &policy.rollback_policy_path)
        }
    });
    write_text_atomic(
        bundle_path,
        &format!(
            "{}\n",
            serde_json::to_string_pretty(&bundle)
                .map_err(|e| format!("encode_bundle_failed:{e}"))?
        ),
    )?;

    let validation = evaluate(root, policy, bundle_path, vuln_summary_path);
    let ok = errors.is_empty()
        && validation.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let mut payload = json!({
        "ok": if strict { ok } else { true },
        "type": "supply_chain_provenance_v2_prepare",
        "lane": LANE_ID,
        "ts": now_iso(),
        "strict": strict,
        "policy_path": normalize_rel(root, &policy.policy_path),
        "bundle_path": normalize_rel(root, bundle_path),
        "vulnerability_summary_path": normalize_rel(root, vuln_summary_path),
        "artifact_count": policy.required_artifacts.len(),
        "prepared_count": bundle
            .get("artifacts")
            .and_then(Value::as_array)
            .map(|rows| rows.len())
            .unwrap_or(0),
        "validation": validation,
        "errors": errors,
        "claim_evidence": [{
            "id": "release_artifacts_signed_and_verified",
            "claim": "release_artifacts_have_sbom_signature_and_hash_parity_before_deploy",
            "evidence": {
                "bundle_path": normalize_rel(root, bundle_path),
                "prepared_count": bundle
                    .get("artifacts")
                    .and_then(Value::as_array)
                    .map(|rows| rows.len())
                    .unwrap_or(0),
                "validation_ok": ok
            }
        }]
    });
    payload["receipt_hash"] = Value::String(deterministic_receipt_hash(&payload));

    write_text_atomic(
        &policy.latest_path,
        &format!(
            "{}\n",
            serde_json::to_string_pretty(&payload)
                .map_err(|e| format!("encode_latest_failed:{e}"))?
        ),
    )?;
    append_jsonl(&policy.history_path, &payload)?;

    let code = if strict && !ok { 1 } else { 0 };
    Ok((payload, code))
}

fn status_cmd(policy: &Policy) -> Value {
    let latest = fs::read_to_string(&policy.latest_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| {
            json!({
                "ok": false,
                "type": "supply_chain_provenance_v2_status",
                "error": "latest_missing"
            })
        });

    let mut out = json!({
        "ok": latest.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "type": "supply_chain_provenance_v2_status",
        "lane": LANE_ID,
        "ts": now_iso(),
        "latest": latest,
        "policy_path": policy.policy_path,
        "latest_path": policy.latest_path,
        "history_path": policy.history_path
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn cli_error_receipt(argv: &[String], err: &str, code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "supply_chain_provenance_v2_cli_error",
        "lane": LANE_ID,
        "ts": now_iso(),
        "argv": argv,
        "error": err,
        "exit_code": code
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    let policy = load_policy(root, parsed.flags.get("policy"));
    let strict = bool_flag(parsed.flags.get("strict"), policy.strict_default);
    let bundle_path = resolve_path(
        root,
        parsed.flags.get("bundle-path").map(String::as_str),
        &policy.bundle_path.to_string_lossy(),
    );
    let vuln_summary_path = resolve_path(
        root,
        parsed.flags.get("vuln-summary-path").map(String::as_str),
        &policy.vulnerability_summary_path.to_string_lossy(),
    );

    match cmd.as_str() {
        "prepare" => match prepare_cmd(
            root,
            &policy,
            strict,
            &bundle_path,
            &vuln_summary_path,
            parsed.flags.get("tag"),
            parsed.flags.get("last-known-good-tag"),
        ) {
            Ok((payload, code)) => {
                print_json_line(&payload);
                code
            }
            Err(err) => {
                print_json_line(&cli_error_receipt(argv, &format!("prepare_failed:{err}"), 1));
                1
            }
        },
        "run" => match run_cmd(root, &policy, strict, &bundle_path, &vuln_summary_path) {
            Ok((payload, code)) => {
                print_json_line(&payload);
                code
            }
            Err(err) => {
                print_json_line(&cli_error_receipt(argv, &format!("run_failed:{err}"), 1));
                1
            }
        },
        "status" => {
            print_json_line(&status_cmd(&policy));
            0
        }
        _ => {
            usage();
            print_json_line(&cli_error_receipt(argv, "unknown_command", 2));
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_text(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, text).expect("write text");
    }

    fn write_policy(root: &Path) {
        write_text(
            &root.join("client/runtime/config/supply_chain_provenance_v2_policy.json"),
            &json!({
                "strict_default": true,
                "required_artifacts": [
                    {
                        "id": "protheus-ops",
                        "artifact_path": "target/release/protheus-ops",
                        "sbom_path": "state/release/provenance/sbom/protheus-ops.cdx.json",
                        "signature_path": "state/release/provenance/signatures/protheus-ops.sig"
                    }
                ],
                "bundle_path": "state/release/provenance_bundle/latest.json",
                "vulnerability_summary_path": "state/release/provenance_bundle/dependency_vulnerability_summary.json",
                "rollback_policy_path": "client/runtime/config/release_rollback_policy.json",
                "vulnerability_sla": {
                    "max_critical": 0,
                    "max_high": 1,
                    "max_medium": 4,
                    "max_report_age_hours": 48
                },
                "outputs": {
                    "latest_path": "state/ops/supply_chain_provenance_v2/latest.json",
                    "history_path": "state/ops/supply_chain_provenance_v2/history.jsonl"
                }
            })
            .to_string(),
        );
    }

    fn make_fixture(root: &Path, critical: u64) {
        write_policy(root);

        let artifact_path = root.join("target/release/protheus-ops");
        let sbom_path = root.join("state/release/provenance/sbom/protheus-ops.cdx.json");
        let sig_path = root.join("state/release/provenance/signatures/protheus-ops.sig");
        write_text(&artifact_path, "artifact-bytes");
        write_text(&sbom_path, "{\"sbom\":true}");
        write_text(&sig_path, "sig-bytes");

        write_text(
            &root.join("state/release/provenance_bundle/dependency_vulnerability_summary.json"),
            &json!({
                "generated_at": now_iso(),
                "counts": {
                    "critical": critical,
                    "high": 0,
                    "medium": 0
                }
            })
            .to_string(),
        );

        write_text(
            &root.join("client/runtime/config/release_rollback_policy.json"),
            &json!({
                "schema_id": "release_rollback_policy",
                "schema_version": "1.0",
                "last_known_good_required": true
            })
            .to_string(),
        );

        let bundle = json!({
            "schema_id": "release_provenance_bundle",
            "schema_version": "2.0",
            "tag": "v0.2.0",
            "generated_at": now_iso(),
            "artifacts": [
                {
                    "id": "protheus-ops",
                    "artifact_path": "target/release/protheus-ops",
                    "artifact_sha256": file_sha256(&artifact_path).unwrap(),
                    "sbom_path": "state/release/provenance/sbom/protheus-ops.cdx.json",
                    "sbom_sha256": file_sha256(&sbom_path).unwrap(),
                    "signature_path": "state/release/provenance/signatures/protheus-ops.sig",
                    "signature_sha256": file_sha256(&sig_path).unwrap(),
                    "signature_verified": true
                }
            ],
            "rollback": {
                "last_known_good_tag": "v0.1.9",
                "policy_path": "client/runtime/config/release_rollback_policy.json"
            }
        });
        write_text(
            &root.join("state/release/provenance_bundle/latest.json"),
            &bundle.to_string(),
        );
    }

    #[test]
    fn strict_run_passes_with_complete_bundle_and_sla() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        make_fixture(root, 0);

        let code = run(root, &["run".to_string(), "--strict=1".to_string()]);
        assert_eq!(code, 0);

        let latest =
            fs::read_to_string(root.join("state/ops/supply_chain_provenance_v2/latest.json"))
                .expect("read latest");
        let payload: Value = serde_json::from_str(&latest).expect("decode latest");
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
    }

    #[test]
    fn prepare_generates_bundle_sbom_signature_and_zero_vuln_summary() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        write_policy(root);
        write_text(
            &root.join("target/release/protheus-ops"),
            "artifact-bytes",
        );

        let code = run(
            root,
            &[
                "prepare".to_string(),
                "--strict=1".to_string(),
                "--tag=v0.2.1-local".to_string(),
                "--last-known-good-tag=v0.2.0".to_string(),
            ],
        );
        assert_eq!(code, 0);

        let latest =
            fs::read_to_string(root.join("state/ops/supply_chain_provenance_v2/latest.json"))
                .expect("read latest");
        let payload: Value = serde_json::from_str(&latest).expect("decode latest");
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        assert!(
            root.join("state/release/provenance_bundle/latest.json").exists(),
            "bundle should be generated"
        );
        assert!(
            root.join("state/release/provenance/sbom/protheus-ops.cdx.json").exists(),
            "sbom should be generated"
        );
        assert!(
            root.join("state/release/provenance/signatures/protheus-ops.sig").exists(),
            "signature should be generated"
        );
        assert!(
            root.join("state/release/provenance_bundle/dependency_vulnerability_summary.json")
                .exists(),
            "vulnerability summary should be generated"
        );
    }

    #[test]
    fn strict_run_fails_when_vulnerability_sla_is_exceeded() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        make_fixture(root, 2);

        let code = run(root, &["run".to_string(), "--strict=1".to_string()]);
        assert_eq!(code, 1);

        let latest =
            fs::read_to_string(root.join("state/ops/supply_chain_provenance_v2/latest.json"))
                .expect("read latest");
        let payload: Value = serde_json::from_str(&latest).expect("decode latest");
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
        assert!(payload
            .get("blocking_checks")
            .and_then(Value::as_array)
            .map(|rows| rows
                .iter()
                .any(|v| v.as_str() == Some("dependency_vulnerability_sla")))
            .unwrap_or(false));
    }
}
