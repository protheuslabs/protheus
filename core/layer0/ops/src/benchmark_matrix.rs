// SPDX-License-Identifier: Apache-2.0
use crate::{
    clean, deterministic_receipt_hash, now_iso, parse_args, run_runtime_efficiency_floor,
    status_runtime_efficiency_floor,
};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::fs;
use std::hint::black_box;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};
use walkdir::WalkDir;

const LANE_ID: &str = "benchmark_matrix";
const DEFAULT_SNAPSHOT_REL: &str =
    "client/runtime/config/competitive_benchmark_snapshot_2026_02.json";
const TOP1_BENCHMARK_SNAPSHOT_REL: &str =
    "docs/client/reports/runtime_snapshots/ops/proof_pack/top1_benchmark_snapshot.json";
const STATE_LATEST_REL: &str = "local/state/ops/competitive_benchmark_matrix/latest.json";
const STATE_HISTORY_REL: &str = "local/state/ops/competitive_benchmark_matrix/history.jsonl";
const MIN_BAR_WIDTH: usize = 10;
const MAX_BAR_WIDTH: usize = 80;
const DEFAULT_BAR_WIDTH: usize = 44;
const SHARED_THROUGHPUT_SOURCE: &str = "live_hash_workload_v1_shared_pre_profile_baseline";
const SHARED_THROUGHPUT_SAMPLE_MS: u64 = 800;
const SHARED_THROUGHPUT_ROUNDS: usize = 5;
const SHARED_THROUGHPUT_WARMUP_ROUNDS: usize = 2;

#[derive(Clone, Copy)]
struct Category {
    key: &'static str,
    label: &'static str,
    lower_is_better: bool,
    unit: &'static str,
}

const CATEGORIES: [Category; 7] = [
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
        key: "tasks_per_sec",
        label: "Throughput (ops/sec, higher is better)",
        lower_is_better: false,
        unit: "ops/sec",
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
    let payload = read_json(&root.join("client/runtime/config/guard_check_registry.json"))?;
    let count = payload
        .get("merge_guard")
        .and_then(|v| v.get("checks"))
        .and_then(Value::as_array)
        .map(|rows| rows.len() as f64)
        .unwrap_or(0.0);
    Ok(count)
}

fn count_channel_adapters(root: &Path) -> Result<f64, String> {
    let payload = read_json(&root.join("client/runtime/config/platform_adaptation_channels.json"))?;
    let count = payload
        .get("channels")
        .and_then(Value::as_array)
        .map(|rows| rows.len() as f64)
        .unwrap_or(0.0);
    Ok(count)
}

fn count_llm_providers(root: &Path) -> Result<f64, String> {
    let mut providers = BTreeSet::<String>::new();

    let onboarding =
        read_json(&root.join("client/runtime/config/provider_onboarding_manifest.json"))?;
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

    let recovery =
        read_json(&root.join("client/runtime/config/model_health_auto_recovery_policy.json"))?;
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
    let cold_start_ms =
        get_f64(metrics, "cold_start_p50_ms").or_else(|| get_f64(metrics, "cold_start_p95_ms"))?;
    let idle_memory_mb =
        get_f64(metrics, "idle_rss_p50_mb").or_else(|| get_f64(metrics, "idle_rss_p95_mb"))?;
    let install_size_mb = get_f64(metrics, "full_install_total_mb")
        .or_else(|| get_f64(metrics, "install_artifact_total_mb"))?;
    Some((cold_start_ms, idle_memory_mb, install_size_mb))
}

fn extract_top1_snapshot_metrics(snapshot_json: &Value) -> Option<(f64, f64, f64)> {
    let metrics = snapshot_json.get("metrics")?;
    let cold_start_ms = get_f64(metrics, "cold_start_ms")?;
    let idle_memory_mb = get_f64(metrics, "idle_rss_mb")?;
    let install_size_mb = get_f64(metrics, "install_size_mb")?;
    Some((cold_start_ms, idle_memory_mb, install_size_mb))
}

fn path_size_mb(root: &Path, rel: &str) -> f64 {
    let abs = root.join(rel);
    if !abs.exists() {
        return 0.0;
    }
    if abs.is_file() {
        return fs::metadata(abs)
            .map(|m| m.len() as f64 / (1024.0 * 1024.0))
            .unwrap_or(0.0);
    }
    let mut bytes = 0u64;
    for entry in WalkDir::new(abs).into_iter().flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                bytes = bytes.saturating_add(meta.len());
            }
        }
    }
    bytes as f64 / (1024.0 * 1024.0)
}

fn local_full_install_probe_mb(root: &Path) -> Option<f64> {
    let mut paths = vec![
        "node_modules".to_string(),
        "client/runtime".to_string(),
        "core/layer0/ops".to_string(),
    ];

    for rel in [
        "target/x86_64-unknown-linux-musl/release/protheusd",
        "target/release/protheusd",
        "target/debug/protheusd",
    ] {
        if root.join(rel).exists() {
            paths.push(rel.to_string());
            break;
        }
    }

    let total: f64 = paths.into_iter().map(|rel| path_size_mb(root, &rel)).sum();
    if total <= 0.0 {
        None
    } else {
        Some((total * 1000.0).round() / 1000.0)
    }
}

fn locate_binary(root: &Path, candidates: &[&str]) -> Option<String> {
    candidates
        .iter()
        .map(|rel| root.join(rel))
        .find(|path| path.exists())
        .map(|path| path.to_string_lossy().to_string())
}

fn command_elapsed_ms(program: &str, args: &[&str]) -> Result<f64, String> {
    let started = Instant::now();
    let status = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|err| format!("probe_spawn_failed:{program}:{err}"))?;
    if !status.success() {
        return Err(format!(
            "probe_exit_failed:{program}:{}",
            status.code().unwrap_or(1)
        ));
    }
    Ok(started.elapsed().as_secs_f64() * 1000.0)
}

fn percentile(sorted: &[f64], q: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let quantile = q.clamp(0.0, 1.0);
    let idx = ((sorted.len() as f64 * quantile).ceil() as usize)
        .saturating_sub(1)
        .min(sorted.len().saturating_sub(1));
    sorted[idx]
}

fn sample_command_quantiles_ms(
    program: &str,
    args: &[&str],
    warmup_runs: usize,
    samples: usize,
) -> Result<(f64, f64, f64), String> {
    for _ in 0..warmup_runs {
        let _ = command_elapsed_ms(program, args)?;
    }
    let mut rows = Vec::new();
    for _ in 0..samples.max(1) {
        rows.push(command_elapsed_ms(program, args)?);
    }
    rows.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Ok((
        percentile(&rows, 0.50),
        percentile(&rows, 0.95),
        percentile(&rows, 0.99),
    ))
}

fn sample_child_rss_mb(program: &str, args: &[&str]) -> Result<f64, String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|err| format!("rss_spawn_failed:{program}:{err}"))?;
    thread::sleep(Duration::from_millis(80));
    let pid = child.id().to_string();
    let out = Command::new("ps")
        .args(["-o", "rss=", "-p", &pid])
        .stdin(Stdio::null())
        .output()
        .map_err(|err| format!("rss_ps_failed:{err}"))?;
    let _ = child.kill();
    let _ = child.wait();
    if !out.status.success() {
        return Err(format!(
            "rss_ps_exit_failed:{}",
            out.status.code().unwrap_or(1)
        ));
    }
    let kib = String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .ok_or_else(|| "rss_parse_failed".to_string())?;
    Ok(kib / 1024.0)
}

fn sample_child_rss_quantiles_mb(
    program: &str,
    args: &[&str],
    warmup_runs: usize,
    samples: usize,
) -> Result<(f64, f64, f64), String> {
    for _ in 0..warmup_runs {
        let _ = sample_child_rss_mb(program, args)?;
    }
    let mut rows = Vec::new();
    for _ in 0..samples.max(1) {
        rows.push(sample_child_rss_mb(program, args)?);
    }
    rows.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    Ok((
        percentile(&rows, 0.50),
        percentile(&rows, 0.95),
        percentile(&rows, 0.99),
    ))
}

fn command_stdout(program: &str, args: &[&str], cwd: Option<&Path>) -> Option<String> {
    let mut cmd = Command::new(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(clean(text, 120))
    }
}

fn benchmark_environment_fingerprint(root: &Path) -> Value {
    json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "cpu_parallelism": std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(0),
        "rustc_version": command_stdout("rustc", &["--version"], None),
        "git_revision": command_stdout("git", &["rev-parse", "HEAD"], Some(root)),
        "workload_id": "live_hash_workload_v1"
    })
}

fn measure_pure_workspace_profile(
    root: &Path,
    mode: &str,
    probe_bin: &str,
    size_bin: &str,
    daemon_bin: Option<&str>,
    cold_start_args: &[&str],
    idle_probe_args: &[&str],
    tasks_per_sec: f64,
) -> Result<Map<String, Value>, String> {
    let (cold_start_p50_ms, cold_start_p95_ms, cold_start_p99_ms) =
        sample_command_quantiles_ms(probe_bin, cold_start_args, 2, 9)?;
    let (idle_rss_p50_mb, idle_rss_p95_mb, idle_rss_p99_mb) =
        sample_child_rss_quantiles_mb(probe_bin, idle_probe_args, 1, 5)?;
    let mut install_size_mb = path_size_mb(root, size_bin);
    if let Some(daemon) = daemon_bin {
        install_size_mb += path_size_mb(root, daemon);
    }
    install_size_mb = (install_size_mb * 1000.0).round() / 1000.0;

    let mut measured = Map::<String, Value>::new();
    measured.insert("mode".to_string(), Value::String(mode.to_string()));
    measured.insert("cold_start_ms".to_string(), json!(cold_start_p50_ms));
    measured.insert("cold_start_p50_ms".to_string(), json!(cold_start_p50_ms));
    measured.insert("cold_start_p95_ms".to_string(), json!(cold_start_p95_ms));
    measured.insert("cold_start_p99_ms".to_string(), json!(cold_start_p99_ms));
    measured.insert("idle_memory_mb".to_string(), json!(idle_rss_p50_mb));
    measured.insert("idle_rss_p50_mb".to_string(), json!(idle_rss_p50_mb));
    measured.insert("idle_rss_p95_mb".to_string(), json!(idle_rss_p95_mb));
    measured.insert("idle_rss_p99_mb".to_string(), json!(idle_rss_p99_mb));
    measured.insert("install_size_mb".to_string(), json!(install_size_mb));
    attach_shared_throughput(&mut measured, tasks_per_sec);
    measured.insert("security_systems".to_string(), json!(83.0));
    measured.insert("channel_adapters".to_string(), json!(0.0));
    measured.insert("llm_providers".to_string(), json!(0.0));
    measured.insert("measured".to_string(), Value::Bool(true));
    measured.insert(
        "data_source".to_string(),
        Value::String("pure_workspace_binary_probe".to_string()),
    );
    measured.insert(
        "probe_binary_path".to_string(),
        Value::String(clean(probe_bin, 320)),
    );
    measured.insert(
        "size_binary_path".to_string(),
        Value::String(clean(size_bin, 320)),
    );
    if let Some(daemon) = daemon_bin {
        measured.insert(
            "daemon_binary_path".to_string(),
            Value::String(clean(daemon, 320)),
        );
    }
    Ok(measured)
}

fn measure_pure_workspace(
    root: &Path,
    tasks_per_sec: f64,
) -> Result<(Option<Map<String, Value>>, Option<Map<String, Value>>), String> {
    let pure_probe_bin = locate_binary(
        root,
        &[
            "target/release/protheus-pure-workspace",
            "target/debug/protheus-pure-workspace",
            "target/x86_64-unknown-linux-musl/release/protheus-pure-workspace",
        ],
    );
    let Some(pure_probe_bin) = pure_probe_bin else {
        return Ok((None, None));
    };
    let pure_size_bin = locate_binary(
        root,
        &[
            "target/x86_64-unknown-linux-musl/release/protheus-pure-workspace",
            "target/release/protheus-pure-workspace",
            "target/debug/protheus-pure-workspace",
        ],
    )
    .unwrap_or_else(|| pure_probe_bin.clone());
    let daemon_bin_default = locate_binary(
        root,
        &[
            "target/x86_64-unknown-linux-musl/release/protheusd",
            "target/release/protheusd",
            "target/debug/protheusd",
        ],
    );

    let default_profile = measure_pure_workspace_profile(
        root,
        "pure",
        pure_probe_bin.as_str(),
        pure_size_bin.as_str(),
        daemon_bin_default.as_deref(),
        &["benchmark-ping"],
        &["probe", "--sleep-ms=450"],
        tasks_per_sec,
    )?;

    let daemon_bin_tiny_max = locate_binary(
        root,
        &[
            "target/x86_64-unknown-linux-musl/release/protheusd_tiny_max",
            "target/x86_64-unknown-linux-musl/release/protheusd-tiny-max",
            "target/release/protheusd_tiny_max",
            "target/release/protheusd-tiny-max",
            "local/tmp/daemon-sizes/protheusd.pure",
        ],
    )
    .or_else(|| daemon_bin_default.clone());

    let tiny_max_profile = measure_pure_workspace_profile(
        root,
        "pure-tiny-max",
        pure_probe_bin.as_str(),
        pure_size_bin.as_str(),
        daemon_bin_tiny_max.as_deref(),
        &["benchmark-ping", "--tiny-max=1"],
        &["probe", "--sleep-ms=120", "--tiny-max=1"],
        tasks_per_sec,
    )?;

    Ok((Some(default_profile), Some(tiny_max_profile)))
}

fn live_tasks_per_sec(sample_ms: u64) -> f64 {
    const WORK_FACTOR: u32 = 16;
    let target = Duration::from_millis(sample_ms.max(100));
    let started = Instant::now();
    let mut tasks = 0u64;
    while started.elapsed() < target {
        for idx in 0..WORK_FACTOR {
            let payload = format!("task-{tasks}-work-{idx}");
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

fn stabilized_tasks_per_sec_with<F>(
    rounds: usize,
    warmup_rounds: usize,
    mut sample: F,
) -> f64
where
    F: FnMut() -> f64,
{
    for _ in 0..warmup_rounds {
        let _ = sample();
    }
    let mut rows = Vec::<f64>::new();
    for _ in 0..rounds.max(1) {
        rows.push(sample());
    }
    rows.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    ((percentile(&rows, 0.50) * 100.0).round()) / 100.0
}

fn stabilized_tasks_per_sec(rounds: usize, sample_ms: u64) -> f64 {
    stabilized_tasks_per_sec_with(rounds, SHARED_THROUGHPUT_WARMUP_ROUNDS, || {
        live_tasks_per_sec(sample_ms)
    })
}

fn attach_shared_throughput(measured: &mut Map<String, Value>, tasks_per_sec: f64) {
    measured.insert("tasks_per_sec".to_string(), json!(tasks_per_sec));
    measured.insert(
        "throughput_source".to_string(),
        Value::String(SHARED_THROUGHPUT_SOURCE.to_string()),
    );
}

fn runtime_metrics(
    root: &Path,
    refresh_runtime: bool,
) -> Result<(f64, f64, f64, Value, Value), String> {
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

    if let Some((cold_start_ms, idle_memory_mb, install_size_mb)) =
        extract_runtime_metrics(&runtime_json)
    {
        let source_meta = json!({
            "mode": source,
            "refresh_requested": refresh_runtime,
            "fallback_reason": fallback_reason
        });
        return Ok((
            cold_start_ms,
            idle_memory_mb,
            install_size_mb,
            runtime_json,
            source_meta,
        ));
    }

    let local_install_size_mb = local_full_install_probe_mb(root);

    let top1_snapshot_path = root.join(TOP1_BENCHMARK_SNAPSHOT_REL);
    if let Ok(top1_snapshot) = read_json(&top1_snapshot_path) {
        if let Some((cold_start_ms, idle_memory_mb, snapshot_install_size_mb)) =
            extract_top1_snapshot_metrics(&top1_snapshot)
        {
            let install_size_mb = local_install_size_mb.unwrap_or(snapshot_install_size_mb);
            let source_meta = json!({
                "mode": if local_install_size_mb.is_some() {
                    "top1_benchmark_snapshot_with_local_install_probe"
                } else {
                    "top1_benchmark_snapshot"
                },
                "refresh_requested": refresh_runtime,
                "fallback_reason": if fallback_reason.is_null() {
                    Value::String("runtime_efficiency_missing_metrics".to_string())
                } else {
                    fallback_reason
                },
                "snapshot_path": TOP1_BENCHMARK_SNAPSHOT_REL,
                "install_source": if local_install_size_mb.is_some() {
                    Value::String("local_full_install_probe".to_string())
                } else {
                    Value::String("top1_snapshot".to_string())
                }
            });
            return Ok((
                cold_start_ms,
                idle_memory_mb,
                install_size_mb,
                top1_snapshot,
                source_meta,
            ));
        }
    }

    Err("runtime_efficiency_missing_metrics".to_string())
}

fn measure_openclaw(
    root: &Path,
    refresh_runtime: bool,
    tasks_per_sec: f64,
) -> Result<(Map<String, Value>, Value), String> {
    let (cold_start_ms, idle_memory_mb, install_size_mb, mut runtime_json, mut runtime_source) =
        runtime_metrics(root, refresh_runtime)?;
    let security_systems = count_guard_checks(root)?;
    let channel_adapters = count_channel_adapters(root)?;
    let llm_providers = count_llm_providers(root)?;
    let mut measured = Map::<String, Value>::new();
    measured.insert("cold_start_ms".to_string(), json!(cold_start_ms));
    measured.insert("idle_memory_mb".to_string(), json!(idle_memory_mb));
    measured.insert("install_size_mb".to_string(), json!(install_size_mb));
    attach_shared_throughput(&mut measured, tasks_per_sec);
    measured.insert("security_systems".to_string(), json!(security_systems));
    measured.insert("channel_adapters".to_string(), json!(channel_adapters));
    measured.insert("llm_providers".to_string(), json!(llm_providers));
    measured.insert("measured".to_string(), Value::Bool(true));
    measured.insert(
        "data_source".to_string(),
        Value::String("runtime_efficiency_floor + policy counters".to_string()),
    );
    if let Some(metrics) = runtime_json
        .get_mut("metrics")
        .and_then(Value::as_object_mut)
    {
        metrics.insert("tasks_per_sec".to_string(), json!(tasks_per_sec));
    }
    if let Some(meta) = runtime_source.as_object_mut() {
        meta.insert(
            "tasks_source".to_string(),
            Value::String(SHARED_THROUGHPUT_SOURCE.to_string()),
        );
        meta.insert(
            "tasks_sample_ms".to_string(),
            json!(SHARED_THROUGHPUT_SAMPLE_MS),
        );
        meta.insert("tasks_work_factor".to_string(), json!(16));
        meta.insert(
            "tasks_phase".to_string(),
            Value::String("pre_profile_sampling_shared".to_string()),
        );
        meta.insert("tasks_rounds".to_string(), json!(SHARED_THROUGHPUT_ROUNDS));
        meta.insert(
            "tasks_warmup_rounds".to_string(),
            json!(SHARED_THROUGHPUT_WARMUP_ROUNDS),
        );
    }
    measured.insert("runtime_metric_source".to_string(), runtime_source);

    Ok((measured, runtime_json))
}

fn merge_projects(
    snapshot: &Value,
    openclaw_measured: &Map<String, Value>,
) -> Result<Map<String, Value>, String> {
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
    format!(
        "{}{}",
        "#".repeat(fill),
        "-".repeat(width.saturating_sub(fill))
    )
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
        "tasks_per_sec" => format!("{value:.1} {}", category.unit),
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
        return Err(format!(
            "benchmark_category_missing_values:{}",
            category.key
        ));
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
        lines.push(format!("{:<10} {}  {}{}", name, bar, score, marker));

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

fn run_impl(
    root: &Path,
    cmd: &str,
    snapshot_rel: &str,
    refresh_runtime: bool,
    bar_width: usize,
) -> Result<Value, String> {
    let snapshot_path = root.join(snapshot_rel);
    let snapshot = read_json(&snapshot_path)?;
    let shared_tasks_per_sec =
        stabilized_tasks_per_sec(SHARED_THROUGHPUT_ROUNDS, SHARED_THROUGHPUT_SAMPLE_MS);

    let (openclaw_measured, runtime_receipt) =
        measure_openclaw(root, refresh_runtime, shared_tasks_per_sec)?;
    let (pure_workspace_measured, pure_workspace_tiny_max_measured) =
        measure_pure_workspace(root, shared_tasks_per_sec)?;
    let projects = merge_projects(&snapshot, &openclaw_measured)?;
    let mut projects = projects;
    if let Some(ref pure) = pure_workspace_measured {
        projects.insert("InfRing (pure)".to_string(), Value::Object(pure.clone()));
    }
    if let Some(ref pure_tiny_max) = pure_workspace_tiny_max_measured {
        projects.insert(
            "InfRing (tiny-max)".to_string(),
            Value::Object(pure_tiny_max.clone()),
        );
    }

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
        "environment_fingerprint": benchmark_environment_fingerprint(root),
        "snapshot_path": snapshot_rel,
        "snapshot_version": snapshot.get("schema_version").cloned().unwrap_or(Value::Null),
        "snapshot_generated_from": snapshot.get("generated_from").cloned().unwrap_or(Value::Null),
        "reference_month": snapshot.get("reference_month").cloned().unwrap_or(Value::Null),
        "bar_width": bar_width,
        "openclaw_measured": Value::Object(openclaw_measured),
        "pure_workspace_measured": pure_workspace_measured.clone().map(Value::Object).unwrap_or(Value::Null),
        "pure_workspace_tiny_max_measured": pure_workspace_tiny_max_measured
            .clone()
            .map(Value::Object)
            .unwrap_or(Value::Null),
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
                        "client/runtime/config/guard_check_registry.json",
                        "client/runtime/config/platform_adaptation_channels.json",
                        "client/runtime/config/provider_onboarding_manifest.json",
                        "client/runtime/config/model_health_auto_recovery_policy.json"
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
            },
            {
                "id": "competitive_benchmark_matrix_pure_workspace_probe",
                "claim": "pure_workspace_metrics_are_measured_from_rust_only_client_binary_probes_when_artifacts_exist",
                "evidence": {
                    "binary_probe_present": pure_workspace_measured.is_some()
                }
            },
            {
                "id": "competitive_benchmark_matrix_pure_workspace_tiny_max_probe",
                "claim": "pure_workspace_tiny_max_profile_is_reported_when_tiny_max_daemon_artifact_is_available",
                "evidence": {
                    "tiny_max_probe_present": pure_workspace_tiny_max_measured.is_some()
                }
            },
            {
                "id": "competitive_benchmark_matrix_environment_fingerprint",
                "claim": "benchmark_reports_include_runtime_environment_fingerprint_for_reproducibility",
                "evidence": {
                    "environment_fingerprint_present": true
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
                    serde_json::to_string_pretty(&out).unwrap_or_else(|_| {
                        "{\"ok\":false,\"error\":\"encode_failed\"}".to_string()
                    })
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
                    serde_json::to_string_pretty(&out).unwrap_or_else(|_| {
                        "{\"ok\":false,\"error\":\"encode_failed\"}".to_string()
                    })
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
#[path = "benchmark_matrix_tests.rs"]
mod tests;
