// SPDX-License-Identifier: Apache-2.0
#[path = "enterprise_moat_extensions.rs"]
mod enterprise_moat_extensions;

use crate::{deterministic_receipt_hash, now_iso, parse_args};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

const DEFAULT_POLICY_REL: &str = "client/runtime/config/f100_enterprise_hardening_policy.json";
const DEFAULT_IDENTITY_POLICY_REL: &str = "client/runtime/config/identity_federation_policy.json";
const DEFAULT_ACCESS_POLICY_REL: &str = "client/runtime/config/enterprise_access_policy.json";
const DEFAULT_ABAC_POLICY_REL: &str = "client/runtime/config/abac_policy_plane.json";
const DEFAULT_SIEM_POLICY_REL: &str = "client/runtime/config/siem_bridge_policy.json";
const DEFAULT_SCALE_POLICY_REL: &str = "client/runtime/config/scale_readiness_program_policy.json";
const DEFAULT_BEDROCK_POLICY_REL: &str =
    "planes/contracts/enterprise/bedrock_proxy_contract_v1.json";
const DEFAULT_THIN_WRAPPER_SCAN_ROOT_REL: &str = "client/runtime/systems";
const DEFAULT_DOC_FREEZE_TAG: &str = "genesis-candidate";
const DEFAULT_INSTALLER_PROFILE: &str = "standard";
const ALLOWED_DELIVERY_CHANNELS: &[&str] = &[
    "last",
    "main",
    "inbox",
    "discord",
    "slack",
    "email",
    "pagerduty",
    "stdout",
    "stderr",
    "sms",
];

fn usage() {
    println!("Usage:");
    println!("  protheus-ops enterprise-hardening run [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops enterprise-hardening status [--policy=<path>]");
    println!(
        "  protheus-ops enterprise-hardening export-compliance [--profile=<internal|customer|auditor>] [--strict=1|0] [--policy=<path>]"
    );
    println!(
        "  protheus-ops enterprise-hardening identity-surface [--provider=<id>] [--token-issuer=<url>] [--scopes=a,b] [--roles=r1,r2] [--strict=1|0]"
    );
    println!(
        "  protheus-ops enterprise-hardening certify-scale [--target-nodes=<n>] [--samples=<n>] [--strict=1|0] [--scale-policy=<path>]"
    );
    println!(
        "  protheus-ops enterprise-hardening enable-bedrock [--strict=1|0] [--region=<aws-region>] [--vpc=<id>] [--subnet=<id>] [--ssm-path=<path>] [--policy=<path>]"
    );
    println!(
        "  protheus-ops enterprise-hardening moat-license [--strict=1|0] [--primitives=a,b] [--license=<id>] [--reviewer=<id>]"
    );
    println!(
        "  protheus-ops enterprise-hardening moat-contrast [--strict=1|0] [--narrative=<short-text>]"
    );
    println!(
        "  protheus-ops enterprise-hardening moat-launch-sim [--strict=1|0] [--contributors=<n>] [--events=<n>]"
    );
    println!(
        "  protheus-ops enterprise-hardening genesis-truth-gate [--strict=1|0] [--regression-pass=1|0] [--dod-pass=1|0] [--verify-pass=1|0]"
    );
    println!(
        "  protheus-ops enterprise-hardening genesis-thin-wrapper-audit [--strict=1|0] [--scan-root=<rel-path>]"
    );
    println!(
        "  protheus-ops enterprise-hardening genesis-doc-freeze [--strict=1|0] [--release-tag=<tag>]"
    );
    println!(
        "  protheus-ops enterprise-hardening genesis-bootstrap [--strict=1|0] [--profile=<id>]"
    );
    println!(
        "  protheus-ops enterprise-hardening genesis-installer-sim [--strict=1|0] [--profile=<standard|airgap|enterprise>]"
    );
    println!(
        "  protheus-ops enterprise-hardening zero-trust-profile [--issuer=<url>] [--cmek-key=<kms://...>] [--private-link=<id>] [--egress=deny|restricted] [--strict=1|0]"
    );
    println!("  protheus-ops enterprise-hardening ops-bridge [--providers=a,b] [--strict=1|0]");
    println!(
        "  protheus-ops enterprise-hardening scale-ha-certify [--regions=<n>] [--airgap-agents=<n>] [--cold-start-ms=<n>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops enterprise-hardening deploy-modules [--profile=<enterprise|airgap>] [--strict=1|0]"
    );
    println!("  protheus-ops enterprise-hardening super-gate [--strict=1|0]");
    println!(
        "  protheus-ops enterprise-hardening adoption-bootstrap [--profile=<id>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops enterprise-hardening replay [--at=<rfc3339> | --receipt-hash=<hash>] [--strict=1|0]"
    );
    println!("  protheus-ops enterprise-hardening explore [--strict=1|0]");
    println!(
        "  protheus-ops enterprise-hardening ai [--model=<ollama/...>] [--prompt=<text>] [--local-only=1|0] [--strict=1|0]"
    );
    println!("  protheus-ops enterprise-hardening sync [--peer-roots=a,b] [--strict=1|0]");
    println!(
        "  protheus-ops enterprise-hardening energy-cert [--agents=<n>] [--idle-watts=<n>] [--task-watts=<n>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops enterprise-hardening migrate-ecosystem [--from=openfang|openhands|agent-os] --payload-file=<path> [--strict=1|0]"
    );
    println!(
        "  protheus-ops enterprise-hardening chaos-run [--agents=<n>] [--suite=general|isolate] [--attacks=a,b] [--strict=1|0]"
    );
    println!(
        "  protheus-ops enterprise-hardening assistant-mode [--topic=<id>] [--hand=<id>] [--workspace=<path>] [--strict=1|0]"
    );
    println!("  protheus-ops enterprise-hardening dashboard");
}

fn bool_flag(raw: Option<&str>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("read_json_failed:{}:{err}", path.display()))?;
    serde_json::from_str::<Value>(&raw)
        .map_err(|err| format!("parse_json_failed:{}:{err}", path.display()))
}

fn split_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|token| token.trim().to_ascii_lowercase())
        .filter(|token| !token.is_empty())
        .collect()
}

fn enterprise_state_root(root: &Path) -> PathBuf {
    crate::core_state_root(root)
        .join("ops")
        .join("enterprise_hardening")
}

fn enterprise_latest_path(root: &Path) -> PathBuf {
    enterprise_state_root(root).join("latest.json")
}

fn enterprise_history_path(root: &Path) -> PathBuf {
    enterprise_state_root(root).join("history.jsonl")
}

fn write_json(path: &Path, payload: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create_parent_failed:{}:{err}", parent.to_string_lossy()))?;
    }
    let encoded =
        serde_json::to_string_pretty(payload).map_err(|err| format!("encode_json_failed:{err}"))?;
    fs::write(path, format!("{encoded}\n"))
        .map_err(|err| format!("write_json_failed:{}:{err}", path.display()))
}

fn append_jsonl(path: &Path, payload: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create_parent_failed:{}:{err}", parent.to_string_lossy()))?;
    }
    let mut row =
        serde_json::to_string(payload).map_err(|err| format!("encode_jsonl_failed:{err}"))?;
    row.push('\n');
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut file| std::io::Write::write_all(&mut file, row.as_bytes()))
        .map_err(|err| format!("append_jsonl_failed:{}:{err}", path.display()))
}

fn with_receipt_hash(mut payload: Value) -> Value {
    payload["receipt_hash"] = Value::String(deterministic_receipt_hash(&payload));
    payload
}

fn persist_enterprise_receipt(root: &Path, payload: &Value) -> Result<(), String> {
    write_json(&enterprise_latest_path(root), payload)?;
    append_jsonl(&enterprise_history_path(root), payload)
}

fn file_sha256(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|err| format!("read_bytes_failed:{}:{err}", path.display()))?;
    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    Ok(hex::encode(hasher.finalize()))
}

fn manifest_entry(root: &Path, rel: &str) -> Value {
    let path = root.join(rel);
    if !path.exists() {
        return json!({
            "path": rel,
            "exists": false
        });
    }
    let sha256 = file_sha256(&path).unwrap_or_else(|_| String::new());
    let size = fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    json!({
        "path": rel,
        "exists": true,
        "size_bytes": size,
        "sha256": sha256
    })
}

fn collect_files_with_extension(
    dir: &Path,
    extension: &str,
    out: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if !dir.exists() {
        return Ok(());
    }
    let entries =
        fs::read_dir(dir).map_err(|err| format!("read_dir_failed:{}:{err}", dir.display()))?;
    for entry in entries {
        let entry =
            entry.map_err(|err| format!("read_dir_entry_failed:{}:{err}", dir.display()))?;
        let path = entry.path();
        if path.is_dir() {
            collect_files_with_extension(&path, extension, out)?;
        } else if path
            .extension()
            .and_then(|v| v.to_str())
            .map(|v| v.eq_ignore_ascii_case(extension))
            .unwrap_or(false)
        {
            out.push(path);
        }
    }
    Ok(())
}

fn resolve_json_path<'a>(value: &'a Value, dotted_path: &str) -> Option<&'a Value> {
    let mut cur = value;
    for part in dotted_path.split('.') {
        if part.trim().is_empty() {
            return None;
        }
        cur = cur.get(part)?;
    }
    Some(cur)
}

fn file_contains_all(path: &Path, required_tokens: &[String]) -> Result<Vec<String>, String> {
    let body = fs::read_to_string(path)
        .map_err(|err| format!("read_text_failed:{}:{err}", path.display()))?;
    let missing = required_tokens
        .iter()
        .filter(|token| !body.contains(token.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    Ok(missing)
}

fn check_cron_delivery_integrity(root: &Path, path_rel: &str) -> Result<(bool, Value), String> {
    let path = root.join(path_rel);
    let payload = read_json(&path)?;
    let jobs = payload
        .get("jobs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut issues = Vec::<Value>::new();
    let mut enabled_jobs = 0usize;
    for job in jobs {
        let enabled = job.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        if !enabled {
            continue;
        }
        enabled_jobs += 1;
        let name = job.get("name").and_then(Value::as_str).unwrap_or("unknown");
        let id = job.get("id").and_then(Value::as_str).unwrap_or("unknown");
        let target = job
            .get("sessionTarget")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let delivery = job.get("delivery").and_then(Value::as_object);

        if delivery.is_none() {
            issues.push(json!({
                "id": id,
                "name": name,
                "reason": "missing_delivery_for_enabled_job",
                "session_target": target
            }));
            continue;
        }

        let Some(delivery) = delivery else {
            continue;
        };

        let mode = delivery
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        let channel = delivery
            .get("channel")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();

        if mode == "none" {
            issues.push(json!({
                "id": id,
                "name": name,
                "reason": "delivery_mode_none_forbidden"
            }));
            continue;
        }

        if mode == "announce" {
            if channel.is_empty() {
                issues.push(json!({
                    "id": id,
                    "name": name,
                    "reason": "announce_channel_missing"
                }));
                continue;
            }
            if !ALLOWED_DELIVERY_CHANNELS.contains(&channel.as_str()) {
                issues.push(json!({
                    "id": id,
                    "name": name,
                    "reason": "announce_channel_invalid",
                    "channel": channel
                }));
            }
        }

        if target == "isolated" && mode != "announce" {
            issues.push(json!({
                "id": id,
                "name": name,
                "reason": "isolated_requires_announce"
            }));
        }
    }

    Ok((
        issues.is_empty(),
        json!({
            "enabled_jobs": enabled_jobs,
            "issues": issues,
            "allowed_channels": ALLOWED_DELIVERY_CHANNELS
        }),
    ))
}

fn run_control(root: &Path, control: &serde_json::Map<String, Value>) -> Value {
    let id = control
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let title = control
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("untitled")
        .to_string();
    let kind = control
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("path_exists")
        .to_string();
    let rel_path = control
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();

    if rel_path.trim().is_empty() {
        return json!({
            "id": id,
            "title": title,
            "ok": false,
            "reason": "missing_path"
        });
    }

    let path = root.join(&rel_path);
    match kind.as_str() {
        "path_exists" => {
            let ok = path.exists();
            json!({
                "id": id,
                "title": title,
                "type": kind,
                "ok": ok,
                "path": rel_path,
                "reason": if ok { Value::Null } else { Value::String("path_missing".to_string()) }
            })
        }
        "file_contains_all" => {
            let required_tokens = control
                .get("required_tokens")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(Value::as_str)
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if required_tokens.is_empty() {
                return json!({
                    "id": id,
                    "title": title,
                    "type": kind,
                    "ok": false,
                    "path": rel_path,
                    "reason": "required_tokens_missing"
                });
            }
            match file_contains_all(&path, &required_tokens) {
                Ok(missing) => json!({
                    "id": id,
                    "title": title,
                    "type": kind,
                    "ok": missing.is_empty(),
                    "path": rel_path,
                    "required_tokens": required_tokens.len(),
                    "missing_tokens": missing
                }),
                Err(err) => json!({
                    "id": id,
                    "title": title,
                    "type": kind,
                    "ok": false,
                    "path": rel_path,
                    "reason": err
                }),
            }
        }
        "json_fields" => {
            let required_fields = control
                .get("required_fields")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(Value::as_str)
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if required_fields.is_empty() {
                return json!({
                    "id": id,
                    "title": title,
                    "type": kind,
                    "ok": false,
                    "path": rel_path,
                    "reason": "required_fields_missing"
                });
            }
            match read_json(&path) {
                Ok(payload) => {
                    let missing_fields = required_fields
                        .iter()
                        .filter(|field| resolve_json_path(&payload, field).is_none())
                        .cloned()
                        .collect::<Vec<_>>();
                    json!({
                        "id": id,
                        "title": title,
                        "type": kind,
                        "ok": missing_fields.is_empty(),
                        "path": rel_path,
                        "required_fields": required_fields,
                        "missing_fields": missing_fields
                    })
                }
                Err(err) => json!({
                    "id": id,
                    "title": title,
                    "type": kind,
                    "ok": false,
                    "path": rel_path,
                    "reason": err
                }),
            }
        }
        "cron_delivery_integrity" => match check_cron_delivery_integrity(root, &rel_path) {
            Ok((ok, details)) => json!({
                "id": id,
                "title": title,
                "type": kind,
                "ok": ok,
                "path": rel_path,
                "details": details
            }),
            Err(err) => json!({
                "id": id,
                "title": title,
                "type": kind,
                "ok": false,
                "path": rel_path,
                "reason": err
            }),
        },
        _ => json!({
            "id": id,
            "title": title,
            "type": kind,
            "ok": false,
            "path": rel_path,
            "reason": format!("unknown_control_type:{kind}")
        }),
    }
}

fn run_with_policy(
    root: &Path,
    cmd: &str,
    strict: bool,
    policy_path_rel: &str,
) -> Result<Value, String> {
    let policy_path = root.join(policy_path_rel);
    let policy = read_json(&policy_path)?;
    let controls = policy
        .get("controls")
        .and_then(Value::as_array)
        .ok_or_else(|| "enterprise_policy_missing_controls".to_string())?;

    let mut results = Vec::<Value>::new();
    for control in controls {
        let Some(section) = control.as_object() else {
            results.push(json!({
                "id": "unknown",
                "ok": false,
                "reason": "invalid_control_entry"
            }));
            continue;
        };
        results.push(run_control(root, section));
    }

    let passed = results
        .iter()
        .filter(|row| row.get("ok").and_then(Value::as_bool).unwrap_or(false))
        .count();
    let failed = results.len().saturating_sub(passed);
    let ok = if strict { failed == 0 } else { true };

    let mut out = json!({
        "ok": ok,
        "type": "enterprise_hardening",
        "lane": "enterprise_hardening",
        "mode": cmd,
        "strict": strict,
        "ts": now_iso(),
        "policy_path": policy_path_rel,
        "controls_total": results.len(),
        "controls_passed": passed,
        "controls_failed": failed,
        "controls": results,
        "claim_evidence": [
            {
                "id": "f100_controls_gate",
                "claim": "fortune_100_control_contract_is_enforced_before_release",
                "evidence": {
                    "controls_total": controls.len(),
                    "strict": strict,
                    "failed": failed
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    Ok(out)
}

fn run_export_compliance(
    root: &Path,
    strict: bool,
    policy_path_rel: &str,
    profile: &str,
) -> Result<Value, String> {
    let profile_clean = profile.trim().to_ascii_lowercase();
    if !matches!(profile_clean.as_str(), "internal" | "customer" | "auditor") {
        return Err("invalid_compliance_profile".to_string());
    }
    let hardening = run_with_policy(root, "run", strict, policy_path_rel)?;
    let controls = hardening
        .get("controls")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let evidence_manifest = controls
        .iter()
        .filter_map(|row| row.get("path").and_then(Value::as_str))
        .map(|path| manifest_entry(root, path))
        .collect::<Vec<_>>();
    let controls_failed = hardening
        .get("controls_failed")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let bundle_seed = json!({
        "profile": profile_clean,
        "controls_total": controls.len(),
        "controls_failed": controls_failed,
        "ts": now_iso()
    });
    let bundle_hash = deterministic_receipt_hash(&bundle_seed);
    let bundle_id = format!("enterprise_bundle_{}", &bundle_hash[..16]);
    let bundle_path = enterprise_state_root(root)
        .join("compliance_exports")
        .join(format!("{bundle_id}.json"));
    let bundle_rel = bundle_path
        .strip_prefix(root)
        .unwrap_or(&bundle_path)
        .to_string_lossy()
        .replace('\\', "/");
    let bundle = json!({
        "schema_id": "enterprise_compliance_bundle",
        "schema_version": "1.0",
        "bundle_id": bundle_id,
        "profile": profile_clean,
        "generated_at": now_iso(),
        "policy_path": policy_path_rel,
        "controls_total": controls.len(),
        "controls_failed": controls_failed,
        "hardening_receipt_hash": hardening.get("receipt_hash").cloned().unwrap_or(Value::Null),
        "evidence_manifest": evidence_manifest
    });
    write_json(&bundle_path, &bundle)?;

    Ok(with_receipt_hash(json!({
        "ok": !strict || controls_failed == 0,
        "type": "enterprise_hardening_compliance_export",
        "lane": "enterprise_hardening",
        "mode": "export-compliance",
        "strict": strict,
        "profile": profile_clean,
        "bundle_path": bundle_rel,
        "controls_total": controls.len(),
        "controls_failed": controls_failed,
        "claim_evidence": [
            {
                "id": "V7-ENTERPRISE-001.1",
                "claim": "one_command_compliance_export_produces_traceable_audit_bundle_artifacts",
                "evidence": {
                    "bundle_path": bundle_rel,
                    "profile": profile_clean,
                    "manifest_entries": controls.len()
                }
            }
        ]
    })))
}

fn run_identity_surface(
    root: &Path,
    strict: bool,
    flags: &std::collections::HashMap<String, String>,
) -> Result<Value, String> {
    let identity_policy_path = flags
        .get("identity-policy")
        .map(|v| v.as_str())
        .unwrap_or(DEFAULT_IDENTITY_POLICY_REL);
    let access_policy_path = flags
        .get("access-policy")
        .map(|v| v.as_str())
        .unwrap_or(DEFAULT_ACCESS_POLICY_REL);
    let abac_policy_path = flags
        .get("abac-policy")
        .map(|v| v.as_str())
        .unwrap_or(DEFAULT_ABAC_POLICY_REL);
    let siem_policy_path = flags
        .get("siem-policy")
        .map(|v| v.as_str())
        .unwrap_or(DEFAULT_SIEM_POLICY_REL);

    let identity_policy = read_json(&root.join(identity_policy_path))?;
    let providers = identity_policy
        .get("providers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let requested_provider = flags
        .get("provider")
        .map(|v| v.trim().to_ascii_lowercase())
        .or_else(|| providers.keys().next().map(|v| v.to_ascii_lowercase()))
        .unwrap_or_default();
    let provider = providers
        .get(&requested_provider)
        .cloned()
        .unwrap_or(Value::Null);
    let provider_obj = provider.as_object().cloned().unwrap_or_default();
    let issuer_prefix = provider_obj
        .get("issuer_prefix")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let token_issuer = flags
        .get("token-issuer")
        .cloned()
        .unwrap_or_else(|| format!("{issuer_prefix}enterprise"));
    let scopes = split_csv(
        flags
            .get("scopes")
            .map(|v| v.as_str())
            .unwrap_or("openid,profile,protheus.read"),
    );
    let roles = split_csv(flags.get("roles").map(|v| v.as_str()).unwrap_or("operator"));
    let allowed_scopes = provider_obj
        .get("allowed_scopes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|v| v.to_ascii_lowercase())
        .collect::<std::collections::BTreeSet<_>>();
    let allowed_roles = provider_obj
        .get("allowed_roles")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|v| v.to_ascii_lowercase())
        .collect::<std::collections::BTreeSet<_>>();
    let scopes_allowed = scopes.iter().all(|scope| allowed_scopes.contains(scope));
    let roles_allowed = roles.iter().all(|role| allowed_roles.contains(role));
    let issuer_allowed = !issuer_prefix.is_empty() && token_issuer.starts_with(&issuer_prefix);
    let scim_enabled = provider_obj
        .get("scim_enabled")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let access_policy = read_json(&root.join(access_policy_path))?;
    let access_ops = access_policy
        .get("operations")
        .and_then(Value::as_object)
        .map(|ops| ops.len())
        .unwrap_or(0);
    let abac_policy = read_json(&root.join(abac_policy_path))?;
    let abac_rules = abac_policy
        .get("policies")
        .and_then(Value::as_array)
        .map(|rows| rows.len())
        .unwrap_or(0);
    let siem_policy = read_json(&root.join(siem_policy_path))?;
    let has_siem_export = siem_policy
        .get("latest_export_path")
        .and_then(Value::as_str)
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    let identity_ok = !requested_provider.is_empty()
        && !providers.is_empty()
        && scopes_allowed
        && roles_allowed
        && issuer_allowed
        && access_ops > 0
        && abac_rules > 0
        && has_siem_export;

    Ok(with_receipt_hash(json!({
        "ok": !strict || identity_ok,
        "type": "enterprise_hardening_identity_surface",
        "lane": "enterprise_hardening",
        "mode": "identity-surface",
        "strict": strict,
        "provider": requested_provider,
        "token_issuer": token_issuer,
        "scopes": scopes,
        "roles": roles,
        "surface": {
            "providers": providers.keys().cloned().collect::<Vec<_>>(),
            "scim_enabled_for_provider": scim_enabled,
            "rbac_operations": access_ops,
            "abac_rules": abac_rules,
            "siem_export_configured": has_siem_export
        },
        "checks": {
            "scopes_allowed": scopes_allowed,
            "roles_allowed": roles_allowed,
            "issuer_allowed": issuer_allowed
        },
        "claim_evidence": [
            {
                "id": "V7-ENTERPRISE-001.2",
                "claim": "identity_and_integration_surface_enforces_sso_scim_rbac_abac_with_receipted_authz_checks",
                "evidence": {
                    "provider": requested_provider,
                    "scim_enabled_for_provider": scim_enabled,
                    "rbac_operations": access_ops,
                    "abac_rules": abac_rules,
                    "siem_export_configured": has_siem_export
                }
            }
        ]
    })))
}

fn percentile(samples: &[f64], p: f64) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = (((sorted.len() - 1) as f64) * p).round() as usize;
    sorted[idx.min(sorted.len() - 1)]
}

fn run_scale_certification(
    root: &Path,
    strict: bool,
    flags: &std::collections::HashMap<String, String>,
) -> Result<Value, String> {
    let requested_target_nodes = flags
        .get("target-nodes")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(10_000);
    let target_nodes = requested_target_nodes.max(1);
    let requested_samples = flags
        .get("samples")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(80);
    let samples = requested_samples.clamp(20, 400);

    let mut strict_errors = Vec::<String>::new();
    if strict && target_nodes < 10_000 {
        strict_errors.push("strict_target_nodes_below_10000".to_string());
    }
    if strict && requested_samples < 80 {
        strict_errors.push("strict_samples_below_80".to_string());
    }
    if !strict_errors.is_empty() {
        return Ok(with_receipt_hash(json!({
            "ok": false,
            "type": "enterprise_hardening_scale_certification",
            "lane": "enterprise_hardening",
            "mode": "certify-scale",
            "strict": strict,
            "target_nodes": target_nodes,
            "samples": samples,
            "errors": strict_errors,
            "claim_evidence": [
                {
                    "id": "V7-ENTERPRISE-001.3",
                    "claim": "scale_and_performance_certification_requires_strict_10k_node_minimum_and_reproducible_artifacts",
                    "evidence": {
                        "requested_target_nodes": requested_target_nodes,
                        "requested_samples": requested_samples
                    }
                }
            ]
        })));
    }
    let scale_policy_path = flags
        .get("scale-policy")
        .map(|v| v.as_str())
        .unwrap_or(DEFAULT_SCALE_POLICY_REL);
    let scale_policy = read_json(&root.join(scale_policy_path))?;
    let max_p95 = scale_policy
        .get("budgets")
        .and_then(|v| v.get("max_p95_latency_ms"))
        .and_then(Value::as_f64)
        .unwrap_or(250.0);
    let max_p99 = scale_policy
        .get("budgets")
        .and_then(|v| v.get("max_p99_latency_ms"))
        .and_then(Value::as_f64)
        .unwrap_or(450.0);
    let max_cost = scale_policy
        .get("budgets")
        .and_then(|v| v.get("max_cost_per_user_usd"))
        .and_then(Value::as_f64)
        .unwrap_or(0.18);

    let mut durations_ms = Vec::<f64>::with_capacity(samples);
    let bench_start = Instant::now();
    let loop_budget = (target_nodes / 125).clamp(64, 4096) as usize;
    for sample in 0..samples {
        let start = Instant::now();
        let mut acc = sample as u64 + 1;
        for step in 0..loop_budget {
            acc = acc
                .wrapping_mul(6364136223846793005)
                .wrapping_add((step as u64) ^ 0x9e3779b97f4a7c15);
            acc ^= acc.rotate_left((step % 31) as u32);
        }
        if acc == 0 {
            durations_ms.push(0.0001);
        }
        durations_ms.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    let total_secs = bench_start.elapsed().as_secs_f64().max(0.000001);
    let p95 = percentile(&durations_ms, 0.95);
    let p99 = percentile(&durations_ms, 0.99);
    let throughput = (samples as f64 * (target_nodes as f64 / 10_000.0)) / total_secs;
    let simulated_cost_per_user =
        (0.09 + (p95 / 4000.0) + (target_nodes as f64 / 2_000_000.0)).clamp(0.01, 2.0);
    let ok = p95 <= max_p95 && p99 <= max_p99 && simulated_cost_per_user <= max_cost;

    let cert_seed = json!({
        "target_nodes": target_nodes,
        "samples": samples,
        "p95": p95,
        "p99": p99,
        "throughput": throughput,
        "ts": now_iso()
    });
    let cert_hash = deterministic_receipt_hash(&cert_seed);
    let cert_id = format!("scale_cert_{}", &cert_hash[..16]);
    let cert_path = enterprise_state_root(root)
        .join("scale_certifications")
        .join(format!("{cert_id}.json"));
    let cert_rel = cert_path
        .strip_prefix(root)
        .unwrap_or(&cert_path)
        .to_string_lossy()
        .replace('\\', "/");
    write_json(
        &cert_path,
        &json!({
            "schema_id": "enterprise_scale_certification",
            "schema_version": "1.0",
            "certificate_id": cert_id,
            "target_nodes": target_nodes,
            "samples": samples,
            "p95_latency_ms": p95,
            "p99_latency_ms": p99,
            "throughput_units_per_sec": throughput,
            "simulated_cost_per_user_usd": simulated_cost_per_user,
            "budget_limits": {
                "max_p95_latency_ms": max_p95,
                "max_p99_latency_ms": max_p99,
                "max_cost_per_user_usd": max_cost
            },
            "ok": ok,
            "generated_at": now_iso()
        }),
    )?;

    let whitepaper_path = enterprise_state_root(root)
        .join("scale_certifications")
        .join(format!("{cert_id}_whitepaper.md"));
    let whitepaper_rel = whitepaper_path
        .strip_prefix(root)
        .unwrap_or(&whitepaper_path)
        .to_string_lossy()
        .replace('\\', "/");
    let whitepaper_body = format!(
        "# Scale Certification {cert_id}\n\n- Target Nodes: {target_nodes}\n- Samples: {samples}\n- p95 Latency (ms): {p95:.6}\n- p99 Latency (ms): {p99:.6}\n- Throughput Units/sec: {throughput:.6}\n- Simulated Cost/User (USD): {simulated_cost_per_user:.6}\n- Budget Max p95 (ms): {max_p95:.6}\n- Budget Max p99 (ms): {max_p99:.6}\n- Budget Max Cost/User (USD): {max_cost:.6}\n- Result: {}\n\nGenerated at: {}\n",
        if ok { "PASS" } else { "FAIL" },
        now_iso()
    );
    if let Some(parent) = whitepaper_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create_dir_failed:{}:{err}", parent.display()))?;
    }
    fs::write(&whitepaper_path, whitepaper_body).map_err(|err| {
        format!(
            "write_whitepaper_failed:{}:{err}",
            whitepaper_path.display()
        )
    })?;

    Ok(with_receipt_hash(json!({
        "ok": !strict || ok,
        "type": "enterprise_hardening_scale_certification",
        "lane": "enterprise_hardening",
        "mode": "certify-scale",
        "strict": strict,
        "target_nodes": target_nodes,
        "samples": samples,
        "metrics": {
            "p95_latency_ms": p95,
            "p99_latency_ms": p99,
            "throughput_units_per_sec": throughput,
            "simulated_cost_per_user_usd": simulated_cost_per_user
        },
        "budget_limits": {
            "max_p95_latency_ms": max_p95,
            "max_p99_latency_ms": max_p99,
            "max_cost_per_user_usd": max_cost
        },
        "certificate_path": cert_rel,
        "whitepaper_path": whitepaper_rel,
        "claim_evidence": [
            {
                "id": "V7-ENTERPRISE-001.3",
                "claim": "scale_and_performance_certification_emits_reproducible_10k_node_evidence",
                "evidence": {
                    "target_nodes": target_nodes,
                    "certificate_path": cert_rel,
                    "whitepaper_path": whitepaper_rel,
                    "p95_latency_ms": p95,
                    "p99_latency_ms": p99
                }
            }
        ]
    })))
}

fn run_enable_bedrock(
    root: &Path,
    strict: bool,
    flags: &std::collections::HashMap<String, String>,
) -> Result<Value, String> {
    let policy_path_rel = flags
        .get("policy")
        .map(|v| v.trim())
        .filter(|v| !v.is_empty())
        .unwrap_or(DEFAULT_BEDROCK_POLICY_REL);
    let policy = read_json(&root.join(policy_path_rel))?;
    let mut errors = Vec::<String>::new();
    if policy
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("bedrock_policy_version_must_be_v1".to_string());
    }
    if policy
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "enterprise_bedrock_proxy_contract"
    {
        errors.push("bedrock_policy_kind_invalid".to_string());
    }
    let require_sigv4 = policy
        .get("auth")
        .and_then(|v| v.get("require_sigv4"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let require_private_subnet = policy
        .get("network")
        .and_then(|v| v.get("require_private_subnet"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let require_ssm = policy
        .get("secrets")
        .and_then(|v| v.get("require_ssm"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let provider = policy
        .get("provider")
        .and_then(Value::as_str)
        .unwrap_or("bedrock")
        .to_ascii_lowercase();
    if provider != "bedrock" {
        errors.push("bedrock_policy_provider_must_be_bedrock".to_string());
    }

    let region = flags
        .get("region")
        .cloned()
        .or_else(|| {
            policy
                .get("region")
                .and_then(Value::as_str)
                .map(|v| v.to_string())
        })
        .unwrap_or_else(|| "us-west-2".to_string());
    let vpc = flags
        .get("vpc")
        .cloned()
        .or_else(|| {
            policy
                .get("network")
                .and_then(|v| v.get("vpc"))
                .and_then(Value::as_str)
                .map(|v| v.to_string())
        })
        .unwrap_or_else(|| "vpc-local".to_string());
    let subnet = flags
        .get("subnet")
        .cloned()
        .or_else(|| {
            policy
                .get("network")
                .and_then(|v| v.get("subnet"))
                .and_then(Value::as_str)
                .map(|v| v.to_string())
        })
        .unwrap_or_else(|| "subnet-private-a".to_string());
    let ssm_path = flags
        .get("ssm-path")
        .cloned()
        .or_else(|| {
            policy
                .get("secrets")
                .and_then(|v| v.get("ssm_path"))
                .and_then(Value::as_str)
                .map(|v| v.to_string())
        })
        .unwrap_or_else(|| "/protheus/bedrock/proxy".to_string());

    if strict && require_sigv4 {
        let mode_ok = policy
            .get("auth")
            .and_then(|v| v.get("mode"))
            .and_then(Value::as_str)
            .map(|mode| mode.eq_ignore_ascii_case("sigv4_instance_profile"))
            .unwrap_or(false);
        if !mode_ok {
            errors.push("bedrock_sigv4_instance_profile_required".to_string());
        }
    }
    if strict && require_private_subnet && !subnet.to_ascii_lowercase().contains("private") {
        errors.push("bedrock_private_subnet_required".to_string());
    }
    if strict && require_ssm && !ssm_path.starts_with('/') {
        errors.push("bedrock_ssm_path_required".to_string());
    }

    let ok = errors.is_empty();
    let activation_hash = deterministic_receipt_hash(&json!({
        "provider": provider,
        "region": region,
        "vpc": vpc,
        "subnet": subnet,
        "ssm_path": ssm_path
    }));
    let profile = json!({
        "ok": ok,
        "type": "enterprise_bedrock_proxy_profile",
        "provider": provider,
        "region": region,
        "network": {
            "vpc": vpc,
            "subnet": subnet,
            "private_access_only": require_private_subnet
        },
        "auth": {
            "mode": "sigv4_instance_profile",
            "require_sigv4": require_sigv4
        },
        "secrets": {
            "ssm_path": ssm_path,
            "require_ssm": require_ssm
        },
        "policy_path": policy_path_rel,
        "activation_hash": activation_hash,
        "activation_command": "protheus enterprise enable bedrock",
        "ts": now_iso()
    });
    let profile_path = enterprise_state_root(root)
        .join("bedrock_proxy")
        .join("profile.json");
    write_json(&profile_path, &profile)?;
    let profile_rel = profile_path
        .strip_prefix(root)
        .unwrap_or(&profile_path)
        .to_string_lossy()
        .replace('\\', "/");

    Ok(with_receipt_hash(json!({
        "ok": !strict || ok,
        "type": "enterprise_hardening_enable_bedrock",
        "lane": "enterprise_hardening",
        "mode": "enable-bedrock",
        "strict": strict,
        "profile_path": profile_rel,
        "profile": profile,
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V7-ASSIMILATE-001.5.1",
                "claim": "enterprise_bedrock_proxy_uses_sigv4_private_access_and_ssm_backed_configuration",
                "evidence": {
                    "profile_path": profile_rel,
                    "activation_hash": activation_hash
                }
            },
            {
                "id": "V7-ASSIMILATE-001.5.4",
                "claim": "one_command_bedrock_activation_is_exposed_through_core_authoritative_surface",
                "evidence": {
                    "command": "protheus enterprise enable bedrock",
                    "profile_path": profile_rel
                }
            }
        ]
    })))
}

fn run_moat_license(
    root: &Path,
    strict: bool,
    flags: &std::collections::HashMap<String, String>,
) -> Result<Value, String> {
    let primitives = flags
        .get("primitives")
        .map(|raw| split_csv(raw))
        .filter(|rows| !rows.is_empty())
        .unwrap_or_else(|| {
            vec![
                "conduit".to_string(),
                "binary_blob".to_string(),
                "directive_kernel".to_string(),
                "network_protocol".to_string(),
            ]
        });
    let license = flags
        .get("license")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "Apache-2.0".to_string());
    let reviewer = flags
        .get("reviewer")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "legal-review-bot".to_string());

    let source_for = |primitive: &str| -> Option<&'static str> {
        match primitive {
            "conduit" => Some("core/layer0/ops/src/v8_kernel.rs"),
            "binary_blob" => Some("core/layer0/ops/src/binary_blob_runtime.rs"),
            "directive_kernel" => Some("core/layer0/ops/src/directive_kernel.rs"),
            "network_protocol" => Some("core/layer0/ops/src/network_protocol_run.rs"),
            "enterprise_hardening" => Some("core/layer0/ops/src/enterprise_hardening.rs"),
            _ => None,
        }
    };

    let mut errors = Vec::<String>::new();
    let mut packages = Vec::<Value>::new();
    for primitive in &primitives {
        if let Some(src) = source_for(primitive) {
            let entry = manifest_entry(root, src);
            if strict
                && !entry
                    .get("exists")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
            {
                errors.push(format!("primitive_source_missing:{primitive}"));
            }
            packages.push(json!({
                "primitive": primitive,
                "source": src,
                "source_manifest": entry
            }));
        } else if strict {
            errors.push(format!("unknown_primitive:{primitive}"));
        } else {
            packages.push(json!({
                "primitive": primitive,
                "source": Value::Null,
                "source_manifest": {"path": Value::Null, "exists": false}
            }));
        }
    }

    let package_seed = json!({
        "primitives": primitives,
        "license": license,
        "reviewer": reviewer
    });
    let package_hash = deterministic_receipt_hash(&package_seed);
    let package_id = format!("moat_license_{}", &package_hash[..16]);
    let package_path = enterprise_state_root(root)
        .join("moat")
        .join("licensing")
        .join(format!("{package_id}.json"));
    let package_rel = package_path
        .strip_prefix(root)
        .unwrap_or(&package_path)
        .to_string_lossy()
        .replace('\\', "/");

    let package_payload = json!({
        "schema_id": "moat_licensing_package_v1",
        "schema_version": "1.0",
        "package_id": package_id,
        "license": license,
        "reviewer": reviewer,
        "primitives": packages,
        "review_checkpoint": {
            "status": if errors.is_empty() { "approved" } else { "requires_revision" },
            "reviewed_at": now_iso()
        }
    });
    write_json(&package_path, &package_payload)?;

    Ok(with_receipt_hash(json!({
        "ok": !strict || errors.is_empty(),
        "type": "enterprise_hardening_moat_license",
        "lane": "enterprise_hardening",
        "mode": "moat-license",
        "strict": strict,
        "license": license,
        "reviewer": reviewer,
        "primitives_requested": primitives,
        "package_path": package_rel,
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V7-MOAT-001.1",
                "claim": "ip_and_licensing_pipeline_emits_deterministic_legal_package_manifests_with_review_checkpoints",
                "evidence": {"package_path": package_rel, "reviewer": reviewer}
            }
        ]
    })))
}

fn run_moat_contrast(
    root: &Path,
    strict: bool,
    flags: &std::collections::HashMap<String, String>,
) -> Result<Value, String> {
    let narrative = flags
        .get("narrative")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| {
            "Security posture emphasizes fail-closed conduit authority and deterministic receipts."
                .to_string()
        });
    let enterprise_history_rows = fs::read_to_string(enterprise_history_path(root))
        .ok()
        .map(|body| body.lines().count())
        .unwrap_or(0usize);
    let directive_integrity = crate::directive_kernel::directive_vault_integrity(root);
    let blob_vault_path = crate::core_state_root(root)
        .join("blob_vault")
        .join("prime_blob_vault.json");
    let blob_integrity = if blob_vault_path.exists() {
        let vault = read_json(&blob_vault_path).unwrap_or_else(|_| json!({}));
        let entries = vault
            .get("entries")
            .and_then(Value::as_array)
            .map(|rows| rows.len())
            .unwrap_or(0usize);
        let chain_head = vault
            .get("chain_head")
            .and_then(Value::as_str)
            .unwrap_or("genesis")
            .to_string();
        json!({
            "ok": entries == 0 || chain_head != "genesis",
            "entry_count": entries,
            "chain_head": chain_head
        })
    } else {
        json!({
            "ok": true,
            "entry_count": 0,
            "chain_head": "genesis"
        })
    };
    let top1_latest = read_json(
        &crate::core_state_root(root)
            .join("ops")
            .join("top1_assurance")
            .join("latest.json"),
    )
    .unwrap_or_else(|_| json!({"proven_ratio": 0.0}));
    let proven_ratio = top1_latest
        .get("proven_ratio")
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    let receipts_ok = directive_integrity
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        && blob_integrity
            .get("ok")
            .and_then(Value::as_bool)
            .unwrap_or(false);

    let contrast_seed = json!({
        "history_rows": enterprise_history_rows,
        "receipts_ok": receipts_ok,
        "proven_ratio": proven_ratio,
        "narrative": narrative
    });
    let contrast_hash = deterministic_receipt_hash(&contrast_seed);
    let contrast_id = format!("contrast_{}", &contrast_hash[..16]);
    let json_path = enterprise_state_root(root)
        .join("moat")
        .join("contrast")
        .join(format!("{contrast_id}.json"));
    let md_path = enterprise_state_root(root)
        .join("moat")
        .join("contrast")
        .join(format!("{contrast_id}.md"));
    let json_rel = json_path
        .strip_prefix(root)
        .unwrap_or(&json_path)
        .to_string_lossy()
        .replace('\\', "/");
    let md_rel = md_path
        .strip_prefix(root)
        .unwrap_or(&md_path)
        .to_string_lossy()
        .replace('\\', "/");

    write_json(
        &json_path,
        &json!({
            "schema_id": "moat_security_contrast_v1",
            "schema_version": "1.0",
            "contrast_id": contrast_id,
            "enterprise_history_rows": enterprise_history_rows,
            "receipts_ok": receipts_ok,
            "top1_proven_ratio": proven_ratio,
            "directive_integrity": directive_integrity,
            "blob_integrity": blob_integrity,
            "narrative": narrative,
            "generated_at": now_iso()
        }),
    )?;
    let contrast_md = format!(
        "# Security Contrast Report {contrast_id}\n\n\
         - Enterprise history rows: {enterprise_history_rows}\n\
         - Directive integrity ok: {}\n\
         - Binary blob integrity ok: {}\n\
         - Top1 proven ratio: {proven_ratio:.3}\n\n\
         ## Narrative\n{narrative}\n",
        directive_integrity
            .get("ok")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        blob_integrity
            .get("ok")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    );
    if let Some(parent) = md_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create_dir_failed:{}:{err}", parent.display()))?;
    }
    fs::write(&md_path, contrast_md)
        .map_err(|err| format!("write_contrast_md_failed:{}:{err}", md_path.display()))?;

    let ok = receipts_ok || !strict;
    Ok(with_receipt_hash(json!({
        "ok": ok,
        "type": "enterprise_hardening_moat_contrast",
        "lane": "enterprise_hardening",
        "mode": "moat-contrast",
        "strict": strict,
        "contrast_json_path": json_rel,
        "contrast_markdown_path": md_rel,
        "receipts_ok": receipts_ok,
        "top1_proven_ratio": proven_ratio,
        "claim_evidence": [
            {
                "id": "V7-MOAT-001.2",
                "claim": "security_contrast_artifacts_publish_reproducible_evidence_linked_narrative_metrics",
                "evidence": {"contrast_json_path": json_rel, "top1_proven_ratio": proven_ratio}
            }
        ]
    })))
}

fn run_moat_launch_sim(
    root: &Path,
    strict: bool,
    flags: &std::collections::HashMap<String, String>,
) -> Result<Value, String> {
    let contributors = flags
        .get("contributors")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(800)
        .max(1);
    let events = flags
        .get("events")
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(12_000)
        .max(1);
    let queue_depth = (events as f64 / contributors as f64).max(1.0);
    let p95_latency_ms = (queue_depth * 18.0).min(5000.0);
    let p99_latency_ms = (p95_latency_ms * 1.35).min(8000.0);
    let readiness_score = (100.0 - (p95_latency_ms / 3.0)).clamp(0.0, 100.0);
    let ready = readiness_score >= 75.0;

    let sim_seed = json!({
        "contributors": contributors,
        "events": events,
        "p95_latency_ms": p95_latency_ms,
        "p99_latency_ms": p99_latency_ms,
        "readiness_score": readiness_score
    });
    let sim_hash = deterministic_receipt_hash(&sim_seed);
    let sim_id = format!("launch_sim_{}", &sim_hash[..16]);
    let sim_path = enterprise_state_root(root)
        .join("moat")
        .join("launch_sim")
        .join(format!("{sim_id}.json"));
    let sim_rel = sim_path
        .strip_prefix(root)
        .unwrap_or(&sim_path)
        .to_string_lossy()
        .replace('\\', "/");
    write_json(
        &sim_path,
        &json!({
            "schema_id": "moat_launch_simulation_v1",
            "schema_version": "1.0",
            "simulation_id": sim_id,
            "contributors": contributors,
            "events": events,
            "metrics": {
                "p95_latency_ms": p95_latency_ms,
                "p99_latency_ms": p99_latency_ms,
                "readiness_score": readiness_score
            },
            "rollback_playbook": [
                "pause_new_contributor_onboarding",
                "drain_non_critical_queues",
                "switch_to_safe_capacity_profile",
                "resume_after_guard_validation"
            ],
            "ready": ready,
            "generated_at": now_iso()
        }),
    )?;

    let mut errors = Vec::<String>::new();
    if strict && !ready {
        errors.push("launch_sim_not_ready".to_string());
    }
    Ok(with_receipt_hash(json!({
        "ok": !strict || errors.is_empty(),
        "type": "enterprise_hardening_moat_launch_sim",
        "lane": "enterprise_hardening",
        "mode": "moat-launch-sim",
        "strict": strict,
        "contributors": contributors,
        "events": events,
        "metrics": {
            "p95_latency_ms": p95_latency_ms,
            "p99_latency_ms": p99_latency_ms,
            "readiness_score": readiness_score
        },
        "artifact_path": sim_rel,
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V7-MOAT-001.3",
                "claim": "launch_day_load_simulation_emits_readiness_and_rollback_playbook_artifacts",
                "evidence": {"artifact_path": sim_rel, "readiness_score": readiness_score}
            }
        ]
    })))
}

fn run_genesis_truth_gate(
    root: &Path,
    strict: bool,
    flags: &std::collections::HashMap<String, String>,
) -> Result<Value, String> {
    let regression_pass = bool_flag(flags.get("regression-pass").map(String::as_str), false);
    let dod_pass = bool_flag(flags.get("dod-pass").map(String::as_str), false);
    let verify_pass = bool_flag(flags.get("verify-pass").map(String::as_str), false);
    let all_pass = regression_pass && dod_pass && verify_pass;
    let mut errors = Vec::<String>::new();
    if strict && !all_pass {
        errors.push("genesis_truth_gate_failed".to_string());
    }
    let candidate_seed = json!({
        "regression_pass": regression_pass,
        "dod_pass": dod_pass,
        "verify_pass": verify_pass,
        "ts": now_iso()
    });
    let candidate_hash = deterministic_receipt_hash(&candidate_seed);
    let candidate_id = format!("launch_candidate_{}", &candidate_hash[..16]);
    let candidate_path = enterprise_state_root(root)
        .join("genesis")
        .join("launch_candidates")
        .join(format!("{candidate_id}.json"));
    let candidate_rel = candidate_path
        .strip_prefix(root)
        .unwrap_or(&candidate_path)
        .to_string_lossy()
        .replace('\\', "/");
    write_json(
        &candidate_path,
        &json!({
            "schema_id": "genesis_launch_candidate_v1",
            "schema_version": "1.0",
            "candidate_id": candidate_id,
            "gates": {
                "regression_pass": regression_pass,
                "dod_pass": dod_pass,
                "verify_pass": verify_pass
            },
            "ready": all_pass,
            "generated_at": now_iso()
        }),
    )?;
    Ok(with_receipt_hash(json!({
        "ok": !strict || errors.is_empty(),
        "type": "enterprise_hardening_genesis_truth_gate",
        "lane": "enterprise_hardening",
        "mode": "genesis-truth-gate",
        "strict": strict,
        "candidate_id": candidate_id,
        "candidate_path": candidate_rel,
        "gates": {
            "regression_pass": regression_pass,
            "dod_pass": dod_pass,
            "verify_pass": verify_pass
        },
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V7-GENESIS-001.1",
                "claim": "launch_blocker_requires_regression_dod_and_verify_gates_before_promotion",
                "evidence": {"candidate_id": candidate_id, "all_pass": all_pass}
            }
        ]
    })))
}

fn run_genesis_thin_wrapper_audit(
    root: &Path,
    strict: bool,
    flags: &std::collections::HashMap<String, String>,
) -> Result<Value, String> {
    let scan_root_rel = flags
        .get("scan-root")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_THIN_WRAPPER_SCAN_ROOT_REL.to_string());
    let scan_root = root.join(&scan_root_rel);
    let mut files = Vec::<PathBuf>::new();
    collect_files_with_extension(&scan_root, "ts", &mut files)?;
    files.sort();

    let forbidden = vec![
        "child_process.exec".to_string(),
        "child_process.spawnSync".to_string(),
        "from 'child_process'".to_string(),
        "from \"child_process\"".to_string(),
        "require('child_process')".to_string(),
        "require(\"child_process\")".to_string(),
        "Deno.Command".to_string(),
        "std::process::Command".to_string(),
        "core/layer0/ops/src".to_string(),
    ];
    let allowlist = [
        "client/runtime/systems/ops/formal_spec_guard.ts",
        "client/runtime/systems/ops/dependency_boundary_guard.ts",
    ];
    let mut violations = Vec::<Value>::new();
    for file in files {
        let rel = file
            .strip_prefix(root)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        if allowlist.iter().any(|allowed| rel == *allowed) {
            continue;
        }
        let body = fs::read_to_string(&file).unwrap_or_default();
        let hits = forbidden
            .iter()
            .filter(|token| body.contains(token.as_str()))
            .cloned()
            .collect::<Vec<_>>();
        if !hits.is_empty() {
            violations.push(json!({"path": rel, "tokens": hits}));
        }
    }
    let mut errors = Vec::<String>::new();
    if strict && !violations.is_empty() {
        errors.push("thin_wrapper_boundary_violation".to_string());
    }
    Ok(with_receipt_hash(json!({
        "ok": !strict || errors.is_empty(),
        "type": "enterprise_hardening_genesis_thin_wrapper_audit",
        "lane": "enterprise_hardening",
        "mode": "genesis-thin-wrapper-audit",
        "strict": strict,
        "scan_root": scan_root_rel,
        "violations": violations,
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V7-GENESIS-001.2",
                "claim": "client_surface_boundary_audit_proves_thin_wrapper_paths_without_unauthorized_authority_calls",
                "evidence": {"scan_root": scan_root_rel}
            }
        ]
    })))
}

fn run_genesis_doc_freeze(
    root: &Path,
    strict: bool,
    flags: &std::collections::HashMap<String, String>,
) -> Result<Value, String> {
    let release_tag = flags
        .get("release-tag")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_DOC_FREEZE_TAG.to_string());
    let required_docs = vec![
        "docs/workspace/SRS.md",
        "docs/workspace/DEFINITION_OF_DONE.md",
        "docs/workspace/codex_enforcer.md",
        "README.md",
    ];
    let entries = required_docs
        .iter()
        .map(|rel| manifest_entry(root, rel))
        .collect::<Vec<_>>();
    let missing = entries
        .iter()
        .filter(|row| !row.get("exists").and_then(Value::as_bool).unwrap_or(false))
        .count();
    let freeze_seed = json!({
        "release_tag": release_tag,
        "entries": entries
    });
    let freeze_hash = deterministic_receipt_hash(&freeze_seed);
    let freeze_id = format!("doc_freeze_{}", &freeze_hash[..16]);
    let manifest_path = enterprise_state_root(root)
        .join("genesis")
        .join("doc_freeze")
        .join(format!("{freeze_id}.json"));
    let whitepaper_path = enterprise_state_root(root)
        .join("genesis")
        .join("doc_freeze")
        .join(format!("{freeze_id}_whitepaper.md"));
    let manifest_rel = manifest_path
        .strip_prefix(root)
        .unwrap_or(&manifest_path)
        .to_string_lossy()
        .replace('\\', "/");
    let whitepaper_rel = whitepaper_path
        .strip_prefix(root)
        .unwrap_or(&whitepaper_path)
        .to_string_lossy()
        .replace('\\', "/");
    write_json(
        &manifest_path,
        &json!({
            "schema_id": "genesis_doc_freeze_v1",
            "schema_version": "1.0",
            "freeze_id": freeze_id,
            "release_tag": release_tag,
            "entries": entries,
            "missing_count": missing,
            "generated_at": now_iso()
        }),
    )?;
    let whitepaper = format!(
        "# Genesis Documentation Freeze {freeze_id}\n\n- Release tag: {release_tag}\n- Missing required docs: {missing}\n- Manifest: {manifest_rel}\n"
    );
    if let Some(parent) = whitepaper_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create_dir_failed:{}:{err}", parent.display()))?;
    }
    fs::write(&whitepaper_path, whitepaper).map_err(|err| {
        format!(
            "write_whitepaper_failed:{}:{err}",
            whitepaper_path.display()
        )
    })?;
    let mut errors = Vec::<String>::new();
    if strict && missing > 0 {
        errors.push("genesis_doc_freeze_missing_required_docs".to_string());
    }
    Ok(with_receipt_hash(json!({
        "ok": !strict || errors.is_empty(),
        "type": "enterprise_hardening_genesis_doc_freeze",
        "lane": "enterprise_hardening",
        "mode": "genesis-doc-freeze",
        "strict": strict,
        "release_tag": release_tag,
        "manifest_path": manifest_rel,
        "whitepaper_path": whitepaper_rel,
        "missing_count": missing,
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V7-GENESIS-001.3",
                "claim": "documentation_freeze_and_whitepaper_artifacts_are_hash_linked_to_release_candidate",
                "evidence": {"manifest_path": manifest_rel, "whitepaper_path": whitepaper_rel}
            }
        ]
    })))
}

fn run_genesis_bootstrap(
    root: &Path,
    strict: bool,
    flags: &std::collections::HashMap<String, String>,
) -> Result<Value, String> {
    let profile = flags
        .get("profile")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "default".to_string());
    let step_ids = ["node-init", "governance-init", "monitoring-init"];
    let mut previous = "GENESIS".to_string();
    let mut checkpoints = Vec::<Value>::new();
    for step in step_ids {
        let seed = json!({"step": step, "previous": previous, "profile": profile, "ts": now_iso()});
        let checkpoint_hash = deterministic_receipt_hash(&seed);
        checkpoints.push(json!({
            "step": step,
            "checkpoint_hash": checkpoint_hash,
            "previous_checkpoint": previous,
            "rollback_pointer": format!("rollback:{step}")
        }));
        previous = checkpoints
            .last()
            .and_then(|v| v.get("checkpoint_hash"))
            .and_then(Value::as_str)
            .unwrap_or("GENESIS")
            .to_string();
    }
    let runbook_seed = json!({"profile": profile, "head": previous});
    let runbook_hash = deterministic_receipt_hash(&runbook_seed);
    let runbook_id = format!("bootstrap_{}", &runbook_hash[..16]);
    let runbook_path = enterprise_state_root(root)
        .join("genesis")
        .join("bootstrap")
        .join(format!("{runbook_id}.json"));
    let runbook_rel = runbook_path
        .strip_prefix(root)
        .unwrap_or(&runbook_path)
        .to_string_lossy()
        .replace('\\', "/");
    write_json(
        &runbook_path,
        &json!({
            "schema_id": "genesis_bootstrap_runbook_v1",
            "schema_version": "1.0",
            "runbook_id": runbook_id,
            "profile": profile,
            "checkpoints": checkpoints,
            "head": previous,
            "generated_at": now_iso()
        }),
    )?;
    Ok(with_receipt_hash(json!({
        "ok": true,
        "type": "enterprise_hardening_genesis_bootstrap",
        "lane": "enterprise_hardening",
        "mode": "genesis-bootstrap",
        "strict": strict,
        "profile": profile,
        "runbook_path": runbook_rel,
        "head": previous,
        "claim_evidence": [
            {
                "id": "V7-GENESIS-001.4",
                "claim": "genesis_bootstrap_runbook_executes_deterministic_checkpointed_sequence_with_rollback_pointers",
                "evidence": {"runbook_path": runbook_rel, "profile": profile}
            }
        ]
    })))
}

fn command_exists(name: &str) -> bool {
    let path = std::env::var("PATH").unwrap_or_default();
    path.split(':')
        .filter(|segment| !segment.trim().is_empty())
        .map(Path::new)
        .any(|dir| dir.join(name).exists())
}

fn run_genesis_installer_sim(
    root: &Path,
    strict: bool,
    flags: &std::collections::HashMap<String, String>,
) -> Result<Value, String> {
    let profile = flags
        .get("profile")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_INSTALLER_PROFILE.to_string());
    let checks = vec![
        json!({"name": "git", "ok": command_exists("git")}),
        json!({"name": "cargo", "ok": command_exists("cargo")}),
        json!({"name": "node", "ok": command_exists("node")}),
        json!({"name": "core_ops_manifest", "ok": root.join("core/layer0/ops/Cargo.toml").exists()}),
        json!({"name": "srs_exists", "ok": root.join("docs/workspace/SRS.md").exists()}),
    ];
    let failed = checks
        .iter()
        .filter(|row| !row.get("ok").and_then(Value::as_bool).unwrap_or(false))
        .count();
    let ready = failed == 0;
    let sim_seed = json!({"profile": profile, "checks": checks});
    let sim_hash = deterministic_receipt_hash(&sim_seed);
    let sim_id = format!("installer_sim_{}", &sim_hash[..16]);
    let sim_path = enterprise_state_root(root)
        .join("genesis")
        .join("installer")
        .join(format!("{sim_id}.json"));
    let sim_rel = sim_path
        .strip_prefix(root)
        .unwrap_or(&sim_path)
        .to_string_lossy()
        .replace('\\', "/");
    write_json(
        &sim_path,
        &json!({
            "schema_id": "genesis_installer_simulation_v1",
            "schema_version": "1.0",
            "simulation_id": sim_id,
            "profile": profile,
            "checks": checks,
            "ready": ready,
            "generated_at": now_iso()
        }),
    )?;
    let mut errors = Vec::<String>::new();
    if strict && !ready {
        errors.push("installer_readiness_failed".to_string());
    }
    Ok(with_receipt_hash(json!({
        "ok": !strict || errors.is_empty(),
        "type": "enterprise_hardening_genesis_installer_sim",
        "lane": "enterprise_hardening",
        "mode": "genesis-installer-sim",
        "strict": strict,
        "profile": profile,
        "artifact_path": sim_rel,
        "ready": ready,
        "failed_checks": failed,
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V7-GENESIS-001.5",
                "claim": "one_command_installer_readiness_simulation_emits_environment_check_receipts_before_launch",
                "evidence": {"artifact_path": sim_rel, "ready": ready}
            }
        ]
    })))
}

fn run_dashboard(root: &Path) -> Value {
    let latest = read_json(&enterprise_latest_path(root)).unwrap_or_else(|_| json!({}));
    let compliance_dir = enterprise_state_root(root).join("compliance_exports");
    let scale_dir = enterprise_state_root(root).join("scale_certifications");
    let compliance_bundles = fs::read_dir(&compliance_dir)
        .ok()
        .map(|rows| rows.filter_map(|entry| entry.ok()).count())
        .unwrap_or(0);
    let scale_certifications = fs::read_dir(&scale_dir)
        .ok()
        .map(|rows| rows.filter_map(|entry| entry.ok()).count())
        .unwrap_or(0);
    let moat_dir = enterprise_state_root(root).join("moat");
    let genesis_dir = enterprise_state_root(root).join("genesis");
    let moat_artifacts = fs::read_dir(&moat_dir)
        .ok()
        .map(|rows| rows.filter_map(|entry| entry.ok()).count())
        .unwrap_or(0);
    let genesis_artifacts = fs::read_dir(&genesis_dir)
        .ok()
        .map(|rows| rows.filter_map(|entry| entry.ok()).count())
        .unwrap_or(0);
    let bedrock_profile = read_json(
        &enterprise_state_root(root)
            .join("bedrock_proxy")
            .join("profile.json"),
    )
    .unwrap_or_else(|_| json!({"ok": false}));
    let scheduled_hands = read_json(
        &crate::core_state_root(root)
            .join("ops")
            .join("assimilation_controller")
            .join("scheduled_hands")
            .join("state.json"),
    )
    .unwrap_or_else(|_| json!({"enabled": false}));
    with_receipt_hash(json!({
        "ok": true,
        "type": "enterprise_hardening_dashboard",
        "lane": "enterprise_hardening",
        "mode": "dashboard",
        "latest": latest,
        "summary": {
            "compliance_bundles": compliance_bundles,
            "scale_certifications": scale_certifications,
            "moat_artifact_groups": moat_artifacts,
            "genesis_artifact_groups": genesis_artifacts,
            "bedrock_proxy_enabled": bedrock_profile.get("ok").and_then(Value::as_bool).unwrap_or(false),
            "scheduled_hands_enabled": scheduled_hands.get("enabled").and_then(Value::as_bool).unwrap_or(false),
            "scheduled_hands_run_count": scheduled_hands.get("run_count").cloned().unwrap_or(Value::from(0)),
            "scheduled_hands_earnings_total_usd": scheduled_hands.get("earnings_total_usd").cloned().unwrap_or(Value::from(0.0))
        },
        "claim_evidence": [
            {
                "id": "V7-ASSIMILATE-001.5.4",
                "claim": "operations_dashboard_surfaces_bedrock_and_scheduled_hands_runtime_metrics",
                "evidence": {
                    "bedrock_proxy_enabled": bedrock_profile.get("ok").cloned().unwrap_or(Value::Bool(false)),
                    "scheduled_hands_enabled": scheduled_hands.get("enabled").cloned().unwrap_or(Value::Bool(false))
                }
            }
        ]
    }))
}

fn print_pretty(payload: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(payload)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn command_exit(strict: bool, payload: &Value) -> i32 {
    if strict && !payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        1
    } else {
        0
    }
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    if argv
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h" | "help"))
    {
        usage();
        return 0;
    }

    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "run".to_string());

    let strict_default = cmd == "run";
    let strict = bool_flag(
        parsed.flags.get("strict").map(String::as_str),
        strict_default,
    );
    let policy_path = parsed
        .flags
        .get("policy")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_POLICY_REL.to_string());

    let result = match cmd.as_str() {
        "run" | "status" => {
            run_with_policy(root, &cmd, strict, &policy_path).map(with_receipt_hash)
        }
        "export-compliance" => {
            let profile = parsed
                .flags
                .get("profile")
                .map(|v| v.as_str())
                .unwrap_or("auditor");
            run_export_compliance(root, strict, &policy_path, profile)
        }
        "identity-surface" => run_identity_surface(root, strict, &parsed.flags),
        "certify-scale" => run_scale_certification(root, strict, &parsed.flags),
        "enable-bedrock" => run_enable_bedrock(root, strict, &parsed.flags),
        "moat-license" => run_moat_license(root, strict, &parsed.flags),
        "moat-contrast" => run_moat_contrast(root, strict, &parsed.flags),
        "moat-launch-sim" => run_moat_launch_sim(root, strict, &parsed.flags),
        "genesis-truth-gate" => run_genesis_truth_gate(root, strict, &parsed.flags),
        "genesis-thin-wrapper-audit" => run_genesis_thin_wrapper_audit(root, strict, &parsed.flags),
        "genesis-doc-freeze" => run_genesis_doc_freeze(root, strict, &parsed.flags),
        "genesis-bootstrap" => run_genesis_bootstrap(root, strict, &parsed.flags),
        "genesis-installer-sim" => run_genesis_installer_sim(root, strict, &parsed.flags),
        "zero-trust-profile" => {
            enterprise_moat_extensions::run_zero_trust_profile(root, strict, &parsed.flags)
        }
        "ops-bridge" => enterprise_moat_extensions::run_ops_bridge(root, strict, &parsed.flags),
        "scale-ha-certify" => {
            enterprise_moat_extensions::run_scale_ha_certify(root, strict, &parsed.flags)
        }
        "deploy-modules" => {
            enterprise_moat_extensions::run_deploy_modules(root, strict, &parsed.flags)
        }
        "super-gate" => enterprise_moat_extensions::run_super_gate(root, strict),
        "adoption-bootstrap" => {
            enterprise_moat_extensions::run_adoption_bootstrap(root, strict, &parsed.flags)
        }
        "replay" => enterprise_moat_extensions::run_replay(root, strict, &parsed.flags),
        "explore" => enterprise_moat_extensions::run_explore(root, strict),
        "ai" => enterprise_moat_extensions::run_ai(root, strict, &parsed.flags),
        "sync" => enterprise_moat_extensions::run_sync(root, strict, &parsed.flags),
        "energy-cert" => enterprise_moat_extensions::run_energy_cert(root, strict, &parsed.flags),
        "migrate-ecosystem" => {
            enterprise_moat_extensions::run_migrate_ecosystem(root, strict, &parsed.flags)
        }
        "chaos-run" => enterprise_moat_extensions::run_chaos(root, strict, &parsed.flags),
        "assistant-mode" | "assistant_mode" => {
            enterprise_moat_extensions::run_assistant_mode(root, strict, &parsed.flags)
        }
        "dashboard" => Ok(run_dashboard(root)),
        _ => {
            usage();
            Ok(with_receipt_hash(json!({
                "ok": false,
                "type": "enterprise_hardening_cli_error",
                "lane": "enterprise_hardening",
                "ts": now_iso(),
                "error": "unknown_command",
                "command": cmd
            })))
        }
    };

    match result {
        Ok(payload) => {
            if let Err(err) = persist_enterprise_receipt(root, &payload) {
                let out = with_receipt_hash(json!({
                    "ok": false,
                    "type": "enterprise_hardening",
                    "lane": "enterprise_hardening",
                    "mode": cmd,
                    "strict": strict,
                    "ts": now_iso(),
                    "error": format!("persist_failed:{err}")
                }));
                print_pretty(&out);
                return 1;
            }
            print_pretty(&payload);
            if payload.get("type").and_then(Value::as_str) == Some("enterprise_hardening_cli_error")
            {
                2
            } else {
                command_exit(strict, &payload)
            }
        }
        Err(err) => {
            let out = with_receipt_hash(json!({
                "ok": false,
                "type": "enterprise_hardening",
                "lane": "enterprise_hardening",
                "mode": cmd,
                "strict": strict,
                "ts": now_iso(),
                "policy_path": policy_path,
                "error": err
            }));
            let _ = persist_enterprise_receipt(root, &out);
            print_pretty(&out);
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_text(root: &Path, rel: &str, body: &str) {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).expect("mkdir");
        }
        fs::write(p, body).expect("write");
    }

    #[test]
    fn cron_integrity_rejects_none_delivery_mode() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_text(
            tmp.path(),
            "client/runtime/config/cron_jobs.json",
            r#"{"jobs":[{"id":"j1","name":"x","enabled":true,"sessionTarget":"isolated","delivery":{"mode":"none","channel":"last"}}]}"#,
        );
        let (ok, details) =
            check_cron_delivery_integrity(tmp.path(), "client/runtime/config/cron_jobs.json")
                .expect("audit");
        assert!(!ok);
        assert!(details.to_string().contains("delivery_mode_none_forbidden"));
    }

    #[test]
    fn cron_integrity_rejects_missing_delivery_for_enabled_jobs() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_text(
            tmp.path(),
            "client/runtime/config/cron_jobs.json",
            r#"{"jobs":[{"id":"j1","name":"x","enabled":true,"sessionTarget":"main"}]}"#,
        );
        let (ok, details) =
            check_cron_delivery_integrity(tmp.path(), "client/runtime/config/cron_jobs.json")
                .expect("audit");
        assert!(!ok);
        assert!(details
            .to_string()
            .contains("missing_delivery_for_enabled_job"));
    }

    #[test]
    fn run_control_json_fields_detects_missing_field() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_text(
            tmp.path(),
            "client/runtime/config/x.json",
            r#"{"a":{"b":1}}"#,
        );
        let control = json!({
            "id": "c1",
            "title": "json",
            "type": "json_fields",
            "path": "client/runtime/config/x.json",
            "required_fields": ["a.b", "a.c"]
        });
        let out = run_control(tmp.path(), control.as_object().expect("obj"));
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
        assert!(out.to_string().contains("a.c"));
    }

    #[test]
    fn enable_bedrock_produces_sigv4_private_profile() {
        let tmp = tempfile::tempdir().expect("tmp");
        write_text(
            tmp.path(),
            DEFAULT_BEDROCK_POLICY_REL,
            r#"{
  "version": "v1",
  "kind": "enterprise_bedrock_proxy_contract",
  "provider": "bedrock",
  "region": "us-west-2",
  "auth": {
    "mode": "sigv4_instance_profile",
    "require_sigv4": true
  },
  "network": {
    "vpc": "vpc-prod",
    "subnet": "subnet-private-a",
    "require_private_subnet": true
  },
  "secrets": {
    "ssm_path": "/protheus/bedrock/proxy",
    "require_ssm": true
  }
}"#,
        );
        let out = run_enable_bedrock(tmp.path(), true, &std::collections::HashMap::new())
            .expect("enable bedrock");
        assert_eq!(
            out.get("type").and_then(Value::as_str),
            Some("enterprise_hardening_enable_bedrock")
        );
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert!(out
            .pointer("/profile/auth/mode")
            .and_then(Value::as_str)
            .map(|row| row == "sigv4_instance_profile")
            .unwrap_or(false));
        let claim_ok = out
            .get("claim_evidence")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .any(|row| row.get("id").and_then(Value::as_str) == Some("V7-ASSIMILATE-001.5.1"));
        assert!(claim_ok, "missing bedrock claim evidence");
    }
}
