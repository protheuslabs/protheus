// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer2/autonomy (authoritative).

use crate::{
    append_jsonl, clean_text, clamp_num, normalize_token, now_iso, read_json, resolve_runtime_path,
    round_to, write_json_atomic,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
struct EthicalPolicy {
    version: String,
    enabled: bool,
    shadow_only: bool,
    monoculture_warn_share: f64,
    high_impact_share: f64,
    maturity_min_for_prior_updates: f64,
    mirror_pressure_warn: f64,
    value_priors: BTreeMap<String, f64>,
    max_prior_delta_per_run: f64,
    weaver_latest_path: PathBuf,
    mirror_latest_path: PathBuf,
}

#[derive(Clone, Debug)]
struct RuntimePaths {
    latest_path: PathBuf,
    history_path: PathBuf,
    receipts_path: PathBuf,
    priors_state_path: PathBuf,
}

fn hash10(seed: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    hex::encode(hasher.finalize())[..10].to_string()
}

fn default_policy(root: &Path) -> EthicalPolicy {
    let mut priors = BTreeMap::new();
    priors.insert("adaptive_value".to_string(), 0.2);
    priors.insert("user_value".to_string(), 0.2);
    priors.insert("quality".to_string(), 0.2);
    priors.insert("learning".to_string(), 0.2);
    priors.insert("delivery".to_string(), 0.2);

    EthicalPolicy {
        version: "1.0".to_string(),
        enabled: true,
        shadow_only: true,
        monoculture_warn_share: 0.68,
        high_impact_share: 0.72,
        maturity_min_for_prior_updates: 0.65,
        mirror_pressure_warn: 0.55,
        value_priors: priors,
        max_prior_delta_per_run: 0.03,
        weaver_latest_path: resolve_runtime_path(
            root,
            Some("state/autonomy/weaver/latest.json"),
            "state/autonomy/weaver/latest.json",
        ),
        mirror_latest_path: resolve_runtime_path(
            root,
            Some("state/autonomy/mirror_organ/latest.json"),
            "state/autonomy/mirror_organ/latest.json",
        ),
    }
}

fn policy_path(root: &Path, explicit: Option<&Path>) -> PathBuf {
    explicit
        .map(|p| p.to_path_buf())
        .or_else(|| {
            std::env::var("ETHICAL_REASONING_POLICY_PATH")
                .ok()
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| {
            resolve_runtime_path(
                root,
                Some("config/ethical_reasoning_policy.json"),
                "config/ethical_reasoning_policy.json",
            )
        })
}

fn load_policy(root: &Path, explicit: Option<&Path>) -> EthicalPolicy {
    let mut policy = default_policy(root);
    let p = policy_path(root, explicit);
    let raw = read_json(&p);
    let obj = raw.as_object();

    if let Some(v) = obj
        .and_then(|m| m.get("version"))
        .and_then(Value::as_str)
        .map(|s| clean_text(s, 40))
    {
        if !v.is_empty() {
            policy.version = v;
        }
    }
    if let Some(v) = obj
        .and_then(|m| m.get("enabled"))
        .and_then(Value::as_bool)
    {
        policy.enabled = v;
    }
    if let Some(v) = obj
        .and_then(|m| m.get("shadow_only"))
        .and_then(Value::as_bool)
    {
        policy.shadow_only = v;
    }

    if let Some(th) = obj
        .and_then(|m| m.get("thresholds"))
        .and_then(Value::as_object)
    {
        policy.monoculture_warn_share = clamp_num(
            th.get("monoculture_warn_share")
                .and_then(Value::as_f64)
                .unwrap_or(policy.monoculture_warn_share),
            0.3,
            0.99,
            policy.monoculture_warn_share,
        );
        policy.high_impact_share = clamp_num(
            th.get("high_impact_share")
                .and_then(Value::as_f64)
                .unwrap_or(policy.high_impact_share),
            0.3,
            0.99,
            policy.high_impact_share,
        );
        policy.maturity_min_for_prior_updates = clamp_num(
            th.get("maturity_min_for_prior_updates")
                .and_then(Value::as_f64)
                .unwrap_or(policy.maturity_min_for_prior_updates),
            0.0,
            1.0,
            policy.maturity_min_for_prior_updates,
        );
        policy.mirror_pressure_warn = clamp_num(
            th.get("mirror_pressure_warn")
                .and_then(Value::as_f64)
                .unwrap_or(policy.mirror_pressure_warn),
            0.0,
            1.0,
            policy.mirror_pressure_warn,
        );
    }

    if let Some(priors) = obj
        .and_then(|m| m.get("value_priors"))
        .and_then(Value::as_object)
    {
        let mut next = BTreeMap::new();
        for (k, v) in priors {
            let key = normalize_token(k, 80);
            if key.is_empty() {
                continue;
            }
            next.insert(key, clamp_num(v.as_f64().unwrap_or(0.0), 0.0, 1.0, 0.0));
        }
        if !next.is_empty() {
            policy.value_priors = next;
        }
    }

    policy.max_prior_delta_per_run = clamp_num(
        obj.and_then(|m| m.get("max_prior_delta_per_run"))
            .and_then(Value::as_f64)
            .unwrap_or(policy.max_prior_delta_per_run),
        0.001,
        0.2,
        policy.max_prior_delta_per_run,
    );

    if let Some(integration) = obj
        .and_then(|m| m.get("integration"))
        .and_then(Value::as_object)
    {
        policy.weaver_latest_path = resolve_runtime_path(
            root,
            integration.get("weaver_latest_path").and_then(Value::as_str),
            "state/autonomy/weaver/latest.json",
        );
        policy.mirror_latest_path = resolve_runtime_path(
            root,
            integration.get("mirror_latest_path").and_then(Value::as_str),
            "state/autonomy/mirror_organ/latest.json",
        );
    }

    policy
}

fn resolve_runtime_paths(root: &Path, state_dir: Option<&Path>) -> RuntimePaths {
    let dir = state_dir
        .map(|p| p.to_path_buf())
        .or_else(|| {
            std::env::var("ETHICAL_REASONING_STATE_DIR")
                .ok()
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| {
            resolve_runtime_path(
                root,
                Some("local/state/autonomy/ethical_reasoning"),
                "local/state/autonomy/ethical_reasoning",
            )
        });

    RuntimePaths {
        latest_path: dir.join("latest.json"),
        history_path: dir.join("history.jsonl"),
        receipts_path: dir.join("tradeoff_receipts.jsonl"),
        priors_state_path: dir.join("value_priors.json"),
    }
}

fn normalize_allocations(payload: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let rows = payload
        .get("value_context")
        .and_then(|m| m.get("allocations"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    for row in rows {
        let obj = row.as_object();
        let metric_id = obj
            .and_then(|m| m.get("metric_id"))
            .and_then(Value::as_str)
            .map(|v| normalize_token(v, 80))
            .unwrap_or_default();
        if metric_id.is_empty() {
            continue;
        }
        let value_currency = obj
            .and_then(|m| m.get("value_currency"))
            .and_then(Value::as_str)
            .map(|v| normalize_token(v, 80))
            .filter(|v| !v.is_empty())
            .unwrap_or_else(|| "adaptive_value".to_string());
        let share = clamp_num(
            obj.and_then(|m| m.get("share"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            0.0,
            1.0,
            0.0,
        );
        let raw_score = clamp_num(
            obj.and_then(|m| m.get("raw_score"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0),
            -10.0,
            10.0,
            0.0,
        );
        out.push(json!({
            "metric_id": metric_id,
            "value_currency": value_currency,
            "share": share,
            "raw_score": raw_score
        }));
    }

    out.sort_by(|a, b| {
        b.get("share")
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .partial_cmp(&a.get("share").and_then(Value::as_f64).unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

fn load_priors(path: &Path, fallback: &BTreeMap<String, f64>) -> BTreeMap<String, f64> {
    let raw = read_json(path);
    let mut out = BTreeMap::new();
    if let Some(priors) = raw.get("priors").and_then(Value::as_object) {
        for (k, v) in priors {
            let key = normalize_token(k, 80);
            if key.is_empty() {
                continue;
            }
            out.insert(key, clamp_num(v.as_f64().unwrap_or(0.0), 0.0, 1.0, 0.0));
        }
    }
    if out.is_empty() {
        return fallback.clone();
    }
    out
}

fn normalize_priors(priors: &BTreeMap<String, f64>) -> BTreeMap<String, f64> {
    if priors.is_empty() {
        return BTreeMap::new();
    }
    let sum: f64 = priors.values().copied().sum();
    if sum <= 0.0 {
        let even = round_to(1.0 / priors.len() as f64, 6);
        return priors.keys().map(|k| (k.clone(), even)).collect();
    }
    priors
        .iter()
        .map(|(k, v)| (k.clone(), round_to(clamp_num(*v / sum, 0.0, 1.0, 0.0), 6)))
        .collect()
}

pub fn run_ethical_reasoning(
    root: &Path,
    input: &Value,
    explicit_policy_path: Option<&Path>,
    explicit_state_dir: Option<&Path>,
    persist: bool,
) -> Value {
    let policy = load_policy(root, explicit_policy_path);
    let paths = resolve_runtime_paths(root, explicit_state_dir);
    let ts = input
        .get("ts")
        .and_then(Value::as_str)
        .map(|v| clean_text(v, 80))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(now_iso);
    let run_id = input
        .get("run_id")
        .and_then(Value::as_str)
        .map(|v| normalize_token(v, 120))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| format!("eth_{}", hash10(&ts)));

    if !policy.enabled {
        return json!({
            "ok": false,
            "type": "ethical_reasoning_run",
            "ts": ts,
            "run_id": run_id,
            "error": "policy_disabled"
        });
    }

    let weaver_payload = input
        .get("weaver_payload")
        .cloned()
        .filter(|v| v.is_object())
        .unwrap_or_else(|| read_json(&policy.weaver_latest_path));
    let mirror_payload = input
        .get("mirror_payload")
        .cloned()
        .filter(|v| v.is_object())
        .unwrap_or_else(|| read_json(&policy.mirror_latest_path));
    let maturity_score = clamp_num(
        input
            .get("maturity_score")
            .and_then(Value::as_f64)
            .unwrap_or(0.5),
        0.0,
        1.0,
        0.5,
    );

    let allocations = normalize_allocations(&weaver_payload);
    let top = allocations.first().cloned();
    let top_share = clamp_num(
        top.as_ref()
            .and_then(|m| m.get("share"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        0.0,
        1.0,
        0.0,
    );
    let mirror_pressure = clamp_num(
        mirror_payload
            .get("pressure_score")
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        0.0,
        1.0,
        0.0,
    );

    let mut reason_codes = Vec::<String>::new();
    let mut correction_actions = Vec::<Value>::new();

    if top_share >= policy.monoculture_warn_share {
        reason_codes.push("ethical_monoculture_warning".to_string());
        correction_actions.push(json!({
            "action": "rebalance_value_allocations",
            "reason": "top_metric_share_exceeded",
            "top_metric_id": top.as_ref().and_then(|m| m.get("metric_id")).cloned().unwrap_or(Value::Null),
            "top_share": round_to(top_share, 6)
        }));
    }
    if mirror_pressure >= policy.mirror_pressure_warn {
        reason_codes.push("ethical_mirror_pressure_warning".to_string());
        correction_actions.push(json!({
            "action": "increase_reflection_weight",
            "reason": "mirror_pressure_high",
            "mirror_pressure": round_to(mirror_pressure, 6)
        }));
    }

    let mut tradeoff_receipts = Vec::<Value>::new();
    if top_share >= policy.high_impact_share {
        let alternatives: Vec<Value> = allocations
            .iter()
            .skip(1)
            .take(3)
            .map(|row| {
                json!({
                    "metric_id": row.get("metric_id").cloned().unwrap_or(Value::Null),
                    "share": row.get("share").cloned().unwrap_or(json!(0.0))
                })
            })
            .collect();
        tradeoff_receipts.push(json!({
            "receipt_id": format!("ethrcpt_{}", hash10(&format!("{}|{}|{}", run_id, top.as_ref().and_then(|m| m.get("metric_id")).and_then(Value::as_str).unwrap_or("unknown"), top_share))),
            "ts": now_iso(),
            "objective_id": input
                .get("objective_id")
                .or_else(|| weaver_payload.get("objective_id"))
                .and_then(Value::as_str)
                .map(|s| clean_text(s, 120)),
            "selected_metric_id": top.as_ref().and_then(|m| m.get("metric_id")).cloned().unwrap_or(Value::Null),
            "selected_share": round_to(top_share, 6),
            "alternatives": alternatives,
            "ethical_basis": [
                "constitution_sovereignty_preserved",
                "monoculture_checked",
                "mirror_pressure_considered"
            ],
            "high_impact": true
        }));
    }

    let current_priors = load_priors(&paths.priors_state_path, &policy.value_priors);
    let mut next_priors = current_priors.clone();
    let mut priors_updated = false;

    if maturity_score >= policy.maturity_min_for_prior_updates && !allocations.is_empty() {
        for row in &allocations {
            let key = row
                .get("metric_id")
                .and_then(Value::as_str)
                .map(|s| normalize_token(s, 80))
                .unwrap_or_default();
            if key.is_empty() {
                continue;
            }
            let current = *next_priors.get(&key).unwrap_or(&0.0);
            let target = clamp_num(
                row.get("share").and_then(Value::as_f64).unwrap_or(0.0),
                0.0,
                1.0,
                0.0,
            );
            let delta = clamp_num(
                target - current,
                -policy.max_prior_delta_per_run,
                policy.max_prior_delta_per_run,
                0.0,
            );
            let updated = round_to(current + delta, 6);
            next_priors.insert(key, updated);
            if delta.abs() > 0.0005 {
                priors_updated = true;
            }
        }
    } else {
        reason_codes.push("ethical_prior_update_maturity_gate".to_string());
    }

    let normalized_priors = normalize_priors(&next_priors);

    let summary = json!({
        "top_metric_id": top.as_ref().and_then(|m| m.get("metric_id")).cloned().unwrap_or(Value::Null),
        "top_share": round_to(top_share, 6),
        "mirror_pressure": round_to(mirror_pressure, 6),
        "maturity_score": round_to(maturity_score, 6),
        "monoculture_warning": top_share >= policy.monoculture_warn_share,
        "priors_updated": priors_updated
    });

    let payload = json!({
        "ok": true,
        "type": "ethical_reasoning_run",
        "ts": ts,
        "run_id": run_id,
        "policy": {
            "version": policy.version,
            "shadow_only": policy.shadow_only
        },
        "objective_id": input
            .get("objective_id")
            .or_else(|| weaver_payload.get("objective_id"))
            .and_then(Value::as_str)
            .map(|s| clean_text(s, 120)),
        "summary": summary,
        "reason_codes": reason_codes,
        "correction_actions": correction_actions,
        "tradeoff_receipts": tradeoff_receipts,
        "value_priors": normalized_priors
    });

    if persist {
        let _ = write_json_atomic(&paths.latest_path, &payload);
        let _ = append_jsonl(
            &paths.history_path,
            &json!({
                "ts": payload.get("ts").cloned().unwrap_or(Value::Null),
                "type": "ethical_reasoning_history",
                "run_id": payload.get("run_id").cloned().unwrap_or(Value::Null),
                "objective_id": payload.get("objective_id").cloned().unwrap_or(Value::Null),
                "reason_codes": payload.get("reason_codes").cloned().unwrap_or(json!([])),
                "top_metric_id": summary.get("top_metric_id").cloned().unwrap_or(Value::Null),
                "top_share": summary.get("top_share").cloned().unwrap_or(json!(0.0)),
                "priors_updated": summary.get("priors_updated").cloned().unwrap_or(json!(false))
            }),
        );
        if let Some(rows) = payload.get("tradeoff_receipts").and_then(Value::as_array) {
            for row in rows {
                let _ = append_jsonl(
                    &paths.receipts_path,
                    &json!({
                        "ts": payload.get("ts").cloned().unwrap_or(Value::Null),
                        "run_id": payload.get("run_id").cloned().unwrap_or(Value::Null),
                        "receipt": row
                    }),
                );
            }
        }
        if priors_updated {
            let priors_map: Map<String, Value> = normalized_priors
                .iter()
                .map(|(k, v)| (k.clone(), json!(*v)))
                .collect();
            let _ = write_json_atomic(
                &paths.priors_state_path,
                &json!({
                    "schema_id": "ethical_value_priors",
                    "schema_version": "1.0",
                    "ts": payload.get("ts").cloned().unwrap_or(Value::Null),
                    "run_id": payload.get("run_id").cloned().unwrap_or(Value::Null),
                    "priors": priors_map
                }),
            );
        }
    }

    payload
}

pub fn ethical_reasoning_status(
    root: &Path,
    explicit_policy_path: Option<&Path>,
    explicit_state_dir: Option<&Path>,
) -> Value {
    let policy = load_policy(root, explicit_policy_path);
    let paths = resolve_runtime_paths(root, explicit_state_dir);
    let latest = read_json(&paths.latest_path);
    let priors_raw = read_json(&paths.priors_state_path);

    let priors = priors_raw
        .get("priors")
        .cloned()
        .filter(|v| v.is_object())
        .unwrap_or_else(|| {
            let map: Map<String, Value> = policy
                .value_priors
                .iter()
                .map(|(k, v)| (k.clone(), json!(*v)))
                .collect();
            Value::Object(map)
        });

    json!({
        "ok": true,
        "type": "ethical_reasoning_status",
        "ts": now_iso(),
        "latest": if latest.is_null() { Value::Null } else { latest },
        "priors": priors,
        "paths": {
            "latest_path": paths.latest_path,
            "history_path": paths.history_path,
            "receipts_path": paths.receipts_path
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn ethical_run_emits_expected_flags() {
        let tmp = tempdir().expect("tmp");
        let root = tmp.path();

        let policy_path = root.join("config/ethical_reasoning_policy.json");
        let state_dir = root.join("state/autonomy/ethical_reasoning");
        let weaver_path = root.join("state/autonomy/weaver/latest.json");
        let mirror_path = root.join("state/autonomy/mirror_organ/latest.json");

        write_json_atomic(
            &policy_path,
            &json!({
                "enabled": true,
                "thresholds": {
                    "monoculture_warn_share": 0.6,
                    "high_impact_share": 0.7,
                    "maturity_min_for_prior_updates": 0.4,
                    "mirror_pressure_warn": 0.5
                },
                "max_prior_delta_per_run": 0.05,
                "integration": {
                    "weaver_latest_path": weaver_path,
                    "mirror_latest_path": mirror_path
                }
            }),
        )
        .expect("policy");

        write_json_atomic(
            &weaver_path,
            &json!({
                "run_id": "weaver_demo",
                "objective_id": "heroic_growth",
                "value_context": {
                    "allocations": [
                        { "metric_id": "revenue", "share": 0.81, "raw_score": 0.9 },
                        { "metric_id": "learning", "share": 0.11, "raw_score": 0.5 },
                        { "metric_id": "quality", "share": 0.08, "raw_score": 0.45 }
                    ]
                }
            }),
        )
        .expect("weaver");
        write_json_atomic(&mirror_path, &json!({ "pressure_score": 0.77 })).expect("mirror");

        let out = run_ethical_reasoning(
            root,
            &json!({ "objective_id": "heroic_growth", "maturity_score": 0.9 }),
            Some(&policy_path),
            Some(&state_dir),
            true,
        );

        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        let reasons = out
            .get("reason_codes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(reasons
            .iter()
            .any(|v| v.as_str() == Some("ethical_monoculture_warning")));
        assert!(reasons
            .iter()
            .any(|v| v.as_str() == Some("ethical_mirror_pressure_warning")));
        assert!(out
            .get("tradeoff_receipts")
            .and_then(Value::as_array)
            .map(|v| !v.is_empty())
            .unwrap_or(false));
        assert_eq!(
            out.get("summary")
                .and_then(Value::as_object)
                .and_then(|m| m.get("priors_updated"))
                .and_then(Value::as_bool),
            Some(true)
        );

        let status = ethical_reasoning_status(root, Some(&policy_path), Some(&state_dir));
        assert_eq!(status.get("ok").and_then(Value::as_bool), Some(true));
        assert!(status.get("priors").map(Value::is_object).unwrap_or(false));
    }
}
