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

pub mod fluxlattice_program;
pub mod foundation_contract_gate;
pub mod legacy_bridge;
pub mod perception_polish;
pub mod protheusctl;
pub mod scale_readiness;
pub mod state_kernel;

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
        365,
        base.target_hold_days as i64,
    ) as u32;
    policy.enforce_hold_streak_strict = to_bool(
        raw.get("enforce_hold_streak_strict")
            .and_then(Value::as_bool)
            .map(|v| if v { "true" } else { "false" }),
        base.enforce_hold_streak_strict,
    );

    policy.cold_start_probe.command =
        normalize_cmd(cold_raw.get("command"), &base.cold_start_probe.command);
    policy.cold_start_probe.samples = clamp_int(
        cold_raw.get("samples").and_then(Value::as_i64),
        1,
        30,
        base.cold_start_probe.samples as i64,
    ) as usize;
    policy.cold_start_probe.max_ms = clamp_num(
        cold_raw.get("max_ms").and_then(Value::as_f64),
        1.0,
        30000.0,
        base.cold_start_probe.max_ms,
    );
    policy.cold_start_probe.warmup_runs = clamp_int(
        cold_raw.get("warmup_runs").and_then(Value::as_i64),
        0,
        10,
        base.cold_start_probe.warmup_runs as i64,
    ) as usize;
    let runtime_mode = cold_raw
        .get("runtime_mode")
        .and_then(Value::as_str)
        .unwrap_or(&base.cold_start_probe.runtime_mode)
        .trim()
        .to_ascii_lowercase();
    policy.cold_start_probe.runtime_mode = if runtime_mode == "source" || runtime_mode == "dist" {
        runtime_mode
    } else {
        base.cold_start_probe.runtime_mode.clone()
    };
    policy.cold_start_probe.require_full_dist = cold_raw
        .get("require_full_dist")
        .and_then(Value::as_bool)
        .unwrap_or(base.cold_start_probe.require_full_dist);

    policy.idle_rss_probe.samples = clamp_int(
        idle_raw.get("samples").and_then(Value::as_i64),
        1,
        20,
        base.idle_rss_probe.samples as i64,
    ) as usize;
    policy.idle_rss_probe.max_mb = clamp_num(
        idle_raw.get("max_mb").and_then(Value::as_f64),
        1.0,
        8192.0,
        base.idle_rss_probe.max_mb,
    );
    policy.idle_rss_probe.require_modules = idle_raw
        .get("require_modules")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|v| clean(v, 240))
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| base.idle_rss_probe.require_modules.clone());

    policy.install_artifact_probe.max_mb = clamp_num(
        artifact_raw.get("max_mb").and_then(Value::as_f64),
        1.0,
        8192.0,
        base.install_artifact_probe.max_mb,
    );
    policy.install_artifact_probe.paths = artifact_raw
        .get("paths")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|v| clean(v, 240))
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| base.install_artifact_probe.paths.clone());

    if let Some(state) = raw.get("state_path").and_then(Value::as_str) {
        let clean_state = clean(state, 240);
        if !clean_state.is_empty() {
            policy.state_path = if Path::new(&clean_state).is_absolute() {
                PathBuf::from(clean_state)
            } else {
                root.join(clean_state)
            };
        }
    }
    if let Some(hist) = raw.get("history_path").and_then(Value::as_str) {
        let clean_hist = clean(hist, 240);
        if !clean_hist.is_empty() {
            policy.history_path = if Path::new(&clean_hist).is_absolute() {
                PathBuf::from(clean_hist)
            } else {
                root.join(clean_hist)
            };
        }
    }

    policy
}

fn node_bin() -> String {
    std::env::var("PROTHEUS_NODE_BINARY").unwrap_or_else(|_| "node".to_string())
}

pub fn maybe_rewrite_to_dist_command(root: &Path, cmd: &[String]) -> DistRewrite {
    if cmd.len() < 2 {
        return DistRewrite {
            command: cmd.to_vec(),
            build_attempted: false,
            build_ok: None,
            dist_target: None,
            build_error: None,
        };
    }

    let runner = clean(&cmd[0], 240);
    let script = clean(&cmd[1], 240);
    let is_node_runner = runner == "node"
        || Path::new(&runner)
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n == "node")
            .unwrap_or(false);
    if !is_node_runner || script.is_empty() || script.starts_with('-') {
        return DistRewrite {
            command: cmd.to_vec(),
            build_attempted: false,
            build_ok: None,
            dist_target: None,
            build_error: None,
        };
    }

    let rel_script = script
        .replace('\\', "/")
        .trim_start_matches("./")
        .to_string();
    if !rel_script.starts_with("systems/") {
        return DistRewrite {
            command: cmd.to_vec(),
            build_attempted: false,
            build_ok: None,
            dist_target: None,
            build_error: None,
        };
    }

    let dist_rel = format!("dist/{rel_script}");
    let dist_abs = root.join(&dist_rel);
    let mut build_attempted = false;
    let mut build_ok = None;
    let mut build_error = None;

    if !dist_abs.exists() {
        build_attempted = true;
        let output = Command::new(node_bin())
            .arg("systems/ops/build_systems.js")
            .current_dir(root)
            .output();
        match output {
            Ok(out) => {
                let ok = out.status.success();
                build_ok = Some(ok);
                if !ok {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let text = if stderr.trim().is_empty() {
                        stdout.to_string()
                    } else {
                        stderr.to_string()
                    };
                    build_error = Some(clean(text, 200));
                }
            }
            Err(err) => {
                build_ok = Some(false);
                build_error = Some(clean(format!("build_spawn_failed:{err}"), 200));
            }
        }
    }

    if dist_abs.exists() {
        let mut new_cmd = vec![cmd[0].clone(), dist_rel];
        new_cmd.extend_from_slice(&cmd[2..]);
        return DistRewrite {
            command: new_cmd,
            build_attempted,
            build_ok: if build_attempted { Some(true) } else { None },
            dist_target: Some(dist_abs.to_string_lossy().to_string()),
            build_error: None,
        };
    }

    DistRewrite {
        command: cmd.to_vec(),
        build_attempted,
        build_ok,
        dist_target: Some(dist_abs.to_string_lossy().to_string()),
        build_error: Some(
            build_error.unwrap_or_else(|| "dist_target_missing_after_build".to_string()),
        ),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ColdStartResult {
    pub pass: bool,
    pub samples: usize,
    pub warmup_runs: usize,
    pub samples_ms: Vec<f64>,
    pub p95_ms: Option<f64>,
    pub threshold_ms: f64,
    pub command: Vec<String>,
    pub runtime_mode: String,
    pub require_full_dist: bool,
    pub dist_build_attempted: bool,
    pub dist_build_ok: Option<bool>,
    pub dist_target: Option<String>,
    pub error: Option<String>,
}

pub fn run_cold_start_probe(root: &Path, policy: &Policy) -> ColdStartResult {
    let mut cmd = policy.cold_start_probe.command.clone();
    let mut dist_build_attempted = false;
    let mut dist_build_ok = None;
    let mut dist_target = None;
    let mut dist_build_error = None;
    if policy.cold_start_probe.runtime_mode == "dist" {
        let rewrite = maybe_rewrite_to_dist_command(root, &cmd);
        cmd = rewrite.command;
        dist_build_attempted = rewrite.build_attempted;
        dist_build_ok = rewrite.build_ok;
        dist_target = rewrite.dist_target;
        dist_build_error = rewrite.build_error;
    }

    let total_runs = policy.cold_start_probe.samples + policy.cold_start_probe.warmup_runs;
    let mut samples_ms = Vec::new();
    let mut last_err = None::<String>;
    for idx in 0..total_runs {
        let start = Instant::now();
        let output = Command::new(&cmd[0])
            .args(&cmd[1..])
            .current_dir(root)
            .env(
                "PROTHEUS_RUNTIME_MODE",
                &policy.cold_start_probe.runtime_mode,
            )
            .env(
                "PROTHEUS_RUNTIME_DIST_REQUIRED",
                if policy.cold_start_probe.runtime_mode == "dist" {
                    if policy.cold_start_probe.require_full_dist {
                        "1"
                    } else {
                        "0"
                    }
                } else {
                    "0"
                },
            )
            .output();
        let elapsed = start.elapsed().as_secs_f64() * 1000.0;
        if idx >= policy.cold_start_probe.warmup_runs {
            samples_ms.push((elapsed * 1000.0).round() / 1000.0);
        }
        match output {
            Ok(out) => {
                if !out.status.success() {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let text = if stderr.trim().is_empty() {
                        stdout.to_string()
                    } else {
                        stderr.to_string()
                    };
                    last_err = Some(clean(text, 200));
                }
            }
            Err(err) => {
                last_err = Some(clean(format!("cold_start_probe_spawn_failed:{err}"), 200));
            }
        }
    }

    if last_err.is_none() && dist_build_error.is_some() && policy.cold_start_probe.require_full_dist
    {
        last_err = dist_build_error;
    }

    let p95 = percentile(&samples_ms, 0.95);
    let pass = p95
        .map(|v| v <= policy.cold_start_probe.max_ms)
        .unwrap_or(false)
        && last_err.is_none();

    ColdStartResult {
        pass,
        samples: policy.cold_start_probe.samples,
        warmup_runs: policy.cold_start_probe.warmup_runs,
        samples_ms,
        p95_ms: p95,
        threshold_ms: policy.cold_start_probe.max_ms,
        command: cmd,
        runtime_mode: policy.cold_start_probe.runtime_mode.clone(),
        require_full_dist: policy.cold_start_probe.require_full_dist,
        dist_build_attempted,
        dist_build_ok,
        dist_target,
        error: last_err,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdleRssResult {
    pub pass: bool,
    pub samples: usize,
    pub samples_mb: Vec<f64>,
    pub p95_mb: Option<f64>,
    pub threshold_mb: f64,
    pub require_modules: Vec<String>,
    pub error: Option<String>,
}

pub fn run_idle_rss_probe(root: &Path, policy: &Policy) -> IdleRssResult {
    let mut samples_mb = Vec::new();
    let mut last_err = None::<String>;
    let code = [
        "const path=require(\"path\");",
        "const mods=JSON.parse(process.env.RUNTIME_EFF_IDLE_MODULES||\"[]\");",
        "for(const m of mods){",
        "  try{",
        "    const abs=path.isAbsolute(m)?m:path.join(process.cwd(), String(m));",
        "    require(abs);",
        "  }catch(_err){}",
        "}",
        "setTimeout(()=>{",
        "  const mb=Number((process.memoryUsage().rss/1024/1024).toFixed(3));",
        "  process.stdout.write(JSON.stringify({ok:true,rss_mb:mb})+\"\\n\");",
        "}, 5);",
    ]
    .join("");

    for _ in 0..policy.idle_rss_probe.samples {
        let output = Command::new(node_bin())
            .arg("-e")
            .arg(&code)
            .current_dir(root)
            .env(
                "RUNTIME_EFF_IDLE_MODULES",
                serde_json::to_string(&policy.idle_rss_probe.require_modules)
                    .unwrap_or_else(|_| "[]".to_string()),
            )
            .output();
        match output {
            Ok(out) => {
                if !out.status.success() {
                    let stderr = String::from_utf8_lossy(&out.stderr);
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    let text = if stderr.trim().is_empty() {
                        stdout.to_string()
                    } else {
                        stderr.to_string()
                    };
                    last_err = Some(clean(text, 200));
                    continue;
                }
                let mut payload = String::new();
                payload.push_str(&String::from_utf8_lossy(&out.stdout));
                let parsed = serde_json::from_str::<Value>(payload.trim());
                match parsed {
                    Ok(v) => {
                        let rss = v.get("rss_mb").and_then(Value::as_f64).unwrap_or(0.0);
                        if rss > 0.0 {
                            samples_mb.push(((rss * 1000.0).round()) / 1000.0);
                        } else {
                            last_err = Some("idle_rss_probe_parse_error".to_string());
                        }
                    }
                    Err(_) => {
                        last_err = Some("idle_rss_probe_parse_error".to_string());
                    }
                }
            }
            Err(err) => {
                last_err = Some(clean(format!("idle_rss_probe_spawn_failed:{err}"), 200));
            }
        }
    }

    let p95 = percentile(&samples_mb, 0.95);
    let pass = p95
        .map(|v| v <= policy.idle_rss_probe.max_mb)
        .unwrap_or(false)
        && last_err.is_none();

    IdleRssResult {
        pass,
        samples: policy.idle_rss_probe.samples,
        samples_mb,
        p95_mb: p95,
        threshold_mb: policy.idle_rss_probe.max_mb,
        require_modules: policy.idle_rss_probe.require_modules.clone(),
        error: last_err,
    }
}

fn size_bytes_of_path(path: &Path) -> u64 {
    let Ok(meta) = fs::metadata(path) else {
        return 0;
    };
    if meta.is_file() {
        return meta.len();
    }
    if !meta.is_dir() {
        return 0;
    }
    let mut total = 0u64;
    for entry in WalkDir::new(path).into_iter().flatten() {
        if entry.file_type().is_file() {
            if let Ok(md) = entry.metadata() {
                total = total.saturating_add(md.len());
            }
        }
    }
    total
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactPathRow {
    pub path: String,
    pub bytes: u64,
    pub mb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InstallArtifactResult {
    pub pass: bool,
    pub threshold_mb: f64,
    pub total_mb: f64,
    pub paths: Vec<ArtifactPathRow>,
}

pub fn run_install_artifact_probe(root: &Path, policy: &Policy) -> InstallArtifactResult {
    let mut rows = Vec::new();
    let mut total_bytes = 0u64;
    for item in &policy.install_artifact_probe.paths {
        let rel = clean(item, 240);
        if rel.is_empty() {
            continue;
        }
        let abs = if Path::new(&rel).is_absolute() {
            PathBuf::from(&rel)
        } else {
            root.join(&rel)
        };
        let bytes = size_bytes_of_path(&abs);
        total_bytes = total_bytes.saturating_add(bytes);
        rows.push(ArtifactPathRow {
            path: rel_path(root, &abs),
            bytes,
            mb: ((bytes as f64 / 1024.0 / 1024.0) * 1000.0).round() / 1000.0,
        });
    }
    let total_mb = ((total_bytes as f64 / 1024.0 / 1024.0) * 1000.0).round() / 1000.0;
    InstallArtifactResult {
        pass: total_mb <= policy.install_artifact_probe.max_mb,
        threshold_mb: policy.install_artifact_probe.max_mb,
        total_mb,
        paths: rows,
    }
}

pub fn detect_hardware_class() -> Value {
    let cpu_cores = num_cpus::get();
    let mut sys = System::new();
    sys.refresh_memory();
    let total_mem_mb = ((sys.total_memory() as f64) / 1024.0 / 1024.0).round() as i64;
    let class_id = if cpu_cores >= 8 && total_mem_mb >= 16384 {
        "desktop_high"
    } else if cpu_cores >= 4 && total_mem_mb >= 8192 {
        "desktop_mid"
    } else {
        "desktop_low"
    };
    json!({
        "class_id": class_id,
        "cpu_cores": cpu_cores,
        "total_mem_mb": total_mem_mb
    })
}

pub fn run_runtime_efficiency_floor(root: &Path, args: &ParsedArgs) -> Result<RunOutput, String> {
    let policy_path = args
        .flags
        .get("policy")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var("RUNTIME_EFFICIENCY_FLOOR_POLICY_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|_| root.join("config/runtime_efficiency_floor_policy.json"))
        });
    let policy_abs = if policy_path.is_absolute() {
        policy_path
    } else {
        root.join(policy_path)
    };
    let policy = load_policy(root, &policy_abs);
    let strict = to_bool(
        args.flags.get("strict").map(String::as_str),
        policy.strict_default,
    );

    let cold = run_cold_start_probe(root, &policy);
    let idle = run_idle_rss_probe(root, &policy);
    let artifact = run_install_artifact_probe(root, &policy);

    let mut checks = serde_json::Map::new();
    checks.insert("cold_start".to_string(), Value::Bool(cold.pass));
    checks.insert("idle_rss".to_string(), Value::Bool(idle.pass));
    checks.insert("install_artifact".to_string(), Value::Bool(artifact.pass));

    let mut blocking: Vec<String> = checks
        .iter()
        .filter_map(|(k, v)| {
            if v.as_bool() == Some(true) {
                None
            } else {
                Some(k.clone())
            }
        })
        .collect();

    let threshold_gaps = json!({
        "cold_start_ms_over": ((cold.p95_ms.unwrap_or(0.0) - cold.threshold_ms).max(0.0) * 1000.0).round() / 1000.0,
        "idle_rss_mb_over": ((idle.p95_mb.unwrap_or(0.0) - idle.threshold_mb).max(0.0) * 1000.0).round() / 1000.0,
        "install_artifact_mb_over": ((artifact.total_mb - artifact.threshold_mb).max(0.0) * 1000.0).round() / 1000.0
    });

    let mut optimization_order = vec![
        json!({"lane": "cold_start", "gap": threshold_gaps["cold_start_ms_over"], "unit": "ms"}),
        json!({"lane": "idle_rss", "gap": threshold_gaps["idle_rss_mb_over"], "unit": "mb"}),
        json!({"lane": "install_artifact", "gap": threshold_gaps["install_artifact_mb_over"], "unit": "mb"}),
    ];
    optimization_order.sort_by(|a, b| {
        let aa = a.get("gap").and_then(Value::as_f64).unwrap_or(0.0);
        let bb = b.get("gap").and_then(Value::as_f64).unwrap_or(0.0);
        bb.partial_cmp(&aa).unwrap_or(std::cmp::Ordering::Equal)
    });

    let pass = cold.pass && idle.pass && artifact.pass;
    let result = if pass { "pass" } else { "warn" };
    let date = now_iso()[..10].to_string();

    let mut history_rows = read_jsonl(&policy.history_path);
    history_rows.push(json!({"ts": now_iso(), "date": date, "pass": pass}));

    let hold_streak = compute_hold_streak_days(&history_rows, &date);
    let hold_remaining = (policy.target_hold_days as i64 - hold_streak as i64).max(0) as u32;
    let hold_ready = hold_streak >= policy.target_hold_days;
    let projected_ready = if hold_ready {
        date.clone()
    } else {
        add_utc_days(&date, hold_remaining as i64)
    };

    if policy.enforce_hold_streak_strict && !hold_ready {
        checks.insert("target_hold_streak".to_string(), Value::Bool(false));
        if !blocking.iter().any(|v| v == "target_hold_streak") {
            blocking.push("target_hold_streak".to_string());
        }
    } else {
        checks.insert("target_hold_streak".to_string(), Value::Bool(hold_ready));
    }

    let payload = json!({
        "schema_id": "runtime_efficiency_floor",
        "schema_version": "1.0",
        "updated_at": now_iso(),
        "policy_version": policy.version,
        "strict": strict,
        "checks": checks,
        "blocking_checks": blocking,
        "threshold_gaps": threshold_gaps,
        "optimization_order": optimization_order,
        "target_hold_days": policy.target_hold_days,
        "hold_streak_days": hold_streak,
        "hold_remaining_days": hold_remaining,
        "hold_ready": hold_ready,
        "hold_projected_ready_date": projected_ready,
        "pass": pass,
        "result": result,
        "hardware": detect_hardware_class(),
        "metrics": {
            "cold_start_p95_ms": cold.p95_ms,
            "cold_start_threshold_ms": cold.threshold_ms,
            "idle_rss_p95_mb": idle.p95_mb,
            "idle_rss_threshold_mb": idle.threshold_mb,
            "install_artifact_total_mb": artifact.total_mb,
            "install_artifact_threshold_mb": artifact.threshold_mb
        },
        "probes": {
            "cold_start": cold,
            "idle_rss": idle,
            "install_artifact": artifact
        }
    });

    write_json_atomic(&policy.state_path, &payload)?;
    append_jsonl(
        &policy.history_path,
        &json!({
            "ts": payload["updated_at"],
            "pass": payload["pass"],
            "result": payload["result"],
            "checks": payload["checks"],
            "metrics": payload["metrics"]
        }),
    )?;

    let out = json!({
        "ok": true,
        "type": "runtime_efficiency_floor",
        "ts": payload["updated_at"],
        "pass": payload["pass"],
        "result": payload["result"],
        "checks": payload["checks"],
        "blocking_checks": payload["blocking_checks"],
        "threshold_gaps": payload["threshold_gaps"],
        "optimization_order": payload["optimization_order"],
        "target_hold_days": payload["target_hold_days"],
        "hold_streak_days": payload["hold_streak_days"],
        "hold_remaining_days": payload["hold_remaining_days"],
        "hold_ready": payload["hold_ready"],
        "hold_projected_ready_date": payload["hold_projected_ready_date"],
        "hardware": payload["hardware"],
        "metrics": payload["metrics"],
        "policy_path": rel_path(root, &policy_abs),
        "state_path": rel_path(root, &policy.state_path),
        "history_path": rel_path(root, &policy.history_path)
    });

    Ok(RunOutput {
        json: out,
        exit_code: if strict && !pass { 1 } else { 0 },
    })
}

pub fn status_runtime_efficiency_floor(root: &Path, args: &ParsedArgs) -> RunOutput {
    let policy_path = args
        .flags
        .get("policy")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var("RUNTIME_EFFICIENCY_FLOOR_POLICY_PATH")
                .map(PathBuf::from)
                .unwrap_or_else(|_| root.join("config/runtime_efficiency_floor_policy.json"))
        });
    let policy_abs = if policy_path.is_absolute() {
        policy_path
    } else {
        root.join(policy_path)
    };
    let policy = load_policy(root, &policy_abs);
    let payload = read_json(&policy.state_path);
    RunOutput {
        json: json!({
            "ok": true,
            "type": "runtime_efficiency_floor_status",
            "ts": now_iso(),
            "available": payload.is_object(),
            "policy_path": rel_path(root, &policy_abs),
            "state_path": rel_path(root, &policy.state_path),
            "history_path": rel_path(root, &policy.history_path),
            "payload": if payload.is_null() { Value::Null } else { payload }
        }),
        exit_code: 0,
    }
}

pub fn parse_os_args<I>(iter: I) -> Vec<String>
where
    I: IntoIterator<Item = OsString>,
{
    iter.into_iter()
        .map(|s| s.to_string_lossy().to_string())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentile_regression() {
        let values = vec![10.0, 20.0, 30.0, 40.0, 50.0];
        assert_eq!(percentile(&values, 0.95), Some(50.0));
    }

    #[test]
    fn hold_streak_counts_consecutive_days() {
        let rows = vec![
            json!({"date":"2026-03-01","pass":true}),
            json!({"date":"2026-03-02","pass":true}),
            json!({"date":"2026-03-03","pass":true}),
        ];
        assert_eq!(compute_hold_streak_days(&rows, "2026-03-03"), 3);
    }

    #[test]
    fn sovereignty_fail_closed_hold_streak_gate() {
        let root = tempfile::tempdir().expect("tempdir");
        let policy_path = root.path().join("policy.json");
        let state_path = root.path().join("state.json");
        let history_path = root.path().join("history.jsonl");
        fs::write(
            &policy_path,
            serde_json::to_string_pretty(&json!({
                "version":"1.0",
                "strict_default": true,
                "target_hold_days": 7,
                "enforce_hold_streak_strict": true,
                "cold_start_probe": {
                    "command": ["node", "-e", "process.exit(0)"],
                    "samples": 1,
                    "max_ms": 99999,
                    "warmup_runs": 0,
                    "runtime_mode": "source",
                    "require_full_dist": false
                },
                "idle_rss_probe": {
                    "samples": 1,
                    "max_mb": 99999,
                    "require_modules": []
                },
                "install_artifact_probe": {
                    "max_mb": 99999,
                    "paths": ["."]
                },
                "state_path": state_path,
                "history_path": history_path
            }))
            .expect("policy_json"),
        )
        .expect("write_policy");

        let args = ParsedArgs {
            positional: vec![],
            flags: HashMap::from([
                (
                    "policy".to_string(),
                    policy_path.to_string_lossy().to_string(),
                ),
                ("strict".to_string(), "1".to_string()),
            ]),
        };

        let out = run_runtime_efficiency_floor(root.path(), &args).expect("run_ok");
        let blocking = out
            .json
            .get("blocking_checks")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(blocking
            .iter()
            .any(|v| v.as_str() == Some("target_hold_streak")));
    }
}
