// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso, parse_args};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const LANE_ID: &str = "f100_reliability_certification";
const DEFAULT_POLICY_REL: &str = "client/config/f100_reliability_certification_policy.json";

#[derive(Debug, Clone)]
struct Tier {
    min_uptime: f64,
    max_receipt_p95_ms: f64,
    max_receipt_p99_ms: f64,
    max_incident_rate: f64,
    max_change_fail_rate: f64,
    max_error_budget_burn_ratio: f64,
}

#[derive(Debug, Clone)]
struct Policy {
    strict_default: bool,
    active_tier: String,
    tiers: BTreeMap<String, Tier>,
    window_days: i64,
    missing_metric_fail_closed: bool,
    sources_execution_reliability_path: PathBuf,
    sources_error_budget_latest_path: PathBuf,
    sources_error_budget_history_path: PathBuf,
    sources_spine_runs_dir: PathBuf,
    sources_incident_log_path: PathBuf,
    drill_evidence_paths: Vec<PathBuf>,
    rollback_evidence_paths: Vec<PathBuf>,
    min_drill_evidence_count: usize,
    min_rollback_evidence_count: usize,
    latest_path: PathBuf,
    history_path: PathBuf,
    policy_path: PathBuf,
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops f100-reliability-certification run [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops f100-reliability-certification status [--policy=<path>]");
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

fn read_json(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("read_json_failed:{}:{err}", path.display()))?;
    serde_json::from_str::<Value>(&raw)
        .map_err(|err| format!("parse_json_failed:{}:{err}", path.display()))
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                return None;
            }
            serde_json::from_str::<Value>(trimmed).ok()
        })
        .collect()
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

fn value_as_f64(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(raw)) => raw.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn parse_iso_day(value: Option<&Value>) -> Option<NaiveDate> {
    let value = value?;
    let token = value.as_str()?.trim();
    if token.is_empty() {
        return None;
    }
    if token.len() >= 10 {
        let day = &token[..10];
        if let Ok(parsed) = NaiveDate::parse_from_str(day, "%Y-%m-%d") {
            return Some(parsed);
        }
    }
    DateTime::parse_from_rfc3339(token)
        .ok()
        .map(|dt| dt.date_naive())
}

fn percentile(values: &[f64], q: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let quantile = if q.is_finite() { q.clamp(0.0, 1.0) } else { 0.5 };
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((sorted.len() as f64) * quantile).ceil() as usize;
    let idx = idx.saturating_sub(1).min(sorted.len().saturating_sub(1));
    sorted.get(idx).copied()
}

fn collect_spine_latency_metrics(spine_runs_dir: &Path) -> (Option<f64>, Option<f64>, usize, usize) {
    let mut latency_ms = Vec::<f64>::new();
    let mut files_scanned = 0usize;

    if let Ok(entries) = fs::read_dir(spine_runs_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|v| v.to_str()) != Some("jsonl") {
                continue;
            }
            files_scanned += 1;
            for row in read_jsonl(&path) {
                match row.get("type").and_then(Value::as_str).unwrap_or("") {
                    "spine_run_complete" => {
                        if let Some(ms) = row.get("elapsed_ms").and_then(Value::as_f64) {
                            latency_ms.push(ms);
                        }
                    }
                    "spine_observability_trace" => {
                        if let Some(ms) = row.get("trace_duration_ms").and_then(Value::as_f64) {
                            latency_ms.push(ms);
                        }
                    }
                    _ => {}
                }
            }
        }
    }

    (
        percentile(&latency_ms, 0.95),
        percentile(&latency_ms, 0.99),
        latency_ms.len(),
        files_scanned,
    )
}

fn collect_incident_rate(incident_log_path: &Path, window_start: NaiveDate, now: NaiveDate) -> (f64, usize) {
    let rows = read_jsonl(incident_log_path);
    let mut incidents = 0usize;
    for row in rows {
        if row.get("type").and_then(Value::as_str) != Some("autonomy_human_escalation") {
            continue;
        }
        let Some(day) = parse_iso_day(row.get("ts").or_else(|| row.get("date"))) else {
            continue;
        };
        if day < window_start || day > now {
            continue;
        }
        incidents += 1;
    }
    let window_days = (now - window_start).num_days().max(1) as f64;
    (incidents as f64 / window_days, incidents)
}

fn collect_change_fail_rate(history_path: &Path, window_start: NaiveDate, now: NaiveDate) -> (f64, usize, usize) {
    let rows = read_jsonl(history_path);
    let mut total = 0usize;
    let mut failed = 0usize;

    for row in rows {
        let Some(day) = parse_iso_day(row.get("ts").or_else(|| row.get("date"))) else {
            continue;
        };
        if day < window_start || day > now {
            continue;
        }
        total += 1;
        let ok = row.get("ok").and_then(Value::as_bool).unwrap_or(false);
        let blocked = row
            .get("gate")
            .and_then(|v| v.get("promotion_blocked"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if !ok || blocked {
            failed += 1;
        }
    }

    let rate = if total > 0 {
        failed as f64 / total as f64
    } else {
        0.0
    };
    (rate, total, failed)
}

fn evidence_status(paths: &[PathBuf], min_count: usize) -> Value {
    let mut found = Vec::<String>::new();
    let mut missing = Vec::<String>::new();
    for path in paths {
        if path.exists() {
            found.push(path.to_string_lossy().to_string());
        } else {
            missing.push(path.to_string_lossy().to_string());
        }
    }
    let ok = found.len() >= min_count;
    json!({
        "ok": ok,
        "required_min": min_count,
        "found_count": found.len(),
        "found_paths": found,
        "missing_paths": missing
    })
}

fn load_policy(root: &Path, policy_override: Option<&String>) -> Policy {
    let policy_path = policy_override
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(DEFAULT_POLICY_REL));

    let raw = fs::read_to_string(&policy_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}));

    let strict_default = raw
        .get("strict_default")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let active_tier = raw
        .get("active_tier")
        .and_then(Value::as_str)
        .unwrap_or("seed")
        .trim()
        .to_ascii_lowercase();
    let window_days = raw
        .get("window_days")
        .and_then(Value::as_i64)
        .unwrap_or(30)
        .clamp(7, 120);
    let missing_metric_fail_closed = raw
        .get("missing_metric_fail_closed")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let default_seed = Tier {
        min_uptime: 0.90,
        max_receipt_p95_ms: 200.0,
        max_receipt_p99_ms: 300.0,
        max_incident_rate: 0.35,
        max_change_fail_rate: 0.50,
        max_error_budget_burn_ratio: 0.45,
    };
    let default_production = Tier {
        min_uptime: 0.999,
        max_receipt_p95_ms: 100.0,
        max_receipt_p99_ms: 150.0,
        max_incident_rate: 0.10,
        max_change_fail_rate: 0.20,
        max_error_budget_burn_ratio: 0.30,
    };

    let mut tiers = BTreeMap::<String, Tier>::new();
    tiers.insert("seed".to_string(), default_seed.clone());
    tiers.insert("production".to_string(), default_production.clone());

    if let Some(obj) = raw.get("tiers").and_then(Value::as_object) {
        for (name, v) in obj {
            let tier_obj = v.as_object();
            let tier = Tier {
                min_uptime: value_as_f64(tier_obj.and_then(|m| m.get("min_uptime")))
                    .unwrap_or(default_seed.min_uptime)
                    .clamp(0.0, 1.0),
                max_receipt_p95_ms: value_as_f64(tier_obj.and_then(|m| m.get("max_receipt_p95_ms")))
                    .unwrap_or(default_seed.max_receipt_p95_ms)
                    .max(1.0),
                max_receipt_p99_ms: value_as_f64(tier_obj.and_then(|m| m.get("max_receipt_p99_ms")))
                    .unwrap_or(default_seed.max_receipt_p99_ms)
                    .max(1.0),
                max_incident_rate: value_as_f64(tier_obj.and_then(|m| m.get("max_incident_rate")))
                    .unwrap_or(default_seed.max_incident_rate)
                    .clamp(0.0, 10.0),
                max_change_fail_rate: value_as_f64(tier_obj.and_then(|m| m.get("max_change_fail_rate")))
                    .unwrap_or(default_seed.max_change_fail_rate)
                    .clamp(0.0, 1.0),
                max_error_budget_burn_ratio: value_as_f64(
                    tier_obj.and_then(|m| m.get("max_error_budget_burn_ratio")),
                )
                .unwrap_or(default_seed.max_error_budget_burn_ratio)
                .clamp(0.0, 10.0),
            };
            tiers.insert(name.trim().to_ascii_lowercase(), tier);
        }
    }

    let sources = raw.get("sources").and_then(Value::as_object);
    let outputs = raw.get("outputs").and_then(Value::as_object);

    let drill_evidence_paths = sources
        .and_then(|s| s.get("drill_evidence_paths"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|p| resolve_path(root, Some(p), ""))
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            vec![
                root.join("state/ops/dr_gameday_gate_receipts.jsonl"),
                root.join("state/ops/continuous_chaos_resilience/latest.json"),
            ]
        });

    let rollback_evidence_paths = sources
        .and_then(|s| s.get("rollback_evidence_paths"))
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|p| resolve_path(root, Some(p), ""))
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            vec![
                root.join("state/ops/release_gate_canary_rollback_enforcer/latest.json"),
                root.join("state/ops/error_budget_release_gate/freeze_state.json"),
            ]
        });

    Policy {
        strict_default,
        active_tier,
        tiers,
        window_days,
        missing_metric_fail_closed,
        sources_execution_reliability_path: resolve_path(
            root,
            sources
                .and_then(|s| s.get("execution_reliability_path"))
                .and_then(Value::as_str),
            "state/ops/execution_reliability_slo.json",
        ),
        sources_error_budget_latest_path: resolve_path(
            root,
            sources
                .and_then(|s| s.get("error_budget_latest_path"))
                .and_then(Value::as_str),
            "state/ops/error_budget_release_gate/latest.json",
        ),
        sources_error_budget_history_path: resolve_path(
            root,
            sources
                .and_then(|s| s.get("error_budget_history_path"))
                .and_then(Value::as_str),
            "state/ops/error_budget_release_gate/history.jsonl",
        ),
        sources_spine_runs_dir: resolve_path(
            root,
            sources
                .and_then(|s| s.get("spine_runs_dir"))
                .and_then(Value::as_str),
            "state/spine/runs",
        ),
        sources_incident_log_path: resolve_path(
            root,
            sources
                .and_then(|s| s.get("incident_log_path"))
                .and_then(Value::as_str),
            "state/security/autonomy_human_escalations.jsonl",
        ),
        drill_evidence_paths,
        rollback_evidence_paths,
        min_drill_evidence_count: sources
            .and_then(|s| s.get("min_drill_evidence_count"))
            .and_then(Value::as_u64)
            .unwrap_or(1) as usize,
        min_rollback_evidence_count: sources
            .and_then(|s| s.get("min_rollback_evidence_count"))
            .and_then(Value::as_u64)
            .unwrap_or(1) as usize,
        latest_path: resolve_path(
            root,
            outputs
                .and_then(|s| s.get("latest_path"))
                .and_then(Value::as_str),
            "state/ops/f100_reliability_certification/latest.json",
        ),
        history_path: resolve_path(
            root,
            outputs
                .and_then(|s| s.get("history_path"))
                .and_then(Value::as_str),
            "state/ops/f100_reliability_certification/history.jsonl",
        ),
        policy_path,
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

fn evaluate(policy: &Policy) -> Result<Value, String> {
    let tier = policy
        .tiers
        .get(&policy.active_tier)
        .cloned()
        .or_else(|| policy.tiers.get("seed").cloned())
        .ok_or_else(|| "missing_slo_tier".to_string())?;

    let reliability = read_json(&policy.sources_execution_reliability_path).unwrap_or_else(|_| json!({}));
    let uptime = value_as_f64(
        reliability
            .get("measured")
            .and_then(|v| v.get("execution_success_rate")),
    );

    let error_budget = read_json(&policy.sources_error_budget_latest_path).unwrap_or_else(|_| json!({}));
    let burn_ratio = value_as_f64(
        error_budget
            .get("gate")
            .and_then(|v| v.get("burn_ratio")),
    )
    .unwrap_or(0.0);

    let (p95, p99, latency_samples, latency_files_scanned) =
        collect_spine_latency_metrics(&policy.sources_spine_runs_dir);

    let today = Utc::now().date_naive();
    let window_start = today - Duration::days(policy.window_days.saturating_sub(1));
    let (incident_rate, incident_count) =
        collect_incident_rate(&policy.sources_incident_log_path, window_start, today);
    let (change_fail_rate, change_window_total, change_window_failed) =
        collect_change_fail_rate(&policy.sources_error_budget_history_path, window_start, today);

    let drill = evidence_status(&policy.drill_evidence_paths, policy.min_drill_evidence_count);
    let rollback = evidence_status(
        &policy.rollback_evidence_paths,
        policy.min_rollback_evidence_count,
    );

    let mut checks = BTreeMap::<String, Value>::new();

    let uptime_ok = uptime
        .map(|v| v >= tier.min_uptime)
        .unwrap_or(!policy.missing_metric_fail_closed);
    checks.insert(
        "uptime".to_string(),
        json!({
            "ok": uptime_ok,
            "value": uptime,
            "target_min": tier.min_uptime,
            "source": policy.sources_execution_reliability_path
        }),
    );

    let p95_ok = p95
        .map(|v| v <= tier.max_receipt_p95_ms)
        .unwrap_or(!policy.missing_metric_fail_closed);
    checks.insert(
        "receipt_latency_p95_ms".to_string(),
        json!({
            "ok": p95_ok,
            "value": p95,
            "target_max": tier.max_receipt_p95_ms,
            "samples": latency_samples,
            "files_scanned": latency_files_scanned,
            "source": policy.sources_spine_runs_dir
        }),
    );

    let p99_ok = p99
        .map(|v| v <= tier.max_receipt_p99_ms)
        .unwrap_or(!policy.missing_metric_fail_closed);
    checks.insert(
        "receipt_latency_p99_ms".to_string(),
        json!({
            "ok": p99_ok,
            "value": p99,
            "target_max": tier.max_receipt_p99_ms,
            "samples": latency_samples,
            "files_scanned": latency_files_scanned,
            "source": policy.sources_spine_runs_dir
        }),
    );

    let incident_ok = incident_rate <= tier.max_incident_rate;
    checks.insert(
        "incident_rate".to_string(),
        json!({
            "ok": incident_ok,
            "value": incident_rate,
            "target_max": tier.max_incident_rate,
            "incidents": incident_count,
            "window_days": policy.window_days,
            "source": policy.sources_incident_log_path
        }),
    );

    let change_fail_ok = change_fail_rate <= tier.max_change_fail_rate;
    checks.insert(
        "change_fail_rate".to_string(),
        json!({
            "ok": change_fail_ok,
            "value": change_fail_rate,
            "target_max": tier.max_change_fail_rate,
            "window_total": change_window_total,
            "window_failed": change_window_failed,
            "window_days": policy.window_days,
            "source": policy.sources_error_budget_history_path
        }),
    );

    let burn_ok = burn_ratio <= tier.max_error_budget_burn_ratio;
    checks.insert(
        "error_budget_burn_ratio".to_string(),
        json!({
            "ok": burn_ok,
            "value": burn_ratio,
            "target_max": tier.max_error_budget_burn_ratio,
            "source": policy.sources_error_budget_latest_path
        }),
    );

    checks.insert("drill_evidence".to_string(), drill.clone());
    checks.insert("rollback_evidence".to_string(), rollback.clone());

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

    Ok(json!({
        "ok": ok,
        "schema_id": "f100_reliability_certification",
        "schema_version": "1.0",
        "ts": now_iso(),
        "tier": policy.active_tier,
        "window": {
            "start": window_start.to_string(),
            "end": today.to_string(),
            "window_days": policy.window_days
        },
        "checks": checks,
        "blocking_checks": blocking_checks,
        "monthly_scorecard": {
            "uptime": checks.get("uptime").cloned().unwrap_or(Value::Null),
            "receipt_latency_p95_ms": checks.get("receipt_latency_p95_ms").cloned().unwrap_or(Value::Null),
            "receipt_latency_p99_ms": checks.get("receipt_latency_p99_ms").cloned().unwrap_or(Value::Null),
            "incident_rate": checks.get("incident_rate").cloned().unwrap_or(Value::Null),
            "change_fail_rate": checks.get("change_fail_rate").cloned().unwrap_or(Value::Null)
        },
        "release_gate": {
            "burn_ratio": burn_ratio,
            "target_max": tier.max_error_budget_burn_ratio,
            "promotion_blocked": !burn_ok,
            "source": policy.sources_error_budget_latest_path
        },
        "drill_evidence": drill,
        "rollback_evidence": rollback,
        "sources": {
            "execution_reliability_path": policy.sources_execution_reliability_path,
            "error_budget_latest_path": policy.sources_error_budget_latest_path,
            "error_budget_history_path": policy.sources_error_budget_history_path,
            "spine_runs_dir": policy.sources_spine_runs_dir,
            "incident_log_path": policy.sources_incident_log_path
        },
        "claim_evidence": [
            {
                "id": "f100_reliability_error_budget_gate",
                "claim": "release_gate_blocks_when_error_budget_burn_exceeds_policy",
                "evidence": {
                    "burn_ratio": burn_ratio,
                    "max_error_budget_burn_ratio": tier.max_error_budget_burn_ratio,
                    "promotion_blocked": !burn_ok
                }
            },
            {
                "id": "f100_monthly_reliability_scorecard",
                "claim": "monthly_scorecard_emits_uptime_latency_incident_and_change_fail_metrics_with_drill_and_rollback_evidence",
                "evidence": {
                    "metrics": ["uptime", "receipt_latency_p95_ms", "receipt_latency_p99_ms", "incident_rate", "change_fail_rate"],
                    "drill_evidence_ok": drill.get("ok").and_then(Value::as_bool).unwrap_or(false),
                    "rollback_evidence_ok": rollback.get("ok").and_then(Value::as_bool).unwrap_or(false)
                }
            }
        ]
    }))
}

fn run_cmd(policy: &Policy, strict: bool) -> Result<(Value, i32), String> {
    let mut payload = evaluate(policy)?;
    payload["strict"] = Value::Bool(strict);
    payload["policy_path"] = Value::String(policy.policy_path.to_string_lossy().to_string());
    payload["lane"] = Value::String(LANE_ID.to_string());
    payload["type"] = Value::String("f100_reliability_certification_run".to_string());
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

fn status_cmd(policy: &Policy) -> Value {
    let latest = fs::read_to_string(&policy.latest_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| {
            json!({
                "ok": false,
                "type": "f100_reliability_certification_status",
                "error": "latest_missing"
            })
        });

    let mut out = json!({
        "ok": latest.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "type": "f100_reliability_certification_status",
        "ts": now_iso(),
        "lane": LANE_ID,
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
        "type": "f100_reliability_certification_cli_error",
        "ts": now_iso(),
        "lane": LANE_ID,
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

    match cmd.as_str() {
        "run" => match run_cmd(&policy, strict) {
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
    use serde_json::json;
    use tempfile::tempdir;

    fn write_json(path: &Path, value: &Value) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, format!("{}\n", serde_json::to_string_pretty(value).unwrap())).expect("write json");
    }

    fn write_jsonl(path: &Path, rows: &[Value]) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        let mut buf = String::new();
        for row in rows {
            buf.push_str(&serde_json::to_string(row).unwrap());
            buf.push('\n');
        }
        fs::write(path, buf).expect("write jsonl");
    }

    fn write_policy(root: &Path, strict_default: bool) {
        let policy = json!({
            "strict_default": strict_default,
            "active_tier": "seed",
            "window_days": 30,
            "missing_metric_fail_closed": false,
            "tiers": {
                "seed": {
                    "min_uptime": 0.90,
                    "max_receipt_p95_ms": 200.0,
                    "max_receipt_p99_ms": 300.0,
                    "max_incident_rate": 0.35,
                    "max_change_fail_rate": 0.50,
                    "max_error_budget_burn_ratio": 0.45
                }
            },
            "sources": {
                "execution_reliability_path": "state/ops/execution_reliability_slo.json",
                "error_budget_latest_path": "state/ops/error_budget_release_gate/latest.json",
                "error_budget_history_path": "state/ops/error_budget_release_gate/history.jsonl",
                "spine_runs_dir": "state/spine/runs",
                "incident_log_path": "state/security/autonomy_human_escalations.jsonl",
                "drill_evidence_paths": [
                    "state/ops/dr_gameday_gate_receipts.jsonl"
                ],
                "rollback_evidence_paths": [
                    "state/ops/error_budget_release_gate/freeze_state.json"
                ],
                "min_drill_evidence_count": 1,
                "min_rollback_evidence_count": 1
            },
            "outputs": {
                "latest_path": "state/ops/f100_reliability_certification/latest.json",
                "history_path": "state/ops/f100_reliability_certification/history.jsonl"
            }
        });
        write_json(&root.join("client/config/f100_reliability_certification_policy.json"), &policy);
    }

    fn write_common_fixtures(root: &Path, burn_ratio: f64) {
        write_json(
            &root.join("state/ops/execution_reliability_slo.json"),
            &json!({
                "measured": {
                    "execution_success_rate": 0.97
                }
            }),
        );
        write_json(
            &root.join("state/ops/error_budget_release_gate/latest.json"),
            &json!({
                "ok": burn_ratio <= 0.45,
                "gate": {
                    "burn_ratio": burn_ratio,
                    "promotion_blocked": burn_ratio > 0.45
                }
            }),
        );
        write_jsonl(
            &root.join("state/ops/error_budget_release_gate/history.jsonl"),
            &[
                json!({"ts": "2026-03-01T10:00:00Z", "ok": true, "gate": {"promotion_blocked": false}}),
                json!({"ts": "2026-03-02T10:00:00Z", "ok": true, "gate": {"promotion_blocked": false}})
            ],
        );
        write_jsonl(
            &root.join("state/security/autonomy_human_escalations.jsonl"),
            &[
                json!({"type":"autonomy_human_escalation", "ts":"2026-03-02T12:00:00Z", "status":"resolved"})
            ],
        );
        write_jsonl(
            &root.join("state/spine/runs/2026-03-02.jsonl"),
            &[
                json!({"type":"spine_run_complete", "elapsed_ms": 85.0}),
                json!({"type":"spine_run_complete", "elapsed_ms": 95.0}),
                json!({"type":"spine_observability_trace", "trace_duration_ms": 100.0})
            ],
        );
        write_jsonl(
            &root.join("state/ops/dr_gameday_gate_receipts.jsonl"),
            &[json!({"ok": true, "type": "drill"})],
        );
        write_json(
            &root.join("state/ops/error_budget_release_gate/freeze_state.json"),
            &json!({"frozen": false}),
        );
    }

    #[test]
    fn strict_run_blocks_when_error_budget_exceeds_threshold() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        write_policy(root, true);
        write_common_fixtures(root, 0.91);

        let policy = load_policy(root, None);
        let (_payload, code) = run_cmd(&policy, true).expect("run cmd");
        assert_eq!(code, 1);

        let latest = read_json(&root.join("state/ops/f100_reliability_certification/latest.json"))
            .expect("latest should exist");
        assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(false));
        assert!(latest
            .get("blocking_checks")
            .and_then(Value::as_array)
            .map(|rows| rows.iter().any(|v| v.as_str() == Some("error_budget_burn_ratio")))
            .unwrap_or(false));
    }

    #[test]
    fn strict_run_passes_under_seed_thresholds_with_evidence() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        write_policy(root, true);
        write_common_fixtures(root, 0.20);

        let policy = load_policy(root, None);
        let (_payload, code) = run_cmd(&policy, true).expect("run cmd");
        assert_eq!(code, 0);

        let latest = read_json(&root.join("state/ops/f100_reliability_certification/latest.json"))
            .expect("latest should exist");
        assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            latest
                .get("release_gate")
                .and_then(|v| v.get("promotion_blocked"))
                .and_then(Value::as_bool),
            Some(false)
        );
    }
}
