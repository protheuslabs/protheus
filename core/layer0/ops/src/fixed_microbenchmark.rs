// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::hint::black_box;
use std::path::Path;
use std::time::{Duration, Instant};

const DEFAULT_LATEST_REL: &str = "local/state/ops/fixed_microbenchmark/latest.json";
const DEFAULT_HISTORY_REL: &str = "local/state/ops/fixed_microbenchmark/history.jsonl";
const DEFAULT_SAMPLE_MS: u64 = 800;
const DEFAULT_WARMUP_RUNS: usize = 2;
const DEFAULT_ROUNDS: usize = 9;
const DEFAULT_WORK_FACTOR: u32 = 16;
const DEFAULT_WORKLOAD_ID: &str = "sha256_fixed_workload_v1";

fn usage() {
    println!("fixed-microbenchmark commands:");
    println!(
        "  protheus-ops fixed-microbenchmark run [--rounds=9] [--warmup-runs=2] [--sample-ms=800] [--work-factor=16] [--workload-id=sha256_fixed_workload_v1]"
    );
    println!("  protheus-ops fixed-microbenchmark status");
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn cli_receipt(kind: &str, payload: Value) -> Value {
    let ts = now_iso();
    let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(true);
    let mut out = json!({
        "ok": ok,
        "type": kind,
        "ts": ts,
        "date": ts[..10].to_string(),
        "payload": payload,
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn cli_error(kind: &str, error: &str) -> Value {
    let ts = now_iso();
    let mut out = json!({
        "ok": false,
        "type": kind,
        "ts": ts,
        "date": ts[..10].to_string(),
        "error": error,
        "fail_closed": true,
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn percentile(samples: &[f64], q: f64) -> f64 {
    if samples.is_empty() {
        return 0.0;
    }
    let mut rows = samples.to_vec();
    rows.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((rows.len() - 1) as f64 * q.clamp(0.0, 1.0)).round() as usize;
    rows[idx]
}

fn parse_u64(argv: &[String], key: &str, fallback: u64, lo: u64, hi: u64) -> u64 {
    lane_utils::parse_flag(argv, key, false)
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .unwrap_or(fallback)
        .clamp(lo, hi)
}

fn parse_usize(argv: &[String], key: &str, fallback: usize, lo: usize, hi: usize) -> usize {
    lane_utils::parse_flag(argv, key, false)
        .and_then(|raw| raw.trim().parse::<usize>().ok())
        .unwrap_or(fallback)
        .clamp(lo, hi)
}

fn workload_id(argv: &[String]) -> String {
    lane_utils::clean_token(
        lane_utils::parse_flag(argv, "workload-id", false).as_deref(),
        DEFAULT_WORKLOAD_ID,
    )
}

fn latest_path(root: &Path) -> std::path::PathBuf {
    root.join(DEFAULT_LATEST_REL)
}

fn history_path(root: &Path) -> std::path::PathBuf {
    root.join(DEFAULT_HISTORY_REL)
}

fn fixed_workload_ops_per_sec(sample_ms: u64, work_factor: u32, workload_id: &str) -> f64 {
    let target = Duration::from_millis(sample_ms.max(100));
    let started = Instant::now();
    let mut tasks = 0u64;
    while started.elapsed() < target {
        for idx in 0..work_factor.max(1) {
            let payload = format!("{workload_id}:task:{tasks}:work:{idx}");
            let digest = Sha256::digest(payload.as_bytes());
            black_box(digest);
        }
        tasks = tasks.saturating_add(1);
    }
    let secs = started.elapsed().as_secs_f64();
    if secs <= 0.0 {
        0.0
    } else {
        ((tasks as f64 / secs) * 100.0).round() / 100.0
    }
}

fn run_payload(argv: &[String]) -> Value {
    let rounds = parse_usize(argv, "rounds", DEFAULT_ROUNDS, 1, 64);
    let warmup_runs = parse_usize(argv, "warmup-runs", DEFAULT_WARMUP_RUNS, 0, 32);
    let sample_ms = parse_u64(argv, "sample-ms", DEFAULT_SAMPLE_MS, 100, 10_000);
    let work_factor = parse_u64(argv, "work-factor", DEFAULT_WORK_FACTOR as u64, 1, 1_024) as u32;
    let workload_id = workload_id(argv);

    for _ in 0..warmup_runs {
        let _ = fixed_workload_ops_per_sec(sample_ms, work_factor, &workload_id);
    }

    let mut samples = Vec::<f64>::with_capacity(rounds);
    for _ in 0..rounds {
        samples.push(fixed_workload_ops_per_sec(
            sample_ms,
            work_factor,
            &workload_id,
        ));
    }

    let p50 = percentile(&samples, 0.50);
    let p95 = percentile(&samples, 0.95);
    let min = samples.iter().copied().reduce(f64::min).unwrap_or(0.0);
    let max = samples.iter().copied().reduce(f64::max).unwrap_or(0.0);

    json!({
        "ok": true,
        "type": "fixed_microbenchmark",
        "generated_at": now_iso(),
        "workload_id": workload_id,
        "config": {
            "rounds": rounds,
            "warmup_runs": warmup_runs,
            "sample_ms": sample_ms,
            "work_factor": work_factor,
        },
        "environment_fingerprint": {
            "arch": std::env::consts::ARCH,
            "os": std::env::consts::OS,
            "cpu_parallelism": std::thread::available_parallelism().map(|v| v.get()).unwrap_or(1),
        },
        "samples_ops_per_sec": samples,
        "metrics": {
            "ops_per_sec_p50": ((p50 * 100.0).round()) / 100.0,
            "ops_per_sec_p95": ((p95 * 100.0).round()) / 100.0,
            "ops_per_sec_min": ((min * 100.0).round()) / 100.0,
            "ops_per_sec_max": ((max * 100.0).round()) / 100.0,
        },
        "interpretation": {
            "purpose": "host_baseline_and_harness_drift_detection",
            "separate_from_benchmark_matrix": true,
            "product_runtime_excluded": [
                "cold_start_probe",
                "runtime_efficiency_floor",
                "install_size_probe",
                "idle_rss_probe"
            ],
            "note": "This measures only the fixed SHA-256 workload so throughput drift can be compared against benchmark-matrix without product-path confounders."
        }
    })
}

fn write_artifacts(root: &Path, payload: &Value) -> Result<(), String> {
    lane_utils::write_json(&latest_path(root), payload)?;
    lane_utils::append_jsonl(&history_path(root), payload)
}

fn status_payload(root: &Path) -> Result<Value, String> {
    lane_utils::read_json(&latest_path(root)).ok_or_else(|| {
        format!(
            "fixed_microbenchmark_missing_latest:{}",
            latest_path(root).display()
        )
    })
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let command = argv
        .first()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "run".to_string());

    let payload = match command.as_str() {
        "run" => {
            let payload = run_payload(argv);
            if let Err(err) = write_artifacts(root, &payload) {
                print_json_line(&cli_error("fixed_microbenchmark_error", &err));
                return 1;
            }
            Ok(payload)
        }
        "status" => status_payload(root),
        "help" | "--help" | "-h" => {
            usage();
            return 0;
        }
        _ => Err(format!("fixed_microbenchmark_unknown_command:{command}")),
    };

    match payload {
        Ok(payload) => {
            let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(false);
            print_json_line(&cli_receipt(
                &format!("fixed_microbenchmark_{}", command.replace('-', "_")),
                payload,
            ));
            if ok {
                0
            } else {
                1
            }
        }
        Err(err) => {
            print_json_line(&cli_error("fixed_microbenchmark_error", &err));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_workload_returns_positive_rate() {
        let rate = fixed_workload_ops_per_sec(100, 4, "test_workload");
        assert!(rate > 0.0);
    }

    #[test]
    fn run_payload_records_expected_metrics() {
        let payload = run_payload(&[
            "run".to_string(),
            "--rounds=3".to_string(),
            "--warmup-runs=0".to_string(),
            "--sample-ms=100".to_string(),
            "--work-factor=2".to_string(),
            "--workload-id=test-fixed".to_string(),
        ]);
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            payload.get("workload_id").and_then(Value::as_str),
            Some("test-fixed")
        );
        assert!(payload["metrics"]["ops_per_sec_p50"]
            .as_f64()
            .map(|value| value > 0.0)
            .unwrap_or(false));
        assert_eq!(
            payload["interpretation"]["separate_from_benchmark_matrix"].as_bool(),
            Some(true)
        );
    }
}
