use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;
use sysinfo::System;
use walkdir::WalkDir;

pub mod autotest_controller;
pub mod autotest_doctor;
pub mod autonomy_controller;
pub mod contract_check;
pub mod fluxlattice_program;
pub mod foundation_contract_gate;
pub mod legacy_bridge;
pub mod model_router;
pub mod perception_polish;
pub mod protheusctl;
pub mod scale_readiness;
pub mod spine;
pub mod state_kernel;
pub mod strategy_mode_governor;

#[derive(Debug, Clone)]
pub struct ParsedArgs {
    pub positional: Vec<String>,
    pub flags: HashMap<String, String>,
}

pub fn parse_args(raw: &[String]) -> ParsedArgs {
    let mut positional = Vec::new();
    let mut flags = HashMap::new();
    for token in raw {
        if !token.starts_with("--") {
            positional.push(token.clone());
            continue;
        }
        match token.split_once('=') {
            Some((k, v)) => {
                flags.insert(k.trim_start_matches("--").to_string(), v.to_string());
            }
            None => {
                flags.insert(
                    token.trim_start_matches("--").to_string(),
                    "true".to_string(),
                );
            }
        }
    }
    ParsedArgs { positional, flags }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColdStartProbe {
    pub command: Vec<String>,
    pub samples: usize,
    pub max_ms: f64,
    pub warmup_runs: usize,
    pub runtime_mode: String,
    pub require_full_dist: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdleRssProbe {
    pub samples: usize,
    pub max_mb: f64,
    pub require_modules: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallArtifactProbe {
    pub max_mb: f64,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Policy {
    pub version: String,
    pub strict_default: bool,
    pub target_hold_days: u32,
    pub enforce_hold_streak_strict: bool,
    pub cold_start_probe: ColdStartProbe,
    pub idle_rss_probe: IdleRssProbe,
    pub install_artifact_probe: InstallArtifactProbe,
    pub state_path: PathBuf,
    pub history_path: PathBuf,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DistRewrite {
    pub command: Vec<String>,
    pub build_attempted: bool,
    pub build_ok: Option<bool>,
    pub dist_target: Option<String>,
    pub build_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunOutput {
    pub json: Value,
    pub exit_code: i32,
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn clean(v: impl ToString, max_len: usize) -> String {
    let text = v.to_string();
    let trimmed = text.trim();
    let mut out = String::with_capacity(trimmed.len().min(max_len));
    for ch in trimmed.chars().take(max_len) {
        out.push(ch);
    }
    out
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

fn clamp_num(v: Option<f64>, lo: f64, hi: f64, fallback: f64) -> f64 {
    let Some(mut n) = v else {
        return fallback;
    };
    if !n.is_finite() {
        return fallback;
    }
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

fn read_jsonl(path: &Path) -> Vec<Value> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() {
                return None;
            }
            serde_json::from_str::<Value>(line)
                .ok()
                .filter(|v| v.is_object())
        })
        .collect()
}

fn ensure_dir(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|e| format!("create_dir_failed:{}:{e}", path.display()))
}

fn write_json_atomic(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        Utc::now().timestamp_millis()
    ));
    let mut file =
        fs::File::create(&tmp).map_err(|e| format!("create_tmp_failed:{}:{e}", tmp.display()))?;
    let payload =
        serde_json::to_string_pretty(value).map_err(|e| format!("encode_json_failed:{e}"))?;
    file.write_all(payload.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| format!("write_tmp_failed:{}:{e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename_tmp_failed:{}:{e}", path.display()))
}

fn append_jsonl(path: &Path, row: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        ensure_dir(parent)?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open_jsonl_failed:{}:{e}", path.display()))?;
    let payload = serde_json::to_string(row).map_err(|e| format!("encode_row_failed:{e}"))?;
    file.write_all(payload.as_bytes())
        .and_then(|_| file.write_all(b"\n"))
        .map_err(|e| format!("append_jsonl_failed:{}:{e}", path.display()))
}

fn rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn to_date(raw: Option<&str>) -> String {
    let text = clean(raw.unwrap_or_default(), 32);
    if text.len() == 10 && text.chars().nth(4) == Some('-') && text.chars().nth(7) == Some('-') {
        return text;
    }
    now_iso()[..10].to_string()
}

fn add_utc_days(date_str: &str, delta_days: i64) -> String {
    let parsed = chrono::NaiveDate::parse_from_str(date_str, "%Y-%m-%d")
        .unwrap_or_else(|_| Utc::now().date_naive());
    let shifted = parsed + chrono::Duration::days(delta_days);
    shifted.format("%Y-%m-%d").to_string()
}

pub fn percentile(values: &[f64], q: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut arr = values.to_vec();
    arr.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx =
        ((q * arr.len() as f64).ceil() as isize - 1).clamp(0, arr.len() as isize - 1) as usize;
    Some(((arr[idx] * 1000.0).round()) / 1000.0)
}

pub fn compute_hold_streak_days(history_rows: &[Value], today: &str) -> u32 {
    let mut latest_by_date: HashMap<String, bool> = HashMap::new();
    for row in history_rows {
        let date = to_date(
            row.get("date")
                .and_then(Value::as_str)
                .or_else(|| row.get("ts").and_then(Value::as_str)),
        );
        let pass = row.get("pass").and_then(Value::as_bool).unwrap_or(false);
        latest_by_date.insert(date, pass);
    }

    let mut streak = 0u32;
    for i in 0..365 {
        let d = add_utc_days(today, -(i as i64));
        match latest_by_date.get(&d) {
            Some(true) => streak += 1,
            _ => break,
        }
    }
    streak
}

pub fn default_policy(root: &Path) -> Policy {
    Policy {
        version: "1.0".to_string(),
        strict_default: false,
        target_hold_days: 7,
        enforce_hold_streak_strict: false,
        cold_start_probe: ColdStartProbe {
            command: vec![
                "node".to_string(),
                "systems/workflow/workflow_controller.js".to_string(),
                "status".to_string(),
            ],
            samples: 5,
            max_ms: 300.0,
            warmup_runs: 1,
            runtime_mode: "dist".to_string(),
            require_full_dist: false,
        },
        idle_rss_probe: IdleRssProbe {
            samples: 3,
            max_mb: 120.0,
            require_modules: Vec::new(),
        },
        install_artifact_probe: InstallArtifactProbe {
            max_mb: 60.0,
            paths: vec!["dist".to_string()],
        },
        state_path: root.join("state/ops/runtime_efficiency_floor.json"),
        history_path: root.join("state/ops/runtime_efficiency_floor_history.jsonl"),
    }
}

fn normalize_cmd(raw: Option<&Value>, fallback: &[String]) -> Vec<String> {
    let src = raw
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| fallback.iter().map(|v| Value::String(v.clone())).collect());
    let cmd: Vec<String> = src
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 240))
        .filter(|v| !v.is_empty())
        .collect();
    if cmd.len() < 2 {
        return fallback.to_vec();
    }
    cmd
}

pub fn load_policy(root: &Path, policy_path: &Path) -> Policy {
    let raw = read_json(policy_path);
    let base = default_policy(root);
    let cold_raw = raw.get("cold_start_probe").cloned().unwrap_or(Value::Null);
    let idle_raw = raw.get("idle_rss_probe").cloned().unwrap_or(Value::Null);
    let artifact_raw = raw
        .get("install_artifact_probe")
        .cloned()
        .unwrap_or(Value::Null);

    let mut policy = base.clone();
    if let Some(v) = raw.get("version").and_then(Value::as_str) {
        let out = clean(v, 32);
        if !out.is_empty() {
            policy.version = out;
        }
    }
    policy.strict_default = raw
        .get("strict_default")
        .and_then(Value::as_bool)
        .unwrap_or(base.strict_default);
    policy.target_hold_days = clamp_int(
        raw.get("target_hold_days").and_then(Value::as_i64),
        1,
        90,
        base.target_hold_days as i64,
    ) as u32;
    policy.enforce_hold_streak_strict = raw
        .get("enforce_hold_streak_strict")
        .and_then(Value::as_bool)
        .unwrap_or(base.enforce_hold_streak_strict);

    policy.cold_start_probe = ColdStartProbe {
        command: normalize_cmd(cold_raw.get("command"), &base.cold_start_probe.command),
        samples: clamp_int(
            cold_raw.get("samples").and_then(Value::as_i64),
            1,
            50,
            base.cold_start_probe.samples as i64,
        ) as usize,
        max_ms: clamp_num(
            cold_raw.get("max_ms").and_then(Value::as_f64),
            10.0,
            5000.0,
            base.cold_start_probe.max_ms,
        ),
        warmup_runs: clamp_int(
            cold_raw.get("warmup_runs").and_then(Value::as_i64),
            0,
            10,
            base.cold_start_probe.warmup_runs as i64,
        ) as usize,
        runtime_mode: clean(
            cold_raw
                .get("runtime_mode")
                .and_then(Value::as_str)
                .unwrap_or(&base.cold_start_probe.runtime_mode),
            40,
        ),
        require_full_dist: cold_raw
            .get("require_full_dist")
            .and_then(Value::as_bool)
            .unwrap_or(base.cold_start_probe.require_full_dist),
    };

    policy.idle_rss_probe = IdleRssProbe {
        samples: clamp_int(
            idle_raw.get("samples").and_then(Value::as_i64),
            1,
            20,
            base.idle_rss_probe.samples as i64,
        ) as usize,
        max_mb: clamp_num(
            idle_raw.get("max_mb").and_then(Value::as_f64),
            10.0,
            1024.0,
            base.idle_rss_probe.max_mb,
        ),
        require_modules: idle_raw
            .get("require_modules")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(Value::as_str)
                    .map(|v| clean(v, 80))
                    .filter(|v| !v.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| base.idle_rss_probe.require_modules.clone()),
    };

    policy.install_artifact_probe = InstallArtifactProbe {
        max_mb: clamp_num(
            artifact_raw.get("max_mb").and_then(Value::as_f64),
            1.0,
            4096.0,
            base.install_artifact_probe.max_mb,
        ),
        paths: artifact_raw
            .get("paths")
            .and_then(Value::as_array)
            .map(|rows| {
                rows.iter()
                    .filter_map(Value::as_str)
                    .map(|v| clean(v, 200))
                    .filter(|v| !v.is_empty())
                    .collect::<Vec<_>>()
            })
            .filter(|rows| !rows.is_empty())
            .unwrap_or_else(|| base.install_artifact_probe.paths.clone()),
    };

    if let Some(v) = raw.get("state_path").and_then(Value::as_str) {
        let out = clean(v, 240);
        if !out.is_empty() {
            policy.state_path = root.join(out);
        }
    }
    if let Some(v) = raw.get("history_path").and_then(Value::as_str) {
        let out = clean(v, 240);
        if !out.is_empty() {
            policy.history_path = root.join(out);
        }
    }

    policy
}

fn cmd_with_runtime_mode(cmd: &[String], runtime_mode: &str) -> DistRewrite {
    if cmd.is_empty() {
        return DistRewrite {
            command: vec!["node".to_string(), "-e".to_string(), "console.log(\"noop\")".to_string()],
            build_attempted: false,
            build_ok: None,
            dist_target: None,
            build_error: None,
        };
    }

    let mode = clean(runtime_mode, 32).to_ascii_lowercase();
    if mode != "dist" {
        return DistRewrite {
            command: cmd.to_vec(),
            build_attempted: false,
            build_ok: None,
            dist_target: None,
            build_error: None,
        };
    }

    let mut rewritten = cmd.to_vec();
    let mut dist_target = None;

    if rewritten.len() >= 2 {
        let first = rewritten[0].to_ascii_lowercase();
        let second = rewritten[1].replace('\\', "/");
        if first == "node" && second.starts_with("systems/") && second.ends_with(".js") {
            let dist_candidate = format!("dist/{second}");
            rewritten[1] = dist_candidate.clone();
            dist_target = Some(dist_candidate);
        }
    }

    DistRewrite {
        command: rewritten,
        build_attempted: false,
        build_ok: None,
        dist_target,
        build_error: None,
    }
}

fn run_cmd(root: &Path, cmd: &[String]) -> Result<f64, String> {
    if cmd.is_empty() {
        return Err("command_missing".to_string());
    }
    let program = &cmd[0];
    let args = &cmd[1..];
    let start = Instant::now();
    let status = Command::new(program)
        .args(args)
        .current_dir(root)
        .status()
        .map_err(|e| format!("command_spawn_failed:{program}:{e}"))?;
    if !status.success() {
        return Err(format!(
            "command_failed:{program}:exit={}"
            ,status.code().unwrap_or(1)
        ));
    }
    Ok(start.elapsed().as_secs_f64() * 1000.0)
}

fn maybe_build_dist(root: &Path, rewrite: &mut DistRewrite, require_full_dist: bool) {
    let Some(target_rel) = rewrite.dist_target.clone() else {
        return;
    };
    let target_abs = root.join(&target_rel);
    if target_abs.exists() {
        return;
    }

    rewrite.build_attempted = true;
    let status = Command::new("npm")
        .arg("run")
        .arg("build")
        .current_dir(root)
        .status();

    match status {
        Ok(s) if s.success() => {
            rewrite.build_ok = Some(true);
            if !target_abs.exists() && require_full_dist {
                rewrite.build_ok = Some(false);
                rewrite.build_error = Some(format!("dist_target_missing:{target_rel}"));
            }
        }
        Ok(s) => {
            rewrite.build_ok = Some(false);
            rewrite.build_error = Some(format!("build_failed:exit={}", s.code().unwrap_or(1)));
        }
        Err(e) => {
            rewrite.build_ok = Some(false);
            rewrite.build_error = Some(format!("build_spawn_failed:{e}"));
        }
    }
}

fn dir_size_mb(root: &Path, rel_path: &str) -> f64 {
    let abs = root.join(rel_path);
    if !abs.exists() {
        return 0.0;
    }
    let mut bytes = 0u64;
    for entry in WalkDir::new(abs).into_iter().flatten() {
        if let Ok(meta) = entry.metadata() {
            if meta.is_file() {
                bytes = bytes.saturating_add(meta.len());
            }
        }
    }
    (bytes as f64) / (1024.0 * 1024.0)
}

fn system_idle_rss_mb() -> f64 {
    let mut sys = System::new_all();
    sys.refresh_all();
    let total_kib: u64 = sys.processes().values().map(|p| p.memory()).sum();
    total_kib as f64 / 1024.0
}

pub fn run_runtime_efficiency_floor(root: &Path, parsed: &ParsedArgs) -> Result<RunOutput, String> {
    let policy_path = parsed
        .flags
        .get("policy")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("config/runtime_efficiency_floor.json"));

    let policy = load_policy(root, &policy_path);
    let strict = to_bool(
        parsed.flags.get("strict").map(String::as_str),
        policy.strict_default,
    );

    let mut rewrite = cmd_with_runtime_mode(
        &policy.cold_start_probe.command,
        &policy.cold_start_probe.runtime_mode,
    );
    maybe_build_dist(root, &mut rewrite, policy.cold_start_probe.require_full_dist);

    if let Some(false) = rewrite.build_ok {
        let payload = json!({
            "ok": false,
            "type": "runtime_efficiency_floor",
            "error": rewrite
                .build_error
                .clone()
                .unwrap_or_else(|| "dist_build_failed".to_string()),
            "strict": strict,
            "policy_path": rel_path(root, &policy_path),
            "command": rewrite.command,
            "dist_target": rewrite.dist_target,
            "build_attempted": rewrite.build_attempted
        });
        return Ok(RunOutput {
            json: payload,
            exit_code: 1,
        });
    }

    for _ in 0..policy.cold_start_probe.warmup_runs {
        let _ = run_cmd(root, &rewrite.command);
    }

    let mut samples = Vec::new();
    for _ in 0..policy.cold_start_probe.samples {
        samples.push(run_cmd(root, &rewrite.command)?);
    }

    let p95_ms = percentile(&samples, 0.95).unwrap_or(0.0);

    let mut rss_samples = Vec::new();
    for _ in 0..policy.idle_rss_probe.samples {
        rss_samples.push(system_idle_rss_mb());
    }
    let idle_rss_mb = percentile(&rss_samples, 0.95).unwrap_or(0.0);

    let mut install_sizes = HashMap::new();
    let mut install_total = 0.0f64;
    for rel in &policy.install_artifact_probe.paths {
        let size = dir_size_mb(root, rel);
        install_total += size;
        install_sizes.insert(rel.clone(), (size * 1000.0).round() / 1000.0);
    }

    let pass = p95_ms <= policy.cold_start_probe.max_ms
        && idle_rss_mb <= policy.idle_rss_probe.max_mb
        && install_total <= policy.install_artifact_probe.max_mb;

    let now = now_iso();
    let row = json!({
        "ts": now,
        "date": &now[..10],
        "pass": pass,
        "strict": strict,
        "cold_start": {
            "samples": policy.cold_start_probe.samples,
            "max_ms": policy.cold_start_probe.max_ms,
            "p95_ms": (p95_ms * 1000.0).round() / 1000.0,
            "runtime_mode": policy.cold_start_probe.runtime_mode,
            "command": rewrite.command,
            "build_attempted": rewrite.build_attempted,
            "build_ok": rewrite.build_ok,
            "build_error": rewrite.build_error,
            "dist_target": rewrite.dist_target
        },
        "idle_rss": {
            "samples": policy.idle_rss_probe.samples,
            "max_mb": policy.idle_rss_probe.max_mb,
            "p95_mb": (idle_rss_mb * 1000.0).round() / 1000.0,
            "required_modules": policy.idle_rss_probe.require_modules,
        },
        "install_artifact": {
            "max_mb": policy.install_artifact_probe.max_mb,
            "sum_mb": (install_total * 1000.0).round() / 1000.0,
            "paths": install_sizes
        }
    });

    append_jsonl(&policy.history_path, &row)?;

    let history_rows = read_jsonl(&policy.history_path);
    let hold_streak_days = compute_hold_streak_days(&history_rows, &now[..10]);

    let strict_hold_ok = if policy.enforce_hold_streak_strict {
        hold_streak_days >= policy.target_hold_days
    } else {
        true
    };

    let effective_pass = pass && strict_hold_ok;

    let latest = json!({
        "ok": effective_pass,
        "type": "runtime_efficiency_floor",
        "policy_version": policy.version,
        "ts": now,
        "strict": strict,
        "pass": pass,
        "strict_hold_ok": strict_hold_ok,
        "hold_streak_days": hold_streak_days,
        "target_hold_days": policy.target_hold_days,
        "enforce_hold_streak_strict": policy.enforce_hold_streak_strict,
        "cold_start": row["cold_start"],
        "idle_rss": row["idle_rss"],
        "install_artifact": row["install_artifact"],
        "policy_path": rel_path(root, &policy_path),
        "state_path": rel_path(root, &policy.state_path),
        "history_path": rel_path(root, &policy.history_path)
    });

    write_json_atomic(&policy.state_path, &latest)?;

    Ok(RunOutput {
        exit_code: if effective_pass || !strict { 0 } else { 1 },
        json: latest,
    })
}

pub fn status_runtime_efficiency_floor(root: &Path, parsed: &ParsedArgs) -> RunOutput {
    let policy_path = parsed
        .flags
        .get("policy")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("config/runtime_efficiency_floor.json"));

    let policy = load_policy(root, &policy_path);
    let latest = read_json(&policy.state_path);
    let history_rows = read_jsonl(&policy.history_path);
    let today = now_iso();
    let hold_streak_days = compute_hold_streak_days(&history_rows, &today[..10]);

    RunOutput {
        exit_code: 0,
        json: json!({
            "ok": true,
            "type": "runtime_efficiency_floor_status",
            "policy_version": policy.version,
            "policy_path": rel_path(root, &policy_path),
            "state_path": rel_path(root, &policy.state_path),
            "history_path": rel_path(root, &policy.history_path),
            "target_hold_days": policy.target_hold_days,
            "enforce_hold_streak_strict": policy.enforce_hold_streak_strict,
            "hold_streak_days": hold_streak_days,
            "history_count": history_rows.len(),
            "latest": latest
        }),
    }
}

pub fn parse_os_args<I>(iter: I) -> Vec<String>
where
    I: IntoIterator<Item = OsString>,
{
    iter.into_iter()
        .map(|os| os.to_string_lossy().to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_regression() {
        let v = vec![100.0, 200.0, 300.0, 400.0, 500.0];
        let p95 = percentile(&v, 0.95).unwrap();
        assert_eq!(p95, 500.0);
    }

    #[test]
    fn hold_streak_counts_consecutive_days() {
        let rows = vec![
            json!({"date":"2026-02-20","pass":true}),
            json!({"date":"2026-02-21","pass":true}),
            json!({"date":"2026-02-22","pass":false}),
            json!({"date":"2026-02-23","pass":true}),
        ];
        let streak = compute_hold_streak_days(&rows, "2026-02-23");
        assert_eq!(streak, 1);
    }

    #[test]
    fn sovereignty_fail_closed_hold_streak_gate() {
        let root = tempfile::tempdir().unwrap();
        let policy_path = root.path().join("config/runtime_efficiency_floor.json");
        fs::create_dir_all(policy_path.parent().unwrap()).unwrap();
        fs::write(
            &policy_path,
            serde_json::to_string_pretty(&json!({
                "strict_default": true,
                "target_hold_days": 3,
                "enforce_hold_streak_strict": true,
                "cold_start_probe": {
                    "command": ["echo", "ok"],
                    "samples": 1,
                    "max_ms": 5000,
                    "warmup_runs": 0,
                    "runtime_mode": "source",
                    "require_full_dist": false
                },
                "idle_rss_probe": {"samples": 1, "max_mb": 9999, "require_modules": []},
                "install_artifact_probe": {"max_mb": 9999, "paths": ["dist"]},
                "state_path": "state/ops/runtime_efficiency_floor.json",
                "history_path": "state/ops/runtime_efficiency_floor_history.jsonl"
            }))
            .unwrap(),
        )
        .unwrap();

        let parsed = ParsedArgs {
            positional: vec!["run".to_string()],
            flags: HashMap::from([("policy".to_string(), policy_path.to_string_lossy().to_string())]),
        };

        let out1 = run_runtime_efficiency_floor(root.path(), &parsed).unwrap();
        assert_eq!(out1.exit_code, 1, "strict hold streak should fail closed before target");
    }
}
