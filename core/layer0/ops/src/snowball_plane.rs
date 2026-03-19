// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::snowball_plane (authoritative)

use crate::directive_kernel;
use crate::v8_kernel::{
    append_jsonl, attach_conduit, build_conduit_enforcement, conduit_bypass_requested,
    load_json_or, parse_bool, parse_u64, read_json, scoped_state_root, sha256_hex_str, write_json,
    write_receipt,
};
use crate::{clean, parse_args};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "SNOWBALL_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "snowball_plane";
const CONTRACT_PATH: &str = "planes/contracts/apps/snowball_engine_contract_v1.json";
const DEFAULT_BENCHMARK_REPORT_PATH: &str =
    "docs/client/reports/benchmark_matrix_run_2026-03-06.json";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops snowball-plane status [--cycle-id=<id>]");
    println!(
        "  protheus-ops snowball-plane start [--cycle-id=<id>] [--drops=<csv>] [--parallel=<n>] [--deps-json=<json>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops snowball-plane melt-refine|regress [--cycle-id=<id>] [--regression-suite=<id>] [--regression-pass=1|0] [--strict=1|0]"
    );
    println!("  protheus-ops snowball-plane compact [--cycle-id=<id>] [--strict=1|0]");
    println!(
        "      compact flags: [--benchmark-report=<path>] [--assimilations-json=<json>] [--reliability-before=<f>] [--reliability-after=<f>]"
    );
    println!(
        "  protheus-ops snowball-plane fitness-review [--cycle-id=<id>] [--benchmark-report=<path>] [--assimilations-json=<json>] [--reliability-before=<f>] [--reliability-after=<f>] [--strict=1|0]"
    );
    println!("  protheus-ops snowball-plane archive-discarded [--cycle-id=<id>] [--strict=1|0]");
    println!(
        "  protheus-ops snowball-plane publish-benchmarks [--cycle-id=<id>] [--benchmark-report=<path>] [--readme-path=<path>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops snowball-plane promote [--cycle-id=<id>] [--allow-neutral=1|0] [--neutral-justification=<text>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops snowball-plane prime-update [--cycle-id=<id>] [--directive=<text>] [--signer=<id>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops snowball-plane backlog-pack [--cycle-id=<id>] [--unresolved-json=<json>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops snowball-plane control --op=<pause|resume|abort> [--cycle-id=<id>] [--strict=1|0]"
    );
}

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn cycles_path(root: &Path) -> PathBuf {
    state_root(root).join("cycles").join("registry.json")
}

fn snapshot_dir(root: &Path, cycle_id: &str) -> PathBuf {
    state_root(root).join("snapshots").join(cycle_id)
}

fn backlog_path(root: &Path, cycle_id: &str) -> PathBuf {
    state_root(root)
        .join("backlog")
        .join(format!("{cycle_id}-next.json"))
}

fn assimilation_plan_path(root: &Path, cycle_id: &str) -> PathBuf {
    state_root(root)
        .join("evolution")
        .join(format!("{cycle_id}-assimilation-plan.json"))
}

fn kept_path(root: &Path, cycle_id: &str) -> PathBuf {
    state_root(root)
        .join("evolution")
        .join(format!("{cycle_id}-kept.json"))
}

fn discarded_path(root: &Path, cycle_id: &str) -> PathBuf {
    state_root(root)
        .join("evolution")
        .join(format!("{cycle_id}-discarded.json"))
}

fn discarded_blob_index_path(root: &Path, cycle_id: &str) -> PathBuf {
    state_root(root)
        .join("blob_archive")
        .join("discarded_ideas")
        .join(format!("{cycle_id}-index.json"))
}

fn discarded_blob_dir(root: &Path, cycle_id: &str) -> PathBuf {
    state_root(root)
        .join("blob_archive")
        .join("discarded_ideas")
        .join(cycle_id)
}

fn prime_directive_compacted_state_path(root: &Path) -> PathBuf {
    state_root(root).join("prime_directive_compacted_state.json")
}

fn fitness_review_path(root: &Path, cycle_id: &str) -> PathBuf {
    state_root(root)
        .join("evolution")
        .join(format!("{cycle_id}-fitness-review.json"))
}

fn promotion_path(root: &Path, cycle_id: &str) -> PathBuf {
    state_root(root)
        .join("promotion")
        .join(format!("{cycle_id}.json"))
}

fn benchmark_publication_path(root: &Path, cycle_id: &str) -> PathBuf {
    state_root(root)
        .join("benchmark_publication")
        .join(format!("{cycle_id}.json"))
}

fn readme_path(root: &Path, parsed: &crate::ParsedArgs) -> PathBuf {
    let configured = parsed
        .flags
        .get("readme-path")
        .map(String::as_str)
        .unwrap_or("README.md");
    let candidate = PathBuf::from(configured);
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

fn benchmark_report_path(root: &Path, parsed: &crate::ParsedArgs) -> PathBuf {
    let configured = parsed
        .flags
        .get("benchmark-report")
        .map(String::as_str)
        .unwrap_or(DEFAULT_BENCHMARK_REPORT_PATH);
    let candidate = PathBuf::from(configured);
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

fn print_payload(payload: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(payload)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn emit(root: &Path, payload: Value) -> i32 {
    match write_receipt(root, STATE_ENV, STATE_SCOPE, payload) {
        Ok(out) => {
            print_payload(&out);
            if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                0
            } else {
                1
            }
        }
        Err(err) => {
            print_payload(&json!({
                "ok": false,
                "type": "snowball_plane_error",
                "error": clean(err, 240)
            }));
            1
        }
    }
}

fn parse_json_flag(raw: Option<&String>) -> Option<Value> {
    raw.and_then(|text| serde_json::from_str::<Value>(text).ok())
}

fn parse_f64(raw: Option<&String>, default: f64) -> f64 {
    raw.and_then(|text| text.trim().parse::<f64>().ok())
        .unwrap_or(default)
}

fn clean_id(raw: Option<&str>, fallback: &str) -> String {
    let mut out = String::new();
    if let Some(v) = raw {
        for ch in v.trim().chars() {
            if out.len() >= 96 {
                break;
            }
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                out.push(ch.to_ascii_lowercase());
            } else {
                out.push('-');
            }
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn parse_csv_unique(raw: Option<&String>, fallback: &[&str]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::<String>::new();
    let rows = raw
        .map(|v| v.split(',').map(str::to_string).collect::<Vec<_>>())
        .unwrap_or_else(|| fallback.iter().map(|v| v.to_string()).collect::<Vec<_>>());
    for row in rows {
        let item = clean(row, 80).to_ascii_lowercase();
        if item.is_empty() {
            continue;
        }
        if seen.insert(item.clone()) {
            out.push(item);
        }
    }
    if out.is_empty() {
        fallback.iter().map(|v| v.to_string()).collect()
    } else {
        out
    }
}

fn parse_mode_metrics(report: &Value, key: &str) -> Value {
    report
        .get(key)
        .and_then(Value::as_object)
        .map(|obj| {
            json!({
                "cold_start_ms": obj.get("cold_start_ms").and_then(Value::as_f64).unwrap_or(0.0),
                "idle_memory_mb": obj.get("idle_memory_mb").and_then(Value::as_f64).unwrap_or(0.0),
                "install_size_mb": obj.get("install_size_mb").and_then(Value::as_f64).unwrap_or(0.0),
                "tasks_per_sec": obj.get("tasks_per_sec").and_then(Value::as_f64).unwrap_or(0.0),
                "security_systems": obj.get("security_systems").and_then(Value::as_f64).unwrap_or(0.0),
                "channel_adapters": obj.get("channel_adapters").and_then(Value::as_f64).unwrap_or(0.0),
                "llm_providers": obj.get("llm_providers").and_then(Value::as_f64).unwrap_or(0.0)
            })
        })
        .unwrap_or_else(|| {
            json!({
                "cold_start_ms": 0.0,
                "idle_memory_mb": 0.0,
                "install_size_mb": 0.0,
                "tasks_per_sec": 0.0,
                "security_systems": 0.0,
                "channel_adapters": 0.0,
                "llm_providers": 0.0
            })
        })
}

fn benchmark_modes_from_report(report: &Value) -> Value {
    json!({
        "openclaw": parse_mode_metrics(report, "openclaw_measured"),
        "pure_workspace": parse_mode_metrics(report, "pure_workspace_measured"),
        "pure_workspace_tiny_max": parse_mode_metrics(report, "pure_workspace_tiny_max_measured")
    })
}

fn load_benchmark_modes(path: &Path) -> Value {
    read_json(path)
        .map(|v| benchmark_modes_from_report(&v))
        .unwrap_or_else(|| {
            json!({
                "openclaw": parse_mode_metrics(&Value::Null, ""),
                "pure_workspace": parse_mode_metrics(&Value::Null, ""),
                "pure_workspace_tiny_max": parse_mode_metrics(&Value::Null, "")
            })
        })
}

fn metric_from_mode(mode: &Value, key: &str) -> f64 {
    mode.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn mode_delta(before: &Value, after: &Value) -> Value {
    let cold_before = metric_from_mode(before, "cold_start_ms");
    let cold_after = metric_from_mode(after, "cold_start_ms");
    let idle_before = metric_from_mode(before, "idle_memory_mb");
    let idle_after = metric_from_mode(after, "idle_memory_mb");
    let install_before = metric_from_mode(before, "install_size_mb");
    let install_after = metric_from_mode(after, "install_size_mb");
    let throughput_before = metric_from_mode(before, "tasks_per_sec");
    let throughput_after = metric_from_mode(after, "tasks_per_sec");
    let cold_improved = cold_before > 0.0 && cold_after > 0.0 && cold_after < cold_before;
    let cold_regressed = cold_before > 0.0 && cold_after > 0.0 && cold_after > cold_before;
    let idle_improved = idle_before > 0.0 && idle_after > 0.0 && idle_after < idle_before;
    let idle_regressed = idle_before > 0.0 && idle_after > 0.0 && idle_after > idle_before;
    let install_improved =
        install_before > 0.0 && install_after > 0.0 && install_after < install_before;
    let install_regressed =
        install_before > 0.0 && install_after > 0.0 && install_after > install_before;
    let throughput_improved =
        throughput_before > 0.0 && throughput_after > 0.0 && throughput_after > throughput_before;
    let throughput_regressed =
        throughput_before > 0.0 && throughput_after > 0.0 && throughput_after < throughput_before;
    let improved_count = [
        cold_improved,
        idle_improved,
        install_improved,
        throughput_improved,
    ]
    .iter()
    .filter(|v| **v)
    .count();
    let regressed_count = [
        cold_regressed,
        idle_regressed,
        install_regressed,
        throughput_regressed,
    ]
    .iter()
    .filter(|v| **v)
    .count();
    json!({
        "cold_start_ms_before": cold_before,
        "cold_start_ms_after": cold_after,
        "idle_memory_mb_before": idle_before,
        "idle_memory_mb_after": idle_after,
        "install_size_mb_before": install_before,
        "install_size_mb_after": install_after,
        "tasks_per_sec_before": throughput_before,
        "tasks_per_sec_after": throughput_after,
        "cold_improved": cold_improved,
        "cold_regressed": cold_regressed,
        "idle_improved": idle_improved,
        "idle_regressed": idle_regressed,
        "install_improved": install_improved,
        "install_regressed": install_regressed,
        "throughput_improved": throughput_improved,
        "throughput_regressed": throughput_regressed,
        "improved_count": improved_count,
        "regressed_count": regressed_count
    })
}

fn benchmark_delta(before: &Value, after: &Value) -> Value {
    let openclaw_before = before.get("openclaw").cloned().unwrap_or(Value::Null);
    let openclaw_after = after.get("openclaw").cloned().unwrap_or(Value::Null);
    let pure_before = before.get("pure_workspace").cloned().unwrap_or(Value::Null);
    let pure_after = after.get("pure_workspace").cloned().unwrap_or(Value::Null);
    let tiny_before = before
        .get("pure_workspace_tiny_max")
        .cloned()
        .unwrap_or(Value::Null);
    let tiny_after = after
        .get("pure_workspace_tiny_max")
        .cloned()
        .unwrap_or(Value::Null);
    let openclaw = mode_delta(&openclaw_before, &openclaw_after);
    let pure = mode_delta(&pure_before, &pure_after);
    let tiny = mode_delta(&tiny_before, &tiny_after);
    let improved_total = openclaw
        .get("improved_count")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        + pure
            .get("improved_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
        + tiny
            .get("improved_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
    let regressed_total = openclaw
        .get("regressed_count")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        + pure
            .get("regressed_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
        + tiny
            .get("regressed_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
    json!({
        "openclaw": openclaw,
        "pure_workspace": pure,
        "pure_workspace_tiny_max": tiny,
        "improved_metric_count": improved_total,
        "regressed_metric_count": regressed_total
    })
}

fn load_assimilation_plan(root: &Path, cycle_id: &str, parsed: &crate::ParsedArgs) -> Vec<Value> {
    parse_json_flag(parsed.flags.get("assimilations-json"))
        .and_then(|v| v.as_array().cloned())
        .or_else(|| {
            read_json(&assimilation_plan_path(root, cycle_id))
                .and_then(|v| v.get("items").and_then(Value::as_array).cloned())
        })
        .unwrap_or_default()
}

fn first_failed_gate(gates: &Value) -> &'static str {
    let checks = [
        ("metrics", "metrics_no_gain"),
        ("tiny_pure", "tiny_pure_not_strengthened"),
        ("rsi_organism", "rsi_utility_not_improved"),
        ("tiny_hardware", "tiny_hardware_not_supported"),
        ("reliability", "reliability_regressed"),
    ];
    for (key, reason) in checks {
        if gates.get(key).and_then(Value::as_bool) == Some(false) {
            return reason;
        }
    }
    "unknown_rejection_reason"
}

fn score_candidate(gates: &Value, bench_delta: &Value) -> f64 {
    let improved = bench_delta
        .get("improved_metric_count")
        .and_then(Value::as_u64)
        .unwrap_or(0) as f64;
    let gate_score = [
        "metrics",
        "tiny_pure",
        "rsi_organism",
        "tiny_hardware",
        "reliability",
    ]
    .iter()
    .filter(|key| gates.get(**key).and_then(Value::as_bool) == Some(true))
    .count() as f64;
    ((gate_score / 5.0) * 70.0) + improved.min(10.0) * 3.0
}

fn build_fitness_review(
    _root: &Path,
    cycle_id: &str,
    bench_delta: &Value,
    reliability_before: f64,
    reliability_after: f64,
    assimilation_plan: &[Value],
) -> Value {
    let reliability_gate_pass = reliability_after >= reliability_before;
    let metrics_gate_pass = bench_delta
        .get("improved_metric_count")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0;
    let tiny_strengthened = bench_delta
        .pointer("/pure_workspace_tiny_max/improved_count")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0
        || bench_delta
            .pointer("/pure_workspace/improved_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            > 0;

    let mut survivors = Vec::<Value>::new();
    let mut demoted = Vec::<Value>::new();
    let mut rejected = Vec::<Value>::new();
    for candidate in assimilation_plan {
        if !candidate.is_object() {
            continue;
        }
        let mut normalized = candidate.clone();
        let lower = normalized
            .get("idea")
            .and_then(Value::as_str)
            .or_else(|| normalized.get("id").and_then(Value::as_str))
            .unwrap_or("")
            .to_ascii_lowercase();
        let intelligence_fallback = lower.contains("rsi")
            || lower.contains("organism")
            || lower.contains("memory")
            || lower.contains("planner")
            || lower.contains("learn")
            || lower.contains("inference");
        let hardware_fallback = lower.contains("tiny")
            || lower.contains("embedded")
            || lower.contains("mcu")
            || lower.contains("pure")
            || lower.contains("low-power")
            || lower.contains("edge");
        let metric_gate = candidate_gate_bool(
            &normalized,
            &["metric_gain", "metrics_pass"],
            metrics_gate_pass,
        );
        let tiny_gate = candidate_gate_bool(
            &normalized,
            &["pure_tiny_strength", "tiny_strengthened", "pure_mode_gain"],
            tiny_strengthened,
        );
        let intelligence_gate = candidate_gate_bool(
            &normalized,
            &["intelligence_gain", "rsi_gain", "organism_gain"],
            intelligence_fallback,
        );
        let hardware_gate = candidate_gate_bool(
            &normalized,
            &["tiny_hardware_fit", "hardware_fit", "embedded_fit"],
            hardware_fallback,
        );
        let gates = json!({
            "metrics": metric_gate,
            "tiny_pure": tiny_gate,
            "rsi_organism": intelligence_gate,
            "tiny_hardware": hardware_gate,
            "reliability": reliability_gate_pass
        });
        let all_pass = gates
            .as_object()
            .map(|obj| obj.values().all(|value| value.as_bool().unwrap_or(false)))
            .unwrap_or(false);
        let demote = !all_pass
            && !metric_gate
            && (tiny_gate || intelligence_gate || hardware_gate)
            && reliability_gate_pass;
        let status = if all_pass {
            "survivor"
        } else if demote {
            "demoted_optional"
        } else {
            "rejected"
        };
        let rejection_reason = if status == "survivor" {
            "none"
        } else {
            first_failed_gate(&gates)
        };
        normalized["gate_results"] = gates.clone();
        normalized["status"] = Value::String(status.to_string());
        normalized["review_score"] = Value::from(score_candidate(&gates, bench_delta));
        normalized["evaluated_at"] = Value::String(crate::now_iso());
        normalized["rejection_reason"] = Value::String(rejection_reason.to_string());
        normalized["resurrection_metadata"] = json!({
            "cycle_id": cycle_id,
            "recheck_after": "next_snowball_cycle",
            "reason": rejection_reason
        });
        match status {
            "survivor" => survivors.push(normalized),
            "demoted_optional" => demoted.push(normalized),
            _ => rejected.push(normalized),
        }
    }

    json!({
        "version": "v1",
        "cycle_id": cycle_id,
        "generated_at": crate::now_iso(),
        "bench_delta": bench_delta,
        "reliability": {
            "before": reliability_before,
            "after": reliability_after,
            "pass": reliability_gate_pass
        },
        "summary": {
            "survivor_count": survivors.len(),
            "demoted_count": demoted.len(),
            "rejected_count": rejected.len(),
            "improved_metric_count": bench_delta.get("improved_metric_count").and_then(Value::as_u64).unwrap_or(0),
            "regressed_metric_count": bench_delta.get("regressed_metric_count").and_then(Value::as_u64).unwrap_or(0),
            "tiny_strengthened": tiny_strengthened
        },
        "survivors": survivors,
        "demoted": demoted,
        "rejected": rejected
    })
}

fn load_review(root: &Path, cycle_id: &str) -> Option<Value> {
    read_json(&fitness_review_path(root, cycle_id))
}

fn load_cycle_value(cycles: &Value, cycle_id: &str) -> Option<Value> {
    cycles
        .get("cycles")
        .and_then(Value::as_object)
        .and_then(|map| map.get(cycle_id))
        .cloned()
}

fn format_with_commas(raw: f64) -> String {
    let base = format!("{raw:.1}");
    let parts = base.split('.').collect::<Vec<_>>();
    let integer = parts.first().copied().unwrap_or("0");
    let fraction = parts.get(1).copied().unwrap_or("0");
    let mut out = String::new();
    let bytes = integer.as_bytes();
    for (idx, ch) in bytes.iter().enumerate() {
        if idx > 0 && (bytes.len() - idx) % 3 == 0 {
            out.push(',');
        }
        out.push(*ch as char);
    }
    out.push('.');
    out.push_str(fraction);
    out
}

fn readme_sync_summary(report: &Value, readme_text: &str) -> Value {
    let snippets = [
        (
            "rich_cold_start",
            format!(
                "{:.1} ms",
                report
                    .pointer("/openclaw_measured/cold_start_ms")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            ),
        ),
        (
            "rich_idle_memory",
            format!(
                "{:.1} MB",
                report
                    .pointer("/openclaw_measured/idle_memory_mb")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0)
            ),
        ),
        (
            "pure_throughput",
            format!(
                "{} ops/sec",
                format_with_commas(
                    report
                        .pointer("/pure_workspace_measured/tasks_per_sec")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
                )
            ),
        ),
        (
            "tiny_throughput",
            format!(
                "{} ops/sec",
                format_with_commas(
                    report
                        .pointer("/pure_workspace_tiny_max_measured/tasks_per_sec")
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0)
                )
            ),
        ),
    ];
    let rows = snippets
        .iter()
        .map(|(name, snippet)| {
            json!({
                "name": name,
                "snippet": snippet,
                "present": readme_text.contains(snippet)
            })
        })
        .collect::<Vec<_>>();
    let synced = rows
        .iter()
        .all(|row| row.get("present").and_then(Value::as_bool) == Some(true));
    json!({
        "synced": synced,
        "checks": rows
    })
}

fn default_assimilation_items(cycle_id: &str, drops: &[String]) -> Vec<Value> {
    drops
        .iter()
        .map(|drop| {
            let lower = drop.to_ascii_lowercase();
            let tiny_hint = lower.contains("tiny")
                || lower.contains("pure")
                || lower.contains("embedded")
                || lower.contains("mcu")
                || lower.contains("rpi");
            let intelligence_hint = lower.contains("rsi")
                || lower.contains("organism")
                || lower.contains("memory")
                || lower.contains("planner")
                || lower.contains("reason");
            json!({
                "id": format!("assim-{}-{}", cycle_id, clean_id(Some(drop.as_str()), "idea")),
                "idea": drop,
                "source": "snowball_drop",
                "metric_gain": true,
                "pure_tiny_strength": tiny_hint || lower.contains("ops") || lower.contains("core"),
                "intelligence_gain": intelligence_hint || lower.contains("core"),
                "tiny_hardware_fit": tiny_hint || lower.contains("core")
            })
        })
        .collect()
}

fn as_bool_opt(value: Option<&Value>) -> Option<bool> {
    value.and_then(Value::as_bool)
}

fn candidate_gate_bool(candidate: &Value, keys: &[&str], fallback: bool) -> bool {
    for key in keys {
        if let Some(result) = as_bool_opt(candidate.get(*key)) {
            return result;
        }
    }
    fallback
}

fn archive_discarded_blobs(
    root: &Path,
    cycle_id: &str,
    discarded: &[Value],
) -> (Vec<Value>, Value) {
    let dir = discarded_blob_dir(root, cycle_id);
    let _ = fs::create_dir_all(&dir);
    let mut index_rows = Vec::<Value>::new();
    for entry in discarded {
        let id = clean_id(entry.get("id").and_then(Value::as_str), "discarded");
        let encoded = serde_json::to_string(entry).unwrap_or_else(|_| "{}".to_string());
        let blob_hash = sha256_hex_str(&encoded);
        let path = dir.join(format!("{blob_hash}.blob"));
        let mut bytes = Vec::<u8>::with_capacity(encoded.len() + 8);
        bytes.extend_from_slice(b"SNOWV1\0");
        bytes.extend_from_slice(encoded.as_bytes());
        let _ = fs::write(&path, &bytes);
        index_rows.push(json!({
            "id": id,
            "path": path.display().to_string(),
            "sha256": blob_hash,
            "bytes": bytes.len()
        }));
    }
    let index = json!({
        "version": "v1",
        "cycle_id": cycle_id,
        "written_at": crate::now_iso(),
        "items": index_rows
    });
    let index_path = discarded_blob_index_path(root, cycle_id);
    let _ = write_json(&index_path, &index);
    (
        index
            .get("items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
        index,
    )
}

fn claim_ids_for_action(action: &str) -> Vec<&'static str> {
    match action {
        "start" => vec!["V6-APP-023.1", "V6-APP-023.5", "V6-APP-023.6"],
        "melt-refine" | "regress" => vec!["V6-APP-023.2", "V6-APP-023.5", "V6-APP-023.6"],
        "compact" => vec![
            "V6-APP-023.3",
            "V6-APP-023.7",
            "V6-APP-023.9",
            "V6-APP-023.11",
            "V6-APP-023.5",
            "V6-APP-023.6",
        ],
        "fitness-review" => vec!["V6-APP-023.7", "V6-APP-023.5", "V6-APP-023.6"],
        "archive-discarded" => vec!["V6-APP-023.9"],
        "publish-benchmarks" => vec!["V6-APP-023.10"],
        "promote" => vec!["V6-APP-023.8"],
        "prime-update" => vec!["V6-APP-023.11"],
        "backlog-pack" => vec!["V6-APP-023.4", "V6-APP-023.5", "V6-APP-023.6"],
        "control" | "status" => vec!["V6-APP-023.5", "V6-APP-023.6"],
        _ => vec!["V6-APP-023.5", "V6-APP-023.6"],
    }
}

fn conduit_enforcement(
    root: &Path,
    parsed: &crate::ParsedArgs,
    strict: bool,
    action: &str,
) -> Value {
    let bypass_requested = conduit_bypass_requested(&parsed.flags);
    let claim_rows = claim_ids_for_action(action)
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "claim": "snowball_controls_route_through_layer0_conduit_with_fail_closed_denials",
                "evidence": {
                    "action": clean(action, 120),
                    "bypass_requested": bypass_requested
                }
            })
        })
        .collect::<Vec<_>>();
    build_conduit_enforcement(
        root,
        STATE_ENV,
        STATE_SCOPE,
        strict,
        action,
        "snowball_conduit_enforcement",
        "core/layer0/ops/snowball_plane",
        bypass_requested,
        claim_rows,
    )
}

fn load_cycles(root: &Path) -> Value {
    read_json(&cycles_path(root)).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "active_cycle_id": Value::Null,
            "cycles": {}
        })
    })
}

fn store_cycles(root: &Path, cycles: &Value) {
    let _ = write_json(&cycles_path(root), cycles);
}

fn active_or_requested_cycle(parsed: &crate::ParsedArgs, cycles: &Value, fallback: &str) -> String {
    clean_id(
        parsed
            .flags
            .get("cycle-id")
            .map(String::as_str)
            .or_else(|| parsed.flags.get("cycle").map(String::as_str))
            .or_else(|| cycles.get("active_cycle_id").and_then(Value::as_str))
            .or(Some(fallback)),
        fallback,
    )
}

fn classify_drop_risk(drop: &str) -> &'static str {
    let lower = drop.to_ascii_lowercase();
    if lower.contains("prod")
        || lower.contains("deploy")
        || lower.contains("security")
        || lower.contains("payment")
    {
        "high"
    } else if lower.contains("migration") || lower.contains("schema") || lower.contains("runtime") {
        "medium"
    } else {
        "low"
    }
}

fn dependencies_from_json(
    drops: &[String],
    deps_json: Option<Value>,
) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::<String, Vec<String>>::new();
    for drop in drops {
        out.insert(drop.clone(), Vec::new());
    }
    if let Some(obj) = deps_json.and_then(|v| v.as_object().cloned()) {
        for (key, value) in obj {
            let k = clean(key, 80).to_ascii_lowercase();
            if !out.contains_key(&k) {
                continue;
            }
            let deps = value
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(Value::as_str)
                .map(|v| clean(v, 80).to_ascii_lowercase())
                .filter(|v| out.contains_key(v))
                .collect::<Vec<_>>();
            out.insert(k, deps);
        }
    }
    out
}

#[derive(Clone)]
struct BacklogItem {
    id: String,
    priority: i64,
    depends_on: Vec<String>,
    payload: Value,
    original_index: usize,
}

fn dependency_ordered_backlog(rows: Vec<Value>) -> Vec<Value> {
    let mut normalized = Vec::<BacklogItem>::new();
    for (idx, row) in rows.into_iter().enumerate() {
        let fallback_id = format!("item-{}", idx + 1);
        let id = clean_id(
            row.get("id")
                .and_then(Value::as_str)
                .or(Some(fallback_id.as_str())),
            fallback_id.as_str(),
        );
        let priority = row.get("priority").and_then(Value::as_i64).unwrap_or(99);
        normalized.push(BacklogItem {
            id,
            priority,
            depends_on: Vec::new(),
            payload: row,
            original_index: idx,
        });
    }

    let known_ids = normalized
        .iter()
        .map(|item| item.id.clone())
        .collect::<HashSet<_>>();

    for item in &mut normalized {
        let mut deps = Vec::<String>::new();
        if let Some(row_deps) = item.payload.get("depends_on") {
            if let Some(arr) = row_deps.as_array() {
                for dep in arr {
                    if let Some(dep_id) = dep.as_str() {
                        let clean_dep = clean_id(Some(dep_id), "dep");
                        if clean_dep != item.id
                            && known_ids.contains(clean_dep.as_str())
                            && !deps.iter().any(|v| v == &clean_dep)
                        {
                            deps.push(clean_dep);
                        }
                    }
                }
            } else if let Some(csv) = row_deps.as_str() {
                for dep_id in csv.split(',') {
                    let clean_dep = clean_id(Some(dep_id), "dep");
                    if clean_dep != item.id
                        && known_ids.contains(clean_dep.as_str())
                        && !deps.iter().any(|v| v == &clean_dep)
                    {
                        deps.push(clean_dep);
                    }
                }
            }
        }
        item.depends_on = deps;
    }

    let mut pending = normalized
        .into_iter()
        .map(|item| (item.id.clone(), item))
        .collect::<BTreeMap<_, _>>();
    let mut resolved = HashSet::<String>::new();
    let mut out = Vec::<Value>::new();

    while !pending.is_empty() {
        let mut ready = pending
            .values()
            .filter(|item| item.depends_on.iter().all(|dep| resolved.contains(dep)))
            .map(|item| item.id.clone())
            .collect::<Vec<_>>();
        let cycle_break = ready.is_empty();
        if cycle_break {
            ready = pending.keys().cloned().collect::<Vec<_>>();
        }
        ready.sort_by(|a, b| {
            let ia = pending.get(a).expect("pending item a");
            let ib = pending.get(b).expect("pending item b");
            ia.priority
                .cmp(&ib.priority)
                .then_with(|| ia.original_index.cmp(&ib.original_index))
                .then_with(|| ia.id.cmp(&ib.id))
        });
        let next_id = ready
            .first()
            .cloned()
            .unwrap_or_else(|| "item-unknown".to_string());
        let item = match pending.remove(next_id.as_str()) {
            Some(v) => v,
            None => break,
        };
        resolved.insert(item.id.clone());
        let mut payload = item.payload;
        if !payload.is_object() {
            payload = json!({});
        }
        payload["id"] = Value::String(item.id.clone());
        payload["priority"] = Value::from(item.priority);
        payload["depends_on"] = Value::Array(
            item.depends_on
                .iter()
                .map(|dep| Value::String(dep.clone()))
                .collect::<Vec<_>>(),
        );
        payload["order"] = Value::from((out.len() + 1) as u64);
        payload["dependency_cycle_break"] = Value::Bool(cycle_break);
        out.push(payload);
    }

    out
}

fn run_start(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "snowball_engine_contract",
            "default_parallel_limit": 3,
            "max_parallel_limit": 8
        }),
    );
    let mut cycles = load_cycles(root);
    if !cycles.get("cycles").map(Value::is_object).unwrap_or(false) {
        cycles["cycles"] = json!({});
    }
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let drops = parse_csv_unique(
        parsed.flags.get("drops"),
        &["core-hardening", "app-refine", "ops-proof"],
    );
    let default_parallel = contract
        .get("default_parallel_limit")
        .and_then(Value::as_u64)
        .unwrap_or(3);
    let max_parallel = contract
        .get("max_parallel_limit")
        .and_then(Value::as_u64)
        .unwrap_or(8)
        .max(1);
    let parallel_limit = parse_u64(parsed.flags.get("parallel"), default_parallel)
        .max(1)
        .min(max_parallel);
    let allow_high_risk = parse_bool(parsed.flags.get("allow-high-risk"), false);
    let benchmark_path = benchmark_report_path(root, parsed);
    let benchmark_before = load_benchmark_modes(&benchmark_path);
    let deps_map = dependencies_from_json(
        drops.as_slice(),
        parse_json_flag(parsed.flags.get("deps-json")),
    );

    let mut risk_blocked = Vec::<String>::new();
    let mut drop_rows = Vec::<Value>::new();
    for drop in &drops {
        let risk = classify_drop_risk(drop);
        if strict && risk == "high" && !allow_high_risk {
            risk_blocked.push(drop.clone());
        }
        drop_rows.push(json!({
            "drop": drop,
            "risk": risk,
            "deps": deps_map.get(drop).cloned().unwrap_or_default()
        }));
    }
    if strict && !risk_blocked.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_start",
            "action": "start",
            "errors": ["snowball_high_risk_drop_requires_allow_flag"],
            "blocked_drops": risk_blocked
        });
    }

    let mut completed = HashSet::<String>::new();
    let mut pending = drops.clone();
    let mut waves = Vec::<Value>::new();
    let mut wave_idx = 1usize;
    while !pending.is_empty() && wave_idx <= 64 {
        let mut ready = Vec::<String>::new();
        for item in &pending {
            let deps = deps_map.get(item).cloned().unwrap_or_default();
            if deps.iter().all(|dep| completed.contains(dep)) {
                ready.push(item.clone());
            }
        }
        if ready.is_empty() {
            ready.push(pending[0].clone());
        }
        let run_now = ready
            .into_iter()
            .take(parallel_limit as usize)
            .collect::<Vec<_>>();
        for item in &run_now {
            completed.insert(item.clone());
        }
        pending.retain(|item| !run_now.iter().any(|r| r == item));
        waves.push(json!({
            "wave": wave_idx,
            "parallel": run_now.len(),
            "drops": run_now
        }));
        wave_idx += 1;
    }

    let now = crate::now_iso();
    let orchestration = json!({
        "cycle_id": cycle_id,
        "parallel_limit": parallel_limit,
        "drops": drop_rows,
        "waves": waves,
        "dependency_graph": deps_map,
        "benchmark_before": benchmark_before,
        "started_at": now
    });
    let assimilation_plan = default_assimilation_items(&cycle_id, &drops);
    let cycle_value = json!({
        "cycle_id": cycle_id,
        "stage": "running",
        "orchestration": orchestration,
        "benchmark_before": benchmark_before,
        "assimilation_plan_path": assimilation_plan_path(root, &cycle_id).display().to_string(),
        "updated_at": crate::now_iso()
    });
    let _ = write_json(
        &assimilation_plan_path(root, &cycle_id),
        &json!({
            "version": "v1",
            "cycle_id": cycle_id,
            "generated_at": crate::now_iso(),
            "items": assimilation_plan
        }),
    );
    let mut cycles_map = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    cycles_map.insert(cycle_id.clone(), cycle_value.clone());
    cycles["cycles"] = Value::Object(cycles_map);
    cycles["active_cycle_id"] = Value::String(cycle_id.clone());
    cycles["updated_at"] = Value::String(crate::now_iso());
    store_cycles(root, &cycles);
    let _ = append_jsonl(
        &state_root(root).join("history.jsonl"),
        &json!({
            "ts": crate::now_iso(),
            "action": "start",
            "cycle_id": cycle_id
        }),
    );

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "snowball_plane_start",
        "lane": "core/layer0/ops",
        "action": "start",
        "cycle_id": cycle_id,
        "orchestration": cycle_value.get("orchestration").cloned().unwrap_or(Value::Null),
        "artifact": {
            "path": cycles_path(root).display().to_string(),
            "sha256": sha256_hex_str(&cycles.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-APP-023.1",
                "claim": "snowball_start_orchestrates_bounded_parallel_drop_waves_with_dependency_and_risk_gates",
                "evidence": {
                    "cycle_id": cycle_id,
                    "parallel_limit": parallel_limit,
                    "benchmark_before_path": benchmark_path.display().to_string()
                }
            },
            {
                "id": "V6-APP-023.5",
                "claim": "snowball_runtime_publishes_live_cycle_state_for_operator_controls",
                "evidence": {
                    "cycle_id": cycle_id
                }
            },
            {
                "id": "V6-APP-023.6",
                "claim": "snowball_status_and_compact_controls_surface_cycle_stage_batch_outcomes_and_regression_state",
                "evidence": {
                    "cycle_id": cycle_id,
                    "stage": "running"
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_melt_refine(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let mut cycles = load_cycles(root);
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let mut cycles_map = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let cycle = cycles_map.get(&cycle_id).cloned();
    if strict && cycle.is_none() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_melt_refine",
            "action": "melt-refine",
            "errors": ["snowball_cycle_not_found"],
            "cycle_id": cycle_id
        });
    }
    let regression_suite = clean(
        parsed
            .flags
            .get("regression-suite")
            .cloned()
            .unwrap_or_else(|| "core/layer0/ops".to_string()),
        200,
    );
    let regression_pass = parse_bool(parsed.flags.get("regression-pass"), true);
    let gate = json!({
        "suite": regression_suite,
        "pass": regression_pass,
        "rollback_required": !regression_pass,
        "ts": crate::now_iso()
    });
    let mut next_cycle = cycle.unwrap_or_else(|| json!({"cycle_id": cycle_id, "stage":"running"}));
    next_cycle["melt_refine"] = gate.clone();
    next_cycle["stage"] = Value::String(if regression_pass {
        "refined".to_string()
    } else {
        "rollback".to_string()
    });
    next_cycle["updated_at"] = Value::String(crate::now_iso());
    cycles_map.insert(cycle_id.clone(), next_cycle.clone());
    cycles["cycles"] = Value::Object(cycles_map);
    cycles["active_cycle_id"] = Value::String(cycle_id.clone());
    cycles["updated_at"] = Value::String(crate::now_iso());
    store_cycles(root, &cycles);

    let mut out = json!({
        "ok": regression_pass || !strict,
        "strict": strict,
        "type": "snowball_plane_melt_refine",
        "lane": "core/layer0/ops",
        "action": "melt-refine",
        "cycle_id": cycle_id,
        "gate": gate,
        "cycle": next_cycle,
        "artifact": {
            "path": cycles_path(root).display().to_string(),
            "sha256": sha256_hex_str(&cycles.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-APP-023.2",
                "claim": "snowball_melt_refine_enforces_regression_gate_before_promotion_and_emits_rollback_receipts",
                "evidence": {
                    "cycle_id": cycle_id,
                    "regression_pass": regression_pass
                }
            },
            {
                "id": "V6-APP-023.5",
                "claim": "snowball_runtime_publishes_live_cycle_state_for_operator_controls",
                "evidence": {
                    "cycle_id": cycle_id
                }
            },
            {
                "id": "V6-APP-023.6",
                "claim": "snowball_status_and_compact_controls_surface_cycle_stage_batch_outcomes_and_regression_state",
                "evidence": {
                    "cycle_id": cycle_id,
                    "stage": next_cycle.get("stage").cloned().unwrap_or(Value::Null),
                    "regression_pass": regression_pass
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_compact(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let mut cycles = load_cycles(root);
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let mut cycles_map = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let cycle = cycles_map.get(&cycle_id).cloned();
    if strict && cycle.is_none() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_compact",
            "action": "compact",
            "errors": ["snowball_cycle_not_found"],
            "cycle_id": cycle_id
        });
    }
    let stage = cycle
        .as_ref()
        .and_then(|v| v.get("stage"))
        .and_then(Value::as_str)
        .unwrap_or("running");
    let ts = crate::now_iso();
    let snapshot = json!({
        "version": "v1",
        "cycle_id": cycle_id,
        "stage": stage,
        "sphere_of_ice": true,
        "captured_at": ts,
        "restore_pointer": {
            "cycles_path": cycles_path(root).display().to_string(),
            "cycle_id": cycle_id
        }
    });
    let snapshot_path =
        snapshot_dir(root, &cycle_id).join(format!("sphere_of_ice_{}.json", ts.replace(':', "-")));
    let _ = write_json(&snapshot_path, &snapshot);
    let snapshot_hash =
        sha256_hex_str(&read_json(&snapshot_path).unwrap_or(Value::Null).to_string());

    let benchmark_path = benchmark_report_path(root, parsed);
    let benchmark_after = load_benchmark_modes(&benchmark_path);
    let benchmark_before = cycle
        .as_ref()
        .and_then(|v| v.get("benchmark_before"))
        .cloned()
        .unwrap_or_else(|| benchmark_after.clone());
    let bench_delta = benchmark_delta(&benchmark_before, &benchmark_after);
    let reliability_before = parse_f64(parsed.flags.get("reliability-before"), 1.0);
    let reliability_after = parse_f64(parsed.flags.get("reliability-after"), reliability_before);
    let reliability_gate_pass = reliability_after >= reliability_before;

    let assimilation_plan = load_assimilation_plan(root, &cycle_id, parsed);
    let review = build_fitness_review(
        root,
        &cycle_id,
        &bench_delta,
        reliability_before,
        reliability_after,
        assimilation_plan.as_slice(),
    );
    let kept = review
        .get("survivors")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut discarded = review
        .get("demoted")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    discarded.extend(
        review
            .get("rejected")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    );
    let _ = write_json(&fitness_review_path(root, &cycle_id), &review);
    let _ = write_json(
        &kept_path(root, &cycle_id),
        &json!({
            "version": "v1",
            "cycle_id": cycle_id,
            "generated_at": crate::now_iso(),
            "items": kept
        }),
    );
    let _ = write_json(
        &discarded_path(root, &cycle_id),
        &json!({
            "version": "v1",
            "cycle_id": cycle_id,
            "generated_at": crate::now_iso(),
            "items": discarded
        }),
    );
    let (discarded_blob_rows, discarded_blob_index) =
        archive_discarded_blobs(root, &cycle_id, &discarded);
    let prime_state = json!({
        "version": "v1",
        "cycle_id": cycle_id,
        "updated_at": crate::now_iso(),
        "benchmarks": {
            "before": benchmark_before,
            "after": benchmark_after,
            "delta": bench_delta
        },
        "assimilation": {
            "kept_count": kept.len(),
            "discarded_count": discarded.len(),
            "discarded_blob_index_path": discarded_blob_index_path(root, &cycle_id).display().to_string(),
            "fitness_review_path": fitness_review_path(root, &cycle_id).display().to_string()
        },
        "reliability": {
            "before": reliability_before,
            "after": reliability_after,
            "pass": reliability_gate_pass
        }
    });
    let _ = write_json(&prime_directive_compacted_state_path(root), &prime_state);

    let mut next_cycle = cycle.unwrap_or_else(|| json!({"cycle_id": cycle_id, "stage":"running"}));
    next_cycle["snapshot"] = json!({
        "path": snapshot_path.display().to_string(),
        "sha256": snapshot_hash,
        "captured_at": ts
    });
    next_cycle["stage"] = Value::String("compacted".to_string());
    next_cycle["benchmark_after"] = benchmark_after.clone();
    next_cycle["benchmark_delta"] = bench_delta.clone();
    next_cycle["fitness_review"] = json!({
        "path": fitness_review_path(root, &cycle_id).display().to_string(),
        "survivor_count": review.pointer("/summary/survivor_count").and_then(Value::as_u64).unwrap_or(0),
        "demoted_count": review.pointer("/summary/demoted_count").and_then(Value::as_u64).unwrap_or(0),
        "rejected_count": review.pointer("/summary/rejected_count").and_then(Value::as_u64).unwrap_or(0)
    });
    next_cycle["assimilation"] = json!({
        "kept_path": kept_path(root, &cycle_id).display().to_string(),
        "discarded_path": discarded_path(root, &cycle_id).display().to_string(),
        "kept_count": kept.len(),
        "discarded_count": discarded.len(),
        "discarded_blob_index_path": discarded_blob_index_path(root, &cycle_id).display().to_string()
    });
    next_cycle["prime_directive_compacted_state_path"] = Value::String(
        prime_directive_compacted_state_path(root)
            .display()
            .to_string(),
    );
    next_cycle["updated_at"] = Value::String(crate::now_iso());
    cycles_map.insert(cycle_id.clone(), next_cycle.clone());
    cycles["cycles"] = Value::Object(cycles_map);
    cycles["active_cycle_id"] = Value::String(cycle_id.clone());
    cycles["updated_at"] = Value::String(crate::now_iso());
    store_cycles(root, &cycles);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "snowball_plane_compact",
        "lane": "core/layer0/ops",
        "action": "compact",
        "cycle_id": cycle_id,
        "snapshot": next_cycle.get("snapshot").cloned().unwrap_or(Value::Null),
        "benchmark_delta": bench_delta,
        "assimilation": {
            "kept_count": kept.len(),
            "discarded_count": discarded.len(),
            "discarded_blob_count": discarded_blob_rows.len(),
            "kept_path": kept_path(root, &cycle_id).display().to_string(),
            "discarded_path": discarded_path(root, &cycle_id).display().to_string(),
            "fitness_review_path": fitness_review_path(root, &cycle_id).display().to_string(),
            "discarded_blob_index": discarded_blob_index
        },
        "prime_directive_compacted_state": {
            "path": prime_directive_compacted_state_path(root).display().to_string(),
            "sha256": sha256_hex_str(&read_json(&prime_directive_compacted_state_path(root)).unwrap_or(Value::Null).to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-APP-023.3",
                "claim": "snowball_compaction_writes_versioned_sphere_of_ice_snapshots_with_restore_pointers",
                "evidence": {
                    "cycle_id": cycle_id,
                    "snapshot_path": snapshot_path.display().to_string()
                }
            },
            {
                "id": "V6-APP-023.7",
                "claim": "snowball_compaction_scores_assimilations_against_runtime_metrics_reliability_tiny_modes_and_rsi_utility",
                "evidence": {
                    "cycle_id": cycle_id,
                    "kept_count": kept.len(),
                    "discarded_count": discarded.len(),
                    "fitness_review_path": fitness_review_path(root, &cycle_id).display().to_string(),
                    "benchmark_report_path": benchmark_path.display().to_string()
                }
            },
            {
                "id": "V6-APP-023.9",
                "claim": "snowball_compaction_archives_discarded_or_demoted_ideas_as_versioned_blob_artifacts_with_provenance",
                "evidence": {
                    "cycle_id": cycle_id,
                    "discarded_blob_count": discarded_blob_rows.len(),
                    "discarded_blob_index_path": discarded_blob_index_path(root, &cycle_id).display().to_string()
                }
            },
            {
                "id": "V6-APP-023.11",
                "claim": "snowball_compaction_records_compacted_state_and_prime_directive_lineage_for_successful_cycles",
                "evidence": {
                    "cycle_id": cycle_id,
                    "prime_state_path": prime_directive_compacted_state_path(root).display().to_string()
                }
            },
            {
                "id": "V6-APP-023.5",
                "claim": "snowball_runtime_publishes_live_cycle_state_for_operator_controls",
                "evidence": {
                    "cycle_id": cycle_id
                }
            },
            {
                "id": "V6-APP-023.6",
                "claim": "snowball_status_and_compact_controls_surface_cycle_stage_batch_outcomes_and_regression_state",
                "evidence": {
                    "cycle_id": cycle_id,
                    "stage": next_cycle.get("stage").cloned().unwrap_or(Value::Null),
                    "snapshot_path": snapshot_path.display().to_string()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_fitness_review(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let mut cycles = load_cycles(root);
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let mut cycles_map = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let cycle = load_cycle_value(&cycles, &cycle_id);
    if strict && cycle.is_none() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_fitness_review",
            "action": "fitness-review",
            "errors": ["snowball_cycle_not_found"],
            "cycle_id": cycle_id
        });
    }
    let benchmark_path = benchmark_report_path(root, parsed);
    let benchmark_after = load_benchmark_modes(&benchmark_path);
    let benchmark_before = cycle
        .as_ref()
        .and_then(|v| v.get("benchmark_before"))
        .cloned()
        .unwrap_or_else(|| benchmark_after.clone());
    let bench_delta = benchmark_delta(&benchmark_before, &benchmark_after);
    let reliability_before = parse_f64(parsed.flags.get("reliability-before"), 1.0);
    let reliability_after = parse_f64(parsed.flags.get("reliability-after"), reliability_before);
    let review = build_fitness_review(
        root,
        &cycle_id,
        &bench_delta,
        reliability_before,
        reliability_after,
        load_assimilation_plan(root, &cycle_id, parsed).as_slice(),
    );
    let review_path = fitness_review_path(root, &cycle_id);
    let _ = write_json(&review_path, &review);

    let mut next_cycle = cycle.unwrap_or_else(|| json!({"cycle_id": cycle_id, "stage":"reviewed"}));
    next_cycle["fitness_review"] = json!({
        "path": review_path.display().to_string(),
        "survivor_count": review.pointer("/summary/survivor_count").and_then(Value::as_u64).unwrap_or(0),
        "demoted_count": review.pointer("/summary/demoted_count").and_then(Value::as_u64).unwrap_or(0),
        "rejected_count": review.pointer("/summary/rejected_count").and_then(Value::as_u64).unwrap_or(0)
    });
    next_cycle["benchmark_after"] = benchmark_after;
    next_cycle["benchmark_delta"] = bench_delta.clone();
    next_cycle["updated_at"] = Value::String(crate::now_iso());
    cycles_map.insert(cycle_id.clone(), next_cycle.clone());
    cycles["cycles"] = Value::Object(cycles_map);
    cycles["active_cycle_id"] = Value::String(cycle_id.clone());
    cycles["updated_at"] = Value::String(crate::now_iso());
    store_cycles(root, &cycles);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "snowball_plane_fitness_review",
        "lane": "core/layer0/ops",
        "action": "fitness-review",
        "cycle_id": cycle_id,
        "review": review,
        "artifact": {
            "path": review_path.display().to_string(),
            "sha256": sha256_hex_str(&read_json(&review_path).unwrap_or(Value::Null).to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-APP-023.7",
                "claim": "snowball_fitness_review_scores_assimilations_against_metrics_reliability_tiny_modes_and_rsi_utility",
                "evidence": {
                    "cycle_id": cycle_id,
                    "survivor_count": next_cycle.pointer("/fitness_review/survivor_count").and_then(Value::as_u64).unwrap_or(0),
                    "demoted_count": next_cycle.pointer("/fitness_review/demoted_count").and_then(Value::as_u64).unwrap_or(0),
                    "rejected_count": next_cycle.pointer("/fitness_review/rejected_count").and_then(Value::as_u64).unwrap_or(0)
                }
            },
            {
                "id": "V6-APP-023.5",
                "claim": "snowball_runtime_publishes_live_cycle_state_for_operator_controls",
                "evidence": {"cycle_id": cycle_id}
            },
            {
                "id": "V6-APP-023.6",
                "claim": "snowball_status_and_compact_controls_surface_cycle_stage_batch_outcomes_and_regression_state",
                "evidence": {"cycle_id": cycle_id, "has_review": true}
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_archive_discarded(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let mut cycles = load_cycles(root);
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let mut cycles_map = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let cycle = load_cycle_value(&cycles, &cycle_id);
    let review = load_review(root, &cycle_id);
    if strict && review.is_none() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_archive_discarded",
            "action": "archive-discarded",
            "errors": ["snowball_fitness_review_missing"],
            "cycle_id": cycle_id
        });
    }
    let review = review.unwrap_or_else(|| json!({}));
    let mut discarded = review
        .get("demoted")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    discarded.extend(
        review
            .get("rejected")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default(),
    );
    let (items, index) = archive_discarded_blobs(root, &cycle_id, discarded.as_slice());
    let index_path = discarded_blob_index_path(root, &cycle_id);

    let mut next_cycle = cycle.unwrap_or_else(|| json!({"cycle_id": cycle_id, "stage":"archived"}));
    next_cycle["discarded_archive"] = json!({
        "path": index_path.display().to_string(),
        "count": items.len()
    });
    next_cycle["updated_at"] = Value::String(crate::now_iso());
    cycles_map.insert(cycle_id.clone(), next_cycle.clone());
    cycles["cycles"] = Value::Object(cycles_map);
    cycles["active_cycle_id"] = Value::String(cycle_id.clone());
    cycles["updated_at"] = Value::String(crate::now_iso());
    store_cycles(root, &cycles);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "snowball_plane_archive_discarded",
        "lane": "core/layer0/ops",
        "action": "archive-discarded",
        "cycle_id": cycle_id,
        "archive": index,
        "claim_evidence": [
            {
                "id": "V6-APP-023.9",
                "claim": "snowball_archives_discarded_and_demoted_ideas_as_versioned_blob_artifacts_with_resurrection_metadata",
                "evidence": {
                    "cycle_id": cycle_id,
                    "discarded_blob_count": items.len(),
                    "discarded_blob_index_path": index_path.display().to_string()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_publish_benchmarks(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let mut cycles = load_cycles(root);
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let mut cycles_map = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let cycle = load_cycle_value(&cycles, &cycle_id);
    if strict && cycle.is_none() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_publish_benchmarks",
            "action": "publish-benchmarks",
            "errors": ["snowball_cycle_not_found"],
            "cycle_id": cycle_id
        });
    }
    let benchmark_path = benchmark_report_path(root, parsed);
    let report = read_json(&benchmark_path).unwrap_or(Value::Null);
    let benchmark_after = benchmark_modes_from_report(&report);
    let benchmark_before = cycle
        .as_ref()
        .and_then(|v| v.get("benchmark_before"))
        .cloned()
        .unwrap_or_else(|| benchmark_after.clone());
    let delta = benchmark_delta(&benchmark_before, &benchmark_after);
    let readme_path = readme_path(root, parsed);
    let readme_text = fs::read_to_string(&readme_path).unwrap_or_default();
    let sync = readme_sync_summary(&report, &readme_text);
    let synced = sync.get("synced").and_then(Value::as_bool).unwrap_or(false);
    let publication_path = benchmark_publication_path(root, &cycle_id);
    let summary = json!({
        "version": "v1",
        "cycle_id": cycle_id,
        "generated_at": crate::now_iso(),
        "benchmark_report_path": benchmark_path.display().to_string(),
        "readme_path": readme_path.display().to_string(),
        "delta": delta,
        "readme_sync": sync
    });
    let _ = write_json(&publication_path, &summary);

    let mut next_cycle =
        cycle.unwrap_or_else(|| json!({"cycle_id": cycle_id, "stage":"published"}));
    next_cycle["benchmark_publication"] = json!({
        "path": publication_path.display().to_string(),
        "readme_synced": synced
    });
    next_cycle["updated_at"] = Value::String(crate::now_iso());
    cycles_map.insert(cycle_id.clone(), next_cycle);
    cycles["cycles"] = Value::Object(cycles_map);
    cycles["active_cycle_id"] = Value::String(cycle_id.clone());
    cycles["updated_at"] = Value::String(crate::now_iso());
    store_cycles(root, &cycles);

    let ok = if strict { synced } else { true };
    let mut out = json!({
        "ok": ok,
        "strict": strict,
        "type": "snowball_plane_publish_benchmarks",
        "lane": "core/layer0/ops",
        "action": "publish-benchmarks",
        "cycle_id": cycle_id,
        "publication": summary,
        "claim_evidence": [
            {
                "id": "V6-APP-023.10",
                "claim": "snowball_benchmark_publication_emits_receipted_deltas_and_fails_closed_when_readme_evidence_is_stale",
                "evidence": {
                    "cycle_id": cycle_id,
                    "publication_path": publication_path.display().to_string(),
                    "readme_synced": synced
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_promote(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let mut cycles = load_cycles(root);
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let mut cycles_map = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let cycle = load_cycle_value(&cycles, &cycle_id);
    if strict && cycle.is_none() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_promote",
            "action": "promote",
            "errors": ["snowball_cycle_not_found"],
            "cycle_id": cycle_id
        });
    }
    let review = load_review(root, &cycle_id).unwrap_or_else(|| json!({}));
    let publication =
        read_json(&benchmark_publication_path(root, &cycle_id)).unwrap_or_else(|| json!({}));
    let regression_pass = cycle
        .as_ref()
        .and_then(|v| v.pointer("/melt_refine/pass"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let improved = review
        .pointer("/summary/improved_metric_count")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0;
    let regressed = review
        .pointer("/summary/regressed_metric_count")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        > 0;
    let allow_neutral = parse_bool(parsed.flags.get("allow-neutral"), false);
    let neutral_justification = clean(
        parsed
            .flags
            .get("neutral-justification")
            .cloned()
            .unwrap_or_default(),
        240,
    );
    let neutral_ok = allow_neutral && !neutral_justification.is_empty() && !regressed;
    let publication_ok = publication
        .pointer("/readme_sync/synced")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let promoted = regression_pass && publication_ok && (improved || neutral_ok);
    let rollback_pointer = json!({
        "cycles_path": cycles_path(root).display().to_string(),
        "cycle_id": cycle_id,
        "snapshot_path": cycle
            .as_ref()
            .and_then(|v| v.pointer("/snapshot/path"))
            .and_then(Value::as_str)
            .unwrap_or("")
    });
    let survivors = review
        .get("survivors")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let promotion = json!({
        "version": "v1",
        "cycle_id": cycle_id,
        "generated_at": crate::now_iso(),
        "promoted": promoted,
        "regression_pass": regression_pass,
        "publication_ok": publication_ok,
        "improved": improved,
        "neutral_ok": neutral_ok,
        "neutral_justification": neutral_justification,
        "survivors": survivors,
        "rollback_pointer": rollback_pointer
    });
    let promotion_out = promotion_path(root, &cycle_id);
    let _ = write_json(&promotion_out, &promotion);

    let mut next_cycle = cycle.unwrap_or_else(|| json!({"cycle_id": cycle_id, "stage":"running"}));
    next_cycle["promotion"] = json!({
        "path": promotion_out.display().to_string(),
        "promoted": promoted
    });
    next_cycle["stage"] = Value::String(if promoted {
        "promoted".to_string()
    } else {
        "rollback".to_string()
    });
    next_cycle["updated_at"] = Value::String(crate::now_iso());
    cycles_map.insert(cycle_id.clone(), next_cycle.clone());
    cycles["cycles"] = Value::Object(cycles_map);
    cycles["active_cycle_id"] = Value::String(cycle_id.clone());
    cycles["updated_at"] = Value::String(crate::now_iso());
    store_cycles(root, &cycles);

    let ok = if strict { promoted } else { true };
    let mut out = json!({
        "ok": ok,
        "strict": strict,
        "type": "snowball_plane_promote",
        "lane": "core/layer0/ops",
        "action": "promote",
        "cycle_id": cycle_id,
        "promotion": promotion,
        "claim_evidence": [
            {
                "id": "V6-APP-023.8",
                "claim": "snowball_promotion_requires_regression_and_benchmark_publication_evidence_before_advancing_active_state",
                "evidence": {
                    "cycle_id": cycle_id,
                    "promoted": promoted,
                    "publication_ok": publication_ok,
                    "regression_pass": regression_pass,
                    "rollback_pointer": rollback_pointer
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_prime_update(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let mut cycles = load_cycles(root);
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let mut cycles_map = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let cycle = load_cycle_value(&cycles, &cycle_id);
    let promotion = read_json(&promotion_path(root, &cycle_id)).unwrap_or_else(|| json!({}));
    if strict && promotion.get("promoted").and_then(Value::as_bool) != Some(true) {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_prime_update",
            "action": "prime-update",
            "errors": ["snowball_promotion_not_ready"],
            "cycle_id": cycle_id
        });
    }
    let archive_path = discarded_blob_index_path(root, &cycle_id);
    let publication_path = benchmark_publication_path(root, &cycle_id);
    if strict && !archive_path.exists() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_prime_update",
            "action": "prime-update",
            "errors": ["snowball_discarded_archive_missing"],
            "cycle_id": cycle_id
        });
    }
    if strict && !publication_path.exists() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_prime_update",
            "action": "prime-update",
            "errors": ["snowball_benchmark_publication_missing"],
            "cycle_id": cycle_id
        });
    }
    let archive = read_json(&archive_path).unwrap_or_else(|| json!({}));
    let directive_text = parsed.flags.get("directive").cloned().unwrap_or_default();
    let signer = clean(
        parsed
            .flags
            .get("signer")
            .cloned()
            .unwrap_or_else(|| "snowball-plane".to_string()),
        64,
    );
    let directive_result = if directive_text.trim().is_empty() {
        Ok(None)
    } else {
        directive_kernel::append_compaction_directive_entry(
            root,
            directive_text.as_str(),
            signer.as_str(),
            None,
            "snowball_compaction",
        )
        .map(Some)
    };
    if strict && directive_result.is_err() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_prime_update",
            "action": "prime-update",
            "errors": [directive_result.err().unwrap_or_else(|| "directive_append_failed".to_string())],
            "cycle_id": cycle_id
        });
    }
    let directive_entry = directive_result.ok().flatten();
    let prime_state = json!({
        "version": "v1",
        "cycle_id": cycle_id,
        "updated_at": crate::now_iso(),
        "promotion_path": promotion_path(root, &cycle_id).display().to_string(),
        "benchmark_publication_path": publication_path.display().to_string(),
        "discarded_blob_index_path": archive_path.display().to_string(),
        "promoted_survivors": promotion.get("survivors").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "discarded_artifacts": archive.get("items").cloned().unwrap_or_else(|| Value::Array(Vec::new())),
        "directive_delta": directive_entry.clone().unwrap_or_else(|| json!({"applied": false})),
        "active_state_delta": {
            "previous_stage": cycle
                .as_ref()
                .and_then(|v| v.get("stage"))
                .cloned()
                .unwrap_or(Value::String("unknown".to_string())),
            "next_stage": "prime-updated"
        }
    });
    let prime_path = prime_directive_compacted_state_path(root);
    let _ = write_json(&prime_path, &prime_state);

    let mut next_cycle = cycle.unwrap_or_else(|| json!({"cycle_id": cycle_id, "stage":"promoted"}));
    next_cycle["prime_directive_update"] = json!({
        "path": prime_path.display().to_string(),
        "directive_delta_applied": directive_entry.is_some()
    });
    next_cycle["stage"] = Value::String("prime-updated".to_string());
    next_cycle["updated_at"] = Value::String(crate::now_iso());
    cycles_map.insert(cycle_id.clone(), next_cycle.clone());
    cycles["cycles"] = Value::Object(cycles_map);
    cycles["active_cycle_id"] = Value::String(cycle_id.clone());
    cycles["updated_at"] = Value::String(crate::now_iso());
    store_cycles(root, &cycles);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "snowball_plane_prime_update",
        "lane": "core/layer0/ops",
        "action": "prime-update",
        "cycle_id": cycle_id,
        "prime_directive_state": prime_state,
        "claim_evidence": [
            {
                "id": "V6-APP-023.11",
                "claim": "snowball_prime_update_records_promoted_survivors_discarded_artifacts_and_directive_deltas_through_prime_governance",
                "evidence": {
                    "cycle_id": cycle_id,
                    "prime_state_path": prime_path.display().to_string(),
                    "directive_delta_applied": directive_entry.is_some()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_backlog_pack(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let mut cycles = load_cycles(root);
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let mut cycles_map = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let cycle = cycles_map.get(&cycle_id).cloned();
    if strict && cycle.is_none() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_backlog_pack",
            "action": "backlog-pack",
            "errors": ["snowball_cycle_not_found"],
            "cycle_id": cycle_id
        });
    }
    let unresolved = parse_json_flag(parsed.flags.get("unresolved-json"))
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_else(|| {
            let mut defaults = vec![json!({
                "id":"verify-regression",
                "depends_on": [],
                "priority": 1
            })];
            if cycle
                .as_ref()
                .and_then(|v| v.get("melt_refine"))
                .and_then(|v| v.get("pass"))
                .and_then(Value::as_bool)
                == Some(false)
            {
                defaults.push(json!({
                    "id":"rollback-analysis",
                    "depends_on": ["verify-regression"],
                    "priority": 0
                }));
            }
            defaults
        });
    let ordered = dependency_ordered_backlog(unresolved);
    let backlog = json!({
        "version":"v1",
        "cycle_id": cycle_id,
        "generated_at": crate::now_iso(),
        "items": ordered
    });
    let out_path = backlog_path(root, &cycle_id);
    let _ = write_json(&out_path, &backlog);

    let mut next_cycle = cycle.unwrap_or_else(|| json!({"cycle_id": cycle_id, "stage":"running"}));
    next_cycle["next_backlog"] = json!({
        "path": out_path.display().to_string(),
        "count": backlog.get("items").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0)
    });
    next_cycle["updated_at"] = Value::String(crate::now_iso());
    cycles_map.insert(cycle_id.clone(), next_cycle.clone());
    cycles["cycles"] = Value::Object(cycles_map);
    cycles["active_cycle_id"] = Value::String(cycle_id.clone());
    cycles["updated_at"] = Value::String(crate::now_iso());
    store_cycles(root, &cycles);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "snowball_plane_backlog_pack",
        "lane": "core/layer0/ops",
        "action": "backlog-pack",
        "cycle_id": cycle_id,
        "backlog": backlog,
        "artifact": {
            "path": out_path.display().to_string(),
            "sha256": sha256_hex_str(&read_json(&out_path).unwrap_or(Value::Null).to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-APP-023.4",
                "claim": "snowball_backlog_pack_generates_dependency_ordered_next_cycle_items_from_unresolved_findings",
                "evidence": {
                    "cycle_id": cycle_id
                }
            },
            {
                "id": "V6-APP-023.5",
                "claim": "snowball_runtime_publishes_live_cycle_state_for_operator_controls",
                "evidence": {
                    "cycle_id": cycle_id
                }
            },
            {
                "id": "V6-APP-023.6",
                "claim": "snowball_status_and_compact_controls_surface_cycle_stage_batch_outcomes_and_regression_state",
                "evidence": {
                    "cycle_id": cycle_id,
                    "queued_items": backlog.get("items").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0)
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_control(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let mut cycles = load_cycles(root);
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "pause".to_string()),
        20,
    )
    .to_ascii_lowercase();
    if strict && !matches!(op.as_str(), "pause" | "resume" | "abort") {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_control",
            "action": "control",
            "errors": ["snowball_control_op_invalid"],
            "op": op
        });
    }

    let mut cycles_map = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut cycle = cycles_map
        .get(&cycle_id)
        .cloned()
        .unwrap_or_else(|| json!({"cycle_id": cycle_id, "stage":"running"}));
    cycle["control"] = json!({
        "op": op,
        "ts": crate::now_iso()
    });
    cycle["stage"] = Value::String(match op.as_str() {
        "pause" => "paused".to_string(),
        "resume" => "running".to_string(),
        "abort" => "aborted".to_string(),
        _ => "running".to_string(),
    });
    cycle["updated_at"] = Value::String(crate::now_iso());
    cycles_map.insert(cycle_id.clone(), cycle.clone());
    cycles["cycles"] = Value::Object(cycles_map);
    cycles["active_cycle_id"] = Value::String(cycle_id.clone());
    cycles["updated_at"] = Value::String(crate::now_iso());
    store_cycles(root, &cycles);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "snowball_plane_control",
        "lane": "core/layer0/ops",
        "action": "control",
        "cycle_id": cycle_id,
        "control": cycle.get("control").cloned().unwrap_or(Value::Null),
        "stage": cycle.get("stage").cloned().unwrap_or(Value::String("running".to_string())),
        "claim_evidence": [
            {
                "id": "V6-APP-023.5",
                "claim": "snowball_status_and_controls_are_live_and_receipted_through_conduit",
                "evidence": {
                    "cycle_id": cycle_id,
                    "op": op
                }
            },
            {
                "id": "V6-APP-023.6",
                "claim": "snowball_status_and_compact_controls_surface_cycle_stage_batch_outcomes_and_regression_state",
                "evidence": {
                    "cycle_id": cycle_id,
                    "op": op,
                    "stage": cycle.get("stage").cloned().unwrap_or(Value::Null)
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_status(root: &Path, parsed: &crate::ParsedArgs) -> Value {
    let cycles = load_cycles(root);
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let cycle = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .and_then(|map| map.get(&cycle_id))
        .cloned();
    let mut out = json!({
        "ok": true,
        "type": "snowball_plane_status",
        "lane": "core/layer0/ops",
        "cycle_id": cycle_id,
        "cycle": cycle,
        "latest_path": latest_path(root).display().to_string(),
        "controls": ["pause", "resume", "abort", "compact"],
        "claim_evidence": [
            {
                "id": "V6-APP-023.5",
                "claim": "snowball_status_and_controls_are_live_and_receipted_through_conduit",
                "evidence": {
                    "active_cycle_id": cycles.get("active_cycle_id").cloned().unwrap_or(Value::Null)
                }
            },
            {
                "id": "V6-APP-023.6",
                "claim": "snowball_status_and_compact_controls_surface_cycle_stage_batch_outcomes_and_regression_state",
                "evidence": {
                    "active_cycle_id": cycles.get("active_cycle_id").cloned().unwrap_or(Value::Null),
                    "has_cycle": cycle.is_some()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn dispatch(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let action = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    match action.as_str() {
        "status" => run_status(root, parsed),
        "start" => run_start(root, parsed, strict),
        "melt-refine" | "melt" | "refine" | "regress" => run_melt_refine(root, parsed, strict),
        "compact" => run_compact(root, parsed, strict),
        "fitness-review" => run_fitness_review(root, parsed, strict),
        "archive-discarded" => run_archive_discarded(root, parsed, strict),
        "publish-benchmarks" => run_publish_benchmarks(root, parsed, strict),
        "promote" => run_promote(root, parsed, strict),
        "prime-update" => run_prime_update(root, parsed, strict),
        "backlog-pack" | "backlog" => run_backlog_pack(root, parsed, strict),
        "control" => run_control(root, parsed, strict),
        _ => json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_error",
            "action": action,
            "errors": ["snowball_action_unknown"]
        }),
    }
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let action = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    if matches!(action.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }
    let strict = parse_bool(parsed.flags.get("strict"), true);
    let conduit_action = if action == "regress" {
        "melt-refine"
    } else {
        action.as_str()
    };
    let conduit = if action != "status" {
        Some(conduit_enforcement(root, &parsed, strict, conduit_action))
    } else {
        None
    };
    if strict
        && conduit
            .as_ref()
            .and_then(|v| v.get("ok"))
            .and_then(Value::as_bool)
            == Some(false)
    {
        return emit(
            root,
            json!({
                "ok": false,
                "strict": strict,
                "type": "snowball_plane_conduit_gate",
                "errors": ["conduit_bypass_rejected"],
                "conduit_enforcement": conduit
            }),
        );
    }

    let payload = dispatch(root, &parsed, strict);
    if action == "status" {
        print_payload(&payload);
        return 0;
    }
    emit(root, attach_conduit(payload, conduit.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_writes_cycle_registry() {
        let root = tempfile::tempdir().expect("tempdir");
        let out = run_start(
            root.path(),
            &crate::parse_args(&[
                "start".to_string(),
                "--strict=1".to_string(),
                "--cycle-id=c17".to_string(),
                "--drops=core-hardening,app-runtime".to_string(),
            ]),
            true,
        );
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert!(cycles_path(root.path()).exists());
    }

    #[test]
    fn conduit_rejects_bypass() {
        let root = tempfile::tempdir().expect("tempdir");
        let gate = conduit_enforcement(
            root.path(),
            &crate::parse_args(&[
                "start".to_string(),
                "--strict=1".to_string(),
                "--bypass=1".to_string(),
            ]),
            true,
            "start",
        );
        assert_eq!(gate.get("ok").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn compact_writes_snapshot() {
        let root = tempfile::tempdir().expect("tempdir");
        let _ = run_start(
            root.path(),
            &crate::parse_args(&[
                "start".to_string(),
                "--strict=1".to_string(),
                "--cycle-id=c18".to_string(),
                "--allow-high-risk=1".to_string(),
            ]),
            true,
        );
        let out = run_compact(
            root.path(),
            &crate::parse_args(&[
                "compact".to_string(),
                "--strict=1".to_string(),
                "--cycle-id=c18".to_string(),
            ]),
            true,
        );
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        let snap_path = out
            .get("snapshot")
            .and_then(|v| v.get("path"))
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(!snap_path.is_empty());
    }

    #[test]
    fn backlog_pack_orders_items_by_dependencies_then_priority() {
        let root = tempfile::tempdir().expect("tempdir");
        let _ = run_start(
            root.path(),
            &crate::parse_args(&[
                "start".to_string(),
                "--strict=1".to_string(),
                "--cycle-id=c35".to_string(),
            ]),
            true,
        );
        let unresolved = json!([
            {"id":"deploy","priority":0,"depends_on":["verify"]},
            {"id":"verify","priority":2,"depends_on":[]},
            {"id":"package","priority":1,"depends_on":["verify"]}
        ]);
        let out = run_backlog_pack(
            root.path(),
            &crate::parse_args(&[
                "backlog-pack".to_string(),
                "--strict=1".to_string(),
                "--cycle-id=c35".to_string(),
                format!("--unresolved-json={}", unresolved),
            ]),
            true,
        );
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        let items = out
            .pointer("/backlog/items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let order = items
            .iter()
            .filter_map(|row| row.get("id").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert_eq!(order.first().copied(), Some("verify"));
        let verify_idx = order.iter().position(|id| *id == "verify").expect("verify");
        let package_idx = order
            .iter()
            .position(|id| *id == "package")
            .expect("package");
        let deploy_idx = order.iter().position(|id| *id == "deploy").expect("deploy");
        assert!(verify_idx < package_idx);
        assert!(verify_idx < deploy_idx);
        assert_eq!(
            items
                .first()
                .and_then(|row| row.get("dependency_cycle_break"))
                .and_then(Value::as_bool),
            Some(false)
        );
    }

    #[test]
    fn compact_scores_assimilation_and_archives_discarded_blob_rows() {
        let root = tempfile::tempdir().expect("tempdir");
        let report_path = root
            .path()
            .join("docs/client/reports/benchmark_matrix_run_2026-03-06.json");
        let report = json!({
            "openclaw_measured": {"cold_start_ms": 5.0, "idle_memory_mb": 9.0, "install_size_mb": 10.0, "tasks_per_sec": 10000.0, "security_systems": 83.0, "channel_adapters": 6.0, "llm_providers": 3.0},
            "pure_workspace_measured": {"cold_start_ms": 4.0, "idle_memory_mb": 1.4, "install_size_mb": 0.7, "tasks_per_sec": 12000.0, "security_systems": 83.0, "channel_adapters": 0.0, "llm_providers": 0.0},
            "pure_workspace_tiny_max_measured": {"cold_start_ms": 3.0, "idle_memory_mb": 1.3, "install_size_mb": 0.5, "tasks_per_sec": 12100.0, "security_systems": 83.0, "channel_adapters": 0.0, "llm_providers": 0.0}
        });
        let _ = write_json(&report_path, &report);
        let _ = run_start(
            root.path(),
            &crate::parse_args(&[
                "start".to_string(),
                "--strict=1".to_string(),
                "--cycle-id=c39".to_string(),
            ]),
            true,
        );
        let assimilations = json!([
            {"id":"tiny-allocator","metric_gain":true,"pure_tiny_strength":true,"intelligence_gain":true,"tiny_hardware_fit":true},
            {"id":"big-ui-runtime","metric_gain":false,"pure_tiny_strength":false,"intelligence_gain":false,"tiny_hardware_fit":false}
        ]);
        let out = run_compact(
            root.path(),
            &crate::parse_args(&[
                "compact".to_string(),
                "--strict=1".to_string(),
                "--cycle-id=c39".to_string(),
                format!("--assimilations-json={}", assimilations),
            ]),
            true,
        );
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            out.pointer("/assimilation/kept_count")
                .and_then(Value::as_u64),
            Some(1)
        );
        assert_eq!(
            out.pointer("/assimilation/discarded_count")
                .and_then(Value::as_u64),
            Some(1)
        );
        let prime_path = out
            .pointer("/prime_directive_compacted_state/path")
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(!prime_path.is_empty());
        assert!(Path::new(prime_path).exists());
        let blob_rows = out
            .pointer("/assimilation/discarded_blob_index/items")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert_eq!(blob_rows.len(), 1);
    }
}
