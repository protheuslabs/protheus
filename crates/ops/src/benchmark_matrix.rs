use crate::{
    deterministic_receipt_hash, now_iso, parse_args, run_runtime_efficiency_floor,
    status_runtime_efficiency_floor,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::fs;
use std::io::Write;
use std::path::Path;

const LANE_ID: &str = "benchmark_matrix";
const DEFAULT_SNAPSHOT_REL: &str = "config/competitive_benchmark_snapshot_2026_02.json";
const STATE_LATEST_REL: &str = "state/ops/competitive_benchmark_matrix/latest.json";
const STATE_HISTORY_REL: &str = "state/ops/competitive_benchmark_matrix/history.jsonl";
const MIN_BAR_WIDTH: usize = 10;
const MAX_BAR_WIDTH: usize = 80;
const DEFAULT_BAR_WIDTH: usize = 44;

#[derive(Clone, Copy)]
struct Category {
    key: &'static str,
    label: &'static str,
    lower_is_better: bool,
    unit: &'static str,
}

const CATEGORIES: [Category; 6] = [
    Category {
        key: "cold_start_ms",
        label: "Cold Start Time (lower is better)",
        lower_is_better: true,
        unit: "ms",
    },
    Category {
        key: "idle_memory_mb",
        label: "Idle Memory Usage (lower is better)",
        lower_is_better: true,
        unit: "MB",
    },
    Category {
        key: "install_size_mb",
        label: "Install Size (lower is better)",
        lower_is_better: true,
        unit: "MB",
    },
    Category {
        key: "security_systems",
        label: "Security Systems (higher is better)",
        lower_is_better: false,
        unit: "count",
    },
    Category {
        key: "channel_adapters",
        label: "Channel Adapters (higher is better)",
        lower_is_better: false,
        unit: "count",
    },
    Category {
        key: "llm_providers",
        label: "LLM Providers (higher is better)",
        lower_is_better: false,
        unit: "count",
    },
];

fn usage() {
    println!("Usage:");
    println!(
        "  protheus-ops benchmark-matrix run [--snapshot=<path>] [--refresh-runtime=1|0] [--bar-width=44]"
    );
    println!(
        "  protheus-ops benchmark-matrix status [--snapshot=<path>] [--refresh-runtime=1|0] [--bar-width=44]"
    );
}

fn parse_bool_flag(raw: Option<&str>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

fn parse_bar_width(raw: Option<&str>) -> usize {
    let n = raw
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(DEFAULT_BAR_WIDTH);
    n.clamp(MIN_BAR_WIDTH, MAX_BAR_WIDTH)
}

fn read_json(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("read_json_failed:{}:{err}", path.display()))?;
    serde_json::from_str::<Value>(&raw)
        .map_err(|err| format!("parse_json_failed:{}:{err}", path.display()))
}

fn get_f64(value: &Value, key: &str) -> Option<f64> {
    value.get(key).and_then(Value::as_f64)
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create_dir_failed:{}:{err}", parent.display()))?;
    }
    let tmp = path.with_extension("tmp");
    let payload = serde_json::to_string_pretty(value)
        .map_err(|err| format!("encode_json_failed:{}:{err}", path.display()))?;
    fs::write(&tmp, format!("{payload}\n"))
        .map_err(|err| format!("write_tmp_failed:{}:{err}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|err| format!("rename_tmp_failed:{}:{err}", path.display()))
}

fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("create_dir_failed:{}:{err}", parent.display()))?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("open_jsonl_failed:{}:{err}", path.display()))?;
    let line = serde_json::to_string(value)
        .map_err(|err| format!("encode_jsonl_failed:{}:{err}", path.display()))?;
    writeln!(file, "{line}").map_err(|err| format!("append_jsonl_failed:{}:{err}", path.display()))
}

fn count_guard_checks(root: &Path) -> Result<f64, String> {
    let payload = read_json(&root.join("config/guard_check_registry.json"))?;
    let count = payload
        .get("merge_guard")
        .and_then(|v| v.get("checks"))
        .and_then(Value::as_array)
        .map(|rows| rows.len() as f64)
        .unwrap_or(0.0);
    Ok(count)
}

fn count_channel_adapters(root: &Path) -> Result<f64, String> {
    let payload = read_json(&root.join("config/platform_adaptation_channels.json"))?;
    let count = payload
        .get("channels")
        .and_then(Value::as_array)
        .map(|rows| rows.len() as f64)
        .unwrap_or(0.0);
    Ok(count)
}

fn count_llm_providers(root: &Path) -> Result<f64, String> {
    let mut providers = BTreeSet::<String>::new();

    let onboarding = read_json(&root.join("config/provider_onboarding_manifest.json"))?;
    if let Some(entries) = onboarding.get("providers").and_then(Value::as_object) {
        for record in entries.values() {
            if let Some(provider_key) = record.get("provider_key").and_then(Value::as_str) {
                let normalized = provider_key.trim().to_ascii_lowercase();
                if !normalized.is_empty() {
                    providers.insert(normalized);
                }
            }
        }
    }

    let recovery = read_json(&root.join("config/model_health_auto_recovery_policy.json"))?;
    if let Some(items) = recovery.get("providers").and_then(Value::as_array) {
        for item in items {
            if let Some(name) = item.as_str() {
                let normalized = name.trim().to_ascii_lowercase();
                if !normalized.is_empty() {
                    providers.insert(normalized);
                }
            }
        }
    }

    Ok(providers.len() as f64)
}

fn extract_runtime_metrics(runtime_json: &Value) -> Option<(f64, f64, f64)> {
    let latest = runtime_json
        .get("latest")
        .cloned()
        .unwrap_or_else(|| runtime_json.clone());
    let metrics = latest.get("metrics")?;
    let cold_start_ms = get_f64(metrics, "cold_start_p95_ms")?;
    let idle_memory_mb = get_f64(metrics, "idle_rss_p95_mb")?;
    let install_size_mb = get_f64(metrics, "install_artifact_total_mb")?;
    Some((cold_start_ms, idle_memory_mb, install_size_mb))
}

fn runtime_metrics(root: &Path, refresh_runtime: bool) -> Result<(f64, f64, f64, Value, Value), String> {
    let mut source = "status".to_string();
    let mut fallback_reason = Value::Null;
    let mut runtime_json = Value::Null;

    if refresh_runtime {
        let args = vec!["run".to_string(), "--strict=0".to_string()];
        let parsed = parse_args(&args);
        match run_runtime_efficiency_floor(root, &parsed) {
            Ok(out) => {
                if extract_runtime_metrics(&out.json).is_some() {
                    source = "run".to_string();
                    runtime_json = out.json;
                } else {
                    fallback_reason =
                        Value::String("runtime_efficiency_run_missing_metrics".to_string());
                }
            }
            Err(err) => {
                fallback_reason = Value::String(format!("runtime_efficiency_run_failed:{err}"));
            }
        }
    }

    if runtime_json.is_null() {
        let args = vec!["status".to_string()];
        let parsed = parse_args(&args);
        runtime_json = status_runtime_efficiency_floor(root, &parsed).json;
    }

    let (cold_start_ms, idle_memory_mb, install_size_mb) = extract_runtime_metrics(&runtime_json)
        .ok_or_else(|| "runtime_efficiency_missing_metrics".to_string())?;

    let source_meta = json!({
        "mode": source,
        "refresh_requested": refresh_runtime,
        "fallback_reason": fallback_reason
    });
    Ok((
        cold_start_ms,
        idle_memory_mb,
        install_size_mb,
        runtime_json,
        source_meta,
    ))
}

fn measure_openclaw(root: &Path, refresh_runtime: bool) -> Result<(Map<String, Value>, Value), String> {
    let (cold_start_ms, idle_memory_mb, install_size_mb, runtime_json, runtime_source) =
        runtime_metrics(root, refresh_runtime)?;
    let security_systems = count_guard_checks(root)?;
    let channel_adapters = count_channel_adapters(root)?;
    let llm_providers = count_llm_providers(root)?;

    let mut measured = Map::<String, Value>::new();
    measured.insert("cold_start_ms".to_string(), json!(cold_start_ms));
    measured.insert("idle_memory_mb".to_string(), json!(idle_memory_mb));
    measured.insert("install_size_mb".to_string(), json!(install_size_mb));
    measured.insert("security_systems".to_string(), json!(security_systems));
    measured.insert("channel_adapters".to_string(), json!(channel_adapters));
    measured.insert("llm_providers".to_string(), json!(llm_providers));
    measured.insert("measured".to_string(), Value::Bool(true));
    measured.insert(
        "data_source".to_string(),
        Value::String("runtime_efficiency_floor + policy counters".to_string()),
    );
    measured.insert("runtime_metric_source".to_string(), runtime_source);

    Ok((measured, runtime_json))
}

fn merge_projects(snapshot: &Value, openclaw_measured: &Map<String, Value>) -> Result<Map<String, Value>, String> {
    let base_projects = snapshot
        .get("projects")
        .and_then(Value::as_object)
        .ok_or_else(|| "benchmark_snapshot_missing_projects".to_string())?;

    let mut projects = base_projects.clone();
    projects.insert(
        "OpenClaw".to_string(),
        Value::Object(openclaw_measured.clone()),
    );
    Ok(projects)
}

fn metric_value(project: &Map<String, Value>, category_key: &str) -> Option<f64> {
    project.get(category_key).and_then(Value::as_f64)
}

fn bar_fill(value: f64, min: f64, max: f64, width: usize, lower_is_better: bool) -> usize {
    if width == 0 {
        return 0;
    }
    if (max - min).abs() < f64::EPSILON {
        return width;
    }
    let mut norm = (value - min) / (max - min);
    if lower_is_better {
        norm = 1.0 - norm;
    }
    let clamped = norm.clamp(0.0, 1.0);
    let filled = (clamped * width as f64).round() as usize;
    filled.clamp(1, width)
}

fn render_bar(width: usize, fill: usize) -> String {
    format!("{}{}", "#".repeat(fill), "-".repeat(width.saturating_sub(fill)))
}

fn format_metric_value(category: Category, value: f64) -> String {
    match category.key {
        "cold_start_ms" => {
            if value >= 1000.0 {
                format!("{:.2} sec", value / 1000.0)
            } else {
                format!("{value:.0} {}", category.unit)
            }
        }
        "idle_memory_mb" | "install_size_mb" => format!("{value:.1} {}", category.unit),
        _ => format!("{value:.0}"),
    }
}

fn category_report(
    category: Category,
    projects: &Map<String, Value>,
    bar_width: usize,
) -> Result<Value, String> {
    let mut rows = Vec::<(String, f64, bool)>::new();
    for (name, entry) in projects {
        let Some(project) = entry.as_object() else {
            continue;
        };
        let Some(value) = metric_value(project, category.key) else {
            continue;
        };
        let highlight = project
            .get("highlight")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        rows.push((name.clone(), value, highlight));
    }
    if rows.is_empty() {
        return Err(format!("benchmark_category_missing_values:{}", category.key));
    }

    let min = rows
        .iter()
        .map(|(_, value, _)| *value)
        .fold(f64::INFINITY, f64::min);
    let max = rows
        .iter()
        .map(|(_, value, _)| *value)
        .fold(f64::NEG_INFINITY, f64::max);

    if category.lower_is_better {
        rows.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    } else {
        rows.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    }

    let mut report_rows = Vec::<Value>::new();
    let mut lines = Vec::<String>::new();
    lines.push(category.label.to_string());

    for (idx, (name, value, highlight)) in rows.iter().enumerate() {
        let fill = bar_fill(*value, min, max, bar_width, category.lower_is_better);
        let bar = render_bar(bar_width, fill);
        let score = format_metric_value(category, *value);
        let marker = if *highlight { " *" } else { "" };
        lines.push(format!(
            "{:<10} {}  {}{}",
            name,
            bar,
            score,
            marker
        ));

        report_rows.push(json!({
            "rank": idx + 1,
            "project": name,
            "value": value,
            "bar": bar,
            "highlight": highlight,
            "score": score
        }));
    }

    Ok(json!({
        "key": category.key,
        "label": category.label,
        "lower_is_better": category.lower_is_better,
        "unit": category.unit,
        "bar_width": bar_width,
        "rows": report_rows,
        "ascii_lines": lines
    }))
}

fn run_impl(root: &Path, cmd: &str, snapshot_rel: &str, refresh_runtime: bool, bar_width: usize) -> Result<Value, String> {
    let snapshot_path = root.join(snapshot_rel);
    let snapshot = read_json(&snapshot_path)?;

    let (openclaw_measured, runtime_receipt) = measure_openclaw(root, refresh_runtime)?;
    let projects = merge_projects(&snapshot, &openclaw_measured)?;

    let mut categories = Vec::<Value>::new();
    let mut ascii_report = Vec::<String>::new();
    ascii_report.push("Benchmarks: Measured, Not Marketed".to_string());
    if let Some(context) = snapshot.get("benchmark_context").and_then(Value::as_str) {
        ascii_report.push(context.to_string());
    }

    for category in CATEGORIES {
        let report = category_report(category, &projects, bar_width)?;
        if let Some(lines) = report.get("ascii_lines").and_then(Value::as_array) {
            for line in lines {
                if let Some(text) = line.as_str() {
                    ascii_report.push(text.to_string());
                }
            }
        }
        ascii_report.push(String::new());
        categories.push(report);
    }

    let mut out = json!({
        "ok": true,
        "type": "competitive_benchmark_matrix",
        "lane": LANE_ID,
        "mode": cmd,
        "ts": now_iso(),
        "snapshot_path": snapshot_rel,
        "snapshot_version": snapshot.get("schema_version").cloned().unwrap_or(Value::Null),
        "snapshot_generated_from": snapshot.get("generated_from").cloned().unwrap_or(Value::Null),
        "reference_month": snapshot.get("reference_month").cloned().unwrap_or(Value::Null),
        "bar_width": bar_width,
        "openclaw_measured": Value::Object(openclaw_measured),
        "runtime_receipt": runtime_receipt,
        "projects": Value::Object(projects),
        "categories": categories,
        "ascii_report": ascii_report,
        "claim_evidence": [
            {
                "id": "competitive_benchmark_matrix_live_openclaw",
                "claim": "openclaw_metrics_are_measured_from_runtime_and_policy_counters",
                "evidence": {
                    "runtime_source": "runtime_efficiency_floor",
                    "counter_sources": [
                        "config/guard_check_registry.json",
                        "config/platform_adaptation_channels.json",
                        "config/provider_onboarding_manifest.json",
                        "config/model_health_auto_recovery_policy.json"
                    ]
                }
            },
            {
                "id": "competitive_benchmark_matrix_snapshot_reference",
                "claim": "competitor_metrics_are_loaded_from_reference_snapshot",
                "evidence": {
                    "snapshot_path": snapshot_rel,
                    "reference_month": snapshot.get("reference_month").cloned().unwrap_or(Value::Null)
                }
            }
        ]
    });

    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));

    let latest_path = root.join(STATE_LATEST_REL);
    let history_path = root.join(STATE_HISTORY_REL);
    write_json_atomic(&latest_path, &out)?;
    append_jsonl(&history_path, &out)?;

    Ok(out)
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

    let snapshot_rel = parsed
        .flags
        .get("snapshot")
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| DEFAULT_SNAPSHOT_REL.to_string());

    let refresh_default = false;
    let refresh_runtime = parse_bool_flag(
        parsed.flags.get("refresh-runtime").map(String::as_str),
        refresh_default,
    );
    let bar_width = parse_bar_width(parsed.flags.get("bar-width").map(String::as_str));

    match cmd.as_str() {
        "run" | "status" => match run_impl(root, &cmd, &snapshot_rel, refresh_runtime, bar_width) {
            Ok(out) => {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&out)
                        .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
                );
                0
            }
            Err(err) => {
                let mut out = json!({
                    "ok": false,
                    "type": "competitive_benchmark_matrix",
                    "lane": LANE_ID,
                    "mode": cmd,
                    "ts": now_iso(),
                    "snapshot_path": snapshot_rel,
                    "error": err
                });
                out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
                println!(
                    "{}",
                    serde_json::to_string_pretty(&out)
                        .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
                );
                1
            }
        },
        _ => {
            usage();
            let mut out = json!({
                "ok": false,
                "type": "competitive_benchmark_matrix_cli_error",
                "lane": LANE_ID,
                "ts": now_iso(),
                "error": "unknown_command",
                "command": cmd
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            println!(
                "{}",
                serde_json::to_string_pretty(&out)
                    .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
            );
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bar_fill_inverts_when_lower_is_better() {
        let width = 20;
        let best = bar_fill(10.0, 10.0, 100.0, width, true);
        let worst = bar_fill(100.0, 10.0, 100.0, width, true);
        assert_eq!(best, width);
        assert_eq!(worst, 1);
    }

    #[test]
    fn bar_fill_prefers_higher_when_higher_is_better() {
        let width = 20;
        let high = bar_fill(16.0, 1.0, 16.0, width, false);
        let low = bar_fill(1.0, 1.0, 16.0, width, false);
        assert_eq!(high, width);
        assert_eq!(low, 1);
    }

    #[test]
    fn merge_projects_replaces_openclaw_entry() {
        let snapshot = json!({
            "projects": {
                "OpenClaw": {"cold_start_ms": 5980.0},
                "OpenFang": {"cold_start_ms": 180.0}
            }
        });
        let mut measured = Map::<String, Value>::new();
        measured.insert("cold_start_ms".to_string(), json!(253.0));
        measured.insert("measured".to_string(), Value::Bool(true));

        let projects = merge_projects(&snapshot, &measured).expect("merge");
        let openclaw = projects
            .get("OpenClaw")
            .and_then(Value::as_object)
            .expect("openclaw object");
        assert_eq!(
            openclaw.get("cold_start_ms").and_then(Value::as_f64),
            Some(253.0)
        );
        assert_eq!(openclaw.get("measured").and_then(Value::as_bool), Some(true));
    }
}
