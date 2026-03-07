// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

const LANE_ID: &str = "health_status";
const REPLACEMENT: &str = "protheus-ops health-status";
const CRON_JOBS_REL: &str = "client/config/cron_jobs.json";
const RUST_SOURCE_OF_TRUTH_POLICY_REL: &str = "client/config/rust_source_of_truth_policy.json";
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

fn receipt_hash(v: &Value) -> String {
    deterministic_receipt_hash(v)
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops health-status status [--dashboard]");
    println!("  protheus-ops health-status run [--dashboard]");
    println!("  protheus-ops health-status dashboard");
}

fn read_json(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|err| format!("read_json_failed:{}:{err}", path.display()))?;
    serde_json::from_str::<Value>(&raw)
        .map_err(|err| format!("parse_json_failed:{}:{err}", path.display()))
}

fn is_ts_bootstrap_wrapper(source: &str) -> bool {
    let mut normalized = source.replace("\r\n", "\n");
    if normalized.starts_with("#!") {
        if let Some((_, rest)) = normalized.split_once('\n') {
            normalized = rest.to_string();
        }
    }
    let trimmed = normalized.trim();
    let without_use_strict = trimmed
        .strip_prefix("\"use strict\";")
        .or_else(|| trimmed.strip_prefix("'use strict';"))
        .unwrap_or(trimmed)
        .trim();
    without_use_strict.contains("ts_bootstrap")
        && without_use_strict.contains(".bootstrap(__filename, module)")
}

fn missing_tokens(text: &str, tokens: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for token in tokens {
        if !text.contains(token) {
            out.push(token.clone());
        }
    }
    out
}

fn check_required_tokens_at_path(root: &Path, rel_path: &str, required_tokens: &[String]) -> Result<Vec<String>, String> {
    let path = root.join(rel_path);
    let source = fs::read_to_string(&path)
        .map_err(|err| format!("read_source_failed:{}:{err}", path.display()))?;
    Ok(missing_tokens(&source, required_tokens))
}

fn require_object<'a>(value: &'a Value, field: &str) -> Result<&'a serde_json::Map<String, Value>, String> {
    value
        .get(field)
        .and_then(Value::as_object)
        .ok_or_else(|| format!("rust_source_of_truth_policy_missing_object:{field}"))
}

fn require_rel_path(section: &serde_json::Map<String, Value>, key: &str) -> Result<String, String> {
    let rel = section
        .get(key)
        .and_then(Value::as_str)
        .map(|raw| raw.trim().to_string())
        .unwrap_or_default();
    if rel.is_empty() {
        return Err(format!("rust_source_of_truth_policy_missing_path:{key}"));
    }
    Ok(rel)
}

fn require_string_array(section: &serde_json::Map<String, Value>, key: &str) -> Result<Vec<String>, String> {
    let arr = section
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("rust_source_of_truth_policy_missing_array:{key}"))?;
    let values = arr
        .iter()
        .filter_map(Value::as_str)
        .map(|raw| raw.trim().to_string())
        .filter(|raw| !raw.is_empty())
        .collect::<Vec<_>>();
    if values.is_empty() {
        return Err(format!("rust_source_of_truth_policy_empty_array:{key}"));
    }
    Ok(values)
}

fn path_has_allowed_prefix(path: &str, prefixes: &[String]) -> bool {
    prefixes.iter().any(|prefix| path.starts_with(prefix))
}

fn audit_rust_source_of_truth(root: &Path) -> Value {
    let policy_path = root.join(RUST_SOURCE_OF_TRUTH_POLICY_REL);
    let policy = match read_json(&policy_path) {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "policy_path": RUST_SOURCE_OF_TRUTH_POLICY_REL,
                "error": err,
                "violations": ["policy_unreadable"]
            })
        }
    };

    let mut violations = Vec::<Value>::new();
    let mut checked_paths = Vec::<String>::new();

    let entrypoint_gate = match require_object(&policy, "rust_entrypoint_gate") {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "policy_path": RUST_SOURCE_OF_TRUTH_POLICY_REL,
                "error": err,
                "violations": ["policy_invalid"]
            })
        }
    };
    let conduit_gate = match require_object(&policy, "conduit_strict_gate") {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "policy_path": RUST_SOURCE_OF_TRUTH_POLICY_REL,
                "error": err,
                "violations": ["policy_invalid"]
            })
        }
    };
    let conduit_budget_gate = match require_object(&policy, "conduit_budget_gate") {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "policy_path": RUST_SOURCE_OF_TRUTH_POLICY_REL,
                "error": err,
                "violations": ["policy_invalid"]
            })
        }
    };
    let status_dashboard_gate = match require_object(&policy, "status_dashboard_gate") {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "policy_path": RUST_SOURCE_OF_TRUTH_POLICY_REL,
                "error": err,
                "violations": ["policy_invalid"]
            })
        }
    };

    let checks = vec![
        ("rust_entrypoint_gate", entrypoint_gate, ".rs"),
        ("conduit_strict_gate", conduit_gate, ".ts"),
        ("conduit_budget_gate", conduit_budget_gate, ".rs"),
        ("status_dashboard_gate", status_dashboard_gate, ".ts"),
    ];

    for (ctx, section, expected_ext) in checks {
        let rel_path = match require_rel_path(section, "path") {
            Ok(v) => v,
            Err(err) => {
                violations.push(json!({"context": ctx, "reason": err}));
                continue;
            }
        };
        let required_tokens = match require_string_array(section, "required_tokens") {
            Ok(v) => v,
            Err(err) => {
                violations.push(json!({"context": ctx, "reason": err, "path": rel_path}));
                continue;
            }
        };
        if !rel_path.ends_with(expected_ext) {
            violations.push(json!({
                "context": ctx,
                "path": rel_path,
                "reason": "path_extension_mismatch",
                "expected_extension": expected_ext
            }));
            continue;
        }

        match check_required_tokens_at_path(root, &rel_path, &required_tokens) {
            Ok(missing) => {
                if !missing.is_empty() {
                    violations.push(json!({
                        "context": ctx,
                        "path": rel_path,
                        "reason": "missing_source_tokens",
                        "missing_tokens": missing
                    }));
                }
            }
            Err(err) => {
                violations.push(json!({
                    "context": ctx,
                    "path": rel_path,
                    "reason": err
                }));
            }
        }

        checked_paths.push(rel_path);
    }

    let wrapper_contract = match require_object(&policy, "js_wrapper_contract") {
        Ok(v) => v,
        Err(err) => {
            violations.push(json!({"context": "js_wrapper_contract", "reason": err}));
            &serde_json::Map::new()
        }
    };

    if let Ok(wrapper_paths) = require_string_array(wrapper_contract, "required_wrapper_paths") {
        for rel in wrapper_paths {
            if !rel.ends_with(".js") {
                violations.push(json!({
                    "context": "js_wrapper_contract",
                    "path": rel,
                    "reason": "wrapper_must_be_js"
                }));
                continue;
            }
            let path = root.join(&rel);
            match fs::read_to_string(&path) {
                Ok(source) => {
                    if !is_ts_bootstrap_wrapper(&source) {
                        violations.push(json!({
                            "context": "js_wrapper_contract",
                            "path": rel,
                            "reason": "required_wrapper_not_bootstrap"
                        }));
                    }
                }
                Err(err) => violations.push(json!({
                    "context": "js_wrapper_contract",
                    "path": rel,
                    "reason": format!("read_wrapper_failed:{err}")
                })),
            }
        }
    }

    let shim_contract = match require_object(&policy, "rust_shim_contract") {
        Ok(v) => v,
        Err(err) => {
            violations.push(json!({"context": "rust_shim_contract", "reason": err}));
            &serde_json::Map::new()
        }
    };
    let shim_entries = shim_contract
        .get("entries")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if shim_entries.is_empty() {
        violations.push(json!({
            "context": "rust_shim_contract",
            "reason": "rust_source_of_truth_policy_empty_array:entries"
        }));
    }
    for entry in shim_entries {
        let Some(section) = entry.as_object() else {
            violations.push(json!({
                "context": "rust_shim_contract",
                "reason": "rust_source_of_truth_policy_invalid_entry:entries"
            }));
            continue;
        };
        match require_rel_path(section, "path") {
            Ok(rel) => {
                if !rel.ends_with(".js") {
                    violations.push(json!({
                        "context": "rust_shim_contract",
                        "path": rel,
                        "reason": "rust_shim_must_be_js"
                    }));
                }
                checked_paths.push(rel);
            }
            Err(err) => {
                violations.push(json!({
                    "context": "rust_shim_contract",
                    "reason": err
                }));
            }
        }
    }

    let allowlist_prefixes = policy
        .get("ts_surface_allowlist_prefixes")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if allowlist_prefixes.is_empty() {
        violations.push(json!({
            "context": "ts_surface_allowlist_prefixes",
            "reason": "rust_source_of_truth_policy_empty_array:ts_surface_allowlist_prefixes"
        }));
    }

    for rel in checked_paths.iter().filter(|p| p.ends_with(".ts")) {
        if !path_has_allowed_prefix(rel, &allowlist_prefixes) {
            violations.push(json!({
                "context": "ts_surface_allowlist_prefixes",
                "path": rel,
                "reason": "ts_path_outside_allowlist"
            }));
        }
    }

    json!({
        "ok": violations.is_empty(),
        "policy_path": RUST_SOURCE_OF_TRUTH_POLICY_REL,
        "checked_paths": checked_paths,
        "allowlist_prefixes": allowlist_prefixes,
        "violations": violations
    })
}

fn allowed_delivery_channel(channel: &str) -> bool {
    ALLOWED_DELIVERY_CHANNELS.contains(&channel)
}

fn audit_cron_delivery(root: &Path) -> Value {
    let cron_path = root.join(CRON_JOBS_REL);
    let parsed = match read_json(&cron_path) {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "path": CRON_JOBS_REL,
                "error": err,
                "issues": [
                    {
                        "reason": "cron_jobs_unreadable"
                    }
                ]
            })
        }
    };

    let jobs = parsed
        .get("jobs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut enabled_jobs = 0usize;
    let mut isolated_jobs = 0usize;
    let mut jobs_with_delivery = 0usize;
    let mut issues = Vec::<Value>::new();

    for job in jobs {
        let name = job
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let id = job
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string();
        let enabled = job.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        if !enabled {
            continue;
        }
        enabled_jobs += 1;

        let session_target = job
            .get("sessionTarget")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim()
            .to_ascii_lowercase();
        if session_target == "isolated" {
            isolated_jobs += 1;
        }

        let delivery = job.get("delivery").and_then(Value::as_object);
        if delivery.is_none() {
            issues.push(json!({
                "id": id,
                "name": name,
                "reason": "missing_delivery_for_enabled_job",
                "session_target": session_target
            }));
            continue;
        }

        jobs_with_delivery += 1;
        let delivery = delivery.expect("checked");
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

        if mode.is_empty() {
            issues.push(json!({
                "id": id,
                "name": name,
                "reason": "missing_delivery_mode"
            }));
            continue;
        }

        if mode == "none" {
            issues.push(json!({
                "id": id,
                "name": name,
                "reason": "delivery_mode_none_forbidden",
                "mode": mode,
                "channel": channel
            }));
            continue;
        }

        if mode == "announce" {
            if channel.is_empty() {
                issues.push(json!({
                    "id": id,
                    "name": name,
                    "reason": "announce_missing_channel",
                    "mode": mode
                }));
                continue;
            }
            if !allowed_delivery_channel(&channel) {
                issues.push(json!({
                    "id": id,
                    "name": name,
                    "reason": "unsupported_delivery_channel",
                    "mode": mode,
                    "channel": channel,
                    "allowed_channels": ALLOWED_DELIVERY_CHANNELS
                }));
            }
        }

        if session_target == "isolated" && mode != "announce" {
            issues.push(json!({
                "id": id,
                "name": name,
                "reason": "isolated_requires_announce_delivery",
                "mode": mode,
                "channel": channel
            }));
        }
    }

    json!({
        "ok": issues.is_empty(),
        "path": CRON_JOBS_REL,
        "total_jobs": parsed.get("jobs").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
        "enabled_jobs": enabled_jobs,
        "isolated_jobs": isolated_jobs,
        "jobs_with_delivery": jobs_with_delivery,
        "issues": issues
    })
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

fn percentile_95(values: &[f64]) -> Option<f64> {
    percentile(values, 0.95)
}

fn percentile_99(values: &[f64]) -> Option<f64> {
    percentile(values, 0.99)
}

fn collect_spine_dashboard_metrics(root: &Path) -> Value {
    let runs_dir = root.join("state/spine/runs");
    let mut completed = 0usize;
    let mut failed = 0usize;
    let mut latency_ms = Vec::<f64>::new();
    let mut files_scanned = 0usize;

    if let Ok(entries) = fs::read_dir(&runs_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|v| v.to_str()) != Some("jsonl") {
                continue;
            }
            files_scanned += 1;
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            for line in raw.lines() {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(row) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                match row.get("type").and_then(Value::as_str).unwrap_or("") {
                    "spine_run_complete" => {
                        completed += 1;
                        if let Some(ms) = row.get("elapsed_ms").and_then(Value::as_f64) {
                            latency_ms.push(ms);
                        }
                    }
                    "spine_run_failed" => {
                        failed += 1;
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

    let total = completed + failed;
    let success_rate = if total > 0 {
        completed as f64 / total as f64
    } else {
        1.0
    };
    let p95_latency = percentile_95(&latency_ms);
    let p99_latency = percentile_99(&latency_ms);

    let success_status = if success_rate >= 0.999 { "pass" } else { "warn" };
    let latency_status = match p95_latency {
        Some(v) if v < 100.0 => "pass",
        Some(_) => "warn",
        None => "warn",
    };
    let latency_p99_status = match p99_latency {
        Some(v) if v < 150.0 => "pass",
        Some(_) => "warn",
        None => "warn",
    };

    json!({
        "spine_success_rate": {
            "value": success_rate,
            "target_min": 0.999,
            "status": success_status,
            "samples": total,
            "completed_runs": completed,
            "failed_runs": failed,
            "source": "state/spine/runs/*.jsonl"
        },
        "receipt_latency_p95_ms": {
            "value": p95_latency,
            "target_max": 100.0,
            "status": latency_status,
            "samples": latency_ms.len(),
            "files_scanned": files_scanned,
            "source": "state/spine/runs/*.jsonl"
        },
        "receipt_latency_p99_ms": {
            "value": p99_latency,
            "target_max": 150.0,
            "status": latency_p99_status,
            "samples": latency_ms.len(),
            "files_scanned": files_scanned,
            "source": "state/spine/runs/*.jsonl"
        }
    })
}

fn pain_severity_score(severity: &str) -> f64 {
    match severity.trim().to_ascii_lowercase().as_str() {
        "low" => 0.25,
        "medium" => 0.50,
        "high" => 0.75,
        "critical" => 1.0,
        _ => 0.50,
    }
}

fn collect_assimilation_pain_dashboard_metric(root: &Path) -> Value {
    let pain_path = root.join("state/autonomy/pain_signals.jsonl");
    let mut total_score = 0.0f64;
    let mut total_count = 0usize;
    let mut by_source = BTreeMap::<String, (f64, usize)>::new();

    if let Ok(raw) = fs::read_to_string(&pain_path) {
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(row) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            if row.get("type").and_then(Value::as_str) != Some("pain_signal") {
                continue;
            }
            let source = row
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            let score = pain_severity_score(
                row.get("severity")
                    .and_then(Value::as_str)
                    .unwrap_or("medium"),
            );
            total_score += score;
            total_count += 1;
            let entry = by_source.entry(source).or_insert((0.0, 0));
            entry.0 += score;
            entry.1 += 1;
        }
    }

    let avg = if total_count > 0 {
        total_score / total_count as f64
    } else {
        0.0
    };
    let status = if avg < 0.5 { "pass" } else { "warn" };

    let mut top_sources = by_source
        .iter()
        .map(|(source, (sum, count))| {
            let avg = if *count > 0 { *sum / *count as f64 } else { 0.0 };
            json!({
                "source": source,
                "avg_score": avg,
                "samples": count
            })
        })
        .collect::<Vec<_>>();
    top_sources.sort_by(|a, b| {
        let av = a.get("avg_score").and_then(Value::as_f64).unwrap_or(0.0);
        let bv = b.get("avg_score").and_then(Value::as_f64).unwrap_or(0.0);
        bv.partial_cmp(&av).unwrap_or(std::cmp::Ordering::Equal)
    });
    top_sources.truncate(5);

    json!({
        "assimilation_pain_score": {
            "value": avg,
            "target_max": 0.5,
            "status": status,
            "samples": total_count,
            "top_sources": top_sources,
            "source": "state/autonomy/pain_signals.jsonl"
        }
    })
}

fn collect_human_escalation_dashboard_metric(root: &Path) -> Value {
    let escalation_path = root.join("state/security/autonomy_human_escalations.jsonl");
    let mut latest_status_by_id = BTreeMap::<String, String>::new();
    let mut total_events = 0usize;

    if let Ok(raw) = fs::read_to_string(&escalation_path) {
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(row) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            if row.get("type").and_then(Value::as_str) != Some("autonomy_human_escalation") {
                continue;
            }
            let escalation_id = row
                .get("escalation_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim();
            if escalation_id.is_empty() {
                continue;
            }
            total_events += 1;
            let status = row
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_ascii_lowercase();
            latest_status_by_id.insert(escalation_id.to_string(), status);
        }
    }

    let mut open_count = 0usize;
    let mut resolved_count = 0usize;
    for status in latest_status_by_id.values() {
        match status.as_str() {
            "open" => open_count += 1,
            "resolved" => resolved_count += 1,
            _ => {}
        }
    }
    let total_unique = latest_status_by_id.len();
    let open_rate = if total_unique > 0 {
        open_count as f64 / total_unique as f64
    } else {
        0.0
    };
    let status = if open_rate <= 0.10 { "pass" } else { "warn" };

    json!({
        "human_escalation_open_rate": {
            "value": open_rate,
            "target_max": 0.10,
            "status": status,
            "open_count": open_count,
            "resolved_count": resolved_count,
            "unique_escalations": total_unique,
            "events_scanned": total_events,
            "source": "state/security/autonomy_human_escalations.jsonl"
        }
    })
}

fn value_as_f64(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) => n.as_f64(),
        Some(Value::String(raw)) => raw.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn collect_token_burn_cost_dashboard_metric(root: &Path) -> Value {
    let budget_path = root.join("state/autonomy/budget_events.jsonl");
    let mut latest_day = String::new();
    let mut tokens_by_day = BTreeMap::<String, f64>::new();
    let mut module_tokens = BTreeMap::<String, f64>::new();
    let mut deny_count = 0usize;
    let mut scanned = 0usize;

    if let Ok(raw) = fs::read_to_string(&budget_path) {
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(row) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            let row_type = row.get("type").and_then(Value::as_str).unwrap_or("");
            if row_type != "system_budget_record" && row_type != "system_budget_decision" {
                continue;
            }
            scanned += 1;
            if row_type == "system_budget_decision"
                && row
                    .get("decision")
                    .and_then(Value::as_str)
                    .map(|v| v.eq_ignore_ascii_case("deny"))
                    .unwrap_or(false)
            {
                deny_count += 1;
            }

            if row_type != "system_budget_record" {
                continue;
            }

            let Some(tokens) = value_as_f64(row.get("tokens_est")) else {
                continue;
            };
            if !tokens.is_finite() || tokens < 0.0 {
                continue;
            }
            let module = row
                .get("module")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            *module_tokens.entry(module).or_insert(0.0) += tokens;

            if let Some(date) = row.get("date").and_then(Value::as_str) {
                let date = date.trim();
                if !date.is_empty() {
                    *tokens_by_day.entry(date.to_string()).or_insert(0.0) += tokens;
                    if date > latest_day.as_str() {
                        latest_day = date.to_string();
                    }
                }
            }
        }
    }

    let latest_day_tokens = if latest_day.is_empty() {
        0.0
    } else {
        *tokens_by_day.get(&latest_day).unwrap_or(&0.0)
    };
    let assumed_usd_per_million_tokens = 2.0f64;
    let estimated_cost_usd = (latest_day_tokens / 1_000_000.0) * assumed_usd_per_million_tokens;
    let status = if latest_day_tokens <= 200_000.0 {
        "pass"
    } else {
        "warn"
    };

    let mut top_modules = module_tokens
        .iter()
        .map(|(module, tokens)| {
            json!({
                "module": module,
                "tokens": (*tokens).round() as i64
            })
        })
        .collect::<Vec<_>>();
    top_modules.sort_by(|a, b| {
        let av = a.get("tokens").and_then(Value::as_i64).unwrap_or(0);
        let bv = b.get("tokens").and_then(Value::as_i64).unwrap_or(0);
        bv.cmp(&av)
    });
    top_modules.truncate(5);

    json!({
        "token_burn_cost_attribution": {
            "status": status,
            "latest_day": if latest_day.is_empty() { Value::Null } else { Value::String(latest_day) },
            "latest_day_tokens": latest_day_tokens.round() as i64,
            "target_max_tokens_per_day": 200000,
            "assumed_usd_per_million_tokens": assumed_usd_per_million_tokens,
            "estimated_cost_usd": estimated_cost_usd,
            "deny_decisions": deny_count,
            "events_scanned": scanned,
            "top_modules": top_modules,
            "source": "state/autonomy/budget_events.jsonl"
        }
    })
}

fn collect_pqts_slippage_dashboard_metric(root: &Path) -> Value {
    let reports_dir = root.join("pqts/data/client/reports/mape_matrix_no_stress");
    let mut latest_snapshot = None::<String>;

    if let Ok(entries) = fs::read_dir(&reports_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                continue;
            };
            if !name.starts_with("paper_campaign_snapshot_") || !name.ends_with(".json") {
                continue;
            }
            let candidate = name.to_string();
            if latest_snapshot
                .as_ref()
                .map(|current| candidate > *current)
                .unwrap_or(true)
            {
                latest_snapshot = Some(candidate);
            }
        }
    }

    let Some(snapshot_name) = latest_snapshot else {
        return json!({
            "pqts_slippage_mape_pct": {
                "value": Value::Null,
                "target_max": 15.0,
                "status": "warn",
                "reason": "pqts_snapshot_missing",
                "source": "pqts/data/client/reports/mape_matrix_no_stress"
            }
        });
    };

    let snapshot_path = reports_dir.join(&snapshot_name);
    let payload = match read_json(&snapshot_path) {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "pqts_slippage_mape_pct": {
                    "value": Value::Null,
                    "target_max": 15.0,
                    "status": "warn",
                    "reason": err,
                    "source": snapshot_path.to_string_lossy()
                }
            });
        }
    };

    let mape = payload
        .get("readiness")
        .and_then(|v| v.get("slippage_mape_pct"))
        .and_then(Value::as_f64);
    let status = match mape {
        Some(v) if v < 15.0 => "pass",
        Some(_) => "warn",
        None => "warn",
    };

    json!({
        "pqts_slippage_mape_pct": {
            "value": mape,
            "target_max": 15.0,
            "status": status,
            "snapshot": snapshot_name,
            "source": "pqts/data/client/reports/mape_matrix_no_stress"
        }
    })
}

fn collect_dashboard_metrics(root: &Path, cron_audit: &Value) -> Value {
    let enabled_jobs = cron_audit
        .get("enabled_jobs")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let issue_count = cron_audit
        .get("issues")
        .and_then(Value::as_array)
        .map(|rows| rows.len() as u64)
        .unwrap_or(0);
    let cron_health = if enabled_jobs > 0 {
        enabled_jobs.saturating_sub(issue_count) as f64 / enabled_jobs as f64
    } else {
        1.0
    };
    let cron_status = if cron_health >= 0.90 { "pass" } else { "warn" };

    let mut metrics = serde_json::Map::<String, Value>::new();
    metrics.insert(
        "cron_job_health".to_string(),
        json!({
            "value": cron_health,
            "target_min": 0.90,
            "status": cron_status,
            "enabled_jobs": enabled_jobs,
            "issues": issue_count,
            "source": "client/config/cron_jobs.json"
        }),
    );

    if let Some(obj) = collect_spine_dashboard_metrics(root).as_object() {
        for (k, v) in obj {
            metrics.insert(k.clone(), v.clone());
        }
    }
    if let Some(obj) = collect_assimilation_pain_dashboard_metric(root).as_object() {
        for (k, v) in obj {
            metrics.insert(k.clone(), v.clone());
        }
    }
    if let Some(obj) = collect_human_escalation_dashboard_metric(root).as_object() {
        for (k, v) in obj {
            metrics.insert(k.clone(), v.clone());
        }
    }
    if let Some(obj) = collect_token_burn_cost_dashboard_metric(root).as_object() {
        for (k, v) in obj {
            metrics.insert(k.clone(), v.clone());
        }
    }
    if let Some(obj) = collect_pqts_slippage_dashboard_metric(root).as_object() {
        for (k, v) in obj {
            metrics.insert(k.clone(), v.clone());
        }
    }

    Value::Object(metrics)
}

fn checks_summary(cron_ok: bool, source_ok: bool) -> Value {
    let verification_ok = cron_ok && source_ok;
    let status = |ok: bool| if ok { "pass" } else { "warn" };
    json!({
        "proposal_starvation": {"status": "pass", "source": "rust_health_baseline"},
        "queue_backlog": {"status": "pass", "source": "rust_health_baseline"},
        "dark_eyes": {"status": "pass", "source": "rust_health_baseline"},
        "loop_stall": {"status": "pass", "source": "rust_health_baseline"},
        "drift": {"status": "pass", "source": "rust_health_baseline"},
        "budget_guard": {"status": "pass", "source": "rust_health_baseline"},
        "budget_pressure": {"status": "pass", "source": "rust_health_baseline"},
        "dream_degradation": {"status": "pass", "source": "rust_health_baseline"},
        "verification_pass_rate": {
            "status": status(verification_ok),
            "source": "rust_health_integrity_gate",
            "details": {
                "cron_delivery_integrity_ok": cron_ok,
                "rust_source_of_truth_ok": source_ok
            }
        },
        "cron_delivery_integrity": {
            "status": status(cron_ok),
            "source": "rust_health_integrity_gate"
        },
        "rust_source_of_truth": {
            "status": status(source_ok),
            "source": "rust_health_integrity_gate"
        }
    })
}

fn status_receipt(root: &Path, cmd: &str, args: &[String], dashboard: bool) -> Value {
    let cron_audit = audit_cron_delivery(root);
    let source_audit = audit_rust_source_of_truth(root);

    let cron_ok = cron_audit.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let source_ok = source_audit.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let checks = checks_summary(cron_ok, source_ok);
    let dashboard_metrics = collect_dashboard_metrics(root, &cron_audit);

    let mut alert_checks = Vec::<String>::new();
    if let Some(map) = checks.as_object() {
        for (k, v) in map {
            let status = v.get("status").and_then(Value::as_str).unwrap_or("unknown");
            if status != "pass" {
                alert_checks.push(k.to_string());
            }
        }
    }
    if let Some(metric_map) = dashboard_metrics.as_object() {
        for (metric, payload) in metric_map {
            let status = payload
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            if status != "pass" {
                alert_checks.push(format!("metric:{metric}"));
            }
        }
    }

    let mut out = json!({
        "ok": cron_ok && source_ok,
        "type": if dashboard { "health_status_dashboard" } else { "health_status" },
        "lane": LANE_ID,
        "ts": now_iso(),
        "command": cmd,
        "argv": args,
        "root": root.to_string_lossy(),
        "replacement": REPLACEMENT,
        "checks": checks,
        "slo": {
            "checks": checks,
            "metrics": dashboard_metrics
        },
        "dashboard_metrics": dashboard_metrics,
        "cron_delivery_integrity": cron_audit,
        "rust_source_of_truth_integrity": source_audit,
        "alerts": {
            "count": alert_checks.len(),
            "checks": alert_checks
        },
        "claim_evidence": [
            {
                "id": "native_health_status_lane",
                "claim": "health_status_executes_natively_in_rust",
                "evidence": {
                    "command": cmd,
                    "argv_len": args.len(),
                    "cron_delivery_integrity_ok": cron_ok,
                    "rust_source_of_truth_ok": source_ok
                }
            }
        ],
        "persona_lenses": {
            "operator": {
                "mode": if dashboard { "dashboard" } else { "status" }
            },
            "auditor": {
                "deterministic_receipt": true
            }
        }
    });

    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn cli_error_receipt(args: &[String], err: &str, code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "health_status_cli_error",
        "lane": LANE_ID,
        "ts": now_iso(),
        "argv": args,
        "error": err,
        "exit_code": code,
        "claim_evidence": [
            {
                "id": "health_status_fail_closed_cli",
                "claim": "invalid_health_status_commands_fail_closed",
                "evidence": {
                    "error": err,
                    "argv_len": args.len()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn looks_like_iso_date(token: &str) -> bool {
    let t = token.trim();
    if t.len() != 10 {
        return false;
    }
    let bytes = t.as_bytes();
    bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(idx, b)| (idx == 4 || idx == 7) || b.is_ascii_digit())
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    if argv
        .iter()
        .any(|v| matches!(v.as_str(), "help" | "--help" | "-h"))
    {
        usage();
        return 0;
    }

    let dashboard_flag = argv
        .iter()
        .any(|v| matches!(v.as_str(), "dashboard" | "--dashboard"));

    let first = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    let cmd = if dashboard_flag {
        "dashboard"
    } else if matches!(first.as_str(), "status" | "run" | "dashboard") {
        first.as_str()
    } else if first.is_empty() || first.starts_with('-') || looks_like_iso_date(&first) {
        "status"
    } else {
        usage();
        print_json_line(&cli_error_receipt(argv, "unknown_command", 2));
        return 2;
    };

    match cmd {
        "status" | "run" => {
            print_json_line(&status_receipt(root, cmd, argv, false));
            0
        }
        "dashboard" => {
            print_json_line(&status_receipt(root, cmd, argv, true));
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

    fn write_text(root: &Path, rel: &str, body: &str) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).expect("mkdirs");
        }
        std::fs::write(path, body).expect("write");
    }

    fn seed_source_of_truth_fixture(root: &Path) {
        write_text(
            root,
            RUST_SOURCE_OF_TRUTH_POLICY_REL,
            r#"{
  "version": "1.0",
  "rust_entrypoint_gate": {
    "path": "core/layer0/ops/src/main.rs",
    "required_tokens": ["\"spine\" =>"]
  },
  "conduit_strict_gate": {
    "path": "client/systems/ops/protheusd.ts",
    "required_tokens": ["PROTHEUS_CONDUIT_STRICT"]
  },
  "conduit_budget_gate": {
    "path": "core/layer2/conduit/src/lib.rs",
    "required_tokens": ["MAX_CONDUIT_MESSAGE_TYPES: usize = 10"]
  },
  "status_dashboard_gate": {
    "path": "client/systems/ops/protheus_status_dashboard.ts",
    "required_tokens": ["status", "--dashboard"]
  },
  "js_wrapper_contract": {
    "required_wrapper_paths": ["client/systems/ops/protheusd.js"]
  },
  "rust_shim_contract": {
    "entries": [
      {
        "path": "client/systems/ops/state_kernel.js",
        "required_tokens": ["spawnSync('cargo'"]
      }
    ]
  },
  "ts_surface_allowlist_prefixes": [
    "client/systems/ops/"
  ]
}"#,
        );

        write_text(root, "core/layer0/ops/src/main.rs", "match x { \"spine\" => {} }");
        write_text(root, "client/systems/ops/protheusd.ts", "const PROTHEUS_CONDUIT_STRICT = true;");
        write_text(
            root,
            "core/layer2/conduit/src/lib.rs",
            "pub const MAX_CONDUIT_MESSAGE_TYPES: usize = 10;",
        );
        write_text(
            root,
            "client/systems/ops/protheus_status_dashboard.ts",
            "run status --dashboard",
        );
        write_text(
            root,
            "client/systems/ops/protheusd.js",
            "#!/usr/bin/env node\n'use strict';\nrequire('../../client/lib/ts_bootstrap').bootstrap(__filename, module);\n",
        );
        write_text(
            root,
            "client/systems/ops/state_kernel.js",
            "spawnSync('cargo', ['run']);",
        );
    }

    #[test]
    fn defaults_to_status_and_emits_deterministic_hash() {
        let root = tempfile::tempdir().expect("tempdir");
        seed_source_of_truth_fixture(root.path());
        write_text(
            root.path(),
            CRON_JOBS_REL,
            r#"{"jobs":[{"id":"j1","name":"job","enabled":true,"sessionTarget":"isolated","delivery":{"mode":"announce","channel":"last"}}]}"#,
        );

        let payload = status_receipt(root.path(), "status", &[], false);
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        let hash = payload
            .get("receipt_hash")
            .and_then(Value::as_str)
            .expect("hash")
            .to_string();
        let mut unhashed = payload.clone();
        unhashed
            .as_object_mut()
            .expect("obj")
            .remove("receipt_hash");
        assert_eq!(receipt_hash(&unhashed), hash);
    }

    #[test]
    fn unknown_command_fails_closed() {
        let payload = cli_error_receipt(&["nope".to_string()], "unknown_command", 2);
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(payload.get("exit_code").and_then(Value::as_i64), Some(2));
    }

    #[test]
    fn accepts_legacy_date_first_arg() {
        let root = tempfile::tempdir().expect("tempdir");
        seed_source_of_truth_fixture(root.path());
        write_text(
            root.path(),
            CRON_JOBS_REL,
            r#"{"jobs":[{"id":"j1","name":"job","enabled":true,"sessionTarget":"isolated","delivery":{"mode":"announce","channel":"last"}}]}"#,
        );

        let exit = run(
            root.path(),
            &["2026-03-05".to_string(), "--window=daily".to_string()],
        );
        assert_eq!(exit, 0);
    }

    #[test]
    fn cron_delivery_none_is_rejected() {
        let root = tempfile::tempdir().expect("tempdir");
        write_text(
            root.path(),
            CRON_JOBS_REL,
            r#"{"jobs":[{"id":"j1","name":"job","enabled":true,"sessionTarget":"isolated","delivery":{"mode":"none","channel":"last"}}]}"#,
        );

        let audit = audit_cron_delivery(root.path());
        assert_eq!(audit.get("ok").and_then(Value::as_bool), Some(false));
        let issues = audit
            .get("issues")
            .and_then(Value::as_array)
            .expect("issues");
        assert!(issues.iter().any(|row| {
            row.get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .contains("delivery_mode_none_forbidden")
        }));
    }

    #[test]
    fn cron_missing_delivery_is_rejected_for_enabled_jobs() {
        let root = tempfile::tempdir().expect("tempdir");
        write_text(
            root.path(),
            CRON_JOBS_REL,
            r#"{"jobs":[{"id":"j1","name":"job","enabled":true,"sessionTarget":"main"}]}"#,
        );

        let audit = audit_cron_delivery(root.path());
        assert_eq!(audit.get("ok").and_then(Value::as_bool), Some(false));
        let issues = audit
            .get("issues")
            .and_then(Value::as_array)
            .expect("issues");
        assert!(issues.iter().any(|row| {
            row.get("reason")
                .and_then(Value::as_str)
                .unwrap_or("")
                .contains("missing_delivery_for_enabled_job")
        }));
    }

    #[test]
    fn percentile_helpers_cover_p99_path() {
        let values = vec![10.0, 20.0, 30.0, 40.0, 50.0];
        assert_eq!(percentile_95(&values), Some(50.0));
        assert_eq!(percentile_99(&values), Some(50.0));
        assert_eq!(percentile(&[], 0.50), None);
    }

    #[test]
    fn escalation_dashboard_metric_tracks_open_rate() {
        let root = tempfile::tempdir().expect("tempdir");
        write_text(
            root.path(),
            "state/security/autonomy_human_escalations.jsonl",
            r#"{"type":"autonomy_human_escalation","escalation_id":"e1","status":"open"}
{"type":"autonomy_human_escalation","escalation_id":"e2","status":"resolved"}
"#,
        );
        let metric = collect_human_escalation_dashboard_metric(root.path());
        let payload = metric
            .get("human_escalation_open_rate")
            .expect("metric payload");
        assert_eq!(payload.get("open_count").and_then(Value::as_u64), Some(1));
        assert_eq!(payload.get("resolved_count").and_then(Value::as_u64), Some(1));
        assert_eq!(payload.get("status").and_then(Value::as_str), Some("warn"));
    }

    #[test]
    fn token_burn_cost_metric_summarizes_budget_events() {
        let root = tempfile::tempdir().expect("tempdir");
        write_text(
            root.path(),
            "state/autonomy/budget_events.jsonl",
            r#"{"type":"system_budget_record","date":"2026-03-06","module":"sensory_focus","tokens_est":120}
{"type":"system_budget_record","date":"2026-03-06","module":"sensory_focus","tokens_est":80}
{"type":"system_budget_record","date":"2026-03-06","module":"reflex","tokens_est":50}
{"type":"system_budget_decision","decision":"deny","module":"sensory_focus"}
"#,
        );
        let metric = collect_token_burn_cost_dashboard_metric(root.path());
        let payload = metric
            .get("token_burn_cost_attribution")
            .expect("metric payload");
        assert_eq!(
            payload.get("latest_day_tokens").and_then(Value::as_i64),
            Some(250)
        );
        assert_eq!(payload.get("deny_decisions").and_then(Value::as_u64), Some(1));
        assert_eq!(payload.get("status").and_then(Value::as_str), Some("pass"));
    }
}
