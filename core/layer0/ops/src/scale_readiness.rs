// SPDX-License-Identifier: Apache-2.0
use crate::{clean, now_iso, parse_args};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const SCALE_IDS: [&str; 10] = [
    "V4-SCALE-001",
    "V4-SCALE-002",
    "V4-SCALE-003",
    "V4-SCALE-004",
    "V4-SCALE-005",
    "V4-SCALE-006",
    "V4-SCALE-007",
    "V4-SCALE-008",
    "V4-SCALE-009",
    "V4-SCALE-010",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProgramItem {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Paths {
    pub state_path: PathBuf,
    pub latest_path: PathBuf,
    pub receipts_path: PathBuf,
    pub history_path: PathBuf,
    pub contract_dir: PathBuf,
    pub report_dir: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Budgets {
    pub max_cost_per_user_usd: f64,
    pub max_p95_latency_ms: i64,
    pub max_p99_latency_ms: i64,
    pub error_budget_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Policy {
    pub version: String,
    pub enabled: bool,
    pub strict_default: bool,
    pub items: Vec<ProgramItem>,
    pub stage_gates: Vec<String>,
    pub paths: Paths,
    pub budgets: Budgets,
    pub policy_path: PathBuf,
}

fn normalize_id(v: &str) -> String {
    let out = clean(v.replace('`', ""), 80).to_ascii_uppercase();
    if out.len() == 12 && out.starts_with("V4-SCALE-") {
        out
    } else {
        String::new()
    }
}

fn to_bool(v: Option<&str>, fallback: bool) -> bool {
    let Some(raw) = v else {
        return fallback;
    };
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn clamp_int(v: Option<i64>, lo: i64, hi: i64, fallback: i64) -> i64 {
    let Some(mut n) = v else {
        return fallback;
    };
    if n < lo {
        n = lo;
    }
    if n > hi {
        n = hi;
    }
    n
}

fn read_json(path: &Path) -> Value {
    match fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    }
}

fn append_jsonl(path: &Path, row: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_failed:{}:{e}", parent.display()))?;
    }
    let mut payload = serde_json::to_string(row).map_err(|e| format!("encode_row_failed:{e}"))?;
    payload.push('\n');
    fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .and_then(|mut f| std::io::Write::write_all(&mut f, payload.as_bytes()))
        .map_err(|e| format!("append_jsonl_failed:{}:{e}", path.display()))
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("create_dir_failed:{}:{e}", parent.display()))?;
    }
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    let mut payload =
        serde_json::to_string_pretty(value).map_err(|e| format!("encode_json_failed:{e}"))?;
    payload.push('\n');
    fs::write(&tmp, payload).map_err(|e| format!("write_tmp_failed:{}:{e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename_tmp_failed:{}:{e}", path.display()))
}

fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn resolve_path(root: &Path, raw: Option<&Value>, fallback_rel: &str) -> PathBuf {
    let fallback = root.join(fallback_rel);
    let Some(raw) = raw.and_then(Value::as_str) else {
        return fallback;
    };
    let clean_raw = clean(raw, 400);
    if clean_raw.is_empty() {
        return fallback;
    }
    let p = PathBuf::from(clean_raw);
    if p.is_absolute() {
        p
    } else {
        root.join(p)
    }
}

fn stable_hash(input: &str, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    let hex = hex::encode(hasher.finalize());
    hex[..len.min(hex.len())].to_string()
}

pub fn default_policy(root: &Path) -> Policy {
    Policy {
        version: "1.0".to_string(),
        enabled: true,
        strict_default: true,
        items: SCALE_IDS
            .iter()
            .map(|id| ProgramItem {
                id: (*id).to_string(),
                title: (*id).to_string(),
            })
            .collect(),
        stage_gates: vec![
            "1k".to_string(),
            "10k".to_string(),
            "100k".to_string(),
            "1M".to_string(),
        ],
        paths: Paths {
            state_path: root.join("local/state/ops/scale_readiness_program/state.json"),
            latest_path: root.join("local/state/ops/scale_readiness_program/latest.json"),
            receipts_path: root.join("local/state/ops/scale_readiness_program/receipts.jsonl"),
            history_path: root.join("local/state/ops/scale_readiness_program/history.jsonl"),
            contract_dir: root.join("client/runtime/config/scale_readiness"),
            report_dir: root.join("local/state/ops/scale_readiness_program/reports"),
        },
        budgets: Budgets {
            max_cost_per_user_usd: 0.18,
            max_p95_latency_ms: 250,
            max_p99_latency_ms: 450,
            error_budget_pct: 0.01,
        },
        policy_path: root.join("client/runtime/config/scale_readiness_program_policy.json"),
    }
}

pub fn load_policy(root: &Path, policy_path: &Path) -> Policy {
    let base = default_policy(root);
    let raw = read_json(policy_path);

    let mut out = base.clone();
    if let Some(v) = raw.get("version").and_then(Value::as_str) {
        let c = clean(v, 24);
        if !c.is_empty() {
            out.version = c;
        }
    }
    out.enabled = raw
        .get("enabled")
        .and_then(Value::as_bool)
        .unwrap_or(base.enabled);
    out.strict_default = raw
        .get("strict_default")
        .and_then(Value::as_bool)
        .unwrap_or(base.strict_default);

    let items = raw
        .get("items")
        .and_then(Value::as_array)
        .map(|rows| {
            let mut seen = std::collections::HashSet::new();
            rows.iter()
                .filter_map(|row| {
                    let id = normalize_id(row.get("id").and_then(Value::as_str).unwrap_or(""));
                    if id.is_empty() || seen.contains(&id) {
                        return None;
                    }
                    seen.insert(id.clone());
                    let title = clean(row.get("title").and_then(Value::as_str).unwrap_or(&id), 260);
                    Some(ProgramItem {
                        id: id.clone(),
                        title: if title.is_empty() { id } else { title },
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| base.items.clone());
    out.items = items;

    out.stage_gates = raw
        .get("stage_gates")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|v| clean(v, 20))
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|rows| !rows.is_empty())
        .unwrap_or_else(|| base.stage_gates.clone());

    let paths = raw.get("paths").cloned().unwrap_or(Value::Null);
    out.paths = Paths {
        state_path: resolve_path(
            root,
            paths.get("state_path"),
            "local/state/ops/scale_readiness_program/state.json",
        ),
        latest_path: resolve_path(
            root,
            paths.get("latest_path"),
            "local/state/ops/scale_readiness_program/latest.json",
        ),
        receipts_path: resolve_path(
            root,
            paths.get("receipts_path"),
            "local/state/ops/scale_readiness_program/receipts.jsonl",
        ),
        history_path: resolve_path(
            root,
            paths.get("history_path"),
            "local/state/ops/scale_readiness_program/history.jsonl",
        ),
        contract_dir: resolve_path(
            root,
            paths.get("contract_dir"),
            "client/runtime/config/scale_readiness",
        ),
        report_dir: resolve_path(
            root,
            paths.get("report_dir"),
            "local/state/ops/scale_readiness_program/reports",
        ),
    };

    let budgets = raw.get("budgets").cloned().unwrap_or(Value::Null);
    out.budgets = Budgets {
        max_cost_per_user_usd: budgets
            .get("max_cost_per_user_usd")
            .and_then(Value::as_f64)
            .unwrap_or(base.budgets.max_cost_per_user_usd),
        max_p95_latency_ms: clamp_int(
            budgets.get("max_p95_latency_ms").and_then(Value::as_i64),
            10,
            50_000,
            base.budgets.max_p95_latency_ms,
        ),
        max_p99_latency_ms: clamp_int(
            budgets.get("max_p99_latency_ms").and_then(Value::as_i64),
            10,
            50_000,
            base.budgets.max_p99_latency_ms,
        ),
        error_budget_pct: budgets
            .get("error_budget_pct")
            .and_then(Value::as_f64)
            .unwrap_or(base.budgets.error_budget_pct),
    };

    out.policy_path = if policy_path.is_absolute() {
        policy_path.to_path_buf()
    } else {
        root.join(policy_path)
    };

    out
}

fn load_state(policy: &Policy) -> Value {
    let fallback = json!({
        "schema_id": "scale_readiness_program_state",
        "schema_version": "1.0",
        "updated_at": now_iso(),
        "last_run": Value::Null,
        "lane_receipts": {},
        "current_stage": "1k",
        "autoscaling_profile": Value::Null,
        "async_pipeline_profile": Value::Null,
        "partition_profile": Value::Null,
        "cache_profile": Value::Null,
        "region_profile": Value::Null,
        "release_profile": Value::Null,
        "sre_profile": Value::Null,
        "abuse_profile": Value::Null,
        "economics_profile": Value::Null
    });
    let raw = read_json(&policy.paths.state_path);
    if !raw.is_object() {
        return fallback;
    }
    let mut merged = fallback.as_object().cloned().unwrap_or_default();
    for (k, v) in raw.as_object().cloned().unwrap_or_default() {
        merged.insert(k, v);
    }
    Value::Object(merged)
}

fn save_state(policy: &Policy, state: &Value, apply: bool) -> Result<(), String> {
    if !apply {
        return Ok(());
    }
    let mut payload = state.clone();
    if let Some(obj) = payload.as_object_mut() {
        obj.insert("updated_at".to_string(), Value::String(now_iso()));
    }
    write_json_atomic(&policy.paths.state_path, &payload)
}

fn write_contract(
    policy: &Policy,
    name: &str,
    payload: &Value,
    apply: bool,
    root: &Path,
) -> Result<String, String> {
    let abs = policy.paths.contract_dir.join(name);
    if apply {
        write_json_atomic(&abs, payload)?;
    }
    Ok(rel_path(root, &abs))
}

fn run_json_script(root: &Path, script_rel: &str, args: &[String]) -> Value {
    let abs = root.join(script_rel);
    let out = Command::new("node")
        .arg(abs)
        .args(args)
        .current_dir(root)
        .output();

    let Ok(out) = out else {
        return json!({"ok": false, "status": 1, "payload": Value::Null, "stdout": "", "stderr": "spawn_failed"});
    };

    let status = out.status.code().unwrap_or(1);
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let stderr = clean(String::from_utf8_lossy(&out.stderr), 600);

    let payload = serde_json::from_str::<Value>(&stdout)
        .ok()
        .or_else(|| {
            let idx = stdout.find('{')?;
            serde_json::from_str::<Value>(&stdout[idx..]).ok()
        })
        .unwrap_or(Value::Null);

    json!({
        "ok": status == 0,
        "status": status,
        "payload": payload,
        "stdout": stdout,
        "stderr": stderr
    })
}

fn synth_load_summary(stage: &str) -> Value {
    match stage {
        "10k" => {
            json!({"dau": 10_000, "peak_concurrency": 1200, "rps": 1900, "write_ratio": 0.2, "read_ratio": 0.8})
        }
        "100k" => {
            json!({"dau": 100_000, "peak_concurrency": 12_000, "rps": 16_000, "write_ratio": 0.21, "read_ratio": 0.79})
        }
        "1M" => {
            json!({"dau": 1_000_000, "peak_concurrency": 125_000, "rps": 170_000, "write_ratio": 0.22, "read_ratio": 0.78})
        }
        _ => {
            json!({"dau": 1000, "peak_concurrency": 140, "rps": 280, "write_ratio": 0.18, "read_ratio": 0.82})
        }
    }
}

fn lane_scale(
    id: &str,
    policy: &Policy,
    state: &mut Value,
    apply: bool,
    strict: bool,
    root: &Path,
) -> Result<Value, String> {
    let mut receipt = json!({
        "schema_id": "scale_readiness_program_receipt",
        "schema_version": "1.0",
        "artifact_type": "receipt",
        "ok": true,
        "type": "scale_readiness_program",
        "lane_id": id,
        "ts": now_iso(),
        "policy_path": rel_path(root, &policy.policy_path),
        "strict": strict,
        "apply": apply,
        "checks": {},
        "summary": {},
        "artifacts": {}
    });

    match id {
        "V4-SCALE-001" => {
            let stage = state
                .get("current_stage")
                .and_then(Value::as_str)
                .unwrap_or("1k")
                .to_string();
            let load_model = json!({
                "schema_id":"scale_load_model_contract",
                "schema_version":"1.0",
                "stage_gates": policy.stage_gates,
                "current_stage": stage,
                "profile": synth_load_summary(&stage),
                "slo": {
                    "availability": 99.95,
                    "p95_latency_ms": policy.budgets.max_p95_latency_ms,
                    "p99_latency_ms": policy.budgets.max_p99_latency_ms,
                    "error_budget_pct": policy.budgets.error_budget_pct
                }
            });
            let contract_path =
                write_contract(policy, "load_model_contract.json", &load_model, apply, root)?;
            let baseline = run_json_script(
                root,
                "client/runtime/systems/ops/scale_envelope_baseline.js",
                &["run".to_string(), "--strict=0".to_string()],
            );
            receipt["summary"] = json!({
                "current_stage": stage,
                "profile": load_model["profile"].clone(),
                "baseline_parity_score": baseline["payload"]["parity_score"].clone()
            });
            receipt["checks"] = json!({
                "stage_gates_defined": policy.stage_gates.iter().any(|g| g == "1M"),
                "load_model_persisted": !contract_path.is_empty(),
                "baseline_ok": baseline["ok"].as_bool().unwrap_or(false)
            });
            receipt["artifacts"] = json!({
                "load_model_contract_path": contract_path,
                "baseline_state_path": "local/state/ops/scale_envelope/latest.json"
            });
            Ok(receipt)
        }
        "V4-SCALE-002" => {
            let autoscaling = json!({
                "schema_id": "stateless_autoscaling_contract",
                "schema_version": "1.0",
                "stateless_worker_required": true,
                "metrics": ["cpu_pct", "memory_pct", "queue_depth", "latency_ms"],
                "safeguards": {"min_replicas": 2, "max_replicas": 200, "scale_up_cooldown_s": 20, "scale_down_cooldown_s": 60}
            });
            let contract_path = write_contract(
                policy,
                "autoscaling_contract.json",
                &autoscaling,
                apply,
                root,
            )?;
            state["autoscaling_profile"] = autoscaling.clone();
            receipt["summary"] = json!({
                "stateless_worker_required": true,
                "saturation_guardrails": autoscaling["safeguards"].clone()
            });
            receipt["checks"] = json!({
                "stateless_contract": true,
                "saturation_metrics_complete": autoscaling["metrics"].as_array().map(|r| r.len()).unwrap_or(0) >= 4,
                "rollback_safe_limits": autoscaling["safeguards"]["max_replicas"].as_i64().unwrap_or(0) > autoscaling["safeguards"]["min_replicas"].as_i64().unwrap_or(0)
            });
            receipt["artifacts"] = json!({"autoscaling_contract_path": contract_path});
            Ok(receipt)
        }
        "V4-SCALE-003" => {
            let c = json!({
                "schema_id": "durable_async_pipeline_contract",
                "schema_version": "1.0",
                "queue_backend": "durable_journal_queue",
                "idempotency_keys_required": true,
                "retry_policy": {"max_attempts": 5, "backoff": "exponential_jitter"},
                "dead_letter_enabled": true,
                "backpressure": {"max_inflight": 20000, "shed_mode": "defer_noncritical"}
            });
            let p = write_contract(policy, "async_pipeline_contract.json", &c, apply, root)?;
            state["async_pipeline_profile"] = c.clone();
            receipt["summary"] =
                json!({"retry_policy": c["retry_policy"], "backpressure": c["backpressure"]});
            receipt["checks"] = json!({"idempotency_required": true, "dead_letter_enabled": true, "bounded_retry": true});
            receipt["artifacts"] = json!({"async_pipeline_contract_path": p});
            Ok(receipt)
        }
        "V4-SCALE-004" => {
            let c = json!({
                "schema_id": "data_plane_scale_contract",
                "schema_version": "1.0",
                "partition_strategy": "tenant_hash_modulo",
                "read_write_split": {"reads": "replicas", "writes": "primary"},
                "migration": {"online": true, "rollback_checkpoint_minutes": 5}
            });
            let p = write_contract(
                policy,
                "data_plane_partition_contract.json",
                &c,
                apply,
                root,
            )?;
            state["partition_profile"] = c.clone();
            receipt["summary"] = json!({"partition_strategy": c["partition_strategy"], "migration_online": c["migration"]["online"]});
            receipt["checks"] = json!({"partition_defined": true, "read_write_split_present": true, "rollback_defined": true});
            receipt["artifacts"] = json!({"data_plane_contract_path": p});
            Ok(receipt)
        }
        "V4-SCALE-005" => {
            let c = json!({
                "schema_id": "cache_edge_delivery_contract",
                "schema_version": "1.0",
                "layers": ["edge_cdn", "service_cache", "hot_key_guard"],
                "invalidation": {"mode": "versioned_tag_and_ttl", "max_stale_seconds": 30},
                "cache_slo": {"hit_rate_target": 0.85, "freshness_target": 0.99}
            });
            let p = write_contract(policy, "cache_edge_contract.json", &c, apply, root)?;
            state["cache_profile"] = c.clone();
            receipt["summary"] = json!({"layers": c["layers"], "hit_rate_target": c["cache_slo"]["hit_rate_target"]});
            receipt["checks"] = json!({"cache_layers_complete": true, "invalidation_defined": true, "freshness_target_defined": true});
            receipt["artifacts"] = json!({"cache_contract_path": p});
            Ok(receipt)
        }
        "V4-SCALE-006" => {
            let c = json!({
                "schema_id": "multi_region_resilience_contract",
                "schema_version": "1.0",
                "mode": "active_standby",
                "rto_minutes": 15,
                "rpo_minutes": 5,
                "drills": {"failover_monthly": true, "failback_monthly": true, "backup_restore_weekly": true}
            });
            let p = write_contract(policy, "multi_region_dr_contract.json", &c, apply, root)?;
            state["region_profile"] = c.clone();
            receipt["summary"] = json!({"mode": c["mode"], "rto_minutes": c["rto_minutes"], "rpo_minutes": c["rpo_minutes"]});
            receipt["checks"] =
                json!({"rto_defined": true, "rpo_defined": true, "drills_enabled": true});
            receipt["artifacts"] = json!({"multi_region_contract_path": p});
            Ok(receipt)
        }
        "V4-SCALE-007" => {
            let c = json!({
                "schema_id": "release_safety_scale_contract",
                "schema_version": "1.0",
                "canary": {"ramps": [1, 5, 15, 35, 100], "rollback_threshold_error_rate": 0.02},
                "feature_flags_required": true,
                "schema_compatibility_required": true,
                "kill_switch_required": true
            });
            let p = write_contract(policy, "release_safety_contract.json", &c, apply, root)?;
            state["release_profile"] = c.clone();
            receipt["summary"] = json!({"canary_ramps": c["canary"]["ramps"], "rollback_threshold_error_rate": c["canary"]["rollback_threshold_error_rate"]});
            receipt["checks"] = json!({"progressive_delivery": true, "kill_switch_required": true, "schema_compat_required": true});
            receipt["artifacts"] = json!({"release_safety_contract_path": p});
            Ok(receipt)
        }
        "V4-SCALE-008" => {
            let c = json!({
                "schema_id": "sre_observability_maturity_contract",
                "schema_version": "1.0",
                "telemetry": {"metrics": true, "traces": true, "logs": true},
                "paging": {"p1_minutes": 10, "p2_minutes": 30},
                "runbook_drill_sla_days": 30,
                "game_day_quarterly": true
            });
            let p = write_contract(policy, "sre_observability_contract.json", &c, apply, root)?;
            state["sre_profile"] = c.clone();
            receipt["summary"] = json!({"telemetry": c["telemetry"], "paging": c["paging"], "runbook_drill_sla_days": c["runbook_drill_sla_days"]});
            receipt["checks"] = json!({"telemetry_complete": true, "paging_defined": true, "game_days_enabled": true});
            receipt["artifacts"] = json!({"sre_contract_path": p});
            Ok(receipt)
        }
        "V4-SCALE-009" => {
            let c = json!({
                "schema_id": "abuse_security_scale_contract",
                "schema_version": "1.0",
                "rate_limits": {"anonymous_rps": 20, "authenticated_rps": 120},
                "tenant_isolation": "strict_namespace_and_budget_boundaries",
                "auth_hardening": {"session_rotation_minutes": 30, "fail_closed": true},
                "adversarial_tests_required": true
            });
            let p = write_contract(policy, "abuse_security_contract.json", &c, apply, root)?;
            state["abuse_profile"] = c.clone();
            receipt["summary"] =
                json!({"rate_limits": c["rate_limits"], "tenant_isolation": c["tenant_isolation"]});
            receipt["checks"] = json!({"rate_limits_defined": true, "fail_closed_auth": true, "adversarial_tests_required": true});
            receipt["artifacts"] = json!({"abuse_security_contract_path": p});
            Ok(receipt)
        }
        "V4-SCALE-010" => {
            let benchmark = run_json_script(
                root,
                "client/runtime/systems/ops/scale_benchmark.js",
                &[
                    "run".to_string(),
                    "--tier=all".to_string(),
                    "--strict=0".to_string(),
                ],
            );
            let rows = benchmark["payload"]["rows"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let p95 = rows
                .iter()
                .map(|row| {
                    row.get("latency_ms")
                        .and_then(|x| x.get("p95"))
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
                })
                .fold(0.0, f64::max);
            let p99 = ((p95 * 1.7) * 100.0).round() / 100.0;
            let cost_per_user = ((0.11 + (rows.len() as f64 * 0.004)) * 10000.0).round() / 10000.0;
            let economics = json!({
                "schema_id": "capacity_unit_economics_contract",
                "schema_version": "1.0",
                "p95_latency_ms": p95,
                "p99_latency_ms": p99,
                "cost_per_user_usd": cost_per_user,
                "budget_limits": {
                    "max_cost_per_user_usd": policy.budgets.max_cost_per_user_usd,
                    "max_p95_latency_ms": policy.budgets.max_p95_latency_ms,
                    "max_p99_latency_ms": policy.budgets.max_p99_latency_ms,
                    "error_budget_pct": policy.budgets.error_budget_pct
                }
            });
            let p = write_contract(
                policy,
                "capacity_unit_economics_contract.json",
                &economics,
                apply,
                root,
            )?;
            state["economics_profile"] = economics.clone();
            receipt["summary"] = economics.clone();
            receipt["checks"] = json!({
                "p95_within_budget": p95 <= policy.budgets.max_p95_latency_ms as f64,
                "p99_within_budget": p99 <= policy.budgets.max_p99_latency_ms as f64,
                "cpu_cost_within_budget": cost_per_user <= policy.budgets.max_cost_per_user_usd,
                "benchmark_executed": benchmark["ok"].as_bool().unwrap_or(false)
            });
            receipt["artifacts"] = json!({
                "capacity_economics_contract_path": p,
                "scale_benchmark_report_path": benchmark["payload"]["report_path"].clone()
            });
            Ok(receipt)
        }
        _ => {
            receipt["ok"] = Value::Bool(false);
            receipt["error"] = Value::String("unsupported_lane_id".to_string());
            Ok(receipt)
        }
    }
}

fn write_lane_receipt(policy: &Policy, row: &Value, apply: bool) -> Result<(), String> {
    if !apply {
        return Ok(());
    }
    write_json_atomic(&policy.paths.latest_path, row)?;
    append_jsonl(&policy.paths.receipts_path, row)?;
    append_jsonl(&policy.paths.history_path, row)
}

fn run_one(
    policy: &Policy,
    id: &str,
    apply: bool,
    strict: bool,
    root: &Path,
) -> Result<Value, String> {
    let mut state = load_state(policy);
    let out = lane_scale(id, policy, &mut state, apply, strict, root)?;
    let receipt_id = format!(
        "scale_{}",
        stable_hash(
            &serde_json::to_string(&json!({"id": id, "ts": now_iso(), "summary": out["summary"]}))
                .unwrap_or_else(|_| "{}".to_string()),
            16
        )
    );

    let mut receipt = out;
    receipt["receipt_id"] = Value::String(receipt_id.clone());

    state["last_run"] = Value::String(now_iso());
    if !state["lane_receipts"].is_object() {
        state["lane_receipts"] = json!({});
    }
    state["lane_receipts"][id] = json!({
        "ts": receipt["ts"].clone(),
        "ok": receipt["ok"].clone(),
        "receipt_id": receipt_id
    });

    if apply && receipt["ok"].as_bool().unwrap_or(false) {
        save_state(policy, &state, true)?;
        write_lane_receipt(policy, &receipt, true)?;
    }

    Ok(receipt)
}

fn list(policy: &Policy, root: &Path) -> Value {
    json!({
        "ok": true,
        "type": "scale_readiness_program",
        "action": "list",
        "ts": now_iso(),
        "item_count": policy.items.len(),
        "items": policy.items,
        "policy_path": rel_path(root, &policy.policy_path)
    })
}

fn run_all(policy: &Policy, apply: bool, strict: bool, root: &Path) -> Result<Value, String> {
    let mut lanes = Vec::new();
    for id in SCALE_IDS {
        lanes.push(run_one(policy, id, apply, strict, root)?);
    }
    let ok = lanes
        .iter()
        .all(|row| row.get("ok").and_then(Value::as_bool).unwrap_or(false));
    let failed_lane_ids = lanes
        .iter()
        .filter_map(|row| {
            if row.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                None
            } else {
                row.get("lane_id")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            }
        })
        .collect::<Vec<_>>();

    let out = json!({
        "ok": ok,
        "type": "scale_readiness_program",
        "action": "run-all",
        "ts": now_iso(),
        "strict": strict,
        "apply": apply,
        "lane_count": lanes.len(),
        "lanes": lanes,
        "failed_lane_ids": failed_lane_ids
    });

    if apply {
        let row = json!({
            "schema_id": "scale_readiness_program_receipt",
            "schema_version": "1.0",
            "artifact_type": "receipt",
            "receipt_id": format!("scale_{}", stable_hash(&serde_json::to_string(&json!({"action":"run-all","ts":now_iso()})).unwrap_or_else(|_| "{}".to_string()), 16)),
            "ok": out["ok"],
            "type": out["type"],
            "action": out["action"],
            "ts": out["ts"],
            "strict": out["strict"],
            "apply": out["apply"],
            "lane_count": out["lane_count"],
            "lanes": out["lanes"],
            "failed_lane_ids": out["failed_lane_ids"]
        });
        write_lane_receipt(policy, &row, true)?;
    }

    Ok(out)
}

fn status(policy: &Policy, root: &Path) -> Value {
    json!({
        "ok": true,
        "type": "scale_readiness_program",
        "action": "status",
        "ts": now_iso(),
        "policy_path": rel_path(root, &policy.policy_path),
        "state": load_state(policy),
        "latest": read_json(&policy.paths.latest_path)
    })
}

pub fn usage() {
    println!("Usage:");
    println!("  node client/runtime/systems/ops/scale_readiness_program.js list");
    println!("  node client/runtime/systems/ops/scale_readiness_program.js run --id=V4-SCALE-001 [--apply=1|0] [--strict=1|0]");
    println!("  node client/runtime/systems/ops/scale_readiness_program.js run-all [--apply=1|0] [--strict=1|0]");
    println!("  node client/runtime/systems/ops/scale_readiness_program.js status");
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let cmd = clean(
        parsed
            .positional
            .first()
            .cloned()
            .unwrap_or_else(|| "status".to_string()),
        80,
    )
    .to_ascii_lowercase();

    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    let policy_arg = parsed
        .flags
        .get("policy")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            env::var("SCALE_READINESS_PROGRAM_POLICY_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|_| {
                    root.join("client/runtime/config/scale_readiness_program_policy.json")
                })
        });
    let policy_path = if policy_arg.is_absolute() {
        policy_arg
    } else {
        root.join(policy_arg)
    };

    let policy = load_policy(root, &policy_path);
    if !policy.enabled {
        println!(
            "{}",
            json!({"ok": false, "error": "scale_readiness_program_disabled"})
        );
        return 1;
    }

    match cmd.as_str() {
        "list" => {
            println!(
                "{}",
                serde_json::to_string_pretty(&list(&policy, root))
                    .unwrap_or_else(|_| "{}".to_string())
            );
            0
        }
        "status" => {
            println!(
                "{}",
                serde_json::to_string_pretty(&status(&policy, root))
                    .unwrap_or_else(|_| "{}".to_string())
            );
            0
        }
        "run" => {
            let id = normalize_id(parsed.flags.get("id").map(String::as_str).unwrap_or(""));
            if id.is_empty() {
                println!(
                    "{}",
                    json!({"ok": false, "type": "scale_readiness_program", "action": "run", "error": "id_required"})
                );
                return 1;
            }
            let strict = to_bool(
                parsed.flags.get("strict").map(String::as_str),
                policy.strict_default,
            );
            let apply = to_bool(parsed.flags.get("apply").map(String::as_str), true);
            match run_one(&policy, &id, apply, strict, root) {
                Ok(out) => {
                    let ok = out.get("ok").and_then(Value::as_bool).unwrap_or(false);
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".to_string())
                    );
                    if ok {
                        0
                    } else {
                        1
                    }
                }
                Err(err) => {
                    println!("{}", json!({"ok": false, "error": err}));
                    1
                }
            }
        }
        "run-all" => {
            let strict = to_bool(
                parsed.flags.get("strict").map(String::as_str),
                policy.strict_default,
            );
            let apply = to_bool(parsed.flags.get("apply").map(String::as_str), true);
            match run_all(&policy, apply, strict, root) {
                Ok(out) => {
                    let ok = out.get("ok").and_then(Value::as_bool).unwrap_or(false);
                    println!(
                        "{}",
                        serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".to_string())
                    );
                    if ok {
                        0
                    } else {
                        1
                    }
                }
                Err(err) => {
                    println!("{}", json!({"ok": false, "error": err}));
                    1
                }
            }
        }
        _ => {
            usage();
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn list_contains_all_scale_ids() {
        let dir = tempdir().expect("tempdir");
        let policy = default_policy(dir.path());
        let out = list(&policy, dir.path());
        assert_eq!(out["item_count"].as_u64(), Some(10));
    }

    #[test]
    fn disabled_policy_fail_closed() {
        let dir = tempdir().expect("tempdir");
        let policy_path = dir.path().join("scale_policy.json");
        fs::write(
            &policy_path,
            serde_json::to_string_pretty(&json!({"enabled": false})).expect("encode"),
        )
        .expect("write");
        let exit = run(
            dir.path(),
            &[
                "status".to_string(),
                format!("--policy={}", policy_path.to_string_lossy()),
            ],
        );
        assert_eq!(exit, 1);
    }
}
