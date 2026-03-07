use crate::lane_contracts::{build_receipt_row, ClaimEvidenceRow};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

#[derive(Clone, Debug)]
struct TransitionPaths {
    latest_path: PathBuf,
    receipts_path: PathBuf,
    selector_path: PathBuf,
    benchmark_path: PathBuf,
    benchmark_latest_path: PathBuf,
    benchmark_report_path: PathBuf,
    memory_index_path: PathBuf,
    rust_crate_path: PathBuf,
}

#[derive(Clone, Debug)]
struct TransitionThresholds {
    min_speedup_for_cutover: f64,
    max_parity_error_count: i64,
    min_stable_runs_for_retirement: usize,
}

#[derive(Clone, Debug)]
struct TransitionBenchmark {
    mode: String,
    require_rust_transport: String,
}

#[derive(Clone, Debug)]
struct TransitionPolicy {
    version: String,
    enabled: bool,
    shadow_only: bool,
    paths: TransitionPaths,
    thresholds: TransitionThresholds,
    benchmark: TransitionBenchmark,
    raw_soak: Value,
}

#[derive(Clone, Debug)]
struct AutoDecision {
    backend: String,
    active_engine: String,
    eligible: bool,
    stable_runs: usize,
    avg_speedup: f64,
    max_parity_errors: i64,
    auto_reason: String,
}

fn now_iso() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn parse_kv_args(args: &[String]) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let mut idx = 0usize;
    while idx < args.len() {
        let token = &args[idx];
        if !token.starts_with("--") {
            idx += 1;
            continue;
        }
        let raw = token.trim_start_matches("--");
        if let Some(eq_idx) = raw.find('=') {
            out.insert(raw[..eq_idx].to_string(), raw[eq_idx + 1..].to_string());
            idx += 1;
            continue;
        }
        if idx + 1 < args.len() && !args[idx + 1].starts_with("--") {
            out.insert(raw.to_string(), args[idx + 1].clone());
            idx += 2;
            continue;
        }
        out.insert(raw.to_string(), "true".to_string());
        idx += 1;
    }
    out
}

fn clean_text(raw: &str, max_len: usize) -> String {
    raw.split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
        .trim()
        .chars()
        .take(max_len)
        .collect::<String>()
}

fn normalize_token(raw: &str, max_len: usize) -> String {
    clean_text(raw, max_len)
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

fn to_bool(raw: Option<&Value>, fallback: bool) -> bool {
    match raw {
        Some(Value::Bool(v)) => *v,
        Some(Value::Number(v)) => v.as_i64().unwrap_or(0) != 0,
        Some(Value::String(v)) => {
            let norm = normalize_token(v, 20);
            if ["1", "true", "yes", "on"].contains(&norm.as_str()) {
                true
            } else if ["0", "false", "no", "off"].contains(&norm.as_str()) {
                false
            } else {
                fallback
            }
        }
        _ => fallback,
    }
}

fn clamp_i64(raw: Option<&Value>, min: i64, max: i64, fallback: i64) -> i64 {
    let base = match raw {
        Some(Value::Number(v)) => v.as_i64().unwrap_or(fallback),
        Some(Value::String(v)) => v.parse::<i64>().unwrap_or(fallback),
        _ => fallback,
    };
    base.max(min).min(max)
}

fn clamp_usize(raw: Option<&Value>, min: usize, max: usize, fallback: usize) -> usize {
    let base = match raw {
        Some(Value::Number(v)) => v.as_u64().unwrap_or(fallback as u64) as usize,
        Some(Value::String(v)) => v.parse::<usize>().unwrap_or(fallback),
        _ => fallback,
    };
    base.max(min).min(max)
}

fn parse_f64(raw: Option<&Value>, fallback: f64) -> f64 {
    match raw {
        Some(Value::Number(v)) => v.as_f64().unwrap_or(fallback),
        Some(Value::String(v)) => v.parse::<f64>().unwrap_or(fallback),
        _ => fallback,
    }
}

fn resolve_path(root: &Path, raw: Option<&Value>, fallback_rel: &str) -> PathBuf {
    let text = raw
        .and_then(|v| v.as_str())
        .map(|v| v.trim().to_string())
        .unwrap_or_default();
    if text.is_empty() {
        return root.join(fallback_rel);
    }
    let p = PathBuf::from(text);
    if p.is_absolute() {
        p
    } else {
        root.join(p)
    }
}

fn read_json(path: &Path, fallback: Value) -> Value {
    let Ok(raw) = fs::read_to_string(path) else {
        return fallback;
    };
    serde_json::from_str::<Value>(&raw).unwrap_or(fallback)
}

fn write_json_atomic(path: &Path, payload: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{e}"))?;
    }
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    let body = serde_json::to_string_pretty(payload).map_err(|e| format!("encode_failed:{e}"))?;
    fs::write(&tmp, format!("{body}\n")).map_err(|e| format!("tmp_write_failed:{e}"))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename_failed:{e}"))?;
    Ok(())
}

fn append_jsonl(path: &Path, payload: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{e}"))?;
    }
    let row = serde_json::to_string(payload).map_err(|e| format!("encode_failed:{e}"))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open_failed:{e}"))?;
    file.write_all(format!("{row}\n").as_bytes())
        .map_err(|e| format!("append_failed:{e}"))
}

fn stable_hash_text(raw: &str, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    let digest = hasher.finalize();
    let hex = hex::encode(digest);
    let keep = len.min(hex.len());
    hex[..keep].to_string()
}

fn default_policy(root: &Path) -> TransitionPolicy {
    TransitionPolicy {
        version: "1.0".to_string(),
        enabled: true,
        shadow_only: true,
        paths: TransitionPaths {
            latest_path: root.join("state/client/memory/rust_transition/latest.json"),
            receipts_path: root.join("state/client/memory/rust_transition/receipts.jsonl"),
            selector_path: root.join("state/client/memory/rust_transition/backend_selector.json"),
            benchmark_path: root.join("state/client/memory/rust_transition/benchmark_history.json"),
            benchmark_latest_path: root.join("state/client/memory/rust_transition/benchmark_latest.json"),
            benchmark_report_path: root.join("benchmarks/memory-stage1.md"),
            memory_index_path: root.join("MEMORY_INDEX.md"),
            rust_crate_path: root.join("core/layer0/memory"),
        },
        thresholds: TransitionThresholds {
            min_speedup_for_cutover: 1.2,
            max_parity_error_count: 0,
            min_stable_runs_for_retirement: 10,
        },
        benchmark: TransitionBenchmark {
            mode: "probe_commands".to_string(),
            require_rust_transport: "any".to_string(),
        },
        raw_soak: json!({
            "enabled": true,
            "window_hours": 24,
            "max_window_hours": 48,
            "min_rows": 20,
            "min_pass_rate": 0.997,
            "max_fallback_trigger_count": 0,
            "max_restart_count": 2,
            "max_rust_p99_ms": 2000,
            "restart_history_path": "state/client/memory/rust_transition/daemon_restart_history.jsonl",
            "promotion_decisions_path": "state/client/memory/rust_transition/soak_promotion_decisions.jsonl"
        }),
    }
}

fn load_policy(root: &Path, policy_path: &Path) -> TransitionPolicy {
    let defaults = default_policy(root);
    let raw = read_json(policy_path, json!({}));
    let paths_raw = raw.get("paths").cloned().unwrap_or_else(|| json!({}));
    let thresholds_raw = raw.get("thresholds").cloned().unwrap_or_else(|| json!({}));
    let benchmark_raw = raw.get("benchmark").cloned().unwrap_or_else(|| json!({}));
    let soak_raw = raw
        .get("soak")
        .cloned()
        .unwrap_or(defaults.raw_soak.clone());

    TransitionPolicy {
        version: clean_text(
            raw.get("version")
                .and_then(Value::as_str)
                .unwrap_or(&defaults.version),
            32,
        ),
        enabled: to_bool(raw.get("enabled"), defaults.enabled),
        shadow_only: to_bool(raw.get("shadow_only"), defaults.shadow_only),
        paths: TransitionPaths {
            latest_path: resolve_path(
                root,
                paths_raw.get("latest_path"),
                "state/client/memory/rust_transition/latest.json",
            ),
            receipts_path: resolve_path(
                root,
                paths_raw.get("receipts_path"),
                "state/client/memory/rust_transition/receipts.jsonl",
            ),
            selector_path: resolve_path(
                root,
                paths_raw.get("selector_path"),
                "state/client/memory/rust_transition/backend_selector.json",
            ),
            benchmark_path: resolve_path(
                root,
                paths_raw.get("benchmark_path"),
                "state/client/memory/rust_transition/benchmark_history.json",
            ),
            benchmark_latest_path: resolve_path(
                root,
                paths_raw.get("benchmark_latest_path"),
                "state/client/memory/rust_transition/benchmark_latest.json",
            ),
            benchmark_report_path: resolve_path(
                root,
                paths_raw.get("benchmark_report_path"),
                "benchmarks/memory-stage1.md",
            ),
            memory_index_path: resolve_path(
                root,
                paths_raw.get("memory_index_path"),
                "MEMORY_INDEX.md",
            ),
            rust_crate_path: resolve_path(root, paths_raw.get("rust_crate_path"), "core/layer0/memory"),
        },
        thresholds: TransitionThresholds {
            min_speedup_for_cutover: parse_f64(
                thresholds_raw.get("min_speedup_for_cutover"),
                defaults.thresholds.min_speedup_for_cutover,
            ),
            max_parity_error_count: clamp_i64(
                thresholds_raw.get("max_parity_error_count"),
                0,
                1_000_000,
                defaults.thresholds.max_parity_error_count,
            ),
            min_stable_runs_for_retirement: clamp_usize(
                thresholds_raw.get("min_stable_runs_for_retirement"),
                1,
                1_000_000,
                defaults.thresholds.min_stable_runs_for_retirement,
            ),
        },
        benchmark: TransitionBenchmark {
            mode: normalize_token(
                benchmark_raw
                    .get("mode")
                    .and_then(Value::as_str)
                    .unwrap_or(&defaults.benchmark.mode),
                40,
            ),
            require_rust_transport: normalize_token(
                benchmark_raw
                    .get("require_rust_transport")
                    .and_then(Value::as_str)
                    .unwrap_or(&defaults.benchmark.require_rust_transport),
                20,
            ),
        },
        raw_soak: soak_raw,
    }
}

fn policy_scope_id(policy: &TransitionPolicy) -> String {
    stable_hash_text(
        &[
            clean_text(&policy.version, 32),
            clean_text(policy.paths.benchmark_path.to_string_lossy().as_ref(), 240),
            clean_text(
                policy
                    .paths
                    .benchmark_report_path
                    .to_string_lossy()
                    .as_ref(),
                240,
            ),
            clean_text(
                policy.paths.memory_index_path.to_string_lossy().as_ref(),
                240,
            ),
            clean_text(policy.paths.rust_crate_path.to_string_lossy().as_ref(), 240),
            clean_text(&policy.benchmark.mode, 40),
            clean_text(&policy.benchmark.require_rust_transport, 20),
        ]
        .join("|"),
        24,
    )
}

fn transition_claims(
    claim: &str,
    evidence: Vec<String>,
    lenses: Vec<&str>,
) -> Vec<ClaimEvidenceRow> {
    vec![ClaimEvidenceRow {
        claim: claim.to_string(),
        evidence,
        persona_lenses: lenses.into_iter().map(|v| v.to_string()).collect(),
    }]
}

fn write_transition_receipt(
    policy: &TransitionPolicy,
    payload: &Value,
    claims: &[ClaimEvidenceRow],
) {
    let ts = payload
        .get("ts")
        .and_then(Value::as_str)
        .map(|v| v.to_string())
        .unwrap_or_else(now_iso);
    let row = match build_receipt_row(
        payload,
        "rust_memory_transition_receipt",
        "1.0",
        "receipt",
        &ts,
        claims,
    ) {
        Ok(v) => v,
        Err(_) => return,
    };
    let _ = write_json_atomic(&policy.paths.latest_path, &row);
    let _ = append_jsonl(&policy.paths.receipts_path, &row);
}

fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn read_benchmark_rows(policy: &TransitionPolicy, scope_id: &str) -> Vec<Value> {
    let history = read_json(&policy.paths.benchmark_path, json!({ "rows": [] }));
    let Some(rows) = history.get("rows").and_then(Value::as_array) else {
        return vec![];
    };
    rows.iter()
        .filter(|row| {
            row.get("policy_scope")
                .and_then(Value::as_str)
                .map(|scope| clean_text(scope, 80) == scope_id)
                .unwrap_or(false)
        })
        .cloned()
        .collect::<Vec<Value>>()
}

fn number_or_zero(row: &Value, key: &str) -> f64 {
    row.get(key)
        .and_then(|v| match v {
            Value::Number(n) => n.as_f64(),
            Value::String(s) => s.parse::<f64>().ok(),
            _ => None,
        })
        .unwrap_or(0.0)
}

fn parity_or_zero(row: &Value) -> i64 {
    row.get("parity_error_count")
        .and_then(|v| match v {
            Value::Number(n) => n.as_i64(),
            Value::String(s) => s.parse::<i64>().ok(),
            _ => None,
        })
        .unwrap_or(0)
        .max(0)
}

fn evaluate_auto_selector(policy: &TransitionPolicy) -> AutoDecision {
    let scope_id = policy_scope_id(policy);
    let rows = read_benchmark_rows(policy, &scope_id);
    let min_rows = policy.thresholds.min_stable_runs_for_retirement;
    let start = rows.len().saturating_sub(min_rows);
    let recent = rows[start..].to_vec();
    let avg_speedup = if recent.is_empty() {
        0.0
    } else {
        recent
            .iter()
            .map(|row| number_or_zero(row, "speedup"))
            .sum::<f64>()
            / recent.len() as f64
    };
    let avg_speedup = (avg_speedup * 1_000_000.0).round() / 1_000_000.0;
    let max_parity_errors = recent.iter().map(parity_or_zero).max().unwrap_or(0).max(0);
    let eligible = recent.len() >= min_rows
        && avg_speedup >= policy.thresholds.min_speedup_for_cutover
        && max_parity_errors <= policy.thresholds.max_parity_error_count;
    let backend = if eligible {
        "rust_shadow".to_string()
    } else {
        "js".to_string()
    };
    let active_engine = if backend == "js" {
        "js".to_string()
    } else {
        "rust".to_string()
    };
    AutoDecision {
        backend,
        active_engine,
        eligible,
        stable_runs: recent.len(),
        avg_speedup,
        max_parity_errors,
        auto_reason: if eligible {
            "benchmark_gate_pass".to_string()
        } else {
            "benchmark_gate_fail".to_string()
        },
    }
}

fn persist_selector(
    policy: &TransitionPolicy,
    backend: &str,
    active_engine: &str,
    auto_reason: Option<&str>,
) {
    let mut selector = json!({
        "schema_version": "1.0",
        "backend": backend,
        "active_engine": active_engine,
        "fallback_backend": "js",
        "updated_at": now_iso()
    });
    if let Some(reason) = auto_reason {
        selector["auto_selected"] = Value::Bool(true);
        selector["auto_reason"] = Value::String(reason.to_string());
    }
    let _ = write_json_atomic(&policy.paths.selector_path, &selector);
}

fn set_selector(policy: &TransitionPolicy, backend_raw: &str) -> Value {
    let backend = normalize_token(backend_raw, 20);
    if !["js", "rust", "rust_shadow", "rust_live"].contains(&backend.as_str()) {
        return json!({
            "ok": false,
            "error": "invalid_backend",
            "backend": backend
        });
    }
    let active_engine = if backend == "js" { "js" } else { "rust" };
    persist_selector(policy, &backend, active_engine, None);
    let out = json!({
        "ts": now_iso(),
        "type": "rust_memory_backend_selector",
        "ok": true,
        "backend": backend,
        "active_engine": active_engine,
        "fallback_backend": "js"
    });
    write_transition_receipt(
        policy,
        &out,
        &transition_claims(
            "selector decision is deterministic and fail-safe",
            vec![
                format!("path:{}", policy.paths.selector_path.to_string_lossy()),
                format!("backend:{}", out["backend"].as_str().unwrap_or("")),
            ],
            vec!["migration_guard", "operator_safety"],
        ),
    );
    out
}

fn auto_selector(policy: &TransitionPolicy) -> Value {
    let decision = evaluate_auto_selector(policy);
    persist_selector(
        policy,
        &decision.backend,
        &decision.active_engine,
        Some(&decision.auto_reason),
    );
    let out = json!({
        "ts": now_iso(),
        "type": "rust_memory_auto_selector",
        "ok": true,
        "backend": decision.backend,
        "active_engine": decision.active_engine,
        "eligible": decision.eligible,
        "stable_runs": decision.stable_runs,
        "avg_speedup": decision.avg_speedup,
        "max_parity_errors": decision.max_parity_errors
    });
    write_transition_receipt(
        policy,
        &out,
        &transition_claims(
            "auto selector is benchmark-threshold gated",
            vec![
                format!("path:{}", policy.paths.benchmark_path.to_string_lossy()),
                format!("stable_runs:{}", out["stable_runs"].as_u64().unwrap_or(0)),
                format!("avg_speedup:{}", out["avg_speedup"].as_f64().unwrap_or(0.0)),
            ],
            vec!["migration_guard", "performance_governor"],
        ),
    );
    out
}

fn retire_check(policy: &TransitionPolicy) -> Value {
    let decision = evaluate_auto_selector(policy);
    let scope_id = policy_scope_id(policy);
    let out = json!({
        "ts": now_iso(),
        "type": "rust_memory_retire_check",
        "ok": true,
        "policy_scope": scope_id,
        "eligible_for_js_artifact_retirement": decision.eligible,
        "stable_runs": decision.stable_runs,
        "avg_speedup": decision.avg_speedup,
        "max_parity_errors": decision.max_parity_errors
    });
    write_transition_receipt(
        policy,
        &out,
        &transition_claims(
            "retire check preserves parity and speedup gates",
            vec![
                format!("path:{}", policy.paths.benchmark_path.to_string_lossy()),
                format!("max_parity_errors:{}", decision.max_parity_errors),
                format!("avg_speedup:{}", decision.avg_speedup),
            ],
            vec!["migration_guard", "constitution_safety"],
        ),
    );
    out
}

fn status(policy: &TransitionPolicy, root: &Path) -> Value {
    let latest = read_json(&policy.paths.latest_path, json!({}));
    let benchmark_latest = read_json(&policy.paths.benchmark_latest_path, json!({}));
    let selector = read_json(
        &policy.paths.selector_path,
        json!({
            "backend": "js",
            "active_engine": "js",
            "fallback_backend": "js"
        }),
    );
    json!({
        "ok": true,
        "type": "rust_memory_transition_status",
        "shadow_only": policy.shadow_only,
        "soak": policy.raw_soak.clone(),
        "latest": latest,
        "benchmark_latest": benchmark_latest,
        "selector": selector,
        "paths": {
            "latest_path": rel_path(root, &policy.paths.latest_path),
            "receipts_path": rel_path(root, &policy.paths.receipts_path),
            "selector_path": rel_path(root, &policy.paths.selector_path)
        }
    })
}

fn usage() {
    println!("rust_memory_transition_lane.js");
    println!("Usage:");
    println!("  rust_memory_transition_lane selector --backend=js|rust|rust_shadow|rust_live [--policy=<path>]");
    println!("  rust_memory_transition_lane auto-selector [--policy=<path>]");
    println!("  rust_memory_transition_lane pilot [--policy=<path>]");
    println!("  rust_memory_transition_lane benchmark [--policy=<path>]");
    println!("  rust_memory_transition_lane consistency-check [--policy=<path>]");
    println!("  rust_memory_transition_lane index-probe [--policy=<path>]");
    println!("  rust_memory_transition_lane retire-check [--policy=<path>]");
    println!("  rust_memory_transition_lane soak-gate [--policy=<path>]");
    println!("  rust_memory_transition_lane status [--policy=<path>]");
    println!("  other commands fall back to legacy bridge");
}

pub fn maybe_run(root: &Path, argv: &[String]) -> Option<i32> {
    let cmd = argv
        .first()
        .map(|v| normalize_token(v, 80))
        .unwrap_or_else(|| "status".to_string());
    let kv = parse_kv_args(if argv.is_empty() { &[] } else { &argv[1..] });
    let policy_path = {
        let explicit = kv.get("policy").cloned().or_else(|| {
            std::env::var("RUST_MEMORY_TRANSITION_POLICY_PATH")
                .ok()
                .map(|v| v.trim().to_string())
        });
        if let Some(path) = explicit {
            let candidate = PathBuf::from(path);
            if candidate.is_absolute() {
                candidate
            } else {
                root.join(candidate)
            }
        } else {
            root.join("client/config/rust_memory_transition_policy.json")
        }
    };
    let policy = load_policy(root, &policy_path);
    if !policy.enabled {
        println!(
            "{}",
            serde_json::to_string_pretty(
                &json!({"ok": false, "error": "rust_memory_transition_disabled"})
            )
            .unwrap_or_else(|_| "{\"ok\":false}".to_string())
        );
        return Some(1);
    }

    let out = match cmd.as_str() {
        "help" | "--help" | "-h" => {
            usage();
            return Some(0);
        }
        "selector" => set_selector(&policy, kv.get("backend").map(|v| v.as_str()).unwrap_or("")),
        "auto-selector" => auto_selector(&policy),
        "retire-check" => retire_check(&policy),
        "status" => status(&policy, root),
        _ => return None,
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{\"ok\":false}".to_string())
    );
    Some(0)
}

#[cfg(test)]
mod tests {
    use super::{evaluate_auto_selector, load_policy, policy_scope_id, write_transition_receipt};
    use crate::lane_contracts::ClaimEvidenceRow;
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|dur| dur.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("{prefix}-{now}"));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn evaluate_auto_selector_matches_threshold_gate() {
        let root = unique_temp_dir("transition-lane-auto-selector");
        let policy_path = root.join("policy.json");
        fs::create_dir_all(root.join("state/client/memory/rust_transition")).expect("mkdir state");
        fs::write(&policy_path, "{}").expect("write policy");
        let policy = load_policy(&root, &policy_path);
        let scope_id = policy_scope_id(&policy);
        let history_path = root.join("state/client/memory/rust_transition/benchmark_history.json");
        let rows = (0..12)
            .map(|idx| {
                json!({
                    "policy_scope": scope_id,
                    "speedup": if idx < 10 { 1.5 } else { 1.3 },
                    "parity_error_count": 0
                })
            })
            .collect::<Vec<_>>();
        fs::write(
            &history_path,
            serde_json::to_string_pretty(&json!({ "rows": rows })).expect("encode"),
        )
        .expect("write history");

        let decision = evaluate_auto_selector(&policy);
        assert!(decision.eligible);
        assert_eq!(decision.backend, "rust_shadow");
        assert_eq!(decision.active_engine, "rust");
    }

    #[test]
    fn transition_receipt_write_is_deterministic_and_claim_bounded() {
        let root = unique_temp_dir("transition-lane-receipt");
        let policy_path = root.join("policy.json");
        fs::write(&policy_path, "{}").expect("write policy");
        let policy = load_policy(&root, &policy_path);
        let claims = vec![ClaimEvidenceRow {
            claim: "auto selector is benchmark-threshold gated".to_string(),
            evidence: vec![
                "path:state/client/memory/rust_transition/benchmark_history.json".to_string(),
                "stable_runs:10".to_string(),
            ],
            persona_lenses: vec![
                "migration_guard".to_string(),
                "performance_governor".to_string(),
            ],
        }];
        let payload_a = json!({
            "ts": "2026-03-05T00:00:00Z",
            "type": "rust_memory_auto_selector",
            "ok": true,
            "stable_runs": 10,
            "avg_speedup": 1.4
        });
        let payload_b = json!({
            "avg_speedup": 1.4,
            "stable_runs": 10,
            "ok": true,
            "type": "rust_memory_auto_selector",
            "ts": "2026-03-05T00:00:00Z"
        });

        write_transition_receipt(&policy, &payload_a, &claims);
        let first = fs::read_to_string(root.join("state/client/memory/rust_transition/latest.json"))
            .expect("read first");
        write_transition_receipt(&policy, &payload_b, &claims);
        let second = fs::read_to_string(root.join("state/client/memory/rust_transition/latest.json"))
            .expect("read second");

        let first_hash = serde_json::from_str::<serde_json::Value>(&first)
            .expect("decode first")
            .get("receipt_hash")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let second_hash = serde_json::from_str::<serde_json::Value>(&second)
            .expect("decode second")
            .get("receipt_hash")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        assert_eq!(first_hash, second_hash);
    }
}
