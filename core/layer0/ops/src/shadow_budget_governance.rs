// SPDX-License-Identifier: Apache-2.0
use crate::{clean, deterministic_receipt_hash, now_iso, parse_args};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

const POLICY_REL: &str = "client/config/shadow_budget_governance_policy.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ShadowOverride {
    token_budget: u64,
    compute_budget_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Policy {
    schema_id: String,
    schema_version: String,
    global_token_budget: u64,
    global_compute_budget_ms: u64,
    system_reserved_token_budget: u64,
    system_reserved_compute_budget_ms: u64,
    default_shadow_token_budget: u64,
    default_shadow_compute_budget_ms: u64,
    burst_multiplier: f64,
    shadow_overrides: HashMap<String, ShadowOverride>,
    state_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct UsageState {
    schema_id: String,
    schema_version: String,
    shadows: HashMap<String, ShadowUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct ShadowUsage {
    tokens_used: u64,
    compute_used_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum DecisionKind {
    Allow,
    DegradedAllow,
    Deny,
}

impl DecisionKind {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::DegradedAllow => "degraded_allow",
            Self::Deny => "deny",
        }
    }
}

pub fn run(root: &Path, args: &[String]) -> i32 {
    let parsed = parse_args(args);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "evaluate".to_string());

    match cmd.as_str() {
        "evaluate" => evaluate(root, &parsed),
        "status" => status(root, &parsed),
        _ => {
            print_json(&json!({
                "ok": false,
                "type": "shadow_budget_governance",
                "error": "unknown_command",
                "command": cmd
            }));
            1
        }
    }
}

fn evaluate(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let policy_path = parsed
        .flags
        .get("policy")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(POLICY_REL));
    let apply = parse_bool(parsed.flags.get("apply").map(String::as_str), true);
    let shadow_id = clean(
        parsed
            .flags
            .get("shadow-id")
            .map(String::as_str)
            .unwrap_or("unknown_shadow"),
        96,
    );
    let requested_tokens = parse_u64(parsed.flags.get("requested-tokens").map(String::as_str), 0);
    let requested_compute_ms = parse_u64(
        parsed.flags.get("requested-compute-ms").map(String::as_str),
        0,
    );

    if shadow_id.is_empty() {
        print_json(&error_receipt("shadow_id_missing"));
        return 1;
    }

    let policy = match load_policy(&policy_path) {
        Ok(value) => value,
        Err(err) => {
            print_json(&error_receipt(&format!("policy_load_failed:{err}")));
            return 1;
        }
    };
    let state_path = resolve_state_path(root, &policy.state_path);
    let mut state = load_state(&state_path).unwrap_or_default();
    if state.schema_id.is_empty() {
        state.schema_id = "shadow_budget_governance_state".to_string();
    }
    if state.schema_version.is_empty() {
        state.schema_version = "1.0".to_string();
    }

    let current = state.shadows.get(&shadow_id).cloned().unwrap_or_default();
    let effective = effective_budget(&policy, &shadow_id);
    let burst_tokens = ((effective.token_budget as f64) * policy.burst_multiplier).round() as u64;
    let burst_compute =
        ((effective.compute_budget_ms as f64) * policy.burst_multiplier).round() as u64;

    let projected_shadow_tokens = current.tokens_used.saturating_add(requested_tokens);
    let projected_shadow_compute = current.compute_used_ms.saturating_add(requested_compute_ms);

    let global = aggregate_global_usage(&state);
    let projected_global_tokens = global.tokens_used.saturating_add(requested_tokens);
    let projected_global_compute = global.compute_used_ms.saturating_add(requested_compute_ms);

    let reserve_tokens_ok = projected_global_tokens
        .saturating_add(policy.system_reserved_token_budget)
        <= policy.global_token_budget;
    let reserve_compute_ok = projected_global_compute
        .saturating_add(policy.system_reserved_compute_budget_ms)
        <= policy.global_compute_budget_ms;

    let (decision, reason) = if !reserve_tokens_ok || !reserve_compute_ok {
        (
            DecisionKind::Deny,
            "system_reserve_protection_triggered".to_string(),
        )
    } else if projected_shadow_tokens <= effective.token_budget
        && projected_shadow_compute <= effective.compute_budget_ms
    {
        (DecisionKind::Allow, "within_shadow_quota".to_string())
    } else if projected_shadow_tokens <= burst_tokens && projected_shadow_compute <= burst_compute {
        (
            DecisionKind::DegradedAllow,
            "within_burst_window_requires_degraded_mode".to_string(),
        )
    } else {
        (DecisionKind::Deny, "shadow_quota_exceeded".to_string())
    };

    if apply && decision != DecisionKind::Deny {
        let next = ShadowUsage {
            tokens_used: projected_shadow_tokens,
            compute_used_ms: projected_shadow_compute,
        };
        state.shadows.insert(shadow_id.clone(), next);
        if let Err(err) = write_state(&state_path, &state) {
            print_json(&error_receipt(&format!("state_write_failed:{err}")));
            return 1;
        }
    }

    let ts = now_iso();
    let mut receipt = json!({
        "ok": decision != DecisionKind::Deny,
        "type": "shadow_budget_governance",
        "schema_id": "shadow_budget_governance_receipt",
        "schema_version": "1.0",
        "ts": ts,
        "date": ts[..10].to_string(),
        "command": "evaluate",
        "shadow_id": shadow_id,
        "apply": apply,
        "decision": decision.as_str(),
        "reason": reason,
        "request": {
            "requested_tokens": requested_tokens,
            "requested_compute_ms": requested_compute_ms
        },
        "budgets": {
            "effective_token_budget": effective.token_budget,
            "effective_compute_budget_ms": effective.compute_budget_ms,
            "burst_token_budget": burst_tokens,
            "burst_compute_budget_ms": burst_compute
        },
        "usage": {
            "current_tokens": current.tokens_used,
            "current_compute_ms": current.compute_used_ms,
            "projected_tokens": projected_shadow_tokens,
            "projected_compute_ms": projected_shadow_compute
        },
        "global": {
            "current_tokens": global.tokens_used,
            "current_compute_ms": global.compute_used_ms,
            "projected_tokens": projected_global_tokens,
            "projected_compute_ms": projected_global_compute,
            "reserve_tokens_ok": reserve_tokens_ok,
            "reserve_compute_ok": reserve_compute_ok
        },
        "policy": {
            "path": policy_path.to_string_lossy().to_string(),
            "state_path": state_path.to_string_lossy().to_string()
        },
        "claim_evidence": [
            {
                "id": "per_shadow_budget_governance_receipt",
                "claim": "shadow_budget_decisions_are_enforced_with_receipted_policy_and_fairness_metadata",
                "evidence": {
                    "decision": decision.as_str(),
                    "reason": reason,
                    "reserve_tokens_ok": reserve_tokens_ok,
                    "reserve_compute_ok": reserve_compute_ok
                }
            }
        ]
    });
    receipt["receipt_hash"] = Value::String(deterministic_receipt_hash(&receipt));
    print_json(&receipt);

    if decision == DecisionKind::Deny { 1 } else { 0 }
}

fn status(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let policy_path = parsed
        .flags
        .get("policy")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(POLICY_REL));
    let policy = match load_policy(&policy_path) {
        Ok(value) => value,
        Err(err) => {
            print_json(&error_receipt(&format!("policy_load_failed:{err}")));
            return 1;
        }
    };
    let state_path = resolve_state_path(root, &policy.state_path);
    let state = load_state(&state_path).unwrap_or_default();
    let global = aggregate_global_usage(&state);
    let mut out = json!({
        "ok": true,
        "type": "shadow_budget_governance_status",
        "policy_path": policy_path.to_string_lossy().to_string(),
        "state_path": state_path.to_string_lossy().to_string(),
        "shadow_count": state.shadows.len(),
        "global_usage": {
            "tokens_used": global.tokens_used,
            "compute_used_ms": global.compute_used_ms
        },
        "global_budget": {
            "tokens": policy.global_token_budget,
            "compute_ms": policy.global_compute_budget_ms
        },
        "system_reserved": {
            "tokens": policy.system_reserved_token_budget,
            "compute_ms": policy.system_reserved_compute_budget_ms
        }
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    print_json(&out);
    0
}

fn parse_bool(raw: Option<&str>, fallback: bool) -> bool {
    let Some(value) = raw else {
        return fallback;
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn parse_u64(raw: Option<&str>, fallback: u64) -> u64 {
    raw.and_then(|v| v.trim().parse::<u64>().ok()).unwrap_or(fallback)
}

fn load_policy(path: &Path) -> Result<Policy, String> {
    let raw = fs::read_to_string(path).map_err(|err| format!("read_failed:{err}"))?;
    serde_json::from_str(&raw).map_err(|err| format!("decode_failed:{err}"))
}

fn resolve_state_path(root: &Path, configured: &str) -> PathBuf {
    let path = PathBuf::from(configured);
    if path.is_absolute() { path } else { root.join(path) }
}

fn load_state(path: &Path) -> Option<UsageState> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<UsageState>(&raw).ok()
}

fn write_state(path: &Path, state: &UsageState) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("mkdir_failed:{err}"))?;
    }
    let encoded =
        serde_json::to_string_pretty(state).map_err(|err| format!("encode_failed:{err}"))?;
    fs::write(path, format!("{encoded}\n")).map_err(|err| format!("write_failed:{err}"))
}

fn effective_budget(policy: &Policy, shadow_id: &str) -> ShadowOverride {
    policy
        .shadow_overrides
        .get(shadow_id)
        .cloned()
        .unwrap_or(ShadowOverride {
            token_budget: policy.default_shadow_token_budget,
            compute_budget_ms: policy.default_shadow_compute_budget_ms,
        })
}

fn aggregate_global_usage(state: &UsageState) -> ShadowUsage {
    let mut tokens = 0u64;
    let mut compute = 0u64;
    for usage in state.shadows.values() {
        tokens = tokens.saturating_add(usage.tokens_used);
        compute = compute.saturating_add(usage.compute_used_ms);
    }
    ShadowUsage {
        tokens_used: tokens,
        compute_used_ms: compute,
    }
}

fn error_receipt(error: &str) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "shadow_budget_governance",
        "error": error
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value).unwrap_or_else(|_| "{}".to_string())
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn write_policy(root: &Path) -> PathBuf {
        let policy_path = root.join("policy.json");
        let policy = json!({
            "schema_id": "shadow_budget_governance_policy",
            "schema_version": "1.0",
            "global_token_budget": 1000,
            "global_compute_budget_ms": 1000,
            "system_reserved_token_budget": 200,
            "system_reserved_compute_budget_ms": 200,
            "default_shadow_token_budget": 300,
            "default_shadow_compute_budget_ms": 300,
            "burst_multiplier": 1.5,
            "shadow_overrides": {
                "system_critical": {
                    "token_budget": 600,
                    "compute_budget_ms": 600
                }
            },
            "state_path": "state/ops/shadow_budget_governance/usage.json"
        });
        fs::write(
            &policy_path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&policy).expect("policy encode")
            ),
        )
        .expect("policy write");
        policy_path
    }

    #[test]
    fn evaluate_allows_within_quota() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        let policy = write_policy(root);
        let args = vec![
            "evaluate".to_string(),
            format!("--policy={}", policy.to_string_lossy()),
            "--shadow-id=research_shadow".to_string(),
            "--requested-tokens=100".to_string(),
            "--requested-compute-ms=100".to_string(),
            "--apply=1".to_string(),
        ];
        let exit = run(root, &args);
        assert_eq!(exit, 0);
    }

    #[test]
    fn evaluate_degrades_within_burst_window() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        let policy = write_policy(root);
        let args = vec![
            "evaluate".to_string(),
            format!("--policy={}", policy.to_string_lossy()),
            "--shadow-id=research_shadow".to_string(),
            "--requested-tokens=430".to_string(),
            "--requested-compute-ms=430".to_string(),
            "--apply=1".to_string(),
        ];
        let exit = run(root, &args);
        assert_eq!(exit, 0);

        let state_path = root.join("state/ops/shadow_budget_governance/usage.json");
        let state_raw = fs::read_to_string(&state_path).expect("state");
        let state: UsageState = serde_json::from_str(&state_raw).expect("decode");
        let usage = state
            .shadows
            .get("research_shadow")
            .expect("shadow usage");
        assert_eq!(usage.tokens_used, 430);
    }

    #[test]
    fn evaluate_denies_when_reserve_would_be_violated() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        let policy = write_policy(root);
        let args = vec![
            "evaluate".to_string(),
            format!("--policy={}", policy.to_string_lossy()),
            "--shadow-id=research_shadow".to_string(),
            "--requested-tokens=900".to_string(),
            "--requested-compute-ms=900".to_string(),
            "--apply=1".to_string(),
        ];
        let exit = run(root, &args);
        assert_eq!(exit, 1);
    }
}
