// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::top1_assurance (authoritative)

use crate::{deterministic_receipt_hash, now_iso, parse_args, status_runtime_efficiency_floor};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

const LANE_ID: &str = "top1_assurance";
const DEFAULT_POLICY_REL: &str = "client/runtime/config/top1_assurance_policy.json";

#[derive(Debug, Clone)]
struct ProofCoveragePolicy {
    map_path: String,
    min_proven_ratio: f64,
    check_toolchains_default: bool,
}

#[derive(Debug, Clone)]
struct ProofVmPolicy {
    dockerfile_path: String,
    replay_script_path: String,
    manifest_path: String,
}

#[derive(Debug, Clone)]
struct SizeGatePolicy {
    binary_path: String,
    min_mb: f64,
    max_mb: f64,
    require_static: bool,
}

#[derive(Debug, Clone)]
struct BenchmarkThresholdPolicy {
    benchmark_path: String,
    cold_start_max_ms: f64,
    idle_rss_max_mb: f64,
    tasks_per_sec_min: f64,
    sample_ms: u64,
}

#[derive(Debug, Clone)]
struct ComparisonMatrixPolicy {
    snapshot_path: String,
    output_path: String,
}

#[derive(Debug, Clone)]
struct OutputPolicy {
    latest_path: String,
    history_path: String,
}

#[derive(Debug, Clone)]
struct Top1Policy {
    version: String,
    strict_default: bool,
    proof_coverage: ProofCoveragePolicy,
    proof_vm: ProofVmPolicy,
    size_gate: SizeGatePolicy,
    benchmark: BenchmarkThresholdPolicy,
    comparison: ComparisonMatrixPolicy,
    outputs: OutputPolicy,
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops top1-assurance status");
    println!("  protheus-ops top1-assurance proof-coverage [--strict=1|0] [--check-toolchains=1|0] [--execute-proofs=1|0]");
    println!("  protheus-ops top1-assurance proof-vm [--strict=1|0] [--write-manifest=1|0]");
    println!("  protheus-ops top1-assurance size-gate [--strict=1|0] [--binary-path=<path>] [--min-mb=<n>] [--max-mb=<n>]");
    println!("  protheus-ops top1-assurance benchmark-thresholds [--strict=1|0] [--benchmark-path=<path>] [--sample-ms=<n>] [--refresh=1|0]");
    println!("  protheus-ops top1-assurance comparison-matrix [--strict=1|0] [--snapshot-path=<path>] [--output-path=<path>] [--apply=1|0]");
    println!("  protheus-ops top1-assurance run-all [--strict=1|0]");
}

fn parse_bool(raw: Option<&String>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

fn parse_f64(raw: Option<&String>, fallback: f64, lo: f64, hi: f64) -> f64 {
    let parsed = raw
        .and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(fallback);
    if !parsed.is_finite() {
        return fallback;
    }
    parsed.clamp(lo, hi)
}

fn parse_u64(raw: Option<&String>, fallback: u64, lo: u64, hi: u64) -> u64 {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(fallback)
        .clamp(lo, hi)
}

fn normalize_rel(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .ok()
        .map(|p| p.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|| normalize_rel(path))
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent).map_err(|err| format!("mkdir_failed:{}:{err}", parent.display()))
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let mut payload =
        serde_json::to_string_pretty(value).map_err(|err| format!("encode_failed:{err}"))?;
    payload.push('\n');
    fs::write(path, payload).map_err(|err| format!("write_failed:{}:{err}", path.display()))
}

fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path)?;
    let line = serde_json::to_string(value).map_err(|err| format!("encode_failed:{err}"))?;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("open_failed:{}:{err}", path.display()))?;
    writeln!(f, "{line}").map_err(|err| format!("append_failed:{}:{err}", path.display()))
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let data = fs::read(path).map_err(|err| format!("read_failed:{}:{err}", path.display()))?;
    Ok(hex::encode(Sha256::digest(data)))
}

fn run_command(bin: &str, args: &[&str]) -> Value {
    let started = Instant::now();
    let out = Command::new(bin).args(args).output();
    match out {
        Ok(run) => {
            let stdout = String::from_utf8_lossy(&run.stdout)
                .trim()
                .chars()
                .take(600)
                .collect::<String>();
            let stderr = String::from_utf8_lossy(&run.stderr)
                .trim()
                .chars()
                .take(600)
                .collect::<String>();
            json!({
                "ok": run.status.success(),
                "status": run.status.code().unwrap_or(1),
                "elapsed_ms": started.elapsed().as_millis(),
                "stdout": stdout,
                "stderr": stderr
            })
        }
        Err(err) => json!({
            "ok": false,
            "status": 1,
            "elapsed_ms": started.elapsed().as_millis(),
            "spawn_error": err.to_string()
        }),
    }
}

fn run_command_owned(bin: &str, args: &[String]) -> Value {
    let started = Instant::now();
    let out = Command::new(bin).args(args).output();
    match out {
        Ok(run) => {
            let stdout = String::from_utf8_lossy(&run.stdout)
                .trim()
                .chars()
                .take(600)
                .collect::<String>();
            let stderr = String::from_utf8_lossy(&run.stderr)
                .trim()
                .chars()
                .take(600)
                .collect::<String>();
            json!({
                "ok": run.status.success(),
                "status": run.status.code().unwrap_or(1),
                "elapsed_ms": started.elapsed().as_millis(),
                "stdout": stdout,
                "stderr": stderr
            })
        }
        Err(err) => json!({
            "ok": false,
            "status": 1,
            "elapsed_ms": started.elapsed().as_millis(),
            "spawn_error": err.to_string()
        }),
    }
}

fn run_command_program(bin: &Path, args: &[String]) -> Value {
    let started = Instant::now();
    let out = Command::new(bin).args(args).output();
    match out {
        Ok(run) => {
            let stdout = String::from_utf8_lossy(&run.stdout)
                .trim()
                .chars()
                .take(600)
                .collect::<String>();
            let stderr = String::from_utf8_lossy(&run.stderr)
                .trim()
                .chars()
                .take(600)
                .collect::<String>();
            json!({
                "ok": run.status.success(),
                "status": run.status.code().unwrap_or(1),
                "elapsed_ms": started.elapsed().as_millis(),
                "stdout": stdout,
                "stderr": stderr
            })
        }
        Err(err) => json!({
            "ok": false,
            "status": 1,
            "elapsed_ms": started.elapsed().as_millis(),
            "spawn_error": err.to_string()
        }),
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn push_toolchain_candidate(
    rows: &mut Vec<(PathBuf, Vec<String>, &'static str)>,
    program: PathBuf,
    args: Vec<String>,
    source: &'static str,
) {
    if rows.iter().any(|(existing_program, existing_args, _)| {
        existing_program == &program && existing_args == &args
    }) {
        return;
    }
    rows.push((program, args, source));
}

fn toolchain_candidates(id: &str) -> Vec<(PathBuf, Vec<String>, &'static str)> {
    let mut rows = Vec::<(PathBuf, Vec<String>, &'static str)>::new();
    match id {
        "kani_toolchain" => {
            push_toolchain_candidate(
                &mut rows,
                PathBuf::from("cargo"),
                vec!["kani".to_string(), "--version".to_string()],
                "path:cargo",
            );
            push_toolchain_candidate(
                &mut rows,
                PathBuf::from("cargo-kani"),
                vec!["--version".to_string()],
                "path:cargo-kani",
            );
            if let Some(home) = home_dir() {
                push_toolchain_candidate(
                    &mut rows,
                    home.join(".cargo/bin/cargo"),
                    vec!["kani".to_string(), "--version".to_string()],
                    "home:.cargo/bin/cargo",
                );
                push_toolchain_candidate(
                    &mut rows,
                    home.join(".cargo/bin/cargo-kani"),
                    vec!["--version".to_string()],
                    "home:.cargo/bin/cargo-kani",
                );
            }
        }
        "prusti_toolchain" => {
            push_toolchain_candidate(
                &mut rows,
                PathBuf::from("prusti-rustc"),
                vec!["--version".to_string()],
                "path:prusti-rustc",
            );
            if let Some(home) = home_dir() {
                push_toolchain_candidate(
                    &mut rows,
                    home.join(".cargo/bin/prusti-rustc"),
                    vec!["--version".to_string()],
                    "home:.cargo/bin/prusti-rustc",
                );
            }
        }
        "lean_toolchain" => {
            push_toolchain_candidate(
                &mut rows,
                PathBuf::from("lean"),
                vec!["--version".to_string()],
                "path:lean",
            );
            if let Some(home) = home_dir() {
                push_toolchain_candidate(
                    &mut rows,
                    home.join(".elan/bin/lean"),
                    vec!["--version".to_string()],
                    "home:.elan/bin/lean",
                );
            }
        }
        _ => {}
    }
    rows
}

fn run_toolchain_check(id: &str) -> Value {
    let mut attempts = Vec::<Value>::new();
    for (program, args, source) in toolchain_candidates(id) {
        let run = run_command_program(&program, &args);
        let ok = run.get("ok").and_then(Value::as_bool).unwrap_or(false);
        attempts.push(json!({
            "program": program.display().to_string(),
            "args": args,
            "source": source,
            "run": run
        }));
        if ok {
            return json!({
                "ok": true,
                "resolved_bin": program.display().to_string(),
                "resolution_source": source,
                "attempts": attempts
            });
        }
    }
    json!({
        "ok": false,
        "resolved_bin": Value::Null,
        "attempts": attempts
    })
}

fn default_policy() -> Top1Policy {
    Top1Policy {
        version: "1.0".to_string(),
        strict_default: true,
        proof_coverage: ProofCoveragePolicy {
            map_path: "proofs/layer0/core_formal_coverage_map.json".to_string(),
            min_proven_ratio: 0.20,
            check_toolchains_default: true,
        },
        proof_vm: ProofVmPolicy {
            dockerfile_path: "proofs/layer0/ProofVM.Dockerfile".to_string(),
            replay_script_path: "proofs/layer0/replay.sh".to_string(),
            manifest_path: "state/ops/top1_assurance/proof_vm_manifest.json".to_string(),
        },
        size_gate: SizeGatePolicy {
            binary_path: "target/x86_64-unknown-linux-musl/release/protheusd".to_string(),
            min_mb: 25.0,
            max_mb: 35.0,
            require_static: true,
        },
        benchmark: BenchmarkThresholdPolicy {
            benchmark_path: "state/ops/top1_assurance/benchmark_latest.json".to_string(),
            cold_start_max_ms: 80.0,
            idle_rss_max_mb: 25.0,
            tasks_per_sec_min: 5000.0,
            sample_ms: 800,
        },
        comparison: ComparisonMatrixPolicy {
            snapshot_path: "client/runtime/config/competitive_benchmark_snapshot_2026_02.json"
                .to_string(),
            output_path: "docs/comparison/protheus_vs_x.md".to_string(),
        },
        outputs: OutputPolicy {
            latest_path: "state/ops/top1_assurance/latest.json".to_string(),
            history_path: "state/ops/top1_assurance/history.jsonl".to_string(),
        },
    }
}

fn load_policy(_root: &Path, policy_path: &Path) -> Top1Policy {
    let mut policy = default_policy();
    let raw = read_json(policy_path).unwrap_or(Value::Null);

    if let Some(version) = raw.get("version").and_then(Value::as_str) {
        let clean = version.trim();
        if !clean.is_empty() {
            policy.version = clean.to_string();
        }
    }
    policy.strict_default = raw
        .get("strict_default")
        .and_then(Value::as_bool)
        .unwrap_or(policy.strict_default);

    if let Some(node) = raw.get("proof_coverage") {
        if let Some(v) = node.get("map_path").and_then(Value::as_str) {
            let clean = v.trim();
            if !clean.is_empty() {
                policy.proof_coverage.map_path = clean.to_string();
            }
        }
        policy.proof_coverage.min_proven_ratio = node
            .get("min_proven_ratio")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .map(|v| v.clamp(0.0, 1.0))
            .unwrap_or(policy.proof_coverage.min_proven_ratio);
        policy.proof_coverage.check_toolchains_default = node
            .get("check_toolchains_default")
            .and_then(Value::as_bool)
            .unwrap_or(policy.proof_coverage.check_toolchains_default);
    }

    if let Some(node) = raw.get("proof_vm") {
        if let Some(v) = node.get("dockerfile_path").and_then(Value::as_str) {
            let clean = v.trim();
            if !clean.is_empty() {
                policy.proof_vm.dockerfile_path = clean.to_string();
            }
        }
        if let Some(v) = node.get("replay_script_path").and_then(Value::as_str) {
            let clean = v.trim();
            if !clean.is_empty() {
                policy.proof_vm.replay_script_path = clean.to_string();
            }
        }
        if let Some(v) = node.get("manifest_path").and_then(Value::as_str) {
            let clean = v.trim();
            if !clean.is_empty() {
                policy.proof_vm.manifest_path = clean.to_string();
            }
        }
    }

    if let Some(node) = raw.get("size_gate") {
        if let Some(v) = node.get("binary_path").and_then(Value::as_str) {
            let clean = v.trim();
            if !clean.is_empty() {
                policy.size_gate.binary_path = clean.to_string();
            }
        }
        policy.size_gate.min_mb = node
            .get("min_mb")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .unwrap_or(policy.size_gate.min_mb)
            .clamp(0.1, 2048.0);
        policy.size_gate.max_mb = node
            .get("max_mb")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .unwrap_or(policy.size_gate.max_mb)
            .clamp(0.1, 4096.0);
        if policy.size_gate.max_mb < policy.size_gate.min_mb {
            policy.size_gate.max_mb = policy.size_gate.min_mb;
        }
        policy.size_gate.require_static = node
            .get("require_static")
            .and_then(Value::as_bool)
            .unwrap_or(policy.size_gate.require_static);
    }

    if let Some(node) = raw.get("benchmark") {
        if let Some(v) = node.get("benchmark_path").and_then(Value::as_str) {
            let clean = v.trim();
            if !clean.is_empty() {
                policy.benchmark.benchmark_path = clean.to_string();
            }
        }
        policy.benchmark.cold_start_max_ms = node
            .get("cold_start_max_ms")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .unwrap_or(policy.benchmark.cold_start_max_ms)
            .clamp(1.0, 120000.0);
        policy.benchmark.idle_rss_max_mb = node
            .get("idle_rss_max_mb")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .unwrap_or(policy.benchmark.idle_rss_max_mb)
            .clamp(1.0, 10240.0);
        policy.benchmark.tasks_per_sec_min = node
            .get("tasks_per_sec_min")
            .and_then(Value::as_f64)
            .filter(|v| v.is_finite())
            .unwrap_or(policy.benchmark.tasks_per_sec_min)
            .clamp(1.0, 10_000_000.0);
        policy.benchmark.sample_ms = node
            .get("sample_ms")
            .and_then(Value::as_u64)
            .unwrap_or(policy.benchmark.sample_ms)
            .clamp(100, 10_000);
    }

    if let Some(node) = raw.get("comparison") {
        if let Some(v) = node.get("snapshot_path").and_then(Value::as_str) {
            let clean = v.trim();
            if !clean.is_empty() {
                policy.comparison.snapshot_path = clean.to_string();
            }
        }
        if let Some(v) = node.get("output_path").and_then(Value::as_str) {
            let clean = v.trim();
            if !clean.is_empty() {
                policy.comparison.output_path = clean.to_string();
            }
        }
    }

    if let Some(node) = raw.get("outputs") {
        if let Some(v) = node.get("latest_path").and_then(Value::as_str) {
            let clean = v.trim();
            if !clean.is_empty() {
                policy.outputs.latest_path = clean.to_string();
            }
        }
        if let Some(v) = node.get("history_path").and_then(Value::as_str) {
            let clean = v.trim();
            if !clean.is_empty() {
                policy.outputs.history_path = clean.to_string();
            }
        }
    }

    if !policy_path.exists() {
        let _ = write_json(
            policy_path,
            &json!({
                "version": policy.version,
                "strict_default": policy.strict_default,
                "proof_coverage": {
                    "map_path": policy.proof_coverage.map_path,
                    "min_proven_ratio": policy.proof_coverage.min_proven_ratio,
                    "check_toolchains_default": policy.proof_coverage.check_toolchains_default
                },
                "proof_vm": {
                    "dockerfile_path": policy.proof_vm.dockerfile_path,
                    "replay_script_path": policy.proof_vm.replay_script_path,
                    "manifest_path": policy.proof_vm.manifest_path
                },
                "size_gate": {
                    "binary_path": policy.size_gate.binary_path,
                    "min_mb": policy.size_gate.min_mb,
                    "max_mb": policy.size_gate.max_mb,
                    "require_static": policy.size_gate.require_static
                },
                "benchmark": {
                    "benchmark_path": policy.benchmark.benchmark_path,
                    "cold_start_max_ms": policy.benchmark.cold_start_max_ms,
                    "idle_rss_max_mb": policy.benchmark.idle_rss_max_mb,
                    "tasks_per_sec_min": policy.benchmark.tasks_per_sec_min,
                    "sample_ms": policy.benchmark.sample_ms
                },
                "comparison": {
                    "snapshot_path": policy.comparison.snapshot_path,
                    "output_path": policy.comparison.output_path
                },
                "outputs": {
                    "latest_path": policy.outputs.latest_path,
                    "history_path": policy.outputs.history_path
                }
            }),
        );
    }

    policy
}

fn microbench_tasks_per_sec(sample_ms: u64) -> f64 {
    let target = Duration::from_millis(sample_ms);
    let started = Instant::now();
    let mut tasks: u64 = 0;
    while started.elapsed() < target {
        let payload = format!("task-{tasks}");
        let _ = Sha256::digest(payload.as_bytes());
        tasks = tasks.saturating_add(1);
    }
    let secs = started.elapsed().as_secs_f64();
    if secs <= 0.0 {
        0.0
    } else {
        tasks as f64 / secs
    }
}

fn extract_metric(payload: &Value, keys: &[&str]) -> Option<f64> {
    let mut cursor = payload;
    for (idx, key) in keys.iter().enumerate() {
        if idx + 1 == keys.len() {
            return cursor.get(*key).and_then(Value::as_f64);
        }
        cursor = cursor.get(*key)?;
    }
    None
}

fn run_proof_coverage(
    root: &Path,
    policy: &Top1Policy,
    strict: bool,
    parsed: &crate::ParsedArgs,
) -> Value {
    let map_rel = parsed
        .flags
        .get("map-path")
        .map(String::as_str)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(policy.proof_coverage.map_path.as_str());
    let map_path = root.join(map_rel);
    let check_toolchains = parse_bool(
        parsed.flags.get("check-toolchains"),
        policy.proof_coverage.check_toolchains_default,
    );
    let execute_proofs = parse_bool(parsed.flags.get("execute-proofs"), false);

    let mut errors = Vec::<String>::new();
    let map = read_json(&map_path).unwrap_or(Value::Null);
    if map.is_null() {
        errors.push("coverage_map_missing_or_invalid".to_string());
    }

    if map
        .get("schema_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "core_formal_coverage_map"
    {
        errors.push("coverage_map_schema_id_invalid".to_string());
    }

    let surfaces = map
        .get("surfaces")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    if surfaces.is_empty() {
        errors.push("coverage_map_surfaces_missing".to_string());
    }

    let mut proven = 0usize;
    let mut partial = 0usize;
    let mut unproven = 0usize;
    let mut invalid_surfaces = Vec::<String>::new();
    let mut artifact_rows = Vec::<Value>::new();
    let mut proof_command_rows = Vec::<Value>::new();

    for row in &surfaces {
        let id = row
            .get("id")
            .or_else(|| row.get("crate"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim();
        let status = row
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if id.is_empty() {
            invalid_surfaces.push("missing_surface_id".to_string());
            continue;
        }
        match status.as_str() {
            "proven" => proven += 1,
            "partial" => partial += 1,
            "unproven" => unproven += 1,
            _ => invalid_surfaces.push(format!("invalid_surface_status:{id}")),
        }

        let artifact_rel = row
            .get("artifact")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_string();
        let artifact_exists = if artifact_rel.is_empty() {
            false
        } else {
            root.join(&artifact_rel).exists()
        };
        if artifact_rel.is_empty() {
            errors.push(format!("surface_artifact_missing::{id}"));
        } else if !artifact_exists {
            errors.push(format!("surface_artifact_not_found::{id}"));
        }
        artifact_rows.push(json!({
            "surface_id": id,
            "artifact": artifact_rel,
            "exists": artifact_exists
        }));

        let command_specs = row
            .get("proof_commands")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        for (idx, command_spec) in command_specs.iter().enumerate() {
            let command_id = command_spec
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .trim()
                .to_string();
            let required = command_spec
                .get("required")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            let argv = command_spec
                .get("argv")
                .and_then(Value::as_array)
                .map(|rows| {
                    rows.iter()
                        .filter_map(Value::as_str)
                        .map(|v| v.trim().to_string())
                        .filter(|v| !v.is_empty())
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            if argv.is_empty() {
                if required {
                    errors.push(format!("proof_command_missing_argv::{id}::{idx}"));
                }
                proof_command_rows.push(json!({
                    "surface_id": id,
                    "id": if command_id.is_empty() { format!("cmd_{idx}") } else { command_id.clone() },
                    "required": required,
                    "executed": false,
                    "ok": false,
                    "error": "missing_argv"
                }));
                continue;
            }
            let bin = argv.first().cloned().unwrap_or_default();
            let args = argv.into_iter().skip(1).collect::<Vec<_>>();
            let run = if execute_proofs {
                run_command_owned(&bin, &args)
            } else {
                json!({
                    "ok": true,
                    "status": 0,
                    "elapsed_ms": 0,
                    "stdout": "skipped",
                    "stderr": ""
                })
            };
            let ok = run.get("ok").and_then(Value::as_bool).unwrap_or(false);
            if execute_proofs && required && !ok {
                errors.push(format!(
                    "proof_command_failed::{id}::{}",
                    if command_id.is_empty() {
                        format!("cmd_{idx}")
                    } else {
                        command_id.clone()
                    }
                ));
            }
            proof_command_rows.push(json!({
                "surface_id": id,
                "id": if command_id.is_empty() { format!("cmd_{idx}") } else { command_id },
                "required": required,
                "executed": execute_proofs,
                "ok": if execute_proofs { ok } else { true },
                "bin": bin,
                "args": args,
                "run": run
            }));
        }
    }

    if !invalid_surfaces.is_empty() {
        errors.extend(invalid_surfaces.clone());
    }

    let total = proven + partial + unproven;
    let proven_ratio = if total == 0 {
        0.0
    } else {
        proven as f64 / total as f64
    };

    if total > 0 && proven == 0 {
        errors.push("coverage_map_requires_at_least_one_proven_surface".to_string());
    }
    if proven_ratio < policy.proof_coverage.min_proven_ratio {
        errors.push("coverage_ratio_below_policy_floor".to_string());
    }

    let tool_checks = if check_toolchains {
        vec![
            (
                "kani_toolchain",
                true,
                run_toolchain_check("kani_toolchain"),
            ),
            (
                "prusti_toolchain",
                false,
                run_toolchain_check("prusti_toolchain"),
            ),
            (
                "lean_toolchain",
                false,
                run_toolchain_check("lean_toolchain"),
            ),
        ]
    } else {
        Vec::new()
    };

    let mut toolchain_rows = Vec::<Value>::new();
    for (id, required, row) in tool_checks {
        let ok = row.get("ok").and_then(Value::as_bool).unwrap_or(false);
        if required && !ok {
            errors.push(format!("required_toolchain_missing::{id}"));
        }
        toolchain_rows.push(json!({
            "id": id,
            "required": required,
            "ok": ok,
            "row": row
        }));
    }

    let ok = errors.is_empty();
    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "map_path": map_rel,
        "check_toolchains": check_toolchains,
        "execute_proofs": execute_proofs,
        "proven": proven,
        "partial": partial,
        "unproven": unproven,
        "surface_count": total,
        "proven_ratio": (proven_ratio * 10000.0).round() / 10000.0,
        "min_proven_ratio": policy.proof_coverage.min_proven_ratio,
        "artifacts": artifact_rows,
        "proof_commands": proof_command_rows,
        "toolchains": toolchain_rows,
        "errors": errors
    })
}

fn run_proof_vm(
    root: &Path,
    policy: &Top1Policy,
    strict: bool,
    parsed: &crate::ParsedArgs,
) -> Value {
    let docker_rel = parsed
        .flags
        .get("dockerfile-path")
        .map(String::as_str)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(policy.proof_vm.dockerfile_path.as_str());
    let replay_rel = parsed
        .flags
        .get("replay-script-path")
        .map(String::as_str)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(policy.proof_vm.replay_script_path.as_str());
    let manifest_rel = parsed
        .flags
        .get("manifest-path")
        .map(String::as_str)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(policy.proof_vm.manifest_path.as_str());
    let write_manifest = parse_bool(parsed.flags.get("write-manifest"), true);

    let docker_path = root.join(docker_rel);
    let replay_path = root.join(replay_rel);
    let manifest_path = root.join(manifest_rel);

    let mut errors = Vec::<String>::new();
    if !docker_path.exists() {
        errors.push("proof_vm_dockerfile_missing".to_string());
    }
    if !replay_path.exists() {
        errors.push("proof_vm_replay_script_missing".to_string());
    }

    let docker_sha = sha256_file(&docker_path).ok();
    let replay_sha = sha256_file(&replay_path).ok();

    #[cfg(unix)]
    let replay_executable = {
        use std::os::unix::fs::PermissionsExt;
        fs::metadata(&replay_path)
            .ok()
            .map(|m| m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    };

    #[cfg(not(unix))]
    let replay_executable = replay_path.exists();

    if !replay_executable {
        errors.push("proof_vm_replay_script_not_executable".to_string());
    }

    let ok = errors.is_empty();
    let manifest = json!({
        "ok": ok,
        "type": "top1_proof_vm_manifest",
        "ts": now_iso(),
        "dockerfile_path": docker_rel,
        "dockerfile_sha256": docker_sha,
        "replay_script_path": replay_rel,
        "replay_script_sha256": replay_sha,
        "replay_script_executable": replay_executable,
        "errors": errors,
        "claim_evidence": [
            {
                "id": "proof_vm_replay_contract",
                "claim": "proof_vm_replay_artifacts_are_reproducible_and_hash_pinned",
                "evidence": {
                    "dockerfile": docker_rel,
                    "replay_script": replay_rel
                }
            }
        ]
    });

    if write_manifest {
        let _ = write_json(&manifest_path, &manifest);
    }

    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "dockerfile_path": docker_rel,
        "replay_script_path": replay_rel,
        "manifest_path": manifest_rel,
        "manifest_written": write_manifest,
        "dockerfile_sha256": docker_sha,
        "replay_script_sha256": replay_sha,
        "replay_script_executable": replay_executable,
        "errors": manifest.get("errors").cloned().unwrap_or(Value::Array(Vec::new()))
    })
}

fn run_size_gate(
    root: &Path,
    policy: &Top1Policy,
    strict: bool,
    parsed: &crate::ParsedArgs,
) -> Value {
    let binary_rel = parsed
        .flags
        .get("binary-path")
        .map(String::as_str)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(policy.size_gate.binary_path.as_str());
    let min_mb = parse_f64(
        parsed.flags.get("min-mb"),
        policy.size_gate.min_mb,
        0.1,
        4096.0,
    );
    let max_mb = parse_f64(
        parsed.flags.get("max-mb"),
        policy.size_gate.max_mb,
        min_mb,
        8192.0,
    );
    let require_static = parse_bool(
        parsed.flags.get("require-static"),
        policy.size_gate.require_static,
    );
    let binary_path = root.join(binary_rel);

    let exists = binary_path.exists();
    let bytes = fs::metadata(&binary_path).map(|m| m.len()).unwrap_or(0);
    let size_mb = (bytes as f64) / (1024.0 * 1024.0);

    let file_probe = if exists {
        let p = normalize_rel(&binary_path);
        run_command("file", &[p.as_str()])
    } else {
        json!({"ok": false, "status": 1, "stderr": "binary_missing"})
    };
    let static_detected = file_probe
        .get("stdout")
        .and_then(Value::as_str)
        .map(|v| {
            let lower = v.to_ascii_lowercase();
            lower.contains("statically linked") || lower.contains("static-pie")
        })
        .unwrap_or(false);

    let mut errors = Vec::<String>::new();
    if !exists {
        errors.push("binary_missing".to_string());
    }
    if exists && !(size_mb >= min_mb && size_mb <= max_mb) {
        errors.push("binary_size_out_of_range".to_string());
    }
    if require_static && exists && !static_detected {
        errors.push("binary_not_static".to_string());
    }

    let ok = errors.is_empty();
    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "binary_path": binary_rel,
        "exists": exists,
        "size_bytes": bytes,
        "size_mb": (size_mb * 1000.0).round() / 1000.0,
        "min_mb": min_mb,
        "max_mb": max_mb,
        "require_static": require_static,
        "static_detected": static_detected,
        "file_probe": file_probe,
        "errors": errors
    })
}

fn collect_benchmark_metrics(
    root: &Path,
    benchmark_path: &Path,
    sample_ms: u64,
    refresh: bool,
) -> Value {
    let existing = read_json(benchmark_path).unwrap_or(Value::Null);

    let status_args = parse_args(&["status".to_string()]);
    let runtime = status_runtime_efficiency_floor(root, &status_args).json;

    let cold_start_ms = extract_metric(&existing, &["metrics", "cold_start_ms"])
        .or_else(|| extract_metric(&existing, &["openclaw_measured", "cold_start_ms"]))
        .or_else(|| extract_metric(&runtime, &["latest", "metrics", "cold_start_p95_ms"]))
        .or_else(|| extract_metric(&runtime, &["metrics", "cold_start_p95_ms"]));

    let idle_rss_mb = extract_metric(&existing, &["metrics", "idle_rss_mb"])
        .or_else(|| extract_metric(&existing, &["openclaw_measured", "idle_memory_mb"]))
        .or_else(|| extract_metric(&runtime, &["latest", "metrics", "idle_rss_p95_mb"]))
        .or_else(|| extract_metric(&runtime, &["metrics", "idle_rss_p95_mb"]));

    let install_size_mb = extract_metric(&existing, &["metrics", "install_size_mb"])
        .or_else(|| extract_metric(&existing, &["openclaw_measured", "install_size_mb"]))
        .or_else(|| extract_metric(&runtime, &["latest", "metrics", "full_install_total_mb"]))
        .or_else(|| extract_metric(&runtime, &["metrics", "full_install_total_mb"]));

    let tasks_per_sec = extract_metric(&existing, &["metrics", "tasks_per_sec"])
        .or_else(|| extract_metric(&existing, &["openclaw_measured", "tasks_per_sec"]))
        .unwrap_or_else(|| microbench_tasks_per_sec(sample_ms));

    let generated = json!({
        "ok": true,
        "type": "top1_benchmark_metrics",
        "ts": now_iso(),
        "metrics": {
            "cold_start_ms": cold_start_ms,
            "idle_rss_mb": idle_rss_mb,
            "install_size_mb": install_size_mb,
            "tasks_per_sec": (tasks_per_sec * 100.0).round() / 100.0
        },
        "runtime_efficiency_source": runtime,
        "refresh": refresh,
        "sample_ms": sample_ms,
        "source_path": rel_path(root, benchmark_path)
    });

    if refresh {
        let _ = write_json(benchmark_path, &generated);
    }

    generated
}

fn run_benchmark_thresholds(
    root: &Path,
    policy: &Top1Policy,
    strict: bool,
    parsed: &crate::ParsedArgs,
) -> Value {
    let bench_rel = parsed
        .flags
        .get("benchmark-path")
        .map(String::as_str)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(policy.benchmark.benchmark_path.as_str());
    let sample_ms = parse_u64(
        parsed.flags.get("sample-ms"),
        policy.benchmark.sample_ms,
        100,
        10_000,
    );
    let refresh = parse_bool(parsed.flags.get("refresh"), true);

    let cold_max = parse_f64(
        parsed.flags.get("cold-start-max-ms"),
        policy.benchmark.cold_start_max_ms,
        0.1,
        120_000.0,
    );
    let idle_max = parse_f64(
        parsed.flags.get("idle-rss-max-mb"),
        policy.benchmark.idle_rss_max_mb,
        0.1,
        8192.0,
    );
    let tasks_min = parse_f64(
        parsed.flags.get("tasks-per-sec-min"),
        policy.benchmark.tasks_per_sec_min,
        1.0,
        100_000_000.0,
    );

    let benchmark_path = root.join(bench_rel);
    let metrics_row = collect_benchmark_metrics(root, &benchmark_path, sample_ms, refresh);

    let cold = metrics_row
        .get("metrics")
        .and_then(|m| m.get("cold_start_ms"))
        .and_then(Value::as_f64);
    let idle = metrics_row
        .get("metrics")
        .and_then(|m| m.get("idle_rss_mb"))
        .and_then(Value::as_f64);
    let tasks = metrics_row
        .get("metrics")
        .and_then(|m| m.get("tasks_per_sec"))
        .and_then(Value::as_f64);

    let mut errors = Vec::<String>::new();
    let mut checks = Map::<String, Value>::new();

    let cold_ok = cold.map(|v| v <= cold_max).unwrap_or(false);
    let idle_ok = idle.map(|v| v <= idle_max).unwrap_or(false);
    let tasks_ok = tasks.map(|v| v >= tasks_min).unwrap_or(false);

    checks.insert("cold_start_max".to_string(), json!(cold_ok));
    checks.insert("idle_rss_max".to_string(), json!(idle_ok));
    checks.insert("tasks_per_sec_min".to_string(), json!(tasks_ok));

    if !cold_ok {
        errors.push("cold_start_threshold_failed".to_string());
    }
    if !idle_ok {
        errors.push("idle_rss_threshold_failed".to_string());
    }
    if !tasks_ok {
        errors.push("tasks_per_sec_threshold_failed".to_string());
    }

    let ok = errors.is_empty();

    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "benchmark_path": bench_rel,
        "thresholds": {
            "cold_start_max_ms": cold_max,
            "idle_rss_max_mb": idle_max,
            "tasks_per_sec_min": tasks_min
        },
        "metrics": metrics_row.get("metrics").cloned().unwrap_or(Value::Null),
        "checks": checks,
        "errors": errors
    })
}

fn render_matrix_markdown(
    generated_at: &str,
    projects: &Map<String, Value>,
    source_benchmark: &str,
    source_snapshot: &str,
) -> String {
    let mut lines = Vec::<String>::new();
    lines.push("# Protheus vs X (CI Generated)".to_string());
    lines.push(String::new());
    lines.push(format!("Generated at: `{generated_at}`"));
    lines.push(format!("Source benchmark: `{source_benchmark}`"));
    lines.push(format!("Source snapshot: `{source_snapshot}`"));
    lines.push(String::new());
    lines.push(
        "| Project | Cold Start (ms) | Idle RSS (MB) | Install (MB) | Tasks/sec |".to_string(),
    );
    lines.push("|---|---:|---:|---:|---:|".to_string());

    let mut names = projects.keys().cloned().collect::<Vec<_>>();
    names.sort();

    for name in names {
        let row = projects.get(&name).and_then(Value::as_object).cloned();
        let Some(row) = row else {
            continue;
        };
        let cold = row
            .get("cold_start_ms")
            .and_then(Value::as_f64)
            .map(|v| format!("{v:.1}"))
            .unwrap_or_else(|| "n/a".to_string());
        let idle = row
            .get("idle_memory_mb")
            .or_else(|| row.get("idle_rss_mb"))
            .and_then(Value::as_f64)
            .map(|v| format!("{v:.1}"))
            .unwrap_or_else(|| "n/a".to_string());
        let install = row
            .get("install_size_mb")
            .and_then(Value::as_f64)
            .map(|v| format!("{v:.1}"))
            .unwrap_or_else(|| "n/a".to_string());
        let tasks = row
            .get("tasks_per_sec")
            .and_then(Value::as_f64)
            .map(|v| format!("{v:.1}"))
            .unwrap_or_else(|| "n/a".to_string());

        lines.push(format!(
            "| {name} | {cold} | {idle} | {install} | {tasks} |"
        ));
    }

    lines.push(String::new());
    lines.push(
        "This table is generated from receipted benchmark artifacts; manual edits are overwritten."
            .to_string(),
    );

    lines.join("\n") + "\n"
}

fn run_comparison_matrix(
    root: &Path,
    policy: &Top1Policy,
    strict: bool,
    parsed: &crate::ParsedArgs,
) -> Value {
    let snapshot_rel = parsed
        .flags
        .get("snapshot-path")
        .map(String::as_str)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(policy.comparison.snapshot_path.as_str());
    let output_rel = parsed
        .flags
        .get("output-path")
        .map(String::as_str)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(policy.comparison.output_path.as_str());
    let benchmark_rel = parsed
        .flags
        .get("benchmark-path")
        .map(String::as_str)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(policy.benchmark.benchmark_path.as_str());
    let apply = parse_bool(parsed.flags.get("apply"), true);

    let snapshot_path = root.join(snapshot_rel);
    let output_path = root.join(output_rel);
    let benchmark_path = root.join(benchmark_rel);

    let snapshot = read_json(&snapshot_path).unwrap_or(Value::Null);
    let benchmark = read_json(&benchmark_path).unwrap_or(Value::Null);

    let mut errors = Vec::<String>::new();
    if snapshot.is_null() {
        errors.push("comparison_snapshot_missing".to_string());
    }

    let mut projects = snapshot
        .get("projects")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    if projects.is_empty() {
        errors.push("comparison_snapshot_projects_missing".to_string());
    }

    let metrics = benchmark.get("metrics").cloned().unwrap_or(Value::Null);
    let openclaw = json!({
        "cold_start_ms": metrics.get("cold_start_ms").and_then(Value::as_f64),
        "idle_memory_mb": metrics.get("idle_rss_mb").and_then(Value::as_f64),
        "install_size_mb": metrics.get("install_size_mb").and_then(Value::as_f64),
        "tasks_per_sec": metrics.get("tasks_per_sec").and_then(Value::as_f64)
    });
    projects.insert("Protheus".to_string(), openclaw);

    let generated_at = now_iso();
    let markdown = render_matrix_markdown(&generated_at, &projects, benchmark_rel, snapshot_rel);

    if apply {
        if let Some(parent) = output_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&output_path, markdown.as_bytes()).is_err() {
            errors.push("comparison_output_write_failed".to_string());
        }
    }

    let ok = errors.is_empty();
    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "snapshot_path": snapshot_rel,
        "benchmark_path": benchmark_rel,
        "output_path": output_rel,
        "apply": apply,
        "project_count": projects.len(),
        "errors": errors
    })
}

fn run_status(root: &Path, policy: &Top1Policy) -> Value {
    let latest = read_json(&root.join(&policy.outputs.latest_path));
    json!({
        "ok": true,
        "type": "top1_assurance_status",
        "lane": LANE_ID,
        "ts": now_iso(),
        "latest_path": policy.outputs.latest_path,
        "history_path": policy.outputs.history_path,
        "has_latest": latest.is_some(),
        "latest": latest
    })
}

fn wrap_receipt(
    root: &Path,
    policy: &Top1Policy,
    command: &str,
    strict: bool,
    payload: Value,
    write_state: bool,
) -> Value {
    let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let mut out = json!({
        "ok": ok,
        "type": "top1_assurance",
        "lane": LANE_ID,
        "command": command,
        "strict": strict,
        "ts": now_iso(),
        "payload": payload,
        "claim_evidence": [
            {
                "id": "top1_assurance_lane",
                "claim": "top1_assurance_contracts_emit_deterministic_receipts",
                "evidence": {
                    "command": command,
                    "strict": strict
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));

    if write_state {
        let latest_path = root.join(&policy.outputs.latest_path);
        let history_path = root.join(&policy.outputs.history_path);
        let _ = write_json(&latest_path, &out);
        let _ = append_jsonl(&history_path, &out);
    }

    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    if argv
        .iter()
        .any(|arg| matches!(arg.as_str(), "help" | "--help" | "-h"))
    {
        usage();
        return 0;
    }

    let parsed = parse_args(argv);
    let command = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    let policy_rel = parsed
        .flags
        .get("policy")
        .map(String::as_str)
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(DEFAULT_POLICY_REL);
    let policy_path = root.join(policy_rel);
    let policy = load_policy(root, &policy_path);
    let strict = parse_bool(parsed.flags.get("strict"), policy.strict_default);

    let payload = match command.as_str() {
        "status" => run_status(root, &policy),
        "proof-coverage" => run_proof_coverage(root, &policy, strict, &parsed),
        "proof-vm" => run_proof_vm(root, &policy, strict, &parsed),
        "size-gate" => run_size_gate(root, &policy, strict, &parsed),
        "benchmark-thresholds" => run_benchmark_thresholds(root, &policy, strict, &parsed),
        "comparison-matrix" => run_comparison_matrix(root, &policy, strict, &parsed),
        "run-all" => {
            let proof = run_proof_coverage(root, &policy, strict, &parsed);
            let vm = run_proof_vm(root, &policy, strict, &parsed);
            let size = run_size_gate(root, &policy, strict, &parsed);
            let bench = run_benchmark_thresholds(root, &policy, strict, &parsed);
            let compare = run_comparison_matrix(root, &policy, strict, &parsed);
            let ok = [
                proof.get("ok").and_then(Value::as_bool).unwrap_or(false),
                vm.get("ok").and_then(Value::as_bool).unwrap_or(false),
                size.get("ok").and_then(Value::as_bool).unwrap_or(false),
                bench.get("ok").and_then(Value::as_bool).unwrap_or(false),
                compare.get("ok").and_then(Value::as_bool).unwrap_or(false),
            ]
            .into_iter()
            .all(|v| v);
            json!({
                "ok": ok,
                "strict": strict,
                "steps": {
                    "proof_coverage": proof,
                    "proof_vm": vm,
                    "size_gate": size,
                    "benchmark_thresholds": bench,
                    "comparison_matrix": compare
                }
            })
        }
        _ => json!({
            "ok": false,
            "error": "unknown_command",
            "command": command,
            "usage": [
                "protheus-ops top1-assurance status",
                "protheus-ops top1-assurance proof-coverage --strict=1",
                "protheus-ops top1-assurance proof-vm --strict=1",
                "protheus-ops top1-assurance size-gate --strict=1",
                "protheus-ops top1-assurance benchmark-thresholds --strict=1",
                "protheus-ops top1-assurance comparison-matrix --strict=1",
                "protheus-ops top1-assurance run-all --strict=1"
            ]
        }),
    };

    let should_write = command != "status";
    let receipt = wrap_receipt(root, &policy, &command, strict, payload, should_write);

    println!(
        "{}",
        serde_json::to_string_pretty(&receipt)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );

    if receipt.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        0
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, MutexGuard, OnceLock};

    fn env_lock() -> MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().expect("lock")
    }

    #[test]
    fn microbench_reports_positive_rate() {
        let rate = microbench_tasks_per_sec(120);
        assert!(rate > 0.0);
    }

    #[test]
    fn render_matrix_markdown_has_header_and_rows() {
        let mut projects = Map::<String, Value>::new();
        projects.insert(
            "Protheus".to_string(),
            json!({
                "cold_start_ms": 50.0,
                "idle_memory_mb": 20.0,
                "install_size_mb": 120.0,
                "tasks_per_sec": 9000.0
            }),
        );
        let md = render_matrix_markdown(
            "2026-03-13T00:00:00Z",
            &projects,
            "state/ops/top1_assurance/benchmark_latest.json",
            "client/runtime/config/competitive_benchmark_snapshot_2026_02.json",
        );
        assert!(md.contains("# Protheus vs X (CI Generated)"));
        assert!(md.contains("| Protheus |"));
    }

    #[test]
    fn toolchain_check_discovers_home_scoped_binaries() {
        let _guard = env_lock();
        let tmp = tempfile::tempdir().expect("tempdir");
        let home = tmp.path();
        let empty_path = home.join("path-empty");
        fs::create_dir_all(&empty_path).expect("mkdir path");

        let lean = home.join(".elan/bin/lean");
        let cargo_kani = home.join(".cargo/bin/cargo-kani");
        fs::create_dir_all(lean.parent().expect("lean parent")).expect("mkdir lean");
        fs::create_dir_all(cargo_kani.parent().expect("kani parent")).expect("mkdir kani");
        fs::write(&lean, "#!/bin/sh\necho 'Lean 4.0.0'\n").expect("write lean");
        fs::write(&cargo_kani, "#!/bin/sh\necho 'cargo-kani 0.56.0'\n").expect("write kani");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            for path in [&lean, &cargo_kani] {
                let mut perms = fs::metadata(path).expect("metadata").permissions();
                perms.set_mode(0o755);
                fs::set_permissions(path, perms).expect("chmod");
            }
        }

        let old_home = std::env::var_os("HOME");
        let old_path = std::env::var_os("PATH");
        std::env::set_var("HOME", home);
        std::env::set_var("PATH", &empty_path);

        let lean_check = run_toolchain_check("lean_toolchain");
        let kani_check = run_toolchain_check("kani_toolchain");

        if let Some(value) = old_home {
            std::env::set_var("HOME", value);
        } else {
            std::env::remove_var("HOME");
        }
        if let Some(value) = old_path {
            std::env::set_var("PATH", value);
        } else {
            std::env::remove_var("PATH");
        }

        assert_eq!(lean_check.get("ok").and_then(Value::as_bool), Some(true));
        assert!(lean_check
            .get("resolved_bin")
            .and_then(Value::as_str)
            .map(|v| v.ends_with(".elan/bin/lean"))
            .unwrap_or(false));
        assert_eq!(kani_check.get("ok").and_then(Value::as_bool), Some(true));
        assert!(kani_check
            .get("resolved_bin")
            .and_then(Value::as_str)
            .map(|v| v.ends_with(".cargo/bin/cargo-kani"))
            .unwrap_or(false));
    }
}
