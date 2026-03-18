// Layer ownership: core/layer0/ops (authoritative)
// SPDX-License-Identifier: Apache-2.0
use chrono::{SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Instant;
use walkdir::WalkDir;

#[cfg(feature = "minimal")]
#[path = "../../alloc.rs"]
mod layer0_alloc;

#[cfg(all(feature = "mimalloc", not(feature = "minimal")))]
#[global_allocator]
static LAYER0_MIMALLOC_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

pub mod ab_lane_eval;
pub mod action_envelope_kernel;
pub mod action_receipts_kernel;
pub mod adaptive_intelligence;
pub mod adaptive_layer_store_kernel;
pub mod adaptive_runtime;
pub mod agency_plane;
pub mod alpha_readiness;
pub mod app_plane;
pub mod approval_gate_kernel;
pub mod asm_plane;
pub mod assimilation_controller;
pub mod attention_queue;
pub mod audit_log_export;
pub mod autonomy_controller;
pub mod autonomy_receipt_schema_kernel;
pub mod autotest_controller;
pub mod autotest_doctor;
pub mod backlog_delivery_plane;
pub mod backlog_executor_evidence_anchor;
pub mod backlog_github_sync;
pub mod backlog_queue_executor;
pub mod backlog_registry;
pub mod backlog_runtime_anchor;
pub mod benchmark_autonomy_gate;
pub mod benchmark_matrix;
pub mod binary_blob_runtime;
pub mod binary_vuln_plane;
pub mod business_plane;
pub mod canyon_plane;
pub mod catalog_store_kernel;
pub mod camel_bridge;
pub mod child_organ_runtime;
pub mod collab_plane;
pub mod company_plane;
pub mod continuity_runtime;
pub mod contract_check;
pub mod contract_lane_utils;
pub mod conversation_eye_synthesizer_kernel;
pub mod daemon_control;
pub mod directive_kernel;
pub mod dopamine_ambient;
pub mod duality_seed;
pub mod dynamic_burn_budget_oracle;
pub mod dynamic_burn_budget_signal_kernel;
pub mod egress_gateway_kernel;
pub mod enterprise_hardening;
pub mod eval_plane;
pub mod execution_yield_recovery;
pub mod f100_readiness_program;
pub mod f100_reliability_certification;
pub mod finance_plane;
pub mod flow_plane;
pub mod fluxlattice_program;
pub mod focus_trigger_store_kernel;
pub mod foundation_contract_gate;
pub mod google_adk_bridge;
pub mod government_plane;
pub mod graph_toolkit;
pub mod habit_store_kernel;
pub mod hardware_route_hardening;
pub mod haystack_bridge;
pub mod health_status;
pub mod healthcare_plane;
pub mod hermes_plane;
pub mod identity_federation;
pub mod importance;
pub mod integrity_hash_utility_kernel;
pub mod intelligence_nexus;
pub mod inversion_controller;
pub mod legacy_retired_lane;
pub mod langchain_bridge;
pub mod llamaindex_bridge;
pub mod llm_economy_organ;
pub mod local_runtime_partitioner;
pub mod mastra_bridge;
pub mod mcp_plane;
pub mod mech_suit_mode_kernel;
pub mod memory_ambient;
pub mod memory_plane;
pub mod memory_policy_kernel;
pub mod memory_session_isolation_kernel;
pub mod metakernel;
pub mod model_router;
pub mod mutation_provenance_kernel;
pub mod narrow_agent_parity_harness;
pub mod network_protocol;
pub mod nexus_plane;
pub mod observability_plane;
pub mod offline_runtime_guard;
pub mod offsite_backup;
pub mod ops_domain_conduit_runner_kernel;
pub mod ops_lane_runtime;
pub mod orchestration;
pub mod organ_atrophy_controller;
pub mod organism_layer;
pub mod origin_integrity;
pub mod outcome_fitness_kernel;
pub mod parse_plane;
pub mod passport_iteration_chain_kernel;
pub mod perception_polish;
pub mod persist_plane;
pub mod persona_ambient;
pub mod persona_schema_contract;
pub mod personas_cli;
pub mod policy_runtime_kernel;
pub mod pydantic_ai_bridge;
pub mod proposal_enricher;
pub mod proposal_type_classifier_kernel;
pub mod protheus_control_plane;
pub mod protheusctl;
pub mod queue_sqlite_kernel;
pub mod queued_backlog_kernel;
pub mod quorum_validator_kernel;
pub mod rag_cli;
pub mod readiness_bridge_pack_kernel;
pub mod redaction_classification_kernel;
pub mod reflex_store_kernel;
pub mod request_envelope_kernel;
pub mod research_batch6;
pub mod research_batch7;
pub mod research_batch8;
pub mod research_plane;
pub mod rollout_rings;
pub mod rsi_ignition;
pub mod runtime_path_registry_kernel;
pub mod runtime_system_contracts;
pub mod runtime_systems;
pub mod rust50_migration_program;
pub mod rust_enterprise_productivity_program;
pub mod scale_readiness;
pub mod sdlc_change_control;
pub mod secret_broker_kernel;
pub mod security_integrity_kernel;
pub mod security_plane;
pub mod seed_protocol;
pub mod semantic_kernel_bridge;
pub mod sensory_eyes_intake;
pub mod settlement_program;
pub mod shadow_budget_governance;
pub mod skills_plane;
pub mod snowball_plane;
pub mod spawn_broker;
pub mod spine;
pub mod state_artifact_contract_kernel;
pub mod state_kernel;
pub mod strategy_campaign_scheduler_kernel;
pub mod strategy_mode_governor;
pub mod strategy_resolver;
pub mod strategy_store_kernel;
pub mod substrate_plane;
pub mod success_criteria_compiler_kernel;
pub mod success_criteria_kernel;
pub mod supply_chain_provenance_v2;
pub mod swarm_runtime;
pub mod symbiosis_coherence_kernel;
pub mod system_health_audit_runner_kernel;
pub mod ternary_belief_kernel;
pub mod tool_response_compactor_kernel;
pub mod top1_assurance;
pub mod trainability_matrix_kernel;
pub mod training_conduit_schema_kernel;
pub mod trit_kernel;
pub mod trit_shadow_kernel;
pub mod uid_kernel;
pub mod upgrade_lane_kernel;
pub mod v8_kernel;
pub mod vbrowser_plane;
pub mod venom_containment_layer;
pub mod vertical_plane;
pub mod workflow_controller;
pub mod workflow_executor;

#[cfg(kani)]
mod top1_kani_proofs;

#[cfg(feature = "minimal")]
#[global_allocator]
static LAYER0_MINIMAL_ALLOCATOR: layer0_alloc::Layer0CountingAllocator =
    layer0_alloc::Layer0CountingAllocator;

#[cfg(feature = "mimalloc")]
pub fn configure_low_memory_allocator_env() {
    // Keep allocator tuning deterministic and low-footprint for edge profiles.
    std::env::set_var("MIMALLOC_RESERVE", "0");
    std::env::set_var("MIMALLOC_EAGER_COMMIT", "0");
    std::env::set_var("MIMALLOC_ARENA_EAGER_COMMIT", "0");
    std::env::set_var("MIMALLOC_PURGE_DELAY", "0");
    std::env::set_var("MIMALLOC_ALLOW_LARGE_OS_PAGES", "0");
}

#[cfg(not(feature = "mimalloc"))]
pub fn configure_low_memory_allocator_env() {}

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
    pub engine: String,
    pub runtime_mode: String,
    pub require_full_dist: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdleRssProbe {
    pub samples: usize,
    pub max_mb: f64,
    pub measurement_mode: String,
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

#[cfg(test)]
pub(crate) fn test_env_guard() -> std::sync::MutexGuard<'static, ()> {
    use std::sync::{Mutex, OnceLock};
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
}

pub fn client_state_root(root: &Path) -> PathBuf {
    if let Ok(v) = std::env::var("PROTHEUS_SECURITY_STATE_ROOT") {
        let s = v.trim();
        if !s.is_empty() {
            return PathBuf::from(s);
        }
    }
    if let Ok(v) = std::env::var("PROTHEUS_CLIENT_STATE_ROOT") {
        let s = v.trim();
        if !s.is_empty() {
            return PathBuf::from(s);
        }
    }
    root.join("client").join("local").join("state")
}

pub fn core_state_root(root: &Path) -> PathBuf {
    if let Ok(v) = std::env::var("PROTHEUS_CORE_STATE_ROOT") {
        let s = v.trim();
        if !s.is_empty() {
            return PathBuf::from(s);
        }
    }
    root.join("core").join("local").join("state")
}

fn stable_json_string(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(b) => {
            if *b {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(arr) => format!(
            "[{}]",
            arr.iter()
                .map(stable_json_string)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let mut out = String::from("{");
            for (idx, key) in keys.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()));
                out.push(':');
                out.push_str(&stable_json_string(map.get(key).unwrap_or(&Value::Null)));
            }
            out.push('}');
            out
        }
    }
}

pub fn deterministic_receipt_hash(value: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(stable_json_string(value).as_bytes());
    hex::encode(hasher.finalize())
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
                "client/runtime/lib/conduit_full_lifecycle_probe.js".to_string(),
            ],
            samples: 5,
            max_ms: 500.0,
            warmup_runs: 1,
            engine: "core-lazy".to_string(),
            runtime_mode: "dist".to_string(),
            require_full_dist: false,
        },
        idle_rss_probe: IdleRssProbe {
            samples: 3,
            max_mb: 120.0,
            measurement_mode: "process".to_string(),
            require_modules: Vec::new(),
        },
        install_artifact_probe: InstallArtifactProbe {
            max_mb: 60.0,
            paths: vec!["dist".to_string()],
        },
        state_path: root.join("local/state/ops/runtime_efficiency_floor.json"),
        history_path: root.join("local/state/ops/runtime_efficiency_floor_history.jsonl"),
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
        engine: clean(
            cold_raw
                .get("engine")
                .and_then(Value::as_str)
                .unwrap_or(&base.cold_start_probe.engine),
            40,
        ),
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
        measurement_mode: clean(
            idle_raw
                .get("measurement_mode")
                .and_then(Value::as_str)
                .unwrap_or(&base.idle_rss_probe.measurement_mode),
            40,
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
            command: vec![
                "node".to_string(),
                "-e".to_string(),
                "console.log(\"noop\")".to_string(),
            ],
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
        if first == "node"
            && second.starts_with("client/runtime/systems/")
            && second.ends_with(".js")
        {
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
    let out = Command::new(program)
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("command_spawn_failed:{program}:{e}"))?;
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(format!(
            "command_failed:{program}:exit={}:{}",
            out.status.code().unwrap_or(1),
            clean(&detail, 200)
        ));
    }
    Ok(start.elapsed().as_secs_f64() * 1000.0)
}

fn run_core_lazy_process_cold_start(root: &Path) -> Result<f64, String> {
    let current = std::env::current_exe()
        .map_err(|err| format!("current_exe_resolve_failed:{err}"))?
        .to_path_buf();
    let exe_name = current
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let executable_supports_domains =
        exe_name.starts_with("protheus-ops") || exe_name.starts_with("protheusd");

    if !executable_supports_domains {
        let started = Instant::now();
        let receipt = daemon_control::inprocess_lazy_probe_receipt(root);
        std::hint::black_box(receipt);
        return Ok(started.elapsed().as_secs_f64() * 1000.0);
    }

    let cmd = vec![
        current.to_string_lossy().to_string(),
        "daemon-control".to_string(),
        "start".to_string(),
        "--mode=lazy-minimal".to_string(),
        "--lazy-init=1".to_string(),
    ];
    run_cmd(root, &cmd)
}

fn cold_start_sample_ms(
    root: &Path,
    probe: &ColdStartProbe,
    rewrite: &DistRewrite,
) -> Result<f64, String> {
    match probe.engine.trim().to_ascii_lowercase().as_str() {
        "core-lazy" | "core_lazy" | "rust-lazy" | "rust_lazy" => {
            run_core_lazy_process_cold_start(root)
        }
        _ => run_cmd(root, &rewrite.command),
    }
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

fn find_runtime_binary_rel(root: &Path, name: &str) -> Option<String> {
    let exe_name = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    [
        format!("target/x86_64-unknown-linux-musl/release/{exe_name}"),
        format!("target/release/{exe_name}"),
        format!("target/debug/{exe_name}"),
    ]
    .into_iter()
    .find(|rel| root.join(rel).exists())
}

fn full_install_probe_paths(root: &Path) -> Vec<String> {
    let mut paths = vec!["client/runtime".to_string(), "core/layer0/ops".to_string()];

    #[cfg(not(feature = "no-client-bloat"))]
    {
        paths.push("node_modules".to_string());
    }

    #[cfg(feature = "no-client-bloat")]
    {
        for rel in [
            "core/local/artifacts/install/client-runtime-minimal.tar.zst",
            "core/local/artifacts/install/client-runtime-minimal.tar.gz",
            "core/local/artifacts/install/client-runtime-minimal.zip",
        ] {
            if root.join(rel).exists() {
                paths.push(rel.to_string());
                break;
            }
        }
    }

    #[cfg(not(feature = "no-client-bloat"))]
    {
        if root.join("client/cognition/eyes").exists() {
            paths.push("client/cognition/eyes".to_string());
        }
    }

    if root.join("dist").exists() {
        paths.push("dist".to_string());
    }

    for bin in ["protheusd", "protheus-ops", "conduit_daemon"] {
        if let Some(rel) = find_runtime_binary_rel(root, bin) {
            paths.push(rel);
            if bin == "protheusd" {
                break;
            }
        }
    }

    paths.sort();
    paths.dedup();
    paths
}

fn process_idle_rss_mb() -> f64 {
    let pid = std::process::id().to_string();
    let out = Command::new("ps").args(["-o", "rss=", "-p", &pid]).output();
    if let Ok(output) = out {
        if output.status.success() {
            let text = String::from_utf8_lossy(&output.stdout);
            if let Some(kib) = text
                .split_whitespace()
                .next()
                .and_then(|v| v.parse::<f64>().ok())
            {
                return kib / 1024.0;
            }
        }
    }
    0.0
}

fn node_idle_rss_mb() -> Option<f64> {
    let node_probe = Command::new("sh")
        .args([
            "-lc",
            "node -e 'process.stdout.write(String(process.memoryUsage().rss));'",
        ])
        .output()
        .ok()?;
    if !node_probe.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&node_probe.stdout);
    let bytes = text
        .split_whitespace()
        .next()
        .and_then(|v| v.parse::<f64>().ok())?;
    Some(bytes / (1024.0 * 1024.0))
}

fn system_idle_rss_mb(mode: &str) -> f64 {
    match mode.trim().to_ascii_lowercase().as_str() {
        "node" => node_idle_rss_mb().unwrap_or_else(process_idle_rss_mb),
        _ => process_idle_rss_mb(),
    }
}

pub fn run_runtime_efficiency_floor(root: &Path, parsed: &ParsedArgs) -> Result<RunOutput, String> {
    let policy_path = parsed
        .flags
        .get("policy")
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("client/runtime/config/runtime_efficiency_floor_policy.json"));

    let policy = load_policy(root, &policy_path);
    let strict = to_bool(
        parsed.flags.get("strict").map(String::as_str),
        policy.strict_default,
    );

    let mut rewrite = cmd_with_runtime_mode(
        &policy.cold_start_probe.command,
        &policy.cold_start_probe.runtime_mode,
    );
    maybe_build_dist(
        root,
        &mut rewrite,
        policy.cold_start_probe.require_full_dist,
    );

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
        let _ = cold_start_sample_ms(root, &policy.cold_start_probe, &rewrite);
    }

    let mut samples = Vec::new();
    for _ in 0..policy.cold_start_probe.samples {
        samples.push(cold_start_sample_ms(
            root,
            &policy.cold_start_probe,
            &rewrite,
        )?);
    }

    let p50_ms = percentile(&samples, 0.50).unwrap_or(0.0);
    let p95_ms = percentile(&samples, 0.95).unwrap_or(0.0);

    let mut rss_samples = Vec::new();
    for _ in 0..policy.idle_rss_probe.samples {
        rss_samples.push(system_idle_rss_mb(&policy.idle_rss_probe.measurement_mode));
    }
    let idle_rss_p50_mb = percentile(&rss_samples, 0.50).unwrap_or(0.0);
    let idle_rss_mb = percentile(&rss_samples, 0.95).unwrap_or(0.0);

    let mut install_sizes = BTreeMap::new();
    let mut install_total = 0.0f64;
    for rel in &policy.install_artifact_probe.paths {
        let size = dir_size_mb(root, rel);
        install_total += size;
        install_sizes.insert(rel.clone(), (size * 1000.0).round() / 1000.0);
    }

    let full_install_paths = full_install_probe_paths(root);
    let mut full_install_sizes = BTreeMap::new();
    let mut full_install_total = 0.0f64;
    for rel in &full_install_paths {
        let size = dir_size_mb(root, rel);
        full_install_total += size;
        full_install_sizes.insert(rel.clone(), (size * 1000.0).round() / 1000.0);
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
        "metrics": {
            "cold_start_p50_ms": (p50_ms * 1000.0).round() / 1000.0,
            "cold_start_p95_ms": (p95_ms * 1000.0).round() / 1000.0,
            "idle_rss_p50_mb": (idle_rss_p50_mb * 1000.0).round() / 1000.0,
            "idle_rss_p95_mb": (idle_rss_mb * 1000.0).round() / 1000.0,
            "install_artifact_total_mb": (install_total * 1000.0).round() / 1000.0,
            "full_install_total_mb": (full_install_total * 1000.0).round() / 1000.0
        },
        "cold_start": {
            "samples": policy.cold_start_probe.samples,
            "max_ms": policy.cold_start_probe.max_ms,
            "p50_ms": (p50_ms * 1000.0).round() / 1000.0,
            "p95_ms": (p95_ms * 1000.0).round() / 1000.0,
            "engine": policy.cold_start_probe.engine.clone(),
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
            "p50_mb": (idle_rss_p50_mb * 1000.0).round() / 1000.0,
            "p95_mb": (idle_rss_mb * 1000.0).round() / 1000.0,
            "measurement_mode": policy.idle_rss_probe.measurement_mode.clone(),
            "required_modules": policy.idle_rss_probe.require_modules,
        },
        "install_artifact": {
            "max_mb": policy.install_artifact_probe.max_mb,
            "sum_mb": (install_total * 1000.0).round() / 1000.0,
            "paths": install_sizes
        },
        "full_install": {
            "sum_mb": (full_install_total * 1000.0).round() / 1000.0,
            "paths": full_install_sizes
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
        "metrics": row["metrics"],
        "cold_start": row["cold_start"],
        "idle_rss": row["idle_rss"],
        "install_artifact": row["install_artifact"],
        "full_install": row["full_install"],
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
        .unwrap_or_else(|| root.join("client/runtime/config/runtime_efficiency_floor_policy.json"));

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
        let policy_path = root
            .path()
            .join("client/runtime/config/runtime_efficiency_floor.json");
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
                "state_path": "local/state/ops/runtime_efficiency_floor.json",
                "history_path": "local/state/ops/runtime_efficiency_floor_history.jsonl"
            }))
            .unwrap(),
        )
        .unwrap();

        let parsed = ParsedArgs {
            positional: vec!["run".to_string()],
            flags: HashMap::from([(
                "policy".to_string(),
                policy_path.to_string_lossy().to_string(),
            )]),
        };

        let out1 = run_runtime_efficiency_floor(root.path(), &parsed).unwrap();
        assert_eq!(
            out1.exit_code, 1,
            "strict hold streak should fail closed before target"
        );
    }

    #[test]
    fn runtime_efficiency_core_lazy_records_engine_and_process_mode() {
        let _guard = test_env_guard();
        let root = tempfile::tempdir().unwrap();
        let policy_path = root
            .path()
            .join("client/runtime/config/runtime_efficiency_floor.json");
        fs::create_dir_all(policy_path.parent().unwrap()).unwrap();
        fs::write(
            &policy_path,
            serde_json::to_string_pretty(&json!({
                "strict_default": false,
                "target_hold_days": 1,
                "enforce_hold_streak_strict": false,
                "cold_start_probe": {
                    "engine": "core-lazy",
                    "command": ["node", "client/lib/conduit_full_lifecycle_probe.ts"],
                    "samples": 1,
                    "max_ms": 5000,
                    "warmup_runs": 0,
                    "runtime_mode": "source",
                    "require_full_dist": false
                },
                "idle_rss_probe": {
                    "measurement_mode": "process",
                    "samples": 1,
                    "max_mb": 9999,
                    "require_modules": []
                },
                "install_artifact_probe": {"max_mb": 9999, "paths": ["dist"]},
                "state_path": "local/state/ops/runtime_efficiency_floor.json",
                "history_path": "local/state/ops/runtime_efficiency_floor_history.jsonl"
            }))
            .unwrap(),
        )
        .unwrap();

        let parsed = ParsedArgs {
            positional: vec!["run".to_string()],
            flags: HashMap::from([(
                "policy".to_string(),
                policy_path.to_string_lossy().to_string(),
            )]),
        };

        let out = run_runtime_efficiency_floor(root.path(), &parsed).unwrap();
        assert_eq!(out.exit_code, 0);
        assert_eq!(
            out.json
                .pointer("/cold_start/engine")
                .and_then(Value::as_str)
                .unwrap_or(""),
            "core-lazy"
        );
        assert_eq!(
            out.json
                .pointer("/idle_rss/measurement_mode")
                .and_then(Value::as_str)
                .unwrap_or(""),
            "process"
        );
    }

    #[cfg(feature = "no-client-bloat")]
    #[test]
    fn no_client_bloat_full_install_omits_node_modules() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir_all(root.path().join("node_modules")).unwrap();
        fs::create_dir_all(root.path().join("client/runtime")).unwrap();
        fs::create_dir_all(root.path().join("core/layer0/ops")).unwrap();
        let paths = full_install_probe_paths(root.path());
        assert!(
            !paths.iter().any(|p| p == "node_modules"),
            "no-client-bloat profile should omit node_modules from full install floor"
        );
    }
}
