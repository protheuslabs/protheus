// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)
use crate::{deterministic_receipt_hash, now_iso};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const DEFAULT_STATE_PATH: &str = "local/state/ops/swarm_runtime/latest.json";
const MAX_EVENT_ROWS: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SwarmState {
    version: String,
    updated_at: String,
    byzantine_test_mode: bool,
    #[serde(default)]
    sessions: BTreeMap<String, SessionMetadata>,
    #[serde(default)]
    scheduled_tasks: BTreeMap<String, ScheduledTask>,
    #[serde(default)]
    events: Vec<Value>,
}

impl Default for SwarmState {
    fn default() -> Self {
        Self {
            version: "swarm-runtime/v1".to_string(),
            updated_at: now_iso(),
            byzantine_test_mode: false,
            sessions: BTreeMap::new(),
            scheduled_tasks: BTreeMap::new(),
            events: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionMetadata {
    session_id: String,
    parent_id: Option<String>,
    #[serde(default)]
    children: Vec<String>,
    depth: u8,
    task: String,
    created_at: String,
    status: String,
    reachable: bool,
    byzantine: bool,
    #[serde(default)]
    corruption_type: Option<String>,
    #[serde(default)]
    report: Option<Value>,
    #[serde(default)]
    metrics: Option<SpawnMetrics>,
    #[serde(default)]
    budget_telemetry: Option<BudgetTelemetry>,
    #[serde(default)]
    scaled_task: Option<String>,
    #[serde(default)]
    budget_action_taken: Option<String>,
    #[serde(default)]
    check_ins: Vec<Value>,
    #[serde(default)]
    metrics_timeline: Vec<MetricsSnapshot>,
    #[serde(default)]
    anomalies: Vec<String>,
    #[serde(default)]
    persistent: Option<PersistentRuntime>,
    #[serde(default)]
    background_worker: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnMetrics {
    request_received_ms: u64,
    queue_wait_ms: u64,
    spawn_initiated_ms: u64,
    spawn_completed_ms: u64,
    execution_start_ms: u64,
    execution_end_ms: u64,
    report_back_latency_ms: u64,
}

impl SpawnMetrics {
    fn total_latency_ms(&self) -> u64 {
        self.execution_end_ms
            .saturating_sub(self.request_received_ms)
            .saturating_add(self.report_back_latency_ms)
    }

    fn execution_time_ms(&self) -> u64 {
        self.execution_end_ms
            .saturating_sub(self.execution_start_ms)
    }

    fn queue_overhead_pct(&self) -> f64 {
        let total = self.total_latency_ms();
        if total == 0 {
            0.0
        } else {
            (self.queue_wait_ms as f64 / total as f64) * 100.0
        }
    }

    fn as_json(&self) -> Value {
        json!({
            "request_received_ms": self.request_received_ms,
            "queue_wait_ms": self.queue_wait_ms,
            "spawn_initiated_ms": self.spawn_initiated_ms,
            "spawn_completed_ms": self.spawn_completed_ms,
            "execution_start_ms": self.execution_start_ms,
            "execution_end_ms": self.execution_end_ms,
            "execution_time_ms": self.execution_time_ms(),
            "report_back_latency_ms": self.report_back_latency_ms,
            "total_latency_ms": self.total_latency_ms(),
            "queue_overhead_pct": self.queue_overhead_pct(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum BudgetAction {
    FailHard,
    AllowWithWarning,
    TriggerCompaction,
}

impl BudgetAction {
    fn from_flag(raw: Option<String>) -> Self {
        match raw
            .unwrap_or_else(|| "fail".to_string())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "warn" | "allow" | "allow_with_warning" => Self::AllowWithWarning,
            "compact" | "trigger_compaction" | "trigger-compaction" => Self::TriggerCompaction,
            _ => Self::FailHard,
        }
    }

    fn as_label(&self) -> &'static str {
        match self {
            Self::FailHard => "fail",
            Self::AllowWithWarning => "warn",
            Self::TriggerCompaction => "compact",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ReportMode {
    Always,
    AnomaliesOnly,
    FinalOnly,
}

impl ReportMode {
    fn from_flag(raw: Option<String>) -> Self {
        match raw
            .unwrap_or_else(|| "always".to_string())
            .trim()
            .to_ascii_lowercase()
            .as_str()
        {
            "anomalies" | "anomalies_only" => Self::AnomaliesOnly,
            "final" | "final_only" => Self::FinalOnly,
            _ => Self::Always,
        }
    }

    fn as_label(&self) -> &'static str {
        match self {
            Self::Always => "always",
            Self::AnomaliesOnly => "anomalies_only",
            Self::FinalOnly => "final_only",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TokenBudgetConfig {
    max_tokens: u32,
    warning_threshold: f32,
    exhaustion_action: BudgetAction,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistentAgentConfig {
    lifespan_sec: u64,
    check_in_interval_sec: u64,
    report_mode: ReportMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PersistentRuntime {
    mode: String,
    config: PersistentAgentConfig,
    started_at_ms: u64,
    deadline_ms: u64,
    next_check_in_ms: u64,
    check_in_count: u64,
    #[serde(default)]
    last_check_in_ms: Option<u64>,
    #[serde(default)]
    terminated_at_ms: Option<u64>,
    #[serde(default)]
    terminated_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MetricsSnapshot {
    timestamp_ms: u64,
    cumulative_tokens: u32,
    context_percentage: f64,
    response_latency_ms: u64,
    memory_usage_mb: u64,
    active_tools: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScheduledTask {
    task_id: String,
    task: String,
    interval_sec: u64,
    max_runtime_sec: u64,
    next_run_ms: u64,
    remaining_runs: u64,
    #[serde(default)]
    last_run_ms: Option<u64>,
    #[serde(default)]
    last_session_id: Option<String>,
    active: bool,
}

#[derive(Debug, Clone)]
enum ExecutionMode {
    TaskOriented,
    Persistent(PersistentAgentConfig),
    Background(PersistentAgentConfig),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UsageSnapshot {
    timestamp_ms: u64,
    cumulative_usage: u32,
    tool: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct BudgetTelemetry {
    session_id: String,
    budget_config: TokenBudgetConfig,
    #[serde(default)]
    usage_over_time: Vec<UsageSnapshot>,
    #[serde(default)]
    tool_breakdown: BTreeMap<String, u32>,
    final_usage: u32,
    budget_exhausted: bool,
    warning_emitted: bool,
    warning_at_tokens: u32,
    compaction_triggered: bool,
}

enum BudgetUsageOutcome {
    Ok,
    Warning(Value),
    ExhaustedAllowed { event: Value, action: String },
    ExceededDenied(String),
}

impl BudgetTelemetry {
    fn new(session_id: String, config: TokenBudgetConfig) -> Self {
        let threshold = ((config.max_tokens as f32) * config.warning_threshold)
            .round()
            .clamp(0.0, config.max_tokens as f32) as u32;
        Self {
            session_id,
            budget_config: config,
            usage_over_time: Vec::new(),
            tool_breakdown: BTreeMap::new(),
            final_usage: 0,
            budget_exhausted: false,
            warning_emitted: false,
            warning_at_tokens: threshold,
            compaction_triggered: false,
        }
    }

    fn remaining_tokens(&self) -> u32 {
        self.budget_config
            .max_tokens
            .saturating_sub(self.final_usage)
    }

    fn utilization(&self) -> f64 {
        if self.budget_config.max_tokens == 0 {
            0.0
        } else {
            self.final_usage as f64 / self.budget_config.max_tokens as f64
        }
    }

    fn push_usage(&mut self, tool_name: &str, tokens_used: u32) {
        if tokens_used == 0 {
            return;
        }
        self.final_usage = self.final_usage.saturating_add(tokens_used);
        *self
            .tool_breakdown
            .entry(tool_name.to_string())
            .or_insert(0) += tokens_used;
        self.usage_over_time.push(UsageSnapshot {
            timestamp_ms: now_epoch_ms(),
            cumulative_usage: self.final_usage,
            tool: tool_name.to_string(),
        });
    }

    fn record_tool_usage(&mut self, tool_name: &str, requested_tokens: u32) -> BudgetUsageOutcome {
        let current = self.final_usage;
        let projected = current.saturating_add(requested_tokens);
        let max_tokens = self.budget_config.max_tokens;

        if projected > max_tokens {
            let remaining = max_tokens.saturating_sub(current);
            self.budget_exhausted = true;
            return match self.budget_config.exhaustion_action {
                BudgetAction::FailHard => BudgetUsageOutcome::ExceededDenied(format!(
                    "token_budget_exceeded:current={current}:requested={requested_tokens}:limit={max_tokens}:tool={tool_name}"
                )),
                BudgetAction::AllowWithWarning => {
                    self.push_usage(tool_name, remaining);
                    BudgetUsageOutcome::ExhaustedAllowed {
                        event: json!({
                            "type": "budget_exhausted",
                            "action": "allow_with_warning",
                            "tool": tool_name,
                            "current": current,
                            "requested": requested_tokens,
                            "applied": remaining,
                            "limit": max_tokens,
                            "remaining": self.remaining_tokens(),
                        }),
                        action: "warn".to_string(),
                    }
                }
                BudgetAction::TriggerCompaction => {
                    self.compaction_triggered = true;
                    let compacted_request = ((requested_tokens as f32) * 0.4).ceil() as u32;
                    let applied = compacted_request.min(remaining);
                    self.push_usage(tool_name, applied);
                    BudgetUsageOutcome::ExhaustedAllowed {
                        event: json!({
                            "type": "budget_exhausted",
                            "action": "trigger_compaction",
                            "tool": tool_name,
                            "current": current,
                            "requested": requested_tokens,
                            "compacted_request": compacted_request,
                            "applied": applied,
                            "limit": max_tokens,
                            "remaining": self.remaining_tokens(),
                        }),
                        action: "compact".to_string(),
                    }
                }
            };
        }

        self.push_usage(tool_name, requested_tokens);
        if !self.warning_emitted && self.final_usage >= self.warning_at_tokens {
            self.warning_emitted = true;
            return BudgetUsageOutcome::Warning(json!({
                "type": "budget_warning",
                "session_id": self.session_id,
                "current": self.final_usage,
                "threshold": self.warning_at_tokens,
                "remaining": self.remaining_tokens(),
                "utilization": self.utilization(),
            }));
        }
        BudgetUsageOutcome::Ok
    }

    fn generate_report(&self) -> Value {
        let most_expensive_tool = self
            .tool_breakdown
            .iter()
            .max_by_key(|(_, tokens)| **tokens)
            .map(|(name, _)| name.clone());
        json!({
            "budget": self.budget_config.max_tokens,
            "warning_threshold": self.budget_config.warning_threshold,
            "warning_at_tokens": self.warning_at_tokens,
            "on_budget_exhausted": self.budget_config.exhaustion_action.as_label(),
            "used": self.final_usage,
            "remaining": self.remaining_tokens(),
            "utilization": self.utilization(),
            "budget_exhausted": self.budget_exhausted,
            "warning_emitted": self.warning_emitted,
            "compaction_triggered": self.compaction_triggered,
            "tool_breakdown": self.tool_breakdown,
            "most_expensive_tool": most_expensive_tool,
            "timeline": self.usage_over_time,
        })
    }
}

#[derive(Debug, Clone)]
struct SpawnOptions {
    verify: bool,
    timeout_ms: u64,
    metrics_detailed: bool,
    simulate_unreachable: bool,
    byzantine: bool,
    corruption_type: String,
    token_budget: Option<u32>,
    token_warning_threshold: f32,
    budget_exhaustion_action: BudgetAction,
    adaptive_complexity: bool,
    execution_mode: ExecutionMode,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AgentReport {
    agent_id: String,
    #[serde(default)]
    values: BTreeMap<String, Value>,
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops swarm-runtime status [--state-path=<path>]");
    println!("  protheus-ops swarm-runtime spawn [--task=<text>] [--session-id=<parent>] [--recursive=1|0] [--levels=<n>] [--max-depth=<n>] [--verify=1|0] [--timeout-sec=<seconds>] [--metrics=<none|detailed>] [--byzantine=1|0] [--corruption-type=<id>] [--token-budget=<n>] [--token-warning-at=<0..1>] [--on-budget-exhausted=<fail|warn|compact>] [--adaptive-complexity=1|0] [--execution-mode=<task|persistent|background>] [--lifespan-sec=<n>] [--check-in-interval-sec=<n>] [--report-mode=<always|anomalies|final>] [--state-path=<path>]");
    println!("  protheus-ops swarm-runtime tick [--advance-ms=<n>] [--max-check-ins=<n>] [--state-path=<path>]");
    println!(
        "  protheus-ops swarm-runtime byzantine-test <enable|disable|status> [--state-path=<path>]"
    );
    println!("  protheus-ops swarm-runtime consensus-check [--task-id=<id>] [--threshold=<0..1>] [--fields=<csv>] [--reports-json=<json>] [--state-path=<path>]");
    println!("  protheus-ops swarm-runtime test recursive [--levels=<n>] [--state-path=<path>]");
    println!("  protheus-ops swarm-runtime test byzantine [--agents=<n>] [--corrupt=<n>] [--state-path=<path>]");
    println!("  protheus-ops swarm-runtime test concurrency [--agents=<n>] [--metrics=detailed] [--state-path=<path>]");
    println!("  protheus-ops swarm-runtime test budget [--budget=<n>] [--warning-at=<0..1>] [--on-budget-exhausted=<fail|warn|compact>] [--expect-fail=1|0] [--task=<text>] [--state-path=<path>]");
    println!("  protheus-ops swarm-runtime test persistent [--lifespan-sec=<n>] [--check-in-interval-sec=<n>] [--advance-ms=<n>] [--state-path=<path>]");
    println!("  protheus-ops swarm-runtime budget-report --session-id=<id> [--state-path=<path>]");
    println!("  protheus-ops swarm-runtime sessions budget-report --session-id=<id> [--state-path=<path>]");
    println!("  protheus-ops swarm-runtime sessions wake --session-id=<id> [--state-path=<path>]");
    println!("  protheus-ops swarm-runtime sessions terminate --session-id=<id> [--graceful=1|0] [--state-path=<path>]");
    println!("  protheus-ops swarm-runtime sessions metrics --session-id=<id> [--timeline=1|0] [--state-path=<path>]");
    println!(
        "  protheus-ops swarm-runtime sessions anomalies --session-id=<id> [--state-path=<path>]"
    );
    println!("  protheus-ops swarm-runtime background <start|status|stop> [flags]");
    println!("  protheus-ops swarm-runtime scheduled <add|status|run-due> [flags]");
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let key_pref = format!("--{key}=");
    let key_exact = format!("--{key}");
    let mut idx = 0usize;
    while idx < argv.len() {
        let token = argv[idx].trim();
        if let Some(value) = token.strip_prefix(&key_pref) {
            return Some(value.to_string());
        }
        if token == key_exact && idx + 1 < argv.len() {
            return Some(argv[idx + 1].clone());
        }
        idx += 1;
    }
    None
}

fn parse_bool_flag(argv: &[String], key: &str, fallback: bool) -> bool {
    match parse_flag(argv, key) {
        Some(v) => matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        ),
        None => fallback,
    }
}

fn parse_u8_flag(argv: &[String], key: &str, fallback: u8) -> u8 {
    parse_flag(argv, key)
        .and_then(|v| v.trim().parse::<u8>().ok())
        .unwrap_or(fallback)
}

fn parse_u64_flag(argv: &[String], key: &str, fallback: u64) -> u64 {
    parse_flag(argv, key)
        .and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(fallback)
}

fn parse_f64_flag(argv: &[String], key: &str, fallback: f64) -> f64 {
    parse_flag(argv, key)
        .and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(fallback)
}

fn state_path(root: &Path, argv: &[String]) -> PathBuf {
    parse_flag(argv, "state-path")
        .filter(|v| !v.trim().is_empty())
        .map(|v| {
            let candidate = PathBuf::from(v.trim());
            if candidate.is_absolute() {
                candidate
            } else {
                root.join(candidate)
            }
        })
        .unwrap_or_else(|| root.join(DEFAULT_STATE_PATH))
}

fn ensure_parent(path: &Path) -> Result<(), String> {
    let Some(parent) = path.parent() else {
        return Ok(());
    };
    fs::create_dir_all(parent).map_err(|err| format!("mkdir_failed:{}:{err}", parent.display()))
}

fn load_state(path: &Path) -> Result<SwarmState, String> {
    if !path.exists() {
        return Ok(SwarmState::default());
    }
    let raw = fs::read_to_string(path).map_err(|err| format!("state_read_failed:{err}"))?;
    if raw.trim().is_empty() {
        return Ok(SwarmState::default());
    }
    serde_json::from_str::<SwarmState>(&raw).map_err(|err| format!("state_parse_failed:{err}"))
}

fn save_state(path: &Path, state: &SwarmState) -> Result<(), String> {
    ensure_parent(path)?;
    let encoded =
        serde_json::to_string_pretty(state).map_err(|err| format!("state_encode_failed:{err}"))?;
    fs::write(path, encoded).map_err(|err| format!("state_write_failed:{err}"))
}

fn now_epoch_ms() -> u64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(duration) => u64::try_from(duration.as_millis()).unwrap_or(0),
        Err(_) => 0,
    }
}

fn print_receipt(mut payload: Value) {
    payload["receipt_hash"] = Value::String(deterministic_receipt_hash(&payload));
    println!(
        "{}",
        serde_json::to_string(&payload)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn append_event(state: &mut SwarmState, event: Value) {
    state.events.push(event);
    if state.events.len() > MAX_EVENT_ROWS {
        let excess = state.events.len() - MAX_EVENT_ROWS;
        state.events.drain(0..excess);
    }
}

fn next_session_id(state: &SwarmState, task: &str, depth: u8) -> String {
    let mut salt = 0u64;
    loop {
        let candidate_seed = json!({
            "task": task,
            "depth": depth,
            "salt": salt,
            "ts": now_epoch_ms()
        });
        let digest = deterministic_receipt_hash(&candidate_seed);
        let candidate = format!("swarm-{}", &digest[..12]);
        if !state.sessions.contains_key(&candidate) {
            return candidate;
        }
        salt = salt.saturating_add(1);
    }
}

fn verify_session_reachable(
    state: &SwarmState,
    session_id: &str,
    timeout_ms: u64,
) -> Result<Value, String> {
    let deadline = now_epoch_ms().saturating_add(timeout_ms);
    loop {
        if state
            .sessions
            .get(session_id)
            .map(|session| session.reachable)
            .unwrap_or(false)
        {
            return Ok(json!({
                "status": "verified",
                "session_id": session_id,
                "timeout_ms": timeout_ms
            }));
        }
        if now_epoch_ms() >= deadline {
            return Err(format!("session_unreachable_timeout:{session_id}"));
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn scale_task_complexity(base_task: &str, token_budget: u32) -> String {
    match token_budget {
        0..=200 => format!("{base_task} (ultra-concise, max 50 words)"),
        201..=500 => format!("{base_task} (concise, max 100 words)"),
        501..=1000 => format!("{base_task} (standard detail)"),
        1001..=5000 => format!("{base_task} (comprehensive)"),
        _ => format!("{base_task} (exhaustive analysis)"),
    }
}

fn estimate_tool_plan(task: &str, token_budget: Option<u32>) -> Vec<(String, u32)> {
    let read_tokens = 120u32.saturating_add(((task.len() as u32) / 8).min(100));
    let generate_tokens = match token_budget.unwrap_or(1200) {
        0..=200 => 40,
        201..=500 => 80,
        501..=1000 => 140,
        1001..=5000 => 300,
        _ => 600,
    };
    vec![
        ("read".to_string(), read_tokens),
        ("generate".to_string(), generate_tokens),
    ]
}

fn parse_budget_config(options: &SpawnOptions, session_id: &str) -> Option<BudgetTelemetry> {
    options.token_budget.map(|max_tokens| {
        BudgetTelemetry::new(
            session_id.to_string(),
            TokenBudgetConfig {
                max_tokens,
                warning_threshold: options.token_warning_threshold,
                exhaustion_action: options.budget_exhaustion_action.clone(),
            },
        )
    })
}

fn parse_execution_mode(argv: &[String]) -> ExecutionMode {
    let mode = parse_flag(argv, "execution-mode")
        .unwrap_or_else(|| "task".to_string())
        .trim()
        .to_ascii_lowercase();
    let cfg = PersistentAgentConfig {
        lifespan_sec: parse_u64_flag(argv, "lifespan-sec", 3600).max(1),
        check_in_interval_sec: parse_u64_flag(argv, "check-in-interval-sec", 900).max(1),
        report_mode: ReportMode::from_flag(parse_flag(argv, "report-mode")),
    };
    match mode.as_str() {
        "persistent" => ExecutionMode::Persistent(cfg),
        "background" => ExecutionMode::Background(cfg),
        _ => ExecutionMode::TaskOriented,
    }
}

fn report_mode_should_emit(report_mode: &ReportMode, anomalies: &[String], is_final: bool) -> bool {
    if is_final {
        return true;
    }
    match report_mode {
        ReportMode::Always => true,
        ReportMode::AnomaliesOnly => !anomalies.is_empty(),
        ReportMode::FinalOnly => false,
    }
}

fn collect_metrics_snapshot(
    telemetry: Option<&BudgetTelemetry>,
    check_in_count: u64,
    response_latency_ms: u64,
    active_tools: Vec<String>,
) -> MetricsSnapshot {
    let cumulative_tokens = telemetry.map(|t| t.final_usage).unwrap_or(0);
    let context_percentage = (cumulative_tokens as f64 / 8192.0).min(1.0);
    let memory_usage_mb = 1 + (check_in_count / 8);
    MetricsSnapshot {
        timestamp_ms: now_epoch_ms(),
        cumulative_tokens,
        context_percentage,
        response_latency_ms,
        memory_usage_mb,
        active_tools,
    }
}

fn detect_anomalies(timeline: &[MetricsSnapshot]) -> Vec<String> {
    if timeline.is_empty() {
        return Vec::new();
    }
    let mut out = Vec::new();
    for window in timeline.windows(2) {
        let prev = &window[0];
        let current = &window[1];
        let delta = current
            .cumulative_tokens
            .saturating_sub(prev.cumulative_tokens);
        if delta > 400 {
            out.push("token_spike".to_string());
            break;
        }
    }
    if let (Some(first), Some(last)) = (timeline.first(), timeline.last()) {
        if first.response_latency_ms > 0
            && last.response_latency_ms > first.response_latency_ms.saturating_mul(2)
            && last.response_latency_ms > 10
        {
            out.push("latency_degradation".to_string());
        }
    }
    if timeline
        .last()
        .map(|row| row.context_percentage >= 0.85)
        .unwrap_or(false)
    {
        out.push("context_bloat".to_string());
    }
    out.sort();
    out.dedup();
    out
}

fn build_spawn_options(argv: &[String]) -> SpawnOptions {
    let metrics_detailed = parse_flag(argv, "metrics")
        .map(|value| value.eq_ignore_ascii_case("detailed"))
        .unwrap_or(false);
    let token_budget = parse_flag(argv, "token-budget")
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| *value > 0);
    let token_warning_threshold =
        parse_f64_flag(argv, "token-warning-at", 0.8).clamp(0.0, 1.0) as f32;
    SpawnOptions {
        verify: parse_bool_flag(argv, "verify", false),
        timeout_ms: (parse_f64_flag(argv, "timeout-sec", 30.0).max(0.0) * 1000.0) as u64,
        metrics_detailed,
        simulate_unreachable: parse_bool_flag(argv, "simulate-unreachable", false),
        byzantine: parse_bool_flag(argv, "byzantine", false),
        corruption_type: parse_flag(argv, "corruption-type")
            .unwrap_or_else(|| "data_falsification".to_string()),
        token_budget,
        token_warning_threshold,
        budget_exhaustion_action: BudgetAction::from_flag(parse_flag(argv, "on-budget-exhausted")),
        adaptive_complexity: parse_bool_flag(argv, "adaptive-complexity", false),
        execution_mode: parse_execution_mode(argv),
    }
}

fn persistent_session_ids(state: &SwarmState) -> Vec<String> {
    state
        .sessions
        .iter()
        .filter(|(_, session)| {
            session.persistent.is_some()
                && matches!(
                    session.status.as_str(),
                    "persistent_running" | "background_running"
                )
        })
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>()
}

fn apply_tool_plan_for_session(
    session: &mut SessionMetadata,
    tool_plan: &[(String, u32)],
) -> Result<(u32, Option<String>), String> {
    let mut budget_action_taken: Option<String> = None;
    if let Some(telemetry) = session.budget_telemetry.as_mut() {
        for (tool, requested_tokens) in tool_plan {
            match telemetry.record_tool_usage(tool, *requested_tokens) {
                BudgetUsageOutcome::Ok => {}
                BudgetUsageOutcome::Warning(event) => session.check_ins.push(event),
                BudgetUsageOutcome::ExhaustedAllowed { event, action } => {
                    session.check_ins.push(event);
                    budget_action_taken = Some(action);
                }
                BudgetUsageOutcome::ExceededDenied(reason) => {
                    session.status = "failed".to_string();
                    return Err(reason);
                }
            }
        }
        return Ok((telemetry.final_usage, budget_action_taken));
    }
    let usage = tool_plan.iter().map(|(_, tokens)| *tokens).sum::<u32>();
    Ok((usage, budget_action_taken))
}

fn perform_persistent_check_in(
    session: &mut SessionMetadata,
    reason: &str,
    final_report: bool,
) -> Result<Value, String> {
    let task = session
        .scaled_task
        .clone()
        .unwrap_or_else(|| session.task.clone());
    let token_budget = session
        .budget_telemetry
        .as_ref()
        .map(|telemetry| telemetry.budget_config.max_tokens);
    let plan = estimate_tool_plan(&task, token_budget);
    let active_tools = plan
        .iter()
        .map(|(name, _)| name.clone())
        .collect::<Vec<_>>();
    let response_latency_ms = if session
        .metrics
        .as_ref()
        .map(|metrics| metrics.execution_time_ms())
        .unwrap_or(0)
        == 0
    {
        1
    } else {
        session
            .metrics
            .as_ref()
            .map(|metrics| metrics.execution_time_ms())
            .unwrap_or(1)
    };
    let (token_usage, budget_action) = apply_tool_plan_for_session(session, &plan)?;
    if budget_action.is_some() {
        session.budget_action_taken = budget_action;
    }

    let (check_in_count, report_mode) = {
        let runtime = session
            .persistent
            .as_mut()
            .ok_or_else(|| "persistent_runtime_missing".to_string())?;
        runtime.check_in_count = runtime.check_in_count.saturating_add(1);
        runtime.last_check_in_ms = Some(now_epoch_ms());
        (runtime.check_in_count, runtime.config.report_mode.clone())
    };

    let snapshot = collect_metrics_snapshot(
        session.budget_telemetry.as_ref(),
        check_in_count,
        response_latency_ms,
        active_tools,
    );
    session.metrics_timeline.push(snapshot.clone());
    session.anomalies = detect_anomalies(&session.metrics_timeline);

    let report = json!({
        "type": "persistent_check_in",
        "session_id": session.session_id,
        "reason": reason,
        "timestamp_ms": snapshot.timestamp_ms,
        "check_in_count": check_in_count,
        "token_usage_estimate": token_usage,
        "metrics": snapshot,
        "anomalies": session.anomalies,
        "report_mode": report_mode.as_label(),
        "final_report": final_report,
    });
    session.check_ins.push(report.clone());

    let should_emit = report_mode_should_emit(&report_mode, &session.anomalies, final_report);
    if should_emit {
        session.report = Some(report.clone());
    }

    Ok(json!({
        "emitted": should_emit,
        "report": report,
    }))
}

fn spawn_persistent_session(
    state: &mut SwarmState,
    parent_id: Option<&str>,
    task: &str,
    max_depth: u8,
    options: &SpawnOptions,
    cfg: &PersistentAgentConfig,
    background_worker: bool,
) -> Result<Value, String> {
    let parent_depth = if let Some(parent) = parent_id {
        let parent_session = state
            .sessions
            .get(parent)
            .ok_or_else(|| format!("parent_session_missing:{parent}"))?;
        parent_session.depth
    } else {
        0
    };
    let depth = if parent_id.is_some() {
        parent_depth.saturating_add(1)
    } else {
        0
    };
    if depth >= max_depth {
        return Err(format!("max_depth_exceeded:{depth}>=max_depth:{max_depth}"));
    }

    let session_id = next_session_id(state, task, depth);
    let now_ms = now_epoch_ms();
    let scaled_task = if options.adaptive_complexity {
        options
            .token_budget
            .map(|budget| scale_task_complexity(task, budget))
            .unwrap_or_else(|| task.to_string())
    } else {
        task.to_string()
    };
    let runtime = PersistentRuntime {
        mode: if background_worker {
            "background".to_string()
        } else {
            "persistent".to_string()
        },
        config: cfg.clone(),
        started_at_ms: now_ms,
        deadline_ms: now_ms.saturating_add(cfg.lifespan_sec.saturating_mul(1000)),
        next_check_in_ms: now_ms.saturating_add(cfg.check_in_interval_sec.saturating_mul(1000)),
        check_in_count: 0,
        last_check_in_ms: None,
        terminated_at_ms: None,
        terminated_reason: None,
    };
    let mut metadata = SessionMetadata {
        session_id: session_id.clone(),
        parent_id: parent_id.map(ToString::to_string),
        children: Vec::new(),
        depth,
        task: task.to_string(),
        created_at: now_iso(),
        status: if background_worker {
            "background_running".to_string()
        } else {
            "persistent_running".to_string()
        },
        reachable: true,
        byzantine: false,
        corruption_type: None,
        report: None,
        metrics: Some(SpawnMetrics {
            request_received_ms: now_ms,
            queue_wait_ms: 0,
            spawn_initiated_ms: now_ms,
            spawn_completed_ms: now_ms,
            execution_start_ms: now_ms,
            execution_end_ms: now_ms,
            report_back_latency_ms: 0,
        }),
        budget_telemetry: parse_budget_config(options, &session_id),
        scaled_task: Some(scaled_task),
        budget_action_taken: None,
        check_ins: Vec::new(),
        metrics_timeline: Vec::new(),
        anomalies: Vec::new(),
        persistent: Some(runtime),
        background_worker,
    };

    let initial = perform_persistent_check_in(&mut metadata, "initial", false)?;
    state.sessions.insert(session_id.clone(), metadata);
    if let Some(parent) = parent_id {
        if let Some(parent_session) = state.sessions.get_mut(parent) {
            if !parent_session
                .children
                .iter()
                .any(|child| child == &session_id)
            {
                parent_session.children.push(session_id.clone());
            }
        }
    }

    append_event(
        state,
        json!({
            "type": if background_worker { "swarm_background_spawn" } else { "swarm_persistent_spawn" },
            "session_id": session_id,
            "task": task,
            "lifespan_sec": cfg.lifespan_sec,
            "check_in_interval_sec": cfg.check_in_interval_sec,
            "report_mode": cfg.report_mode.as_label(),
            "timestamp": now_iso(),
        }),
    );

    Ok(json!({
        "session_id": session_id,
        "mode": if background_worker { "background" } else { "persistent" },
        "lifespan_sec": cfg.lifespan_sec,
        "check_in_interval_sec": cfg.check_in_interval_sec,
        "report_mode": cfg.report_mode.as_label(),
        "initial_check_in": initial,
    }))
}

fn spawn_single(
    state: &mut SwarmState,
    parent_id: Option<&str>,
    task: &str,
    max_depth: u8,
    options: &SpawnOptions,
) -> Result<Value, String> {
    let request_received_ms = now_epoch_ms();
    let parent_depth = if let Some(parent) = parent_id {
        let parent_session = state
            .sessions
            .get(parent)
            .ok_or_else(|| format!("parent_session_missing:{parent}"))?;
        parent_session.depth
    } else {
        0
    };

    let depth = if parent_id.is_some() {
        parent_depth.saturating_add(1)
    } else {
        0
    };

    if depth >= max_depth {
        return Err(format!("max_depth_exceeded:{depth}>=max_depth:{max_depth}"));
    }

    if options.byzantine && !state.byzantine_test_mode {
        return Err("byzantine_test_mode_required".to_string());
    }

    let queue_wait_ms = now_epoch_ms().saturating_sub(request_received_ms);
    let spawn_initiated_ms = now_epoch_ms();
    let session_id = next_session_id(state, task, depth);
    let spawn_completed_ms = now_epoch_ms();

    let scaled_task = if options.adaptive_complexity {
        options
            .token_budget
            .map(|budget| scale_task_complexity(task, budget))
            .unwrap_or_else(|| task.to_string())
    } else {
        task.to_string()
    };
    let tool_plan = estimate_tool_plan(&scaled_task, options.token_budget);
    let mut budget_telemetry = parse_budget_config(options, &session_id);
    let mut budget_events = Vec::new();
    let mut budget_action_taken: Option<String> = None;

    if let Some(telemetry) = budget_telemetry.as_mut() {
        for (tool, requested_tokens) in &tool_plan {
            match telemetry.record_tool_usage(tool, *requested_tokens) {
                BudgetUsageOutcome::Ok => {}
                BudgetUsageOutcome::Warning(event) => budget_events.push(event),
                BudgetUsageOutcome::ExhaustedAllowed { event, action } => {
                    budget_events.push(event);
                    budget_action_taken = Some(action);
                }
                BudgetUsageOutcome::ExceededDenied(reason) => {
                    budget_action_taken = Some("fail".to_string());
                    let failed_metadata = SessionMetadata {
                        session_id: session_id.clone(),
                        parent_id: parent_id.map(ToString::to_string),
                        children: Vec::new(),
                        depth,
                        task: task.to_string(),
                        created_at: now_iso(),
                        status: "failed".to_string(),
                        reachable: false,
                        byzantine: options.byzantine,
                        corruption_type: if options.byzantine {
                            Some(options.corruption_type.clone())
                        } else {
                            None
                        },
                        report: Some(json!({
                            "task": scaled_task,
                            "original_task": task,
                            "session_id": session_id,
                            "depth": depth,
                            "result": "failed",
                            "reason_code": "token_budget_exceeded"
                        })),
                        metrics: None,
                        budget_telemetry: Some(telemetry.clone()),
                        scaled_task: Some(scaled_task.clone()),
                        budget_action_taken: budget_action_taken.clone(),
                        check_ins: Vec::new(),
                        metrics_timeline: Vec::new(),
                        anomalies: Vec::new(),
                        persistent: None,
                        background_worker: false,
                    };
                    state.sessions.insert(session_id.clone(), failed_metadata);
                    append_event(
                        state,
                        json!({
                            "type": "swarm_spawn_failed",
                            "reason_code": "token_budget_exceeded",
                            "session_id": session_id,
                            "task": task,
                            "scaled_task": scaled_task,
                            "depth": depth,
                            "timestamp": now_iso(),
                        }),
                    );
                    return Err(reason);
                }
            }
        }
    }

    let execution_start_ms = now_epoch_ms();
    if options.metrics_detailed {
        thread::sleep(Duration::from_millis(1));
    }
    let execution_end_ms = now_epoch_ms();
    let token_usage_estimate = budget_telemetry
        .as_ref()
        .map(|telemetry| telemetry.final_usage)
        .unwrap_or_else(|| tool_plan.iter().map(|(_, tokens)| *tokens).sum::<u32>());

    let mut report = json!({
        "task": scaled_task,
        "original_task": task,
        "session_id": session_id,
        "depth": depth,
        "result": "ok",
        "token_usage_estimate": token_usage_estimate,
        "token_budget": options.token_budget,
    });
    if options.byzantine {
        report = corrupted_report(options.corruption_type.as_str(), &session_id);
    }

    let metrics = SpawnMetrics {
        request_received_ms,
        queue_wait_ms,
        spawn_initiated_ms,
        spawn_completed_ms,
        execution_start_ms,
        execution_end_ms,
        report_back_latency_ms: now_epoch_ms().saturating_sub(execution_end_ms),
    };

    let metadata = SessionMetadata {
        session_id: session_id.clone(),
        parent_id: parent_id.map(ToString::to_string),
        children: Vec::new(),
        depth,
        task: task.to_string(),
        created_at: now_iso(),
        status: "running".to_string(),
        reachable: !options.simulate_unreachable,
        byzantine: options.byzantine,
        corruption_type: if options.byzantine {
            Some(options.corruption_type.clone())
        } else {
            None
        },
        report: Some(report.clone()),
        metrics: Some(metrics.clone()),
        budget_telemetry: budget_telemetry.clone(),
        scaled_task: Some(scaled_task.clone()),
        budget_action_taken: budget_action_taken.clone(),
        check_ins: Vec::new(),
        metrics_timeline: Vec::new(),
        anomalies: Vec::new(),
        persistent: None,
        background_worker: false,
    };

    state.sessions.insert(session_id.clone(), metadata);

    if let Some(parent) = parent_id {
        if let Some(parent_session) = state.sessions.get_mut(parent) {
            if !parent_session
                .children
                .iter()
                .any(|child| child == &session_id)
            {
                parent_session.children.push(session_id.clone());
            }
        }
    }

    let verification = if options.verify {
        match verify_session_reachable(state, &session_id, options.timeout_ms) {
            Ok(result) => result,
            Err(err) => {
                if let Some(session) = state.sessions.get_mut(&session_id) {
                    session.status = "failed".to_string();
                }
                return Err(err);
            }
        }
    } else {
        json!({"status": "skipped"})
    };

    append_event(
        state,
        json!({
            "type": "swarm_spawn",
            "session_id": session_id,
            "parent_id": parent_id,
            "depth": depth,
            "task": task,
            "scaled_task": scaled_task,
            "verified": options.verify,
            "byzantine": options.byzantine,
            "token_budget": options.token_budget,
            "token_usage_estimate": token_usage_estimate,
            "budget_action_taken": budget_action_taken,
            "budget_events": budget_events,
            "timestamp": now_iso()
        }),
    );

    Ok(json!({
        "session_id": session_id,
        "parent_id": parent_id,
        "depth": depth,
        "verification": verification,
        "report": report,
        "metrics": metrics.as_json(),
        "budget_report": budget_telemetry.map(|telemetry| telemetry.generate_report()),
    }))
}

fn recursive_spawn_with_tracking(
    state: &mut SwarmState,
    parent_id: Option<&str>,
    task: &str,
    levels: u8,
    max_depth: u8,
    options: &SpawnOptions,
) -> Result<Value, String> {
    if levels == 0 {
        return Err("recursive_levels_must_be_positive".to_string());
    }

    let mut lineage = Vec::new();
    let mut current_parent = parent_id.map(ToString::to_string);
    let mut level = 0u8;
    while level < levels {
        let spawned = spawn_single(state, current_parent.as_deref(), task, max_depth, options)?;
        let child = spawned
            .get("session_id")
            .and_then(Value::as_str)
            .ok_or_else(|| "spawn_missing_session_id".to_string())?
            .to_string();
        lineage.push(spawned);
        current_parent = Some(child);
        level = level.saturating_add(1);
    }

    Ok(json!({
        "recursive": true,
        "levels": levels,
        "lineage": lineage,
        "final_session_id": current_parent,
        "max_depth": max_depth
    }))
}

fn corrupted_report(corruption_type: &str, session_id: &str) -> Value {
    match corruption_type {
        "wrong_file" => json!({
            "session_id": session_id,
            "file": "FAKE.md",
            "file_size": 9999,
            "word_count": 5000,
            "first_line": "FAKE DATA HERE",
            "corrupted": true,
        }),
        _ => json!({
            "session_id": session_id,
            "file": "SOUL.md",
            "file_size": 9999,
            "word_count": 5000,
            "first_line": "FAKE DATA HERE",
            "corrupted": true,
        }),
    }
}

fn parse_reports(raw: &Value) -> Vec<AgentReport> {
    raw.as_array()
        .map(|rows| {
            rows.iter()
                .filter_map(|row| {
                    let agent_id = row
                        .get("agent_id")
                        .or_else(|| row.get("agent"))
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .map(ToString::to_string)?;

                    let mut values = BTreeMap::new();
                    if let Some(object) = row.get("values").and_then(Value::as_object) {
                        for (key, value) in object {
                            values.insert(key.to_string(), value.clone());
                        }
                    }
                    Some(AgentReport { agent_id, values })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn reports_from_state(state: &SwarmState, task_id: Option<&str>) -> Vec<AgentReport> {
    let mut reports = Vec::new();
    for session in state.sessions.values() {
        if let Some(filter) = task_id {
            if session.task != filter {
                continue;
            }
        }

        let Some(report_value) = session.report.as_ref() else {
            continue;
        };

        let mut values = BTreeMap::new();
        if let Some(object) = report_value.as_object() {
            for (key, value) in object {
                values.insert(key.to_string(), value.clone());
            }
        }

        reports.push(AgentReport {
            agent_id: session.session_id.clone(),
            values,
        });
    }
    reports
}

fn normalize_fields(fields_csv: Option<String>, reports: &[AgentReport]) -> Vec<String> {
    if let Some(raw) = fields_csv {
        let mut parsed = raw
            .split(',')
            .map(|field| field.trim())
            .filter(|field| !field.is_empty())
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        parsed.sort();
        parsed.dedup();
        if !parsed.is_empty() {
            return parsed;
        }
    }

    let mut keys = reports
        .iter()
        .flat_map(|report| report.values.keys().cloned())
        .collect::<Vec<_>>();
    keys.sort();
    keys.dedup();
    keys
}

fn evaluate_consensus(reports: &[AgentReport], fields: &[String], threshold: f64) -> Value {
    if reports.is_empty() {
        return json!({
            "consensus_reached": false,
            "reason_code": "no_reports",
            "confidence": 0.0,
            "outliers": []
        });
    }

    let mut groups: BTreeMap<String, Vec<(String, Map<String, Value>)>> = BTreeMap::new();
    for report in reports {
        let mut selected = Map::new();
        for field in fields {
            selected.insert(
                field.clone(),
                report.values.get(field).cloned().unwrap_or(Value::Null),
            );
        }
        let fingerprint = deterministic_receipt_hash(&Value::Object(selected.clone()));
        groups
            .entry(fingerprint)
            .or_default()
            .push((report.agent_id.clone(), selected));
    }

    let Some((leader_fp, leader_group)) = groups.iter().max_by_key(|(_, rows)| rows.len()) else {
        return json!({
            "consensus_reached": false,
            "reason_code": "grouping_failed",
            "confidence": 0.0,
            "outliers": []
        });
    };

    let confidence = leader_group.len() as f64 / reports.len() as f64;
    let mut outliers = Vec::new();
    for (fingerprint, rows) in &groups {
        if fingerprint == leader_fp {
            continue;
        }
        for (agent_id, selected) in rows {
            outliers.push(json!({
                "agent": agent_id,
                "values": selected,
                "deviation": "outlier_group"
            }));
        }
    }

    let agreed_value = leader_group
        .first()
        .map(|(_, selected)| Value::Object(selected.clone()))
        .unwrap_or(Value::Object(Map::new()));

    json!({
        "consensus_reached": confidence >= threshold,
        "confidence": confidence,
        "threshold": threshold,
        "sample_size": reports.len(),
        "agreement_count": leader_group.len(),
        "agreed_value": agreed_value,
        "outliers": outliers,
        "fields": fields,
    })
}

fn run_test_recursive(state: &mut SwarmState, argv: &[String]) -> Result<Value, String> {
    let levels = parse_u8_flag(argv, "levels", 5);
    let options = SpawnOptions {
        verify: true,
        timeout_ms: parse_u64_flag(argv, "timeout-ms", 1_000),
        metrics_detailed: true,
        simulate_unreachable: false,
        byzantine: false,
        corruption_type: "data_falsification".to_string(),
        token_budget: None,
        token_warning_threshold: 0.8,
        budget_exhaustion_action: BudgetAction::FailHard,
        adaptive_complexity: false,
        execution_mode: ExecutionMode::TaskOriented,
    };

    let result = recursive_spawn_with_tracking(
        state,
        None,
        &format!("recursive-test-{levels}"),
        levels,
        levels.saturating_add(1),
        &options,
    )?;

    Ok(json!({
        "ok": true,
        "test": "recursive",
        "levels_requested": levels,
        "levels_completed": result
            .get("lineage")
            .and_then(Value::as_array)
            .map(|rows| rows.len())
            .unwrap_or(0),
        "result": result
    }))
}

fn run_test_byzantine(state: &mut SwarmState, argv: &[String]) -> Result<Value, String> {
    let agent_count = parse_u64_flag(argv, "agents", 5).max(1);
    let corrupt_count = parse_u64_flag(argv, "corrupt", 2).min(agent_count);
    let threshold = parse_f64_flag(argv, "threshold", 0.6);

    state.byzantine_test_mode = true;
    let mut reports = Vec::new();
    for idx in 0..agent_count {
        let is_corrupt = idx < corrupt_count;
        let values = if is_corrupt {
            let mut map = BTreeMap::new();
            map.insert("file".to_string(), Value::String("SOUL.md".to_string()));
            map.insert("file_size".to_string(), Value::Number(9999u64.into()));
            map.insert("word_count".to_string(), Value::Number(5000u64.into()));
            map.insert(
                "first_line".to_string(),
                Value::String("FAKE DATA HERE".to_string()),
            );
            map
        } else {
            let mut map = BTreeMap::new();
            map.insert("file".to_string(), Value::String("SOUL.md".to_string()));
            map.insert("file_size".to_string(), Value::Number(1847u64.into()));
            map.insert("word_count".to_string(), Value::Number(292u64.into()));
            map.insert(
                "first_line".to_string(),
                Value::String("# SOUL.md".to_string()),
            );
            map
        };
        reports.push(AgentReport {
            agent_id: format!("agent-{:02}", idx + 1),
            values,
        });
    }

    let fields = vec![
        "file".to_string(),
        "file_size".to_string(),
        "word_count".to_string(),
        "first_line".to_string(),
    ];
    let consensus = evaluate_consensus(&reports, &fields, threshold);
    let outliers = consensus
        .get("outliers")
        .and_then(Value::as_array)
        .map(|rows| rows.len())
        .unwrap_or(0);

    Ok(json!({
        "ok": true,
        "test": "byzantine",
        "byzantine_test_mode": state.byzantine_test_mode,
        "agents": agent_count,
        "corrupt_requested": corrupt_count,
        "corrupt_detected": outliers,
        "consensus": consensus,
        "truth_constraints_disabled_for_testing": true
    }))
}

fn run_test_concurrency(state: &mut SwarmState, argv: &[String]) -> Result<Value, String> {
    let agents = parse_u64_flag(argv, "agents", 25).max(1);
    let metrics_detailed = parse_flag(argv, "metrics")
        .map(|value| value.eq_ignore_ascii_case("detailed"))
        .unwrap_or(true);

    let options = SpawnOptions {
        verify: true,
        timeout_ms: 1_000,
        metrics_detailed,
        simulate_unreachable: false,
        byzantine: false,
        corruption_type: "data_falsification".to_string(),
        token_budget: None,
        token_warning_threshold: 0.8,
        budget_exhaustion_action: BudgetAction::FailHard,
        adaptive_complexity: false,
        execution_mode: ExecutionMode::TaskOriented,
    };

    let mut queue_wait_total = 0u64;
    let mut execution_total = 0u64;
    let mut report_total = 0u64;
    let mut total_latency = 0u64;

    for idx in 0..agents {
        let task = format!("concurrency-test-{idx}");
        let spawned = spawn_single(state, None, &task, 64, &options)?;
        if let Some(metrics) = spawned.get("metrics") {
            queue_wait_total = queue_wait_total.saturating_add(
                metrics
                    .get("queue_wait_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            );
            execution_total = execution_total.saturating_add(
                metrics
                    .get("execution_time_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            );
            report_total = report_total.saturating_add(
                metrics
                    .get("report_back_latency_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            );
            total_latency = total_latency.saturating_add(
                metrics
                    .get("total_latency_ms")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
            );
        }
    }

    let denom = agents as f64;
    Ok(json!({
        "ok": true,
        "test": "concurrency",
        "agents": agents,
        "metrics": {
            "queue_wait_avg_ms": queue_wait_total as f64 / denom,
            "execution_avg_ms": execution_total as f64 / denom,
            "report_back_avg_ms": report_total as f64 / denom,
            "total_latency_avg_ms": total_latency as f64 / denom,
            "breakdown_available": true,
        }
    }))
}

fn run_test_budget(state: &mut SwarmState, argv: &[String]) -> Result<Value, String> {
    let budget = parse_u64_flag(argv, "budget", 1_000).max(1) as u32;
    let warning_at = parse_f64_flag(argv, "warning-at", 0.8).clamp(0.0, 1.0) as f32;
    let expect_fail = parse_bool_flag(argv, "expect-fail", false);
    let exhaustion_action = BudgetAction::from_flag(parse_flag(argv, "on-budget-exhausted"));
    let task = parse_flag(argv, "task").unwrap_or_else(|| {
        "Write a 10-page essay on quantum physics with detailed references".to_string()
    });

    let options = SpawnOptions {
        verify: true,
        timeout_ms: 1_000,
        metrics_detailed: true,
        simulate_unreachable: false,
        byzantine: false,
        corruption_type: "data_falsification".to_string(),
        token_budget: Some(budget),
        token_warning_threshold: warning_at,
        budget_exhaustion_action: exhaustion_action.clone(),
        adaptive_complexity: parse_bool_flag(argv, "adaptive-complexity", true),
        execution_mode: ExecutionMode::TaskOriented,
    };

    let result = spawn_single(state, None, &task, 8, &options);
    if expect_fail {
        return match result {
            Ok(_) => Err("expected_budget_failure_but_spawn_succeeded".to_string()),
            Err(reason) if reason.contains("token_budget_exceeded") => Ok(json!({
                "ok": true,
                "test": "budget",
                "expect_fail": true,
                "expectation_met": true,
                "reason": reason,
                "budget": budget,
                "warning_at": warning_at,
                "on_budget_exhausted": exhaustion_action.as_label(),
            })),
            Err(reason) => Err(format!("unexpected_failure_reason:{reason}")),
        };
    }

    match result {
        Ok(payload) => Ok(json!({
            "ok": true,
            "test": "budget",
            "expect_fail": false,
            "expectation_met": true,
            "budget": budget,
            "warning_at": warning_at,
            "on_budget_exhausted": exhaustion_action.as_label(),
            "payload": payload,
        })),
        Err(reason) => Err(format!("unexpected_budget_failure:{reason}")),
    }
}

fn budget_report_for_session(state: &SwarmState, session_id: &str) -> Result<Value, String> {
    let Some(session) = state.sessions.get(session_id) else {
        return Err(format!("unknown_session:{session_id}"));
    };
    let Some(telemetry) = session.budget_telemetry.as_ref() else {
        return Err(format!("budget_not_configured_for_session:{session_id}"));
    };
    Ok(json!({
        "ok": true,
        "type": "swarm_runtime_budget_report",
        "session_id": session_id,
        "report": telemetry.generate_report(),
    }))
}

fn tick_persistent_sessions(
    state: &mut SwarmState,
    now_ms: u64,
    max_check_ins: u64,
) -> Result<Value, String> {
    let mut processed_sessions = 0u64;
    let mut check_ins = 0u64;
    let mut finalized_sessions = Vec::new();
    let mut reports = Vec::new();

    for session_id in persistent_session_ids(state) {
        let mut local_processed = 0u64;
        loop {
            if local_processed >= max_check_ins {
                break;
            }
            let mut should_finalize = false;
            let should_check_in = match state
                .sessions
                .get(&session_id)
                .and_then(|session| session.persistent.as_ref())
            {
                Some(runtime) => {
                    if now_ms >= runtime.deadline_ms {
                        should_finalize = true;
                        true
                    } else {
                        now_ms >= runtime.next_check_in_ms
                    }
                }
                None => false,
            };
            if !should_check_in {
                break;
            }

            let Some(session) = state.sessions.get_mut(&session_id) else {
                break;
            };
            let report = if should_finalize {
                let result = perform_persistent_check_in(session, "lifespan_expired", true)?;
                session.status = "completed".to_string();
                if let Some(runtime) = session.persistent.as_mut() {
                    runtime.terminated_at_ms = Some(now_ms);
                    runtime.terminated_reason = Some("lifespan_expired".to_string());
                }
                finalized_sessions.push(session_id.clone());
                result
            } else {
                let result = perform_persistent_check_in(session, "interval", false)?;
                if let Some(runtime) = session.persistent.as_mut() {
                    runtime.next_check_in_ms = now_ms
                        .saturating_add(runtime.config.check_in_interval_sec.saturating_mul(1000));
                }
                result
            };

            reports.push(json!({
                "session_id": session_id,
                "result": report,
            }));
            local_processed = local_processed.saturating_add(1);
            check_ins = check_ins.saturating_add(1);
            if should_finalize {
                break;
            }
        }
        if local_processed > 0 {
            processed_sessions = processed_sessions.saturating_add(1);
        }
    }

    Ok(json!({
        "ok": true,
        "type": "swarm_runtime_tick",
        "processed_sessions": processed_sessions,
        "check_ins": check_ins,
        "finalized_sessions": finalized_sessions,
        "reports": reports,
    }))
}

fn sessions_wake(state: &mut SwarmState, session_id: &str, now_ms: u64) -> Result<Value, String> {
    let Some(session) = state.sessions.get_mut(session_id) else {
        return Err(format!("unknown_session:{session_id}"));
    };
    if session.persistent.is_none() {
        return Err(format!("session_not_persistent:{session_id}"));
    }
    if !matches!(
        session.status.as_str(),
        "persistent_running" | "background_running"
    ) {
        return Err(format!("session_not_active:{session_id}"));
    }
    let report = perform_persistent_check_in(session, "manual_wake", false)?;
    if let Some(runtime) = session.persistent.as_mut() {
        runtime.next_check_in_ms =
            now_ms.saturating_add(runtime.config.check_in_interval_sec.saturating_mul(1000));
    }
    Ok(json!({
        "ok": true,
        "type": "swarm_runtime_wake",
        "session_id": session_id,
        "report": report,
    }))
}

fn sessions_terminate(
    state: &mut SwarmState,
    session_id: &str,
    graceful: bool,
    now_ms: u64,
) -> Result<Value, String> {
    let Some(session) = state.sessions.get_mut(session_id) else {
        return Err(format!("unknown_session:{session_id}"));
    };
    if session.persistent.is_none() {
        return Err(format!("session_not_persistent:{session_id}"));
    }

    let final_report = if graceful {
        Some(perform_persistent_check_in(
            session,
            "terminated_graceful",
            true,
        )?)
    } else {
        None
    };
    session.status = if graceful {
        "terminated_graceful".to_string()
    } else {
        "terminated".to_string()
    };
    if let Some(runtime) = session.persistent.as_mut() {
        runtime.terminated_at_ms = Some(now_ms);
        runtime.terminated_reason = Some(if graceful {
            "terminated_graceful".to_string()
        } else {
            "terminated".to_string()
        });
    }

    Ok(json!({
        "ok": true,
        "type": "swarm_runtime_terminate",
        "session_id": session_id,
        "graceful": graceful,
        "final_report": final_report,
    }))
}

fn sessions_metrics(
    state: &SwarmState,
    session_id: &str,
    include_timeline: bool,
) -> Result<Value, String> {
    let Some(session) = state.sessions.get(session_id) else {
        return Err(format!("unknown_session:{session_id}"));
    };
    let started_at_ms = session
        .persistent
        .as_ref()
        .map(|runtime| runtime.started_at_ms)
        .unwrap_or_else(now_epoch_ms);
    let latest = session.metrics_timeline.last().cloned();
    Ok(json!({
        "ok": true,
        "type": "swarm_runtime_metrics",
        "session_id": session_id,
        "started_at_ms": started_at_ms,
        "snapshot_count": session.metrics_timeline.len(),
        "latest": latest,
        "timeline": if include_timeline { Value::Array(session.metrics_timeline.iter().cloned().map(|row| json!(row)).collect::<Vec<_>>()) } else { Value::Null },
    }))
}

fn sessions_anomalies(state: &SwarmState, session_id: &str) -> Result<Value, String> {
    let Some(session) = state.sessions.get(session_id) else {
        return Err(format!("unknown_session:{session_id}"));
    };
    Ok(json!({
        "ok": true,
        "type": "swarm_runtime_anomalies",
        "session_id": session_id,
        "anomalies": session.anomalies,
    }))
}

fn scheduled_add(state: &mut SwarmState, argv: &[String], now_ms: u64) -> Result<Value, String> {
    let task = parse_flag(argv, "task").unwrap_or_else(|| "scheduled-swarm-task".to_string());
    let interval_sec = parse_u64_flag(argv, "interval-sec", 900).max(1);
    let runs = parse_u64_flag(argv, "runs", 4).max(1);
    let max_runtime_sec = parse_u64_flag(argv, "max-runtime-sec", 30).max(1);
    let task_id = format!(
        "scheduled-{}",
        &deterministic_receipt_hash(&json!({
            "task": task,
            "interval_sec": interval_sec,
            "runs": runs,
            "ts": now_ms,
        }))[..12]
    );
    let row = ScheduledTask {
        task_id: task_id.clone(),
        task,
        interval_sec,
        max_runtime_sec,
        next_run_ms: now_ms.saturating_add(interval_sec.saturating_mul(1000)),
        remaining_runs: runs,
        last_run_ms: None,
        last_session_id: None,
        active: true,
    };
    state.scheduled_tasks.insert(task_id.clone(), row.clone());
    Ok(json!({
        "ok": true,
        "type": "swarm_runtime_scheduled_add",
        "task": row,
    }))
}

fn scheduled_status(state: &SwarmState) -> Value {
    let active = state
        .scheduled_tasks
        .values()
        .filter(|row| row.active)
        .count();
    json!({
        "ok": true,
        "type": "swarm_runtime_scheduled_status",
        "total_tasks": state.scheduled_tasks.len(),
        "active_tasks": active,
        "tasks": state.scheduled_tasks.values().cloned().collect::<Vec<_>>(),
    })
}

fn scheduled_run_due(state: &mut SwarmState, now_ms: u64, max_runs: u64) -> Result<Value, String> {
    let mut executed = Vec::new();
    let due_ids = state
        .scheduled_tasks
        .iter()
        .filter(|(_, row)| row.active && row.remaining_runs > 0 && row.next_run_ms <= now_ms)
        .map(|(id, _)| id.clone())
        .collect::<Vec<_>>();
    for task_id in due_ids.into_iter().take(max_runs as usize) {
        let Some(task_row) = state.scheduled_tasks.get(&task_id).cloned() else {
            continue;
        };
        let options = SpawnOptions {
            verify: false,
            timeout_ms: task_row.max_runtime_sec.saturating_mul(1000),
            metrics_detailed: true,
            simulate_unreachable: false,
            byzantine: false,
            corruption_type: "data_falsification".to_string(),
            token_budget: None,
            token_warning_threshold: 0.8,
            budget_exhaustion_action: BudgetAction::FailHard,
            adaptive_complexity: false,
            execution_mode: ExecutionMode::TaskOriented,
        };
        let spawn = spawn_single(state, None, &task_row.task, 64, &options)?;
        let session_id = spawn
            .get("session_id")
            .and_then(Value::as_str)
            .map(ToString::to_string);
        if let Some(task) = state.scheduled_tasks.get_mut(&task_id) {
            task.last_run_ms = Some(now_ms);
            task.last_session_id = session_id.clone();
            task.remaining_runs = task.remaining_runs.saturating_sub(1);
            task.next_run_ms = now_ms.saturating_add(task.interval_sec.saturating_mul(1000));
            if task.remaining_runs == 0 {
                task.active = false;
            }
        }
        executed.push(json!({
            "task_id": task_id,
            "session_id": session_id,
        }));
    }
    Ok(json!({
        "ok": true,
        "type": "swarm_runtime_scheduled_run_due",
        "executed": executed,
    }))
}

fn run_background_command(state: &mut SwarmState, argv: &[String]) -> Result<Value, String> {
    let sub = argv
        .get(1)
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let now_ms = now_epoch_ms();
    match sub.as_str() {
        "start" => {
            let task = parse_flag(argv, "task")
                .unwrap_or_else(|| "Background worker heartbeat".to_string());
            let parent_id = parse_flag(argv, "session-id");
            let options = build_spawn_options(argv);
            let cfg = match &options.execution_mode {
                ExecutionMode::Background(cfg) | ExecutionMode::Persistent(cfg) => cfg.clone(),
                ExecutionMode::TaskOriented => PersistentAgentConfig {
                    lifespan_sec: parse_u64_flag(argv, "lifespan-sec", 3600).max(1),
                    check_in_interval_sec: parse_u64_flag(argv, "check-in-interval-sec", 900)
                        .max(1),
                    report_mode: ReportMode::from_flag(parse_flag(argv, "report-mode")),
                },
            };
            let payload = spawn_persistent_session(
                state,
                parent_id.as_deref(),
                &task,
                parse_u8_flag(argv, "max-depth", 8).max(1),
                &options,
                &cfg,
                true,
            )?;
            Ok(json!({
                "ok": true,
                "type": "swarm_runtime_background_start",
                "payload": payload,
            }))
        }
        "status" => {
            let workers = state
                .sessions
                .values()
                .filter(|session| session.background_worker)
                .map(|session| {
                    let runtime = session.persistent.as_ref();
                    json!({
                        "session_id": session.session_id,
                        "status": session.status,
                        "check_in_count": runtime.map(|r| r.check_in_count).unwrap_or(0),
                        "next_check_in_ms": runtime.and_then(|r| if matches!(session.status.as_str(), "background_running") { Some(r.next_check_in_ms) } else { None }),
                        "remaining_lifespan_ms": runtime.map(|r| r.deadline_ms.saturating_sub(now_ms)).unwrap_or(0),
                    })
                })
                .collect::<Vec<_>>();
            Ok(json!({
                "ok": true,
                "type": "swarm_runtime_background_status",
                "worker_count": workers.len(),
                "workers": workers,
            }))
        }
        "stop" => {
            let graceful = parse_bool_flag(argv, "graceful", true);
            if let Some(session_id) =
                parse_flag(argv, "session-id").filter(|value| !value.trim().is_empty())
            {
                return sessions_terminate(state, &session_id, graceful, now_ms).map(|payload| {
                    json!({
                        "ok": true,
                        "type": "swarm_runtime_background_stop",
                        "stopped": [payload],
                    })
                });
            }
            let to_stop = state
                .sessions
                .iter()
                .filter(|(_, session)| {
                    session.background_worker
                        && matches!(session.status.as_str(), "background_running")
                })
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            let mut stopped = Vec::new();
            for session_id in to_stop {
                let payload = sessions_terminate(state, &session_id, graceful, now_ms)?;
                stopped.push(payload);
            }
            Ok(json!({
                "ok": true,
                "type": "swarm_runtime_background_stop",
                "stopped_count": stopped.len(),
                "stopped": stopped,
            }))
        }
        _ => Err(format!("unknown_background_subcommand:{sub}")),
    }
}

fn run_test_persistent(state: &mut SwarmState, argv: &[String]) -> Result<Value, String> {
    let cfg = PersistentAgentConfig {
        lifespan_sec: parse_u64_flag(argv, "lifespan-sec", 60).max(1),
        check_in_interval_sec: parse_u64_flag(argv, "check-in-interval-sec", 15).max(1),
        report_mode: ReportMode::Always,
    };
    let options = SpawnOptions {
        verify: false,
        timeout_ms: 1_000,
        metrics_detailed: true,
        simulate_unreachable: false,
        byzantine: false,
        corruption_type: "data_falsification".to_string(),
        token_budget: Some(2000),
        token_warning_threshold: 0.8,
        budget_exhaustion_action: BudgetAction::AllowWithWarning,
        adaptive_complexity: true,
        execution_mode: ExecutionMode::Persistent(cfg.clone()),
    };
    let task =
        parse_flag(argv, "task").unwrap_or_else(|| "Persistent health check loop".to_string());
    let spawned = spawn_persistent_session(state, None, &task, 8, &options, &cfg, false)?;
    let advance_ms = parse_u64_flag(
        argv,
        "advance-ms",
        cfg.check_in_interval_sec.saturating_mul(1000),
    );
    let ticked = tick_persistent_sessions(state, now_epoch_ms().saturating_add(advance_ms), 16)?;
    Ok(json!({
        "ok": true,
        "type": "swarm_runtime_test_persistent",
        "spawned": spawned,
        "ticked": ticked,
    }))
}

fn parse_reports_from_flag(reports_flag: Option<String>) -> Vec<AgentReport> {
    reports_flag
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
        .map(|value| parse_reports(&value))
        .unwrap_or_default()
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let cmd = argv
        .first()
        .map(|value| value.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    let state_file = state_path(root, argv);
    let mut state = match load_state(&state_file) {
        Ok(value) => value,
        Err(err) => {
            print_receipt(json!({
                "ok": false,
                "type": "swarm_runtime_error",
                "command": cmd,
                "error": err,
                "state_path": state_file,
            }));
            return 2;
        }
    };

    let result: Result<Value, String> = match cmd.as_str() {
        "status" => Ok(json!({
            "ok": true,
            "type": "swarm_runtime_status",
            "byzantine_test_mode": state.byzantine_test_mode,
            "session_count": state.sessions.len(),
            "event_count": state.events.len(),
            "max_depth": state
                .sessions
                .values()
                .map(|session| session.depth)
                .max()
                .unwrap_or(0),
            "state_path": state_file,
        })),
        "spawn" => {
            let task = parse_flag(argv, "task").unwrap_or_else(|| "swarm-task".to_string());
            let parent_id = parse_flag(argv, "session-id");
            let recursive = parse_bool_flag(argv, "recursive", false);
            let max_depth = parse_u8_flag(argv, "max-depth", 8).max(1);
            let levels = parse_u8_flag(argv, "levels", max_depth).max(1);
            let options = build_spawn_options(argv);
            let mode = options.execution_mode.clone();

            let payload_result = if recursive {
                if !matches!(mode, ExecutionMode::TaskOriented) {
                    Err("recursive_mode_requires_task_execution_mode".to_string())
                } else {
                    recursive_spawn_with_tracking(
                        &mut state,
                        parent_id.as_deref(),
                        &task,
                        levels,
                        max_depth,
                        &options,
                    )
                }
            } else {
                match mode {
                    ExecutionMode::TaskOriented => {
                        spawn_single(&mut state, parent_id.as_deref(), &task, max_depth, &options)
                    }
                    ExecutionMode::Persistent(cfg) => spawn_persistent_session(
                        &mut state,
                        parent_id.as_deref(),
                        &task,
                        max_depth,
                        &options,
                        &cfg,
                        false,
                    ),
                    ExecutionMode::Background(cfg) => spawn_persistent_session(
                        &mut state,
                        parent_id.as_deref(),
                        &task,
                        max_depth,
                        &options,
                        &cfg,
                        true,
                    ),
                }
            };
            payload_result.map(|payload| {
                json!({
                    "ok": true,
                    "type": "swarm_runtime_spawn",
                    "recursive": recursive,
                    "mode": match options.execution_mode {
                        ExecutionMode::TaskOriented => "task",
                        ExecutionMode::Persistent(_) => "persistent",
                        ExecutionMode::Background(_) => "background",
                    },
                    "payload": payload,
                })
            })
        }
        "tick" => {
            let now_ms = now_epoch_ms().saturating_add(parse_u64_flag(argv, "advance-ms", 0));
            let max_check_ins = parse_u64_flag(argv, "max-check-ins", 16).max(1);
            tick_persistent_sessions(&mut state, now_ms, max_check_ins).map(|payload| {
                json!({
                    "ok": true,
                    "type": "swarm_runtime_tick",
                    "payload": payload,
                })
            })
        }
        "byzantine-test" => {
            let action = argv
                .get(1)
                .map(|value| value.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            match action.as_str() {
                "enable" => {
                    state.byzantine_test_mode = true;
                    Ok(json!({
                        "ok": true,
                        "type": "swarm_runtime_byzantine_test",
                        "enabled": true,
                    }))
                }
                "disable" => {
                    state.byzantine_test_mode = false;
                    Ok(json!({
                        "ok": true,
                        "type": "swarm_runtime_byzantine_test",
                        "enabled": false,
                    }))
                }
                _ => Ok(json!({
                    "ok": true,
                    "type": "swarm_runtime_byzantine_test",
                    "enabled": state.byzantine_test_mode,
                })),
            }
        }
        "consensus-check" => {
            let task_id = parse_flag(argv, "task-id");
            let threshold = parse_f64_flag(argv, "threshold", 0.6).clamp(0.0, 1.0);
            let report_flag = parse_flag(argv, "reports-json");
            let mut reports = parse_reports_from_flag(report_flag);
            if reports.is_empty() {
                reports = reports_from_state(&state, task_id.as_deref());
            }
            let fields = normalize_fields(parse_flag(argv, "fields"), &reports);
            let consensus = evaluate_consensus(&reports, &fields, threshold);
            Ok(json!({
                "ok": true,
                "type": "swarm_runtime_consensus",
                "task_id": task_id,
                "consensus": consensus,
                "sample_size": reports.len(),
            }))
        }
        "budget-report" => {
            if let Some(session_id) =
                parse_flag(argv, "session-id").filter(|value| !value.trim().is_empty())
            {
                budget_report_for_session(&state, &session_id)
            } else {
                Err("session_id_required".to_string())
            }
        }
        "background" => run_background_command(&mut state, argv),
        "scheduled" => {
            let sub = argv
                .get(1)
                .map(|value| value.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            match sub.as_str() {
                "add" => scheduled_add(&mut state, argv, now_epoch_ms()),
                "status" => Ok(scheduled_status(&state)),
                "run-due" => {
                    let now_ms =
                        now_epoch_ms().saturating_add(parse_u64_flag(argv, "advance-ms", 0));
                    let max_runs = parse_u64_flag(argv, "max-runs", 8).max(1);
                    scheduled_run_due(&mut state, now_ms, max_runs)
                }
                _ => Err(format!("unknown_scheduled_subcommand:{sub}")),
            }
        }
        "sessions" => {
            let sub = argv
                .get(1)
                .map(|value| value.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "status".to_string());
            match sub.as_str() {
                "budget-report" => {
                    if let Some(session_id) =
                        parse_flag(argv, "session-id").filter(|value| !value.trim().is_empty())
                    {
                        budget_report_for_session(&state, &session_id)
                    } else {
                        Err("session_id_required".to_string())
                    }
                }
                "wake" => {
                    if let Some(session_id) =
                        parse_flag(argv, "session-id").filter(|value| !value.trim().is_empty())
                    {
                        sessions_wake(&mut state, &session_id, now_epoch_ms())
                    } else {
                        Err("session_id_required".to_string())
                    }
                }
                "terminate" => {
                    if let Some(session_id) =
                        parse_flag(argv, "session-id").filter(|value| !value.trim().is_empty())
                    {
                        sessions_terminate(
                            &mut state,
                            &session_id,
                            parse_bool_flag(argv, "graceful", true),
                            now_epoch_ms(),
                        )
                    } else {
                        Err("session_id_required".to_string())
                    }
                }
                "metrics" => {
                    if let Some(session_id) =
                        parse_flag(argv, "session-id").filter(|value| !value.trim().is_empty())
                    {
                        sessions_metrics(
                            &state,
                            &session_id,
                            parse_bool_flag(argv, "timeline", false),
                        )
                    } else {
                        Err("session_id_required".to_string())
                    }
                }
                "anomalies" => {
                    if let Some(session_id) =
                        parse_flag(argv, "session-id").filter(|value| !value.trim().is_empty())
                    {
                        sessions_anomalies(&state, &session_id)
                    } else {
                        Err("session_id_required".to_string())
                    }
                }
                _ => Err(format!("unknown_sessions_subcommand:{sub}")),
            }
        }
        "test" => {
            let suite = argv
                .get(1)
                .map(|value| value.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "recursive".to_string());
            match suite.as_str() {
                "recursive" => run_test_recursive(&mut state, argv),
                "byzantine" => run_test_byzantine(&mut state, argv),
                "concurrency" => run_test_concurrency(&mut state, argv),
                "budget" => run_test_budget(&mut state, argv),
                "persistent" => run_test_persistent(&mut state, argv),
                _ => Err(format!("unknown_test_suite:{suite}")),
            }
        }
        _ => Err(format!("unknown_command:{cmd}")),
    };

    state.updated_at = now_iso();
    let save_result = save_state(&state_file, &state);

    match result {
        Ok(payload) => {
            if let Err(err) = save_result {
                print_receipt(json!({
                    "ok": false,
                    "type": "swarm_runtime_error",
                    "command": cmd,
                    "error": err,
                    "state_path": state_file,
                }));
                return 2;
            }

            append_event(
                &mut state,
                json!({
                    "type": "swarm_runtime_command",
                    "command": cmd,
                    "timestamp": now_iso(),
                    "ok": true,
                }),
            );
            let _ = save_state(&state_file, &state);
            print_receipt(payload);
            0
        }
        Err(err) => {
            print_receipt(json!({
                "ok": false,
                "type": "swarm_runtime_error",
                "command": cmd,
                "error": err,
                "state_path": state_file,
            }));
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spawn_options() -> SpawnOptions {
        SpawnOptions {
            verify: true,
            timeout_ms: 100,
            metrics_detailed: true,
            simulate_unreachable: false,
            byzantine: false,
            corruption_type: "data_falsification".to_string(),
            token_budget: None,
            token_warning_threshold: 0.8,
            budget_exhaustion_action: BudgetAction::FailHard,
            adaptive_complexity: false,
            execution_mode: ExecutionMode::TaskOriented,
        }
    }

    #[test]
    fn recursive_spawn_tracks_parent_and_children() {
        let mut state = SwarmState::default();
        let options = spawn_options();
        let result = recursive_spawn_with_tracking(&mut state, None, "task", 3, 6, &options)
            .expect("recursive spawn should succeed");
        assert_eq!(
            result
                .get("lineage")
                .and_then(Value::as_array)
                .map(|rows| rows.len()),
            Some(3)
        );

        let lineage = result
            .get("lineage")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let first = lineage
            .first()
            .and_then(|row| row.get("session_id"))
            .and_then(Value::as_str)
            .expect("first session id");
        let second = lineage
            .get(1)
            .and_then(|row| row.get("session_id"))
            .and_then(Value::as_str)
            .expect("second session id");
        let first_session = state.sessions.get(first).expect("first session exists");
        assert_eq!(first_session.children, vec![second.to_string()]);
    }

    #[test]
    fn spawn_verify_fails_when_child_is_unreachable() {
        let mut state = SwarmState::default();
        let mut options = spawn_options();
        options.simulate_unreachable = true;
        let err = spawn_single(&mut state, None, "task", 4, &options).expect_err("must fail");
        assert!(
            err.contains("session_unreachable_timeout"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn consensus_detector_marks_outliers() {
        let reports = vec![
            AgentReport {
                agent_id: "a1".to_string(),
                values: BTreeMap::from([
                    ("file_size".to_string(), json!(1847)),
                    ("word_count".to_string(), json!(292)),
                ]),
            },
            AgentReport {
                agent_id: "a2".to_string(),
                values: BTreeMap::from([
                    ("file_size".to_string(), json!(1847)),
                    ("word_count".to_string(), json!(292)),
                ]),
            },
            AgentReport {
                agent_id: "a3".to_string(),
                values: BTreeMap::from([
                    ("file_size".to_string(), json!(9999)),
                    ("word_count".to_string(), json!(5000)),
                ]),
            },
        ];
        let fields = vec!["file_size".to_string(), "word_count".to_string()];
        let result = evaluate_consensus(&reports, &fields, 0.6);
        assert_eq!(
            result.get("consensus_reached").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            result
                .get("outliers")
                .and_then(Value::as_array)
                .map(|rows| rows.len()),
            Some(1)
        );
    }

    #[test]
    fn byzantine_requires_test_mode() {
        let mut state = SwarmState::default();
        let mut options = spawn_options();
        options.byzantine = true;
        let err = spawn_single(&mut state, None, "task", 5, &options)
            .expect_err("byzantine must fail without test mode");
        assert_eq!(err, "byzantine_test_mode_required");

        state.byzantine_test_mode = true;
        let ok = spawn_single(&mut state, None, "task", 5, &options)
            .expect("byzantine should pass in test mode");
        assert_eq!(
            ok.get("report")
                .and_then(|v| v.get("corrupted"))
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn detailed_metrics_emit_breakdown_fields() {
        let mut state = SwarmState::default();
        let options = spawn_options();
        let ok = spawn_single(&mut state, None, "task", 5, &options).expect("spawn ok");
        let metrics = ok.get("metrics").cloned().unwrap_or(Value::Null);
        assert!(metrics.get("queue_wait_ms").is_some());
        assert!(metrics.get("execution_time_ms").is_some());
        assert!(metrics.get("total_latency_ms").is_some());
    }

    #[test]
    fn token_budget_fail_hard_enforced() {
        let mut state = SwarmState::default();
        let mut options = spawn_options();
        options.token_budget = Some(100);
        options.budget_exhaustion_action = BudgetAction::FailHard;
        let err = spawn_single(
            &mut state,
            None,
            "write detailed and exhaustive analysis with examples and references",
            5,
            &options,
        )
        .expect_err("budget should hard fail");
        assert!(
            err.contains("token_budget_exceeded"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn adaptive_task_scaling_applies_for_small_budget() {
        let mut state = SwarmState::default();
        let mut options = spawn_options();
        options.token_budget = Some(200);
        options.adaptive_complexity = true;
        options.budget_exhaustion_action = BudgetAction::AllowWithWarning;

        let ok = spawn_single(&mut state, None, "Analyze file", 5, &options).expect("spawn ok");
        let report_task = ok
            .get("report")
            .and_then(|value| value.get("task"))
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(
            report_task.contains("ultra-concise"),
            "expected scaled task annotation, got: {report_task}"
        );
    }
}
