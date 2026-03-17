// Layer ownership: core/layer0/ops (authoritative)
// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{
    client_state_root, configure_low_memory_allocator_env, daemon_control,
    deterministic_receipt_hash, now_iso, parse_os_args, status_runtime_efficiency_floor,
};
use serde_json::{json, Value};
use std::env;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::path::PathBuf;
use sysinfo::System;

#[cfg(feature = "embedded-minimal-core")]
type PlaneRunner = fn(&Path, &[String]) -> i32;

fn print_json(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn usage() {
    println!("Usage:");
    println!("  infringd status");
    println!("  infringd start [--strict=1|0]");
    println!("  infringd stop [--strict=1|0]");
    println!("  infringd restart [--strict=1|0]");
    println!("  infringd attach [--strict=1|0]");
    println!("  infringd subscribe [--strict=1|0]");
    println!("  infringd tick [--strict=1|0]");
    println!("  infringd diagnostics [--strict=1|0]");
    println!("  infringd think --prompt=<text> [--session-id=<id>] [--memory-limit=<n>]");
    println!("  infringd research <status|fetch|diagnostics> [flags]");
    println!("  infringd memory <status|write|query> [flags]");
    println!("  infringd orchestration <invoke|help> [flags]");
    println!("  infringd swarm-runtime <status|spawn|sessions|results|tick|metrics|test> [flags]");
    println!("  infringd capability-profile [--hardware-class=<mcu|legacy|standard|high>] [--memory-mb=<n>] [--cpu-cores=<n>] [--tiny-max=1|0]");
    println!("  infringd efficiency-status");
    #[cfg(feature = "embedded-minimal-core")]
    println!("  infringd embedded-core-status");
    #[cfg(feature = "tiny")]
    println!("  infringd tiny-status");
    #[cfg(feature = "embedded-max")]
    println!("  infringd tiny-max-status");
}

fn cli_error(error: &str, command: &str) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "protheusd_error",
        "command": command,
        "error": error,
        "ts": now_iso()
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let pref = format!("--{key}=");
    let key_token = format!("--{key}");
    let mut idx = 0usize;
    while idx < argv.len() {
        let token = argv[idx].trim();
        if let Some(value) = token.strip_prefix(&pref) {
            return Some(value.trim().to_string());
        }
        if token == key_token {
            if let Some(next) = argv.get(idx + 1) {
                return Some(next.trim().to_string());
            }
        }
        idx += 1;
    }
    None
}

fn clean_token(raw: Option<&str>, fallback: &str) -> String {
    let mut out = String::new();
    let source = raw.unwrap_or("").trim();
    for ch in source.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | ':' | '.') {
            out.push(ch);
        } else if ch.is_ascii_whitespace() && !out.ends_with('_') {
            out.push('_');
        }
        if out.len() >= 64 {
            break;
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed
    }
}

fn clean_text(raw: Option<&str>, max_len: usize) -> String {
    let mut out = String::new();
    for ch in raw.unwrap_or("").trim().chars() {
        if ch.is_control() && ch != '\n' && ch != '\t' {
            continue;
        }
        out.push(ch);
        if out.len() >= max_len {
            break;
        }
    }
    out
}

fn parse_usize(raw: Option<&str>, fallback: usize, min: usize, max: usize) -> usize {
    raw.and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn parse_bool_flag(raw: Option<&str>, default: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => default,
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RuntimeHardwareClass {
    Microcontroller,
    Legacy,
    Standard,
    High,
}

impl RuntimeHardwareClass {
    fn as_str(self) -> &'static str {
        match self {
            Self::Microcontroller => "mcu",
            Self::Legacy => "legacy",
            Self::Standard => "standard",
            Self::High => "high",
        }
    }
}

#[derive(Clone, Debug)]
struct RuntimeCapabilityProfile {
    hardware_class: RuntimeHardwareClass,
    tiny_max: bool,
    sensed_memory_mb: u64,
    sensed_cpu_cores: usize,
    max_memory_hits: usize,
    allow_research_fetch: bool,
    allow_orchestration: bool,
    allow_swarm_spawn: bool,
    allow_persistent_swarm: bool,
    max_swarm_depth: u8,
}

impl RuntimeCapabilityProfile {
    fn allows_orchestration_op(&self, op: &str) -> bool {
        if !self.allow_orchestration {
            return false;
        }
        if self.hardware_class != RuntimeHardwareClass::Microcontroller {
            return true;
        }
        matches!(
            op,
            "scope.detect_overlaps"
                | "scope.classify"
                | "scratchpad.status"
                | "scratchpad.write"
                | "scratchpad.append_finding"
                | "scratchpad.append_checkpoint"
                | "checkpoint.should"
                | "checkpoint.tick"
                | "checkpoint.timeout"
                | "coordinator.partition"
                | "coordinator.merge_findings"
        )
    }

    fn as_json(&self) -> Value {
        let mut shed = Vec::<String>::new();
        if !self.allow_research_fetch {
            shed.push("research.fetch".to_string());
        }
        if !self.allow_persistent_swarm {
            shed.push("swarm.persistent".to_string());
        }
        if self.max_swarm_depth <= 1 {
            shed.push("swarm.max_depth>1".to_string());
        }
        if self.max_memory_hits <= 2 {
            shed.push("think.memory_hits>2".to_string());
        }
        json!({
            "hardware_class": self.hardware_class.as_str(),
            "tiny_max": self.tiny_max,
            "sensed_memory_mb": self.sensed_memory_mb,
            "sensed_cpu_cores": self.sensed_cpu_cores,
            "limits": {
                "max_memory_hits": self.max_memory_hits,
                "max_swarm_depth": self.max_swarm_depth
            },
            "capabilities": {
                "research_fetch": self.allow_research_fetch,
                "orchestration": self.allow_orchestration,
                "swarm_spawn": self.allow_swarm_spawn,
                "swarm_persistent": self.allow_persistent_swarm
            },
            "shed_capabilities": shed
        })
    }
}

fn parse_hardware_class(raw: Option<&str>) -> Option<RuntimeHardwareClass> {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "mcu" | "microcontroller" | "embedded") => {
            Some(RuntimeHardwareClass::Microcontroller)
        }
        Some(v) if matches!(v.as_str(), "legacy" | "old" | "ancient") => {
            Some(RuntimeHardwareClass::Legacy)
        }
        Some(v) if matches!(v.as_str(), "standard" | "edge") => {
            Some(RuntimeHardwareClass::Standard)
        }
        Some(v) if matches!(v.as_str(), "high" | "desktop" | "server") => {
            Some(RuntimeHardwareClass::High)
        }
        _ => None,
    }
}

fn parse_u64_any(raw: Option<&str>) -> Option<u64> {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
}

fn parse_usize_any(raw: Option<&str>) -> Option<usize> {
    raw.and_then(|v| v.trim().parse::<usize>().ok())
}

fn tiny_max_requested(argv: &[String]) -> bool {
    parse_bool_flag(parse_flag(argv, "tiny-max").as_deref(), false)
        || parse_bool_flag(parse_flag(argv, "tiny_max").as_deref(), false)
        || parse_bool_flag(env::var("PROTHEUS_EMBEDDED_MAX").ok().as_deref(), false)
        || cfg!(feature = "embedded-max")
}

fn sensed_memory_mb(argv: &[String]) -> u64 {
    if let Some(v) = parse_u64_any(parse_flag(argv, "memory-mb").as_deref()) {
        return v.max(64);
    }
    if let Some(v) = parse_u64_any(env::var("PROTHEUS_HW_MEMORY_MB").ok().as_deref()) {
        return v.max(64);
    }
    let mut system = System::new_all();
    system.refresh_memory();
    let mb = (system.total_memory() as f64 / 1024.0).round() as u64;
    mb.max(64)
}

fn sensed_cpu_cores(argv: &[String]) -> usize {
    if let Some(v) = parse_usize_any(parse_flag(argv, "cpu-cores").as_deref()) {
        return v.max(1);
    }
    if let Some(v) = parse_usize_any(env::var("PROTHEUS_HW_CPU_CORES").ok().as_deref()) {
        return v.max(1);
    }
    num_cpus::get().max(1)
}

fn infer_hardware_class(memory_mb: u64, cpu_cores: usize, tiny_max: bool) -> RuntimeHardwareClass {
    if memory_mb <= 768 || cpu_cores <= 1 {
        RuntimeHardwareClass::Microcontroller
    } else if memory_mb <= 4096 || cpu_cores <= 2 {
        RuntimeHardwareClass::Legacy
    } else if tiny_max && (memory_mb <= 8192 || cpu_cores <= 4) {
        RuntimeHardwareClass::Standard
    } else {
        RuntimeHardwareClass::High
    }
}

fn runtime_capability_profile(argv: &[String]) -> RuntimeCapabilityProfile {
    let tiny_max = tiny_max_requested(argv);
    let memory_mb = sensed_memory_mb(argv);
    let cpu_cores = sensed_cpu_cores(argv);
    let override_class = parse_hardware_class(
        parse_flag(argv, "hardware-class")
            .or_else(|| parse_flag(argv, "device-class"))
            .or_else(|| env::var("PROTHEUS_HW_CLASS").ok())
            .as_deref(),
    );
    let hardware_class =
        override_class.unwrap_or_else(|| infer_hardware_class(memory_mb, cpu_cores, tiny_max));

    match hardware_class {
        RuntimeHardwareClass::Microcontroller => RuntimeCapabilityProfile {
            hardware_class,
            tiny_max,
            sensed_memory_mb: memory_mb,
            sensed_cpu_cores: cpu_cores,
            max_memory_hits: 2,
            allow_research_fetch: false,
            allow_orchestration: true,
            allow_swarm_spawn: true,
            allow_persistent_swarm: false,
            max_swarm_depth: 1,
        },
        RuntimeHardwareClass::Legacy => RuntimeCapabilityProfile {
            hardware_class,
            tiny_max,
            sensed_memory_mb: memory_mb,
            sensed_cpu_cores: cpu_cores,
            max_memory_hits: 4,
            allow_research_fetch: true,
            allow_orchestration: true,
            allow_swarm_spawn: true,
            allow_persistent_swarm: false,
            max_swarm_depth: 2,
        },
        RuntimeHardwareClass::Standard => RuntimeCapabilityProfile {
            hardware_class,
            tiny_max,
            sensed_memory_mb: memory_mb,
            sensed_cpu_cores: cpu_cores,
            max_memory_hits: 8,
            allow_research_fetch: true,
            allow_orchestration: true,
            allow_swarm_spawn: true,
            allow_persistent_swarm: !tiny_max,
            max_swarm_depth: 4,
        },
        RuntimeHardwareClass::High => RuntimeCapabilityProfile {
            hardware_class,
            tiny_max,
            sensed_memory_mb: memory_mb,
            sensed_cpu_cores: cpu_cores,
            max_memory_hits: 20,
            allow_research_fetch: true,
            allow_orchestration: true,
            allow_swarm_spawn: true,
            allow_persistent_swarm: true,
            max_swarm_depth: 8,
        },
    }
}

fn strip_runtime_profile_flags(argv: &[String]) -> Vec<String> {
    let drop_next_for = [
        "--hardware-class",
        "--device-class",
        "--memory-mb",
        "--cpu-cores",
        "--tiny-max",
        "--tiny_max",
    ];
    let drop_prefixes = [
        "--hardware-class=",
        "--device-class=",
        "--memory-mb=",
        "--cpu-cores=",
        "--tiny-max=",
        "--tiny_max=",
    ];
    let mut out = Vec::<String>::new();
    let mut skip_next = false;
    for token in argv {
        if skip_next {
            skip_next = false;
            continue;
        }
        let trimmed = token.trim();
        if drop_next_for.contains(&trimmed) {
            skip_next = true;
            continue;
        }
        if drop_prefixes
            .iter()
            .any(|prefix| trimmed.starts_with(prefix))
        {
            continue;
        }
        out.push(token.clone());
    }
    out
}

fn capability_profile_payload(argv: &[String]) -> Value {
    let profile = runtime_capability_profile(argv);
    let mut out = json!({
        "ok": true,
        "type": "protheusd_capability_profile",
        "ts": now_iso(),
        "profile": profile.as_json()
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn validate_orchestration_profile(
    profile: &RuntimeCapabilityProfile,
    argv: &[String],
) -> Result<(), String> {
    if !profile.allow_orchestration {
        return Err("hardware_profile_blocks_orchestration".to_string());
    }
    let sub = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "help".to_string());
    if sub != "invoke" {
        return Ok(());
    }
    let op = clean_token(parse_flag(argv, "op").as_deref(), "");
    if op.is_empty() {
        return Err("orchestration_op_required".to_string());
    }
    if !profile.allows_orchestration_op(op.as_str()) {
        return Err(format!("hardware_profile_blocks_orchestration_op:{}", op));
    }
    Ok(())
}

fn parse_u8_flag(argv: &[String], key: &str, default: u8) -> u8 {
    parse_flag(argv, key)
        .and_then(|v| v.trim().parse::<u8>().ok())
        .unwrap_or(default)
}

fn validate_swarm_profile(
    profile: &RuntimeCapabilityProfile,
    argv: &[String],
) -> Result<(), String> {
    let sub = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    match sub.as_str() {
        "spawn" => {
            if !profile.allow_swarm_spawn {
                return Err("hardware_profile_blocks_swarm_spawn".to_string());
            }
            let requested_depth = parse_u8_flag(argv, "max-depth", profile.max_swarm_depth);
            if requested_depth > profile.max_swarm_depth {
                return Err(format!(
                    "hardware_profile_max_swarm_depth_exceeded:{}>{}",
                    requested_depth, profile.max_swarm_depth
                ));
            }
            let execution_mode = parse_flag(argv, "execution-mode")
                .unwrap_or_else(|| "task".to_string())
                .trim()
                .to_ascii_lowercase();
            if matches!(execution_mode.as_str(), "persistent" | "background")
                && !profile.allow_persistent_swarm
            {
                return Err("hardware_profile_blocks_persistent_swarm".to_string());
            }
            Ok(())
        }
        "background" => {
            if !profile.allow_persistent_swarm {
                Err("hardware_profile_blocks_background_swarm".to_string())
            } else {
                Ok(())
            }
        }
        "test" => {
            let suite = argv
                .get(1)
                .map(|v| v.trim().to_ascii_lowercase())
                .unwrap_or_else(|| "recursive".to_string());
            if suite == "persistent" && !profile.allow_persistent_swarm {
                Err("hardware_profile_blocks_persistent_swarm_test".to_string())
            } else {
                Ok(())
            }
        }
        _ => Ok(()),
    }
}

fn memory_store_path(root: &Path) -> PathBuf {
    client_state_root(root)
        .join("memory")
        .join("pure_workspace_memory_v1.jsonl")
}

fn read_memory_entries(path: &Path) -> Vec<Value> {
    if !path.exists() {
        return Vec::new();
    }
    let file = match std::fs::File::open(path) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let mut out = Vec::new();
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(trimmed) {
            out.push(value);
        }
    }
    out
}

fn append_memory_entry(path: &Path, row: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("create_memory_parent_failed:{err}"))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("open_memory_store_failed:{err}"))?;
    let line =
        serde_json::to_string(row).map_err(|err| format!("encode_memory_row_failed:{err}"))?;
    file.write_all(line.as_bytes())
        .map_err(|err| format!("write_memory_row_failed:{err}"))?;
    file.write_all(b"\n")
        .map_err(|err| format!("write_memory_newline_failed:{err}"))?;
    Ok(())
}

fn memory_status_payload(root: &Path) -> Value {
    let path = memory_store_path(root);
    let entries = read_memory_entries(&path);
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let last_ts = entries
        .last()
        .and_then(|v| v.get("ts"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let mut out = json!({
        "ok": true,
        "type": "pure_memory_status",
        "ts": now_iso(),
        "path": path.to_string_lossy(),
        "entry_count": entries.len(),
        "bytes": bytes,
        "last_ts": last_ts
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn memory_write_payload(root: &Path, argv: &[String]) -> Result<Value, String> {
    let text = clean_text(parse_flag(argv, "text").as_deref(), 4000);
    if text.is_empty() {
        return Err("missing_text".to_string());
    }
    let session_id = clean_token(parse_flag(argv, "session-id").as_deref(), "default");
    let tags = parse_flag(argv, "tags")
        .map(|raw| {
            raw.split(',')
                .map(|v| clean_token(Some(v), ""))
                .filter(|v| !v.is_empty())
                .take(16)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let ts = now_iso();
    let id_seed = json!({
        "text": text,
        "session_id": session_id,
        "ts": ts
    });
    let derived_id = deterministic_receipt_hash(&id_seed)
        .chars()
        .take(16)
        .collect::<String>();
    let item_id = clean_token(parse_flag(argv, "id").as_deref(), derived_id.as_str());
    let row = json!({
        "id": item_id,
        "ts": ts,
        "session_id": session_id,
        "text": text,
        "tags": tags
    });
    let path = memory_store_path(root);
    append_memory_entry(&path, &row)?;
    let mut out = json!({
        "ok": true,
        "type": "pure_memory_write",
        "ts": now_iso(),
        "path": path.to_string_lossy(),
        "item": row
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    Ok(out)
}

fn memory_query_payload(root: &Path, argv: &[String]) -> Value {
    let q = clean_text(
        parse_flag(argv, "q")
            .or_else(|| parse_flag(argv, "text"))
            .as_deref(),
        240,
    )
    .to_ascii_lowercase();
    let session = clean_token(parse_flag(argv, "session-id").as_deref(), "");
    let tag = clean_token(parse_flag(argv, "tag").as_deref(), "").to_ascii_lowercase();
    let limit = parse_usize(parse_flag(argv, "limit").as_deref(), 20, 1, 200);
    let mut entries = read_memory_entries(&memory_store_path(root))
        .into_iter()
        .filter(|row| {
            let text = row
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_ascii_lowercase();
            let row_session = row
                .get("session_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let tag_match = if tag.is_empty() {
                true
            } else {
                row.get("tags")
                    .and_then(Value::as_array)
                    .map(|tags| {
                        tags.iter().any(|v| {
                            v.as_str()
                                .map(|s| s.to_ascii_lowercase() == tag)
                                .unwrap_or(false)
                        })
                    })
                    .unwrap_or(false)
            };
            let session_match = session.is_empty() || row_session == session;
            let text_match = q.is_empty() || text.contains(&q);
            session_match && tag_match && text_match
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        b.get("ts")
            .and_then(Value::as_str)
            .unwrap_or("")
            .cmp(a.get("ts").and_then(Value::as_str).unwrap_or(""))
    });
    entries.truncate(limit);
    let mut out = json!({
        "ok": true,
        "type": "pure_memory_query",
        "ts": now_iso(),
        "q": q,
        "session_id": if session.is_empty() { Value::Null } else { Value::String(session.clone()) },
        "tag": if tag.is_empty() { Value::Null } else { Value::String(tag.clone()) },
        "limit": limit,
        "matches": entries
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn contains_any_token(haystack: &str, tokens: &[String]) -> usize {
    let hay = haystack.to_ascii_lowercase();
    tokens
        .iter()
        .filter(|token| hay.contains(token.as_str()))
        .count()
}

fn think_payload(root: &Path, argv: &[String]) -> Result<Value, String> {
    let prompt = clean_text(parse_flag(argv, "prompt").as_deref(), 1200);
    if prompt.is_empty() {
        return Err("missing_prompt".to_string());
    }
    let session_id = clean_token(parse_flag(argv, "session-id").as_deref(), "default");
    let profile = runtime_capability_profile(argv);
    let requested_memory_limit = parse_usize(parse_flag(argv, "memory-limit").as_deref(), 5, 1, 20);
    let memory_limit = requested_memory_limit.min(profile.max_memory_hits);
    let lower_prompt = prompt.to_ascii_lowercase();
    let tokens = lower_prompt
        .split(|ch: char| !ch.is_ascii_alphanumeric())
        .filter(|token| token.len() >= 3)
        .take(12)
        .map(|token| token.to_string())
        .collect::<Vec<_>>();
    let mut scored = read_memory_entries(&memory_store_path(root))
        .into_iter()
        .filter_map(|entry| {
            let row_session = entry
                .get("session_id")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if row_session != session_id {
                return None;
            }
            let text = entry
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let score = contains_any_token(&text, &tokens);
            if score == 0 {
                return None;
            }
            Some((score, entry))
        })
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| b.0.cmp(&a.0));
    let memory_hits = scored
        .into_iter()
        .take(memory_limit)
        .map(|(_, row)| row)
        .collect::<Vec<_>>();

    let hint = if lower_prompt.contains("http://") || lower_prompt.contains("https://") {
        "Detected URL intent: run `infring research fetch --url=<url>` for source capture."
    } else if lower_prompt.contains("research") {
        "Research intent detected: run `infring research status` then `infring research fetch --url=<url>`."
    } else {
        "Action intent detected: break the task into one immediate execution step and one verification step."
    };
    let response = format!(
        "Prompt focus: {}. {}",
        prompt.chars().take(180).collect::<String>(),
        hint
    );
    let mut out = json!({
        "ok": true,
        "type": "pure_think",
        "ts": now_iso(),
        "session_id": session_id,
        "prompt": prompt,
        "requested_memory_limit": requested_memory_limit,
        "effective_memory_limit": memory_limit,
        "capability_profile": profile.as_json(),
        "memory_hits": memory_hits,
        "response": response,
        "next_actions": [
            "define_success_criteria",
            "execute_smallest_safe_step",
            "record_outcome_in_memory"
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    Ok(out)
}

fn run_research(root: &Path, argv: &[String]) -> i32 {
    let profile = runtime_capability_profile(argv);
    let mut rest = strip_runtime_profile_flags(argv);
    if rest.is_empty() {
        rest.push("status".to_string());
    }
    let command = rest
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    if !matches!(command.as_str(), "status" | "fetch" | "diagnostics") {
        print_json(&cli_error(
            "research_command_not_allowed_in_pure_v1",
            "research",
        ));
        return 1;
    }
    if command == "fetch" && !profile.allow_research_fetch {
        print_json(&cli_error(
            "hardware_profile_blocks_research_fetch",
            "research",
        ));
        return 1;
    }
    protheus_ops_core::research_plane::run(root, &rest)
}

fn run_memory(root: &Path, argv: &[String]) -> i32 {
    let command = argv
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    match command.as_str() {
        "status" => {
            print_json(&memory_status_payload(root));
            0
        }
        "write" => match memory_write_payload(root, &argv[1..]) {
            Ok(payload) => {
                print_json(&payload);
                0
            }
            Err(err) => {
                print_json(&cli_error(err.as_str(), "memory"));
                1
            }
        },
        "query" => {
            print_json(&memory_query_payload(root, &argv[1..]));
            0
        }
        _ => {
            print_json(&cli_error("unknown_memory_command", "memory"));
            1
        }
    }
}

fn run_think(root: &Path, argv: &[String]) -> i32 {
    match think_payload(root, argv) {
        Ok(payload) => {
            print_json(&payload);
            0
        }
        Err(err) => {
            print_json(&cli_error(err.as_str(), "think"));
            1
        }
    }
}

fn run_orchestration(root: &Path, argv: &[String]) -> i32 {
    let profile = runtime_capability_profile(argv);
    let mut rest = strip_runtime_profile_flags(argv);
    if rest.is_empty() {
        rest.push("help".to_string());
    }
    if let Err(err) = validate_orchestration_profile(&profile, &rest) {
        print_json(&cli_error(err.as_str(), "orchestration"));
        return 1;
    }
    protheus_ops_core::orchestration::run(root, &rest)
}

fn run_swarm(root: &Path, argv: &[String]) -> i32 {
    let profile = runtime_capability_profile(argv);
    let mut rest = strip_runtime_profile_flags(argv);
    if rest.is_empty() {
        rest.push("status".to_string());
    }
    if let Err(err) = validate_swarm_profile(&profile, &rest) {
        print_json(&cli_error(err.as_str(), "swarm-runtime"));
        return 1;
    }
    protheus_ops_core::swarm_runtime::run(root, &rest)
}

#[cfg(feature = "embedded-minimal-core")]
fn embedded_minimal_core_planes() -> [(&'static str, &'static str, PlaneRunner); 5] {
    [
        (
            "layer0-directives",
            "directive_kernel",
            protheus_ops_core::directive_kernel::run,
        ),
        (
            "layer0-attention",
            "attention_queue",
            protheus_ops_core::attention_queue::run,
        ),
        (
            "layer0-receipts",
            "metakernel",
            protheus_ops_core::metakernel::run,
        ),
        (
            "layer0-min-memory",
            "memory_plane",
            protheus_ops_core::memory_plane::run,
        ),
        (
            "layer-1-substrate-detector",
            "substrate_plane",
            protheus_ops_core::substrate_plane::run,
        ),
    ]
}

#[cfg(feature = "embedded-minimal-core")]
fn embedded_minimal_core_status() -> Value {
    let planes = embedded_minimal_core_planes();
    let lane_entries: Vec<Value> = planes
        .iter()
        .map(|(feature, lane, runner)| {
            json!({
                "feature": feature,
                "lane": lane,
                "runner_ptr": format!("{:p}", *runner as *const ())
            })
        })
        .collect();
    let runner_ptr_fingerprint = deterministic_receipt_hash(&json!(lane_entries));
    let mut out = json!({
        "ok": true,
        "type": "protheusd_embedded_minimal_core_status",
        "ts": now_iso(),
        "embedded_feature": "embedded-minimal-core",
        "planes_embedded": lane_entries,
        "runner_ptr_fingerprint": runner_ptr_fingerprint,
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

#[cfg(feature = "tiny")]
fn tiny_status() -> Value {
    let profile = protheus_tiny_runtime::tiny_profile();
    let capacity = protheus_tiny_runtime::normalized_capacity_score(
        profile.max_heap_kib,
        profile.max_concurrent_hands,
    );
    let mut out = json!({
        "ok": true,
        "type": "protheusd_tiny_status",
        "ts": now_iso(),
        "profile": profile.profile,
        "no_std": profile.no_std,
        "max_heap_kib": profile.max_heap_kib,
        "max_concurrent_hands": profile.max_concurrent_hands,
        "supports_hibernation": profile.supports_hibernation,
        "supports_receipt_batching": profile.supports_receipt_batching,
        "capacity_score": capacity
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

#[cfg(feature = "embedded-max")]
fn tiny_max_status() -> Value {
    let profile = protheus_tiny_runtime::tiny_profile();
    let mut out = json!({
        "ok": true,
        "type": "protheusd_tiny_max_status",
        "ts": now_iso(),
        "mode": "embedded-max",
        "no_std_runtime": profile.no_std,
        "allocator_profile": "minimal-alloc",
        "pgo_profile_enabled": cfg!(feature = "pgo-profile"),
        "max_heap_kib": profile.max_heap_kib,
        "max_concurrent_hands": profile.max_concurrent_hands
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn main() {
    configure_low_memory_allocator_env();
    #[cfg(feature = "embedded-max")]
    std::env::set_var("PROTHEUS_EMBEDDED_MAX", "1");
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let args = parse_os_args(env::args_os().skip(1));
    let command = args
        .first()
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return;
    }

    match command.as_str() {
        "status" | "start" | "stop" | "restart" | "attach" | "subscribe" | "tick"
        | "diagnostics" => {
            let exit = daemon_control::run(&cwd, &args);
            std::process::exit(exit);
        }
        "think" => {
            let exit = run_think(&cwd, &args[1..]);
            std::process::exit(exit);
        }
        "research" => {
            let exit = run_research(&cwd, &args[1..]);
            std::process::exit(exit);
        }
        "memory" => {
            let exit = run_memory(&cwd, &args[1..]);
            std::process::exit(exit);
        }
        "orchestration" => {
            let exit = run_orchestration(&cwd, &args[1..]);
            std::process::exit(exit);
        }
        "swarm-runtime" | "swarm" => {
            let exit = run_swarm(&cwd, &args[1..]);
            std::process::exit(exit);
        }
        "capability-profile" => {
            print_json(&capability_profile_payload(&args[1..]));
            std::process::exit(0);
        }
        "efficiency-status" => {
            let parsed = protheus_ops_core::parse_args(&[]);
            let out = status_runtime_efficiency_floor(&cwd, &parsed).json;
            print_json(&out);
            std::process::exit(0);
        }
        #[cfg(feature = "embedded-minimal-core")]
        "embedded-core-status" => {
            print_json(&embedded_minimal_core_status());
            std::process::exit(0);
        }
        #[cfg(feature = "tiny")]
        "tiny-status" => {
            print_json(&tiny_status());
            std::process::exit(0);
        }
        #[cfg(feature = "embedded-max")]
        "tiny-max-status" => {
            print_json(&tiny_max_status());
            std::process::exit(0);
        }
        _ => {
            usage();
            print_json(&cli_error("unknown_command", command.as_str()));
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    use serde_json::Value;

    #[test]
    fn memory_write_and_query_roundtrip() {
        let tmp = tempdir().expect("tempdir");
        let root = tmp.path();
        let payload = memory_write_payload(
            root,
            &[
                "--text=remember pure intelligence".to_string(),
                "--session-id=test".to_string(),
                "--tags=intel,pure".to_string(),
            ],
        )
        .expect("write memory");
        assert_eq!(
            payload.get("type").and_then(Value::as_str),
            Some("pure_memory_write")
        );

        let query = memory_query_payload(
            root,
            &[
                "--q=intelligence".to_string(),
                "--session-id=test".to_string(),
                "--limit=5".to_string(),
            ],
        );
        assert_eq!(
            query.get("type").and_then(Value::as_str),
            Some("pure_memory_query")
        );
        assert!(query
            .get("matches")
            .and_then(Value::as_array)
            .map(|rows| !rows.is_empty())
            .unwrap_or(false));
    }

    #[test]
    fn think_uses_session_memory_hits() {
        let tmp = tempdir().expect("tempdir");
        let root = tmp.path();
        memory_write_payload(
            root,
            &[
                "--text=research rust safety constraints".to_string(),
                "--session-id=alpha".to_string(),
            ],
        )
        .expect("seed memory");
        let thought = think_payload(
            root,
            &[
                "--prompt=Can you research safety constraints?".to_string(),
                "--session-id=alpha".to_string(),
            ],
        )
        .expect("think");
        assert_eq!(
            thought.get("type").and_then(Value::as_str),
            Some("pure_think")
        );
        assert!(thought
            .get("memory_hits")
            .and_then(Value::as_array)
            .map(|rows| !rows.is_empty())
            .unwrap_or(false));
        assert_eq!(
            thought
                .get("effective_memory_limit")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            5
        );
    }

    #[test]
    fn mcu_profile_sheds_heavy_paths() {
        let profile = runtime_capability_profile(&[
            "--hardware-class=mcu".to_string(),
            "--tiny-max=1".to_string(),
            "--memory-mb=256".to_string(),
            "--cpu-cores=1".to_string(),
        ]);
        assert_eq!(
            profile.hardware_class,
            RuntimeHardwareClass::Microcontroller
        );
        assert!(!profile.allow_research_fetch);
        assert!(!profile.allow_persistent_swarm);
        assert_eq!(profile.max_swarm_depth, 1);
        assert_eq!(profile.max_memory_hits, 2);
    }

    #[test]
    fn think_clamps_memory_limit_on_mcu_profile() {
        let tmp = tempdir().expect("tempdir");
        let root = tmp.path();
        for idx in 0..6 {
            memory_write_payload(
                root,
                &[
                    format!("--text=research note {idx}"),
                    "--session-id=alpha".to_string(),
                ],
            )
            .expect("seed memory");
        }
        let thought = think_payload(
            root,
            &[
                "--prompt=research note".to_string(),
                "--session-id=alpha".to_string(),
                "--memory-limit=20".to_string(),
                "--hardware-class=mcu".to_string(),
                "--tiny-max=1".to_string(),
            ],
        )
        .expect("think");
        assert_eq!(
            thought
                .get("effective_memory_limit")
                .and_then(Value::as_u64)
                .unwrap_or(0),
            2
        );
        let hits = thought
            .get("memory_hits")
            .and_then(Value::as_array)
            .expect("memory hits");
        assert!(hits.len() <= 2);
    }

    #[test]
    fn mcu_profile_blocks_heavy_orchestration_ops() {
        let profile = runtime_capability_profile(&["--hardware-class=mcu".to_string()]);
        let err = validate_orchestration_profile(
            &profile,
            &[
                "invoke".to_string(),
                "--op=coordinator.run".to_string(),
                "--payload-json={}".to_string(),
            ],
        )
        .expect_err("should block heavy op");
        assert!(err.contains("hardware_profile_blocks_orchestration_op"));
    }

    #[test]
    fn mcu_profile_limits_swarm_depth() {
        let profile = runtime_capability_profile(&["--hardware-class=mcu".to_string()]);
        let err = validate_swarm_profile(
            &profile,
            &[
                "spawn".to_string(),
                "--task=test".to_string(),
                "--max-depth=3".to_string(),
            ],
        )
        .expect_err("should enforce max depth");
        assert!(err.contains("hardware_profile_max_swarm_depth_exceeded"));
    }

    #[cfg(feature = "tiny")]
    #[test]
    fn tiny_status_emits_receipt_and_profile() {
        let payload = tiny_status();
        assert_eq!(
            payload.get("type").and_then(Value::as_str),
            Some("protheusd_tiny_status")
        );
        assert_eq!(payload.get("no_std").and_then(Value::as_bool), Some(true));
        assert!(payload
            .get("receipt_hash")
            .and_then(Value::as_str)
            .map(|value| !value.is_empty())
            .unwrap_or(false));
    }
}
