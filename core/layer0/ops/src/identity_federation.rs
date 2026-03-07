// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso, parse_args};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const LANE_ID: &str = "identity_federation";
const DEFAULT_POLICY_REL: &str = "client/config/identity_federation_policy.json";

#[derive(Debug, Clone)]
struct ProviderPolicy {
    allowed_scopes: BTreeSet<String>,
    issuer_prefix: String,
    allowed_roles: BTreeSet<String>,
    scim_enabled: bool,
}

#[derive(Debug, Clone)]
struct Policy {
    strict_default: bool,
    providers: BTreeMap<String, ProviderPolicy>,
    latest_path: PathBuf,
    history_path: PathBuf,
    policy_path: PathBuf,
}

fn usage() {
    println!("Usage:");
    println!(
        "  protheus-ops identity-federation authorize --provider=<id> --subject=<id> --token-issuer=<url> --scopes=a,b [--roles=r1,r2] [--policy=<path>]"
    );
    println!(
        "  protheus-ops identity-federation scim-lifecycle --provider=<id> --operation=<create|update|delete> --user-id=<id> [--entitlements=e1,e2] [--policy=<path>]"
    );
    println!("  protheus-ops identity-federation status [--policy=<path>]");
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

fn split_csv(raw: &str) -> BTreeSet<String> {
    raw.split(',')
        .map(|v| v.trim().to_ascii_lowercase())
        .filter(|v| !v.is_empty())
        .collect::<BTreeSet<_>>()
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

fn load_policy(root: &Path, policy_override: Option<&String>) -> Policy {
    let policy_path = policy_override
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(DEFAULT_POLICY_REL));

    let raw = fs::read_to_string(&policy_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}));

    let mut providers = BTreeMap::new();
    if let Some(entries) = raw.get("providers").and_then(Value::as_object) {
        for (id, row) in entries {
            let Some(obj) = row.as_object() else {
                continue;
            };
            let allowed_scopes = obj
                .get("allowed_scopes")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(|v| v.trim().to_ascii_lowercase())
                        .filter(|v| !v.is_empty())
                        .collect::<BTreeSet<_>>()
                })
                .unwrap_or_default();

            let allowed_roles = obj
                .get("allowed_roles")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(|v| v.trim().to_ascii_lowercase())
                        .filter(|v| !v.is_empty())
                        .collect::<BTreeSet<_>>()
                })
                .unwrap_or_default();

            let issuer_prefix = obj
                .get("issuer_prefix")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();

            providers.insert(
                id.to_ascii_lowercase(),
                ProviderPolicy {
                    allowed_scopes,
                    issuer_prefix,
                    allowed_roles,
                    scim_enabled: obj
                        .get("scim_enabled")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                },
            );
        }
    }

    if providers.is_empty() {
        providers.insert(
            "okta".to_string(),
            ProviderPolicy {
                allowed_scopes: split_csv("openid,profile,email,groups,offline_access,protheus.read,protheus.write"),
                issuer_prefix: "https://".to_string(),
                allowed_roles: split_csv("operator,admin,security,auditor"),
                scim_enabled: true,
            },
        );
    }

    let outputs = raw.get("outputs").and_then(Value::as_object);
    Policy {
        strict_default: raw
            .get("strict_default")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        providers,
        latest_path: resolve_path(
            root,
            outputs
                .and_then(|o| o.get("latest_path"))
                .and_then(Value::as_str),
            "state/ops/identity_federation/latest.json",
        ),
        history_path: resolve_path(
            root,
            outputs
                .and_then(|o| o.get("history_path"))
                .and_then(Value::as_str),
            "state/ops/identity_federation/history.jsonl",
        ),
        policy_path,
    }
}

fn persist(policy: &Policy, payload: &Value) -> Result<(), String> {
    write_text_atomic(
        &policy.latest_path,
        &format!(
            "{}\n",
            serde_json::to_string_pretty(payload).map_err(|e| format!("encode_latest_failed:{e}"))?
        ),
    )?;
    append_jsonl(&policy.history_path, payload)
}

fn provider_lookup<'a>(policy: &'a Policy, raw: &str) -> Option<(&'a str, &'a ProviderPolicy)> {
    let key = raw.trim().to_ascii_lowercase();
    policy
        .providers
        .get_key_value(&key)
        .map(|(k, v)| (k.as_str(), v))
}

fn run_authorize(policy: &Policy, flags: &std::collections::HashMap<String, String>) -> Value {
    let provider_raw = flags.get("provider").map(String::as_str).unwrap_or("");
    let subject = flags
        .get("subject")
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let issuer = flags
        .get("token-issuer")
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let scopes = flags
        .get("scopes")
        .map(|v| split_csv(v))
        .unwrap_or_default();
    let roles = flags
        .get("roles")
        .map(|v| split_csv(v))
        .unwrap_or_default();

    let mut checks = BTreeMap::<String, Value>::new();

    let provider = provider_lookup(policy, provider_raw);
    checks.insert(
        "provider_supported".to_string(),
        json!({ "ok": provider.is_some(), "provider": provider_raw }),
    );

    let subject_ok = !subject.is_empty();
    checks.insert(
        "subject_present".to_string(),
        json!({ "ok": subject_ok, "subject": subject }),
    );

    let issuer_ok = provider
        .map(|(_, p)| !p.issuer_prefix.is_empty() && issuer.starts_with(&p.issuer_prefix))
        .unwrap_or(false);
    checks.insert(
        "issuer_prefix_match".to_string(),
        json!({ "ok": issuer_ok, "issuer": issuer }),
    );

    let scopes_ok = provider
        .map(|(_, p)| scopes.iter().all(|s| p.allowed_scopes.contains(s)))
        .unwrap_or(false);
    checks.insert(
        "scope_allowlist".to_string(),
        json!({ "ok": scopes_ok, "scopes": scopes }),
    );

    let roles_ok = provider
        .map(|(_, p)| roles.is_empty() || roles.iter().all(|r| p.allowed_roles.contains(r)))
        .unwrap_or(false);
    checks.insert(
        "role_allowlist".to_string(),
        json!({ "ok": roles_ok, "roles": roles }),
    );

    let blocking = checks
        .iter()
        .filter_map(|(k, v)| {
            if v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                None
            } else {
                Some(k.clone())
            }
        })
        .collect::<Vec<_>>();
    let ok = blocking.is_empty();

    json!({
        "ok": ok,
        "type": "identity_federation_authorize",
        "lane": LANE_ID,
        "schema_id": "identity_federation_authorize",
        "schema_version": "1.0",
        "ts": now_iso(),
        "provider": provider.map(|(id, _)| id).unwrap_or(""),
        "checks": checks,
        "blocking_checks": blocking,
        "claim_evidence": [
            {
                "id": "identity_federation_fail_closed_authorization",
                "claim": "unsupported_identity_provider_or_scope_is_rejected_before_runtime_access",
                "evidence": {
                    "provider_supported": provider.is_some(),
                    "subject_present": subject_ok,
                    "issuer_prefix_match": issuer_ok,
                    "scope_allowlist": scopes_ok,
                    "role_allowlist": roles_ok
                }
            }
        ]
    })
}

fn run_scim(policy: &Policy, flags: &std::collections::HashMap<String, String>) -> Value {
    let provider_raw = flags.get("provider").map(String::as_str).unwrap_or("");
    let operation = flags
        .get("operation")
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    let user_id = flags
        .get("user-id")
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    let entitlements = flags
        .get("entitlements")
        .map(|v| split_csv(v))
        .unwrap_or_default();

    let provider = provider_lookup(policy, provider_raw);

    let mut checks = BTreeMap::<String, Value>::new();
    checks.insert(
        "provider_supported".to_string(),
        json!({ "ok": provider.is_some(), "provider": provider_raw }),
    );

    let operation_ok = matches!(operation.as_str(), "create" | "update" | "delete");
    checks.insert(
        "operation_supported".to_string(),
        json!({ "ok": operation_ok, "operation": operation }),
    );

    checks.insert(
        "user_id_present".to_string(),
        json!({ "ok": !user_id.is_empty(), "user_id": user_id }),
    );

    let scim_enabled = provider.map(|(_, p)| p.scim_enabled).unwrap_or(false);
    checks.insert(
        "scim_enabled_for_provider".to_string(),
        json!({ "ok": scim_enabled }),
    );

    let delete_payload_ok = if operation == "delete" {
        entitlements.is_empty()
    } else {
        true
    };
    checks.insert(
        "delete_payload_contract".to_string(),
        json!({ "ok": delete_payload_ok, "entitlements": entitlements }),
    );

    let blocking = checks
        .iter()
        .filter_map(|(k, v)| {
            if v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                None
            } else {
                Some(k.clone())
            }
        })
        .collect::<Vec<_>>();
    let ok = blocking.is_empty();

    json!({
        "ok": ok,
        "type": "identity_federation_scim_lifecycle",
        "lane": LANE_ID,
        "schema_id": "identity_federation_scim_lifecycle",
        "schema_version": "1.0",
        "ts": now_iso(),
        "provider": provider.map(|(id, _)| id).unwrap_or(""),
        "checks": checks,
        "blocking_checks": blocking,
        "claim_evidence": [
            {
                "id": "scim_lifecycle_fail_closed",
                "claim": "scim_lifecycle_actions_require_supported_provider_and_contract_safe_payload",
                "evidence": {
                    "provider_supported": provider.is_some(),
                    "operation_supported": operation_ok,
                    "scim_enabled": scim_enabled,
                    "delete_payload_ok": delete_payload_ok
                }
            }
        ]
    })
}

fn status(policy: &Policy) -> Value {
    let latest = fs::read_to_string(&policy.latest_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .unwrap_or_else(|| json!({ "ok": false, "error": "latest_missing" }));

    let mut out = json!({
        "ok": latest.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "type": "identity_federation_status",
        "lane": LANE_ID,
        "ts": now_iso(),
        "policy_path": policy.policy_path,
        "latest_path": policy.latest_path,
        "history_path": policy.history_path,
        "latest": latest
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn cli_error(argv: &[String], err: &str, code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "identity_federation_cli_error",
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

    if matches!(cmd.as_str(), "--help" | "-h" | "help") {
        usage();
        return 0;
    }

    let policy = load_policy(root, parsed.flags.get("policy"));
    let strict = parsed
        .flags
        .get("strict")
        .map(|v| matches!(v.as_str(), "1" | "true" | "yes" | "on"))
        .unwrap_or(policy.strict_default);

    let payload = match cmd.as_str() {
        "authorize" => run_authorize(&policy, &parsed.flags),
        "scim-lifecycle" => run_scim(&policy, &parsed.flags),
        "status" => {
            let out = status(&policy);
            println!("{}", serde_json::to_string(&out).unwrap_or_else(|_| "{}".to_string()));
            return 0;
        }
        _ => {
            usage();
            let out = cli_error(argv, "unknown_command", 2);
            println!("{}", serde_json::to_string(&out).unwrap_or_else(|_| "{}".to_string()));
            return 2;
        }
    };

    let mut out = payload;
    out["policy_path"] = Value::String(policy.policy_path.to_string_lossy().to_string());
    out["strict"] = Value::Bool(strict);
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));

    if let Err(err) = persist(&policy, &out) {
        let fail = cli_error(argv, &format!("persist_failed:{err}"), 1);
        println!("{}", serde_json::to_string(&fail).unwrap_or_else(|_| "{}".to_string()));
        return 1;
    }

    println!("{}", serde_json::to_string(&out).unwrap_or_else(|_| "{}".to_string()));
    if strict && !out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        1
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_text(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("mkdir");
        }
        fs::write(path, text).expect("write");
    }

    fn write_policy(root: &Path) {
        write_text(
            &root.join("client/config/identity_federation_policy.json"),
            &json!({
                "strict_default": true,
                "providers": {
                    "okta": {
                        "issuer_prefix": "https://okta.example.com",
                        "allowed_scopes": ["openid", "profile", "protheus.read"],
                        "allowed_roles": ["operator", "security"],
                        "scim_enabled": true
                    }
                },
                "outputs": {
                    "latest_path": "state/ops/identity_federation/latest.json",
                    "history_path": "state/ops/identity_federation/history.jsonl"
                }
            })
            .to_string(),
        );
    }

    #[test]
    fn authorize_fails_closed_on_unknown_scope() {
        let tmp = tempdir().expect("tmp");
        write_policy(tmp.path());

        let code = run(
            tmp.path(),
            &[
                "authorize".to_string(),
                "--provider=okta".to_string(),
                "--subject=user-1".to_string(),
                "--token-issuer=https://okta.example.com/oauth2/default".to_string(),
                "--scopes=openid,unknown.scope".to_string(),
                "--strict=1".to_string(),
            ],
        );
        assert_eq!(code, 1);
    }

    #[test]
    fn scim_delete_requires_empty_entitlements() {
        let tmp = tempdir().expect("tmp");
        write_policy(tmp.path());

        let code = run(
            tmp.path(),
            &[
                "scim-lifecycle".to_string(),
                "--provider=okta".to_string(),
                "--operation=delete".to_string(),
                "--user-id=user-1".to_string(),
                "--entitlements=team.alpha".to_string(),
                "--strict=1".to_string(),
            ],
        );
        assert_eq!(code, 1);
    }
}
