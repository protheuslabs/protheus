// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use crate::v8_kernel::{
    append_jsonl, build_plane_conduit_enforcement, conduit_bypass_requested, emit_plane_receipt,
    parse_bool, parse_f64, parse_u64, print_json, read_json, scoped_state_root, sha256_hex_str,
    split_csv_clean, write_json, ReceiptJsonExt,
};
use crate::{clean, client_state_root, now_iso, parse_args};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const STATE_ENV: &str = "ADAPTIVE_INTELLIGENCE_STATE_ROOT";
const STATE_SCOPE: &str = "adaptive_intelligence";
const LOCAL_AI_BIN_ENV: &str = "PROTHEUS_LOCAL_AI_BIN";
const COMMAND_PATH: &str = "core://adaptive-intelligence";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AdaptivePolicy {
    schema_id: String,
    schema_version: String,
    seed_model: String,
    logical_model: String,
    creative_model: String,
    tiny_logical_model: String,
    resource_thresholds: ResourceThresholds,
    graduation_threshold_pct: f64,
    min_human_approvers: usize,
    nightly_cadence_hours: u64,
    local_only: bool,
    trainer_adapter: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ResourceThresholds {
    dual_vram_gb: f64,
    dual_ram_gb: f64,
    dual_cpu_cores: u64,
    logical_vram_gb: f64,
    logical_ram_gb: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ModelProfile {
    role: String,
    seed_model: String,
    active_model: String,
    specialization_score_pct: f64,
    graduated: bool,
    last_trained_at: Option<String>,
    last_graduated_at: Option<String>,
    trainer_adapter: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TrainingState {
    cycles_completed: u64,
    last_job_id: Option<String>,
    last_context_digest: Option<String>,
    last_mode: Option<String>,
    nightly_due: bool,
    last_trained_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RuntimeState {
    version: String,
    created_at: String,
    updated_at: String,
    active_mode: String,
    local_only: bool,
    logical: ModelProfile,
    creative: ModelProfile,
    training: TrainingState,
    last_proposal_digest: Option<String>,
    last_connector_digest: Option<String>,
    last_resource_mode: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ResourceSnapshot {
    vram_gb: f64,
    ram_gb: f64,
    cpu_cores: u64,
    mode: String,
    degraded: bool,
}

#[derive(Debug, Clone)]
struct ContextBundle {
    conversation_samples: Vec<String>,
    dream_samples: Vec<String>,
    interaction_digest: String,
    persona: String,
    logical_bias: String,
    creative_bias: String,
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops adaptive-intelligence status");
    println!("  protheus-ops adaptive-intelligence propose --prompt=<text> [--persona=<id>] [--logical-bias=<text>] [--creative-bias=<text>] [--vram-gb=<n>] [--ram-gb=<n>] [--cpu-cores=<n>] [--strict=1|0]");
    println!("  protheus-ops adaptive-intelligence shadow-train [--cycles=<n>] [--persona=<id>] [--strict=1|0]");
    println!("  protheus-ops adaptive-intelligence prioritize [--vram-gb=<n>] [--ram-gb=<n>] [--cpu-cores=<n>] [--strict=1|0]");
    println!("  protheus-ops adaptive-intelligence graduate --model=<logical|creative> --human-only=1 --approvers=<csv> [--strict=1|0]");
}

fn policy_path(root: &Path) -> PathBuf {
    root.join("client/runtime/config/adaptive_intelligence_policy.json")
}

fn runtime_state_path(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE).join("runtime_state.json")
}

fn proposal_history_path(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE).join("proposal_history.jsonl")
}

fn connector_history_path(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE).join("connector_history.jsonl")
}

fn training_history_path(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE).join("training_history.jsonl")
}

fn graduation_history_path(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE).join("graduation_history.jsonl")
}

fn latest_path(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE).join("latest.json")
}

fn conversation_eye_path(root: &Path) -> PathBuf {
    let runtime_local = root.join("client/runtime/local/state/memory/conversation_eye/nodes.jsonl");
    if runtime_local.exists() {
        return runtime_local;
    }
    client_state_root(root).join("memory/conversation_eye/nodes.jsonl")
}

fn dream_log_path(root: &Path) -> PathBuf {
    crate::core_state_root(root)
        .join("ops")
        .join("organism_layer")
        .join("dream_log.jsonl")
}

fn default_policy() -> AdaptivePolicy {
    AdaptivePolicy {
        schema_id: "adaptive_intelligence_policy".to_string(),
        schema_version: "1.0".to_string(),
        seed_model: "ollama/llama3.2:latest".to_string(),
        logical_model: "ollama/llama3.2:latest".to_string(),
        creative_model: "ollama/qwen2.5:latest".to_string(),
        tiny_logical_model: "ollama/tinyllama:latest".to_string(),
        resource_thresholds: ResourceThresholds {
            dual_vram_gb: 12.0,
            dual_ram_gb: 16.0,
            dual_cpu_cores: 8,
            logical_vram_gb: 4.0,
            logical_ram_gb: 8.0,
        },
        graduation_threshold_pct: 85.0,
        min_human_approvers: 2,
        nightly_cadence_hours: 24,
        local_only: true,
        trainer_adapter: "qlora_shadow".to_string(),
    }
}

fn default_state(policy: &AdaptivePolicy) -> RuntimeState {
    let now = now_iso();
    RuntimeState {
        version: "1.0".to_string(),
        created_at: now.clone(),
        updated_at: now.clone(),
        active_mode: "logical_only".to_string(),
        local_only: policy.local_only,
        logical: ModelProfile {
            role: "logical".to_string(),
            seed_model: policy.seed_model.clone(),
            active_model: policy.logical_model.clone(),
            specialization_score_pct: 0.0,
            graduated: false,
            last_trained_at: None,
            last_graduated_at: None,
            trainer_adapter: policy.trainer_adapter.clone(),
        },
        creative: ModelProfile {
            role: "creative".to_string(),
            seed_model: policy.seed_model.clone(),
            active_model: policy.creative_model.clone(),
            specialization_score_pct: 0.0,
            graduated: false,
            last_trained_at: None,
            last_graduated_at: None,
            trainer_adapter: policy.trainer_adapter.clone(),
        },
        training: TrainingState {
            cycles_completed: 0,
            last_job_id: None,
            last_context_digest: None,
            last_mode: None,
            nightly_due: true,
            last_trained_at: None,
        },
        last_proposal_digest: None,
        last_connector_digest: None,
        last_resource_mode: None,
    }
}

fn load_policy(root: &Path) -> AdaptivePolicy {
    let path = policy_path(root);
    if !path.exists() {
        return default_policy();
    }
    let raw = match fs::read_to_string(&path) {
        Ok(raw) => raw,
        Err(_) => return default_policy(),
    };
    serde_json::from_str::<AdaptivePolicy>(&raw).unwrap_or_else(|_| default_policy())
}

fn load_state(root: &Path, policy: &AdaptivePolicy) -> RuntimeState {
    let path = runtime_state_path(root);
    let Some(value) = read_json(&path) else {
        return default_state(policy);
    };
    serde_json::from_value::<RuntimeState>(value).unwrap_or_else(|_| default_state(policy))
}

fn store_state(root: &Path, state: &RuntimeState) -> Result<(), String> {
    let path = runtime_state_path(root);
    let value =
        serde_json::to_value(state).map_err(|err| format!("adaptive_state_encode_failed:{err}"))?;
    write_json(&path, &value)
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .collect()
}

fn extract_text(value: &Value) -> String {
    for key in ["text", "content", "summary", "insight", "message", "note"] {
        if let Some(text) = value.get(key).and_then(Value::as_str) {
            let cleaned = clean(text, 240);
            if !cleaned.is_empty() {
                return cleaned;
            }
        }
    }
    clean(
        serde_json::to_string(value).unwrap_or_else(|_| "{}".to_string()),
        240,
    )
}

fn collect_context_bundle(root: &Path, flags: &HashMap<String, String>) -> ContextBundle {
    let conversation_samples = read_jsonl(&conversation_eye_path(root))
        .into_iter()
        .rev()
        .take(12)
        .map(|row| extract_text(&row))
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();
    let dream_samples = read_jsonl(&dream_log_path(root))
        .into_iter()
        .rev()
        .take(8)
        .map(|row| extract_text(&row))
        .filter(|row| !row.is_empty())
        .collect::<Vec<_>>();
    let persona = clean(
        flags
            .get("persona")
            .cloned()
            .unwrap_or_else(|| "default".to_string()),
        80,
    );
    let logical_bias = clean(
        flags
            .get("logical-bias")
            .cloned()
            .unwrap_or_else(|| "precise planning".to_string()),
        160,
    );
    let creative_bias = clean(
        flags
            .get("creative-bias")
            .cloned()
            .unwrap_or_else(|| "divergent synthesis".to_string()),
        160,
    );
    let digest = sha256_hex_str(&format!(
        "{}|{}|{}|{}|{}",
        persona,
        logical_bias,
        creative_bias,
        conversation_samples.join("|"),
        dream_samples.join("|")
    ));
    ContextBundle {
        conversation_samples,
        dream_samples,
        interaction_digest: digest,
        persona,
        logical_bias,
        creative_bias,
    }
}

fn detect_ram_gb() -> f64 {
    #[cfg(target_os = "macos")]
    {
        if let Ok(output) = Command::new("sysctl").args(["-n", "hw.memsize"]).output() {
            if output.status.success() {
                if let Ok(text) = String::from_utf8(output.stdout) {
                    if let Ok(bytes) = text.trim().parse::<f64>() {
                        return bytes / 1024.0 / 1024.0 / 1024.0;
                    }
                }
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(raw) = fs::read_to_string("/proc/meminfo") {
            for line in raw.lines() {
                if let Some(rest) = line.strip_prefix("MemTotal:") {
                    let kb = rest
                        .split_whitespace()
                        .next()
                        .and_then(|v| v.parse::<f64>().ok())
                        .unwrap_or(0.0);
                    return kb / 1024.0 / 1024.0;
                }
            }
        }
    }
    8.0
}

fn resource_snapshot(flags: &HashMap<String, String>, policy: &AdaptivePolicy) -> ResourceSnapshot {
    let vram_gb = parse_f64(flags.get("vram-gb"), 0.0);
    let ram_gb = parse_f64(flags.get("ram-gb"), detect_ram_gb());
    let cpu_cores = parse_u64(
        flags.get("cpu-cores"),
        std::thread::available_parallelism()
            .map(|v| v.get() as u64)
            .unwrap_or(4),
    );
    let mode = if vram_gb >= policy.resource_thresholds.dual_vram_gb
        && ram_gb >= policy.resource_thresholds.dual_ram_gb
        && cpu_cores >= policy.resource_thresholds.dual_cpu_cores
    {
        "dual".to_string()
    } else if vram_gb >= policy.resource_thresholds.logical_vram_gb
        && ram_gb >= policy.resource_thresholds.logical_ram_gb
    {
        "logical_only".to_string()
    } else {
        "tiny_logical_only".to_string()
    };
    let degraded = mode != "dual";
    ResourceSnapshot {
        vram_gb,
        ram_gb,
        cpu_cores,
        mode,
        degraded,
    }
}

fn command_exists(name: &str) -> bool {
    Command::new("sh")
        .arg("-lc")
        .arg(format!("command -v {} >/dev/null 2>&1", clean(name, 120)))
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn is_local_model(model: &str) -> bool {
    let model = model.trim();
    !model.is_empty() && (model.starts_with("ollama/") || model.starts_with("local/"))
}

fn ollama_model_name(model_id: &str) -> String {
    model_id
        .trim()
        .trim_start_matches("ollama/")
        .trim_start_matches("local/")
        .to_string()
}

fn native_model_output(
    role: &str,
    model: &str,
    prompt: &str,
    context: &ContextBundle,
    resource_mode: &str,
) -> String {
    let mut keywords = BTreeSet::<String>::new();
    for row in context
        .conversation_samples
        .iter()
        .chain(context.dream_samples.iter())
    {
        for token in row
            .split(|ch: char| !ch.is_ascii_alphanumeric())
            .filter(|token| token.len() >= 4)
        {
            if keywords.len() >= 6 {
                break;
            }
            keywords.insert(token.to_ascii_lowercase());
        }
        if keywords.len() >= 6 {
            break;
        }
    }
    let keyword_list = if keywords.is_empty() {
        vec!["operator".to_string(), "context".to_string()]
    } else {
        keywords.into_iter().collect::<Vec<_>>()
    };
    let digest = sha256_hex_str(&format!(
        "{}|{}|{}|{}|{}",
        role, model, prompt, context.interaction_digest, resource_mode
    ));
    if role == "creative" {
        format!(
            "creative-hypothesis:{}\ncreative-angle:{}\ncreative-bridge:{}",
            keyword_list
                .first()
                .cloned()
                .unwrap_or_else(|| "novelty".to_string()),
            keyword_list
                .get(1)
                .cloned()
                .unwrap_or_else(|| "scenario".to_string()),
            &digest[..12]
        )
    } else {
        format!(
            "logical-step:{}\nlogical-check:{}\nlogical-constraint:{}",
            keyword_list
                .first()
                .cloned()
                .unwrap_or_else(|| "plan".to_string()),
            keyword_list
                .get(1)
                .cloned()
                .unwrap_or_else(|| "verify".to_string()),
            &digest[..12]
        )
    }
}

fn run_local_model(
    _policy: &AdaptivePolicy,
    role: &str,
    model: &str,
    prompt: &str,
    context: &ContextBundle,
    resource_mode: &str,
) -> Value {
    let bin = std::env::var(LOCAL_AI_BIN_ENV).unwrap_or_else(|_| "ollama".to_string());
    let provider = if is_local_model(model) && command_exists(&bin) {
        let mut command = Command::new(&bin);
        command.arg("run").arg(ollama_model_name(model)).arg(prompt);
        match command.output() {
            Ok(output) if output.status.success() => {
                let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
                json!({
                    "provider": "ollama",
                    "model": model,
                    "role": role,
                    "output": if stdout.is_empty() {
                        native_model_output(role, model, prompt, context, resource_mode)
                    } else {
                        stdout
                    }
                })
            }
            _ => json!({
                "provider": "native-fallback",
                "model": model,
                "role": role,
                "output": native_model_output(role, model, prompt, context, resource_mode)
            }),
        }
    } else {
        json!({
            "provider": "native-fallback",
            "model": model,
            "role": role,
            "output": native_model_output(role, model, prompt, context, resource_mode)
        })
    };
    provider
}

fn extract_candidates(text: &str, prefix: &str) -> Vec<String> {
    let mut out = text
        .lines()
        .map(|line| clean(line, 160))
        .filter(|line| !line.is_empty())
        .take(4)
        .collect::<Vec<_>>();
    if out.is_empty() {
        out.push(format!("{prefix}:{}", clean(text, 120)));
    }
    out
}

fn connector_synthesis(
    prompt: &str,
    logical: &Value,
    creative: Option<&Value>,
    resources: &ResourceSnapshot,
    context: &ContextBundle,
) -> Value {
    let logical_text = logical
        .get("output")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let logical_candidates = extract_candidates(logical_text, "logical");
    let creative_candidates = creative
        .and_then(|row| row.get("output").and_then(Value::as_str))
        .map(|text| extract_candidates(text, "creative"))
        .unwrap_or_default();
    let proposal_count = logical_candidates.len().min(3).max(1);
    let mut proposals = Vec::<Value>::new();
    for idx in 0..proposal_count {
        let logical_line = logical_candidates
            .get(idx)
            .cloned()
            .or_else(|| logical_candidates.first().cloned())
            .unwrap_or_else(|| "logical-step".to_string());
        let creative_line = creative_candidates
            .get(idx)
            .cloned()
            .or_else(|| creative_candidates.first().cloned())
            .unwrap_or_else(|| "".to_string());
        let confidence = if resources.mode == "dual" {
            0.66 + (idx as f64 * 0.05)
        } else if resources.mode == "logical_only" {
            0.61 + (idx as f64 * 0.04)
        } else {
            0.56 + (idx as f64 * 0.03)
        };
        let action = if creative_line.is_empty() {
            logical_line.clone()
        } else {
            format!("{logical_line} | creative_extension:{creative_line}")
        };
        proposals.push(json!({
            "rank": idx + 1,
            "action": action,
            "confidence": (confidence * 100.0).round() / 100.0,
            "prompt_digest": sha256_hex_str(&format!("{}|{}", prompt, idx)),
            "context_digest": context.interaction_digest
        }));
    }
    let connector_digest = sha256_hex_str(&serde_json::to_string(&proposals).unwrap_or_default());
    json!({
        "referee": "deterministic_connector_v1",
        "proposal_count": proposals.len(),
        "connector_digest": connector_digest,
        "proposals": proposals,
        "raw_sources": {
            "logical": logical,
            "creative": creative.cloned().unwrap_or(Value::Null)
        }
    })
}

fn specialization_gain(
    role: &str,
    context: &ContextBundle,
    resources: &ResourceSnapshot,
    cycle: u64,
) -> f64 {
    let conversation_weight = context.conversation_samples.len() as f64;
    let dream_weight = context.dream_samples.len() as f64;
    let resource_bonus = if resources.mode == "dual" { 1.0 } else { 0.5 };
    let cycle_bonus = (cycle as f64).min(6.0) * 0.35;
    let raw = if role == "creative" {
        (dream_weight * 1.4) + (conversation_weight * 0.45) + resource_bonus + cycle_bonus
    } else {
        (conversation_weight * 1.1) + (dream_weight * 0.35) + resource_bonus + cycle_bonus
    };
    raw.min(9.0)
}

fn emit(root: &Path, payload: Value) -> i32 {
    emit_plane_receipt(
        root,
        STATE_ENV,
        STATE_SCOPE,
        "adaptive_intelligence_error",
        payload,
    )
}

fn status(root: &Path, policy: &AdaptivePolicy, state: &RuntimeState) -> Value {
    let latest = read_json(&latest_path(root));
    json!({
        "ok": true,
        "type": "adaptive_intelligence_status",
        "lane": "core/layer0/ops",
        "policy": policy,
        "state": state,
        "latest_path": latest_path(root).display().to_string(),
        "latest": latest
    })
}

fn conduit(root: &Path, parsed: &crate::ParsedArgs, action: &str, strict: bool) -> Value {
    build_plane_conduit_enforcement(
        root,
        STATE_ENV,
        STATE_SCOPE,
        strict,
        action,
        "adaptive_intelligence_conduit_enforcement",
        COMMAND_PATH,
        conduit_bypass_requested(&parsed.flags),
        "adaptive_intelligence_actions_route_through_layer0_conduit_with_fail_closed_policy",
        &[
            "V7-ADAPTIVE-001.1",
            "V7-ADAPTIVE-001.2",
            "V7-ADAPTIVE-001.3",
            "V7-ADAPTIVE-001.4",
            "V7-ADAPTIVE-001.5",
            "V7-ADAPTIVE-001.6",
        ],
    )
}

fn run_prioritize(
    root: &Path,
    policy: &AdaptivePolicy,
    parsed: &crate::ParsedArgs,
    strict: bool,
) -> Value {
    let conduit = conduit(root, parsed, "prioritize", strict);
    if strict && !conduit.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return json!({
            "ok": false,
            "type": "adaptive_intelligence_prioritize",
            "strict": strict,
            "conduit": conduit,
            "errors": ["conduit_bypass_rejected"]
        });
    }
    let resources = resource_snapshot(&parsed.flags, policy);
    json!({
        "ok": true,
        "type": "adaptive_intelligence_prioritize",
        "strict": strict,
        "resources": resources,
        "claim_evidence": [{
            "id": "V7-ADAPTIVE-001.4",
            "claim": "resource_aware_prioritization_runs_dual_or_logical_first_and_logs_degradation",
            "evidence": {
                "mode": resources.mode,
                "degraded": resources.degraded,
                "vram_gb": resources.vram_gb,
                "ram_gb": resources.ram_gb,
                "cpu_cores": resources.cpu_cores
            }
        }],
        "conduit": conduit
    })
}

fn run_propose(
    root: &Path,
    policy: &AdaptivePolicy,
    parsed: &crate::ParsedArgs,
    strict: bool,
) -> Value {
    let conduit = conduit(root, parsed, "propose", strict);
    if strict && !conduit.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return json!({
            "ok": false,
            "type": "adaptive_intelligence_propose",
            "strict": strict,
            "conduit": conduit,
            "errors": ["conduit_bypass_rejected"]
        });
    }
    let prompt = clean(
        parsed
            .flags
            .get("prompt")
            .cloned()
            .unwrap_or_else(|| "summarize operator intent".to_string()),
        600,
    );
    let context = collect_context_bundle(root, &parsed.flags);
    let resources = resource_snapshot(&parsed.flags, policy);
    let mut errors = Vec::<String>::new();
    if strict && !is_local_model(&policy.logical_model) {
        errors.push("logical_model_must_be_local".to_string());
    }
    if strict && !is_local_model(&policy.creative_model) {
        errors.push("creative_model_must_be_local".to_string());
    }
    let logical_prompt = format!(
        "persona={} bias={} prompt={} context_digest={} conversation_samples={} dream_samples={}",
        context.persona,
        context.logical_bias,
        prompt,
        context.interaction_digest,
        context.conversation_samples.join(" || "),
        context.dream_samples.join(" || ")
    );
    let creative_prompt = format!(
        "persona={} bias={} prompt={} context_digest={} dream_samples={} conversation_samples={}",
        context.persona,
        context.creative_bias,
        prompt,
        context.interaction_digest,
        context.dream_samples.join(" || "),
        context.conversation_samples.join(" || ")
    );
    let logical = run_local_model(
        policy,
        "logical",
        if resources.mode == "tiny_logical_only" {
            &policy.tiny_logical_model
        } else {
            &policy.logical_model
        },
        &logical_prompt,
        &context,
        &resources.mode,
    );
    let creative = if resources.mode == "dual" {
        Some(run_local_model(
            policy,
            "creative",
            &policy.creative_model,
            &creative_prompt,
            &context,
            &resources.mode,
        ))
    } else {
        None
    };
    let connector = connector_synthesis(&prompt, &logical, creative.as_ref(), &resources, &context);
    let connector_digest = connector
        .get("connector_digest")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let proposal = json!({
        "prompt": prompt,
        "mode": resources.mode,
        "resources": resources,
        "context": {
            "persona": context.persona,
            "logical_bias": context.logical_bias,
            "creative_bias": context.creative_bias,
            "conversation_count": context.conversation_samples.len(),
            "dream_count": context.dream_samples.len(),
            "interaction_digest": context.interaction_digest
        },
        "logical": logical,
        "creative": creative.clone().unwrap_or(Value::Null),
        "connector": connector
    })
    .with_receipt_hash();
    let _ = append_jsonl(&proposal_history_path(root), &proposal);
    let _ = append_jsonl(
        &connector_history_path(root),
        &json!({
            "ts": now_iso(),
            "type": "adaptive_intelligence_connector_row",
            "prompt_digest": sha256_hex_str(&prompt),
            "connector_digest": connector_digest,
            "proposal_receipt_hash": proposal.get("receipt_hash").cloned().unwrap_or(Value::Null)
        }),
    );
    let mut state = load_state(root, policy);
    state.updated_at = now_iso();
    state.active_mode = resources.mode.clone();
    state.local_only = policy.local_only;
    state.last_proposal_digest = proposal
        .get("receipt_hash")
        .and_then(Value::as_str)
        .map(|v| v.to_string());
    state.last_connector_digest = Some(connector_digest.clone());
    state.last_resource_mode = Some(resources.mode.clone());
    let _ = store_state(root, &state);
    json!({
        "ok": errors.is_empty(),
        "type": "adaptive_intelligence_propose",
        "strict": strict,
        "mode": resources.mode,
        "proposal": proposal,
        "claim_evidence": [
            {
                "id": "V7-ADAPTIVE-001.1",
                "claim": "dual_local_models_share_a_seed_and_run_as_parallel_creative_and_logical_profiles",
                "evidence": {
                    "seed_model": policy.seed_model,
                    "logical_model": policy.logical_model,
                    "creative_model": policy.creative_model,
                    "mode": resources.mode
                }
            },
            {
                "id": "V7-ADAPTIVE-001.3",
                "claim": "deterministic_connector_merges_dual_model_outputs_into_ranked_proposals",
                "evidence": {
                    "connector_digest": connector_digest,
                    "proposal_count": proposal.get("connector").and_then(|v| v.get("proposal_count")).cloned().unwrap_or(Value::Null)
                }
            },
            {
                "id": "V7-ADAPTIVE-001.4",
                "claim": "resource_aware_prioritization_degrades_to_logical_first_under_constraint",
                "evidence": {
                    "mode": resources.mode,
                    "degraded": resources.degraded
                }
            },
            {
                "id": "V7-ADAPTIVE-001.5",
                "claim": "dream_and_conversation_context_plus_persona_bias_feed_the_adaptive_intelligence_lane",
                "evidence": {
                    "conversation_count": context.conversation_samples.len(),
                    "dream_count": context.dream_samples.len(),
                    "persona": context.persona
                }
            }
        ],
        "errors": errors,
        "conduit": conduit
    })
}

fn run_shadow_train(
    root: &Path,
    policy: &AdaptivePolicy,
    parsed: &crate::ParsedArgs,
    strict: bool,
) -> Value {
    let conduit = conduit(root, parsed, "shadow-train", strict);
    if strict && !conduit.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return json!({
            "ok": false,
            "type": "adaptive_intelligence_shadow_train",
            "strict": strict,
            "conduit": conduit,
            "errors": ["conduit_bypass_rejected"]
        });
    }
    let cycles = parse_u64(parsed.flags.get("cycles"), 1).clamp(1, 16);
    let context = collect_context_bundle(root, &parsed.flags);
    let resources = resource_snapshot(&parsed.flags, policy);
    let mut state = load_state(root, policy);
    let mut cycle_rows = Vec::<Value>::new();
    let mut logical_score = state.logical.specialization_score_pct;
    let mut creative_score = state.creative.specialization_score_pct;
    for cycle in 1..=cycles {
        let logical_gain = specialization_gain("logical", &context, &resources, cycle);
        let creative_gain = specialization_gain("creative", &context, &resources, cycle);
        logical_score = (logical_score + logical_gain).min(100.0);
        creative_score = (creative_score + creative_gain).min(100.0);
        cycle_rows.push(json!({
            "cycle": cycle,
            "logical_gain": logical_gain,
            "creative_gain": creative_gain,
            "trainer_adapter": policy.trainer_adapter,
            "local_only": policy.local_only,
            "context_digest": context.interaction_digest
        }));
    }
    let job_id = sha256_hex_str(&format!(
        "{}|{}|{}|{}",
        context.interaction_digest, cycles, policy.seed_model, resources.mode
    ));
    state.updated_at = now_iso();
    state.active_mode = resources.mode.clone();
    state.logical.specialization_score_pct = logical_score;
    state.creative.specialization_score_pct = creative_score;
    state.logical.last_trained_at = Some(state.updated_at.clone());
    state.creative.last_trained_at = Some(state.updated_at.clone());
    state.training.cycles_completed += cycles;
    state.training.last_job_id = Some(job_id.clone());
    state.training.last_context_digest = Some(context.interaction_digest.clone());
    state.training.last_mode = Some(resources.mode.clone());
    state.training.nightly_due = false;
    state.training.last_trained_at = Some(state.updated_at.clone());
    let _ = store_state(root, &state);
    let training_row = json!({
        "ts": now_iso(),
        "type": "adaptive_intelligence_shadow_training_job",
        "job_id": job_id,
        "cycles": cycles,
        "mode": resources.mode,
        "context_digest": context.interaction_digest,
        "logical_score_pct": logical_score,
        "creative_score_pct": creative_score,
        "trainer_adapter": policy.trainer_adapter,
        "seed_model": policy.seed_model,
        "claim_ids": ["V7-ADAPTIVE-001.2"]
    })
    .with_receipt_hash();
    let _ = append_jsonl(&training_history_path(root), &training_row);
    json!({
        "ok": true,
        "type": "adaptive_intelligence_shadow_train",
        "strict": strict,
        "job_id": job_id,
        "cycles": cycles,
        "mode": resources.mode,
        "trainer": {
            "adapter": policy.trainer_adapter,
            "local_only": policy.local_only,
            "seed_model": policy.seed_model,
            "fine_tune_mode": "qlora_or_equivalent"
        },
        "cycle_rows": cycle_rows,
        "specialization": {
            "logical_score_pct": logical_score,
            "creative_score_pct": creative_score,
            "graduation_threshold_pct": policy.graduation_threshold_pct
        },
        "claim_evidence": [{
            "id": "V7-ADAPTIVE-001.2",
            "claim": "shadow_mode_training_uses_local_context_and_updates_specialization_scores_without_safety_plane_execution",
            "evidence": {
                "job_id": job_id,
                "cycles": cycles,
                "context_digest": context.interaction_digest,
                "trainer_adapter": policy.trainer_adapter,
                "local_only": policy.local_only
            }
        }],
        "conduit": conduit
    })
}

fn run_graduate(
    root: &Path,
    policy: &AdaptivePolicy,
    parsed: &crate::ParsedArgs,
    strict: bool,
) -> Value {
    let conduit = conduit(root, parsed, "graduate", strict);
    if strict && !conduit.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return json!({
            "ok": false,
            "type": "adaptive_intelligence_graduate",
            "strict": strict,
            "conduit": conduit,
            "errors": ["conduit_bypass_rejected"]
        });
    }
    let model = clean(
        parsed
            .flags
            .get("model")
            .cloned()
            .unwrap_or_else(|| "logical".to_string()),
        40,
    );
    let human_only = parse_bool(parsed.flags.get("human-only"), false);
    let approvers = parsed
        .flags
        .get("approvers")
        .map(|v| split_csv_clean(v, 80))
        .unwrap_or_default();
    let mut state = load_state(root, policy);
    let target_score = match model.as_str() {
        "creative" => state.creative.specialization_score_pct,
        _ => state.logical.specialization_score_pct,
    };
    let threshold_ok = target_score >= policy.graduation_threshold_pct;
    let approvals_ok = approvers.len() >= policy.min_human_approvers;
    let mut errors = Vec::<String>::new();
    if strict && !human_only {
        errors.push("human_only_required".to_string());
    }
    if strict && !approvals_ok {
        errors.push("multi_signature_required".to_string());
    }
    if strict && !threshold_ok {
        errors.push("specialization_threshold_not_met".to_string());
    }
    if errors.is_empty() {
        match model.as_str() {
            "creative" => {
                state.creative.graduated = true;
                state.creative.last_graduated_at = Some(now_iso());
            }
            _ => {
                state.logical.graduated = true;
                state.logical.last_graduated_at = Some(now_iso());
            }
        }
        state.updated_at = now_iso();
        let _ = store_state(root, &state);
    }
    let row = json!({
        "ts": now_iso(),
        "type": "adaptive_intelligence_graduation_event",
        "model": model,
        "human_only": human_only,
        "approvers": approvers,
        "threshold_ok": threshold_ok,
        "score_pct": target_score,
        "graduated": errors.is_empty()
    })
    .with_receipt_hash();
    let _ = append_jsonl(&graduation_history_path(root), &row);
    json!({
        "ok": errors.is_empty(),
        "type": "adaptive_intelligence_graduate",
        "strict": strict,
        "model": model,
        "human_only": human_only,
        "approvers": approvers,
        "score_pct": target_score,
        "graduated": errors.is_empty(),
        "claim_evidence": [{
            "id": "V7-ADAPTIVE-001.6",
            "claim": "model_graduation_requires_human_only_multisig_and_specialization_threshold_before_activation",
            "evidence": {
                "human_only": human_only,
                "approver_count": row.get("approvers").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
                "threshold_ok": threshold_ok,
                "score_pct": target_score
            }
        }],
        "errors": errors,
        "conduit": conduit
    })
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let strict = parse_bool(parsed.flags.get("strict"), true);
    let policy = load_policy(root);

    match cmd.as_str() {
        "status" => {
            let state = load_state(root, &policy);
            print_json(&status(root, &policy, &state));
            0
        }
        "prioritize" => emit(root, run_prioritize(root, &policy, &parsed, strict)),
        "propose" | "run" => emit(root, run_propose(root, &policy, &parsed, strict)),
        "shadow-train" | "train-shadow" => {
            emit(root, run_shadow_train(root, &policy, &parsed, strict))
        }
        "graduate" => emit(root, run_graduate(root, &policy, &parsed, strict)),
        _ => {
            usage();
            print_json(&json!({
                "ok": false,
                "type": "adaptive_intelligence_error",
                "error": "unknown_command",
                "command": cmd
            }));
            1
        }
    }
}
