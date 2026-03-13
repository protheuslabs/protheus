// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

#[derive(Debug, Clone)]
struct MemoryAmbientPolicy {
    enabled: bool,
    rust_authoritative: bool,
    push_attention_queue: bool,
    quiet_non_critical: bool,
    surface_levels: Vec<String>,
    latest_path: PathBuf,
    receipts_path: PathBuf,
    status_path: PathBuf,
    history_path: PathBuf,
    policy_path: PathBuf,
}

fn usage() {
    eprintln!("Usage:");
    eprintln!(
        "  protheus-ops memory-ambient run <memory-command> [memory-args...] [--run-context=<value>]"
    );
    eprintln!(
        "  protheus-ops memory-ambient run --memory-command=<cmd> [--memory-arg=<arg> ...] [--memory-args-json=<json-array>] [--run-context=<value>]"
    );
    eprintln!("  protheus-ops memory-ambient status");
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut raw) = serde_json::to_string_pretty(value) {
        raw.push('\n');
        let _ = fs::write(path, raw);
    }
}

fn append_jsonl(path: &Path, row: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(line) = serde_json::to_string(row) {
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| {
                std::io::Write::write_all(&mut file, format!("{line}\n").as_bytes())
            });
    }
}

fn parse_cli_flags(argv: &[String]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    let mut i = 0usize;
    while i < argv.len() {
        let token = argv[i].trim();
        if !token.starts_with("--") {
            i += 1;
            continue;
        }
        if let Some((k, v)) = token.split_once('=') {
            out.insert(k.trim_start_matches("--").to_string(), v.to_string());
            i += 1;
            continue;
        }
        let key = token.trim_start_matches("--").to_string();
        if let Some(next) = argv.get(i + 1) {
            if !next.starts_with("--") {
                out.insert(key, next.clone());
                i += 2;
                continue;
            }
        }
        out.insert(key, "true".to_string());
        i += 1;
    }
    out
}

fn parse_string_array(value: Option<&Value>, max_items: usize, max_len: usize) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|row| clean_text(Some(row), max_len))
                .filter(|row| !row.is_empty())
                .take(max_items)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn collect_flag_values(argv: &[String], key: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0usize;
    let flag = format!("--{key}");
    let prefix = format!("--{key}=");
    while i < argv.len() {
        let token = argv[i].trim();
        if token == flag {
            if let Some(next) = argv.get(i + 1) {
                if !next.starts_with("--") {
                    out.push(next.clone());
                    i += 2;
                    continue;
                }
            }
            out.push(String::new());
            i += 1;
            continue;
        }
        if let Some(value) = token.strip_prefix(&prefix) {
            out.push(value.to_string());
        }
        i += 1;
    }
    out
}

fn bool_from_env(name: &str) -> Option<bool> {
    let raw = std::env::var(name).ok()?;
    match raw.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Some(true),
        "0" | "false" | "no" | "off" => Some(false),
        _ => None,
    }
}

fn clean_text(value: Option<&str>, max_len: usize) -> String {
    let mut out = String::new();
    if let Some(raw) = value {
        for ch in raw.split_whitespace().collect::<Vec<_>>().join(" ").chars() {
            if out.len() >= max_len {
                break;
            }
            out.push(ch);
        }
    }
    out.trim().to_string()
}

fn estimate_tokens(value: &Value) -> i64 {
    let rendered = serde_json::to_string(value).unwrap_or_default();
    ((rendered.chars().count() + 3) / 4) as i64
}

fn parse_arg_value(memory_args: &[String], key: &str) -> Option<String> {
    let exact = format!("--{key}");
    let pref = format!("--{key}=");
    let mut i = 0usize;
    while i < memory_args.len() {
        let token = memory_args[i].as_str();
        if token == exact {
            if let Some(next) = memory_args.get(i + 1) {
                if !next.starts_with("--") {
                    return Some(next.clone());
                }
            }
            return Some(String::new());
        }
        if let Some(value) = token.strip_prefix(&pref) {
            return Some(value.to_string());
        }
        i += 1;
    }
    None
}

fn parse_bool_value(raw: Option<&str>, fallback: bool) -> bool {
    let Some(value) = raw else {
        return fallback;
    };
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn command_label(memory_command: &str) -> String {
    match memory_command {
        "query-index" => "query".to_string(),
        "get-node" => "get".to_string(),
        other => other.to_string(),
    }
}

fn is_nano_memory_command(memory_command: &str) -> bool {
    matches!(
        memory_command,
        "stable-nano-chat" | "stable-nano-train" | "stable-nano-fork"
    )
}

fn memory_batch22_command_claim_ids(memory_command: &str) -> &'static [&'static str] {
    match memory_command {
        "memory-taxonomy" | "stable-memory-taxonomy" => &["V6-MEMORY-011.1", "V6-MEMORY-011.5"],
        "memory-enable-metacognitive" | "stable-memory-enable-metacognitive" => {
            &["V6-MEMORY-011.2"]
        }
        "memory-share" | "stable-memory-share" => &["V6-MEMORY-011.3"],
        "memory-evolve" | "stable-memory-evolve" => &["V6-MEMORY-011.4"],
        "memory-enable-causality" | "stable-memory-enable-causality" => {
            &["V6-MEMORY-012.1", "V6-MEMORY-012.5"]
        }
        "memory-causal-retrieve" | "stable-memory-causal-retrieve" => &["V6-MEMORY-012.2"],
        "memory-benchmark-ama" | "stable-memory-benchmark-ama" => {
            &["V6-MEMORY-012.3", "V6-MEMORY-012.5"]
        }
        "memory-fuse" | "stable-memory-fuse" => &["V6-MEMORY-012.4"],
        _ => &[],
    }
}

fn is_batch22_memory_command(memory_command: &str) -> bool {
    !memory_batch22_command_claim_ids(memory_command).is_empty()
}

fn ensure_digest_field(memory_payload: &mut Value, field: &str, digest_input: Value) {
    let missing = memory_payload
        .get(field)
        .and_then(Value::as_str)
        .map(|value| value.trim().is_empty())
        .unwrap_or(true);
    if !missing {
        return;
    }
    if let Some(map) = memory_payload.as_object_mut() {
        map.insert(
            field.to_string(),
            Value::String(deterministic_receipt_hash(&digest_input)),
        );
    }
}

fn ensure_memory_contract_digests(
    memory_command: &str,
    memory_args: &[String],
    memory_payload: &mut Value,
) {
    match memory_command {
        "memory-enable-metacognitive" | "stable-memory-enable-metacognitive" => {
            ensure_digest_field(
                memory_payload,
                "config_digest",
                json!({
                    "type": memory_payload.get("type").and_then(Value::as_str).unwrap_or("memory_metacognitive_enable"),
                    "config_path": memory_payload.get("config_path").and_then(Value::as_str).unwrap_or(""),
                    "enabled": memory_payload.get("enabled").and_then(Value::as_bool).unwrap_or(true),
                    "note": parse_arg_value(memory_args, "note").unwrap_or_default()
                }),
            );
        }
        "memory-taxonomy" | "stable-memory-taxonomy" => {
            ensure_digest_field(
                memory_payload,
                "taxonomy_digest",
                json!({
                    "type": memory_payload.get("type").and_then(Value::as_str).unwrap_or("memory_taxonomy_4w"),
                    "row_count": memory_payload.get("row_count").and_then(Value::as_u64).unwrap_or(0),
                    "what_counts": memory_payload.get("what_counts").cloned().unwrap_or_else(|| json!({})),
                    "who_counts": memory_payload.get("who_counts").cloned().unwrap_or_else(|| json!({})),
                    "when_missing": memory_payload.get("when_missing").and_then(Value::as_u64).unwrap_or(0),
                    "where_missing": memory_payload.get("where_missing").and_then(Value::as_u64).unwrap_or(0)
                }),
            );
        }
        "memory-share" | "stable-memory-share" => {
            ensure_digest_field(
                memory_payload,
                "consent_scope_digest",
                json!({
                    "type": memory_payload.get("type").and_then(Value::as_str).unwrap_or("memory_share"),
                    "persona": memory_payload.get("persona").and_then(Value::as_str).unwrap_or(""),
                    "scope": memory_payload.get("scope").and_then(Value::as_str).unwrap_or(""),
                    "consent": memory_payload.get("consent").and_then(Value::as_bool).unwrap_or(false)
                }),
            );
        }
        "memory-evolve" | "stable-memory-evolve" => {
            ensure_digest_field(
                memory_payload,
                "evolution_digest",
                json!({
                    "type": memory_payload.get("type").and_then(Value::as_str).unwrap_or("memory_evolve"),
                    "generation": memory_payload.get("generation").and_then(Value::as_u64).unwrap_or(0),
                    "stability_score": memory_payload.get("stability_score").cloned().unwrap_or(Value::Null),
                    "state_path": memory_payload.get("evolution_state_path").and_then(Value::as_str).unwrap_or("")
                }),
            );
        }
        _ => {}
    }
}

fn memory_batch22_claim_evidence(
    memory_command: &str,
    memory_args: &[String],
    memory_payload: &Value,
) -> Vec<Value> {
    match memory_command {
        "memory-taxonomy" | "stable-memory-taxonomy" => vec![
            json!({
                "id": "V6-MEMORY-011.1",
                "claim": "memory_taxonomy_classifies_entries_into_4w_tags_with_deterministic_receipts",
                "evidence": {
                    "memory_command": memory_command,
                    "row_count": memory_payload.get("row_count").and_then(Value::as_u64).unwrap_or(0),
                    "taxonomy_path": memory_payload.get("taxonomy_path").and_then(Value::as_str).unwrap_or(""),
                    "taxonomy_digest": memory_payload.get("taxonomy_digest").and_then(Value::as_str).unwrap_or("")
                }
            }),
            json!({
                "id": "V6-MEMORY-011.5",
                "claim": "taxonomy_commands_emit_dashboard_ready_health_metrics_with_deterministic_receipts",
                "evidence": {
                    "memory_command": memory_command,
                    "when_missing": memory_payload.get("when_missing").and_then(Value::as_u64).unwrap_or(0),
                    "what_bucket_count": memory_payload.get("what_counts").and_then(Value::as_object).map(|m| m.len()).unwrap_or(0),
                    "taxonomy_digest": memory_payload.get("taxonomy_digest").and_then(Value::as_str).unwrap_or("")
                }
            }),
        ],
        "memory-enable-metacognitive" | "stable-memory-enable-metacognitive" => vec![json!({
            "id": "V6-MEMORY-011.2",
            "claim": "metacognitive_enable_persists_config_and_journal_with_deterministic_receipts",
            "evidence": {
                "memory_command": memory_command,
                "enabled": memory_payload.get("enabled").and_then(Value::as_bool).unwrap_or(false),
                "config_path": memory_payload.get("config_path").and_then(Value::as_str).unwrap_or(""),
                "config_digest": memory_payload.get("config_digest").and_then(Value::as_str).unwrap_or("")
            }
        })],
        "memory-share" | "stable-memory-share" => vec![json!({
            "id": "V6-MEMORY-011.3",
            "claim": "memory_share_enforces_consent_scoped_multi_agent_sharing_with_deterministic_receipts",
            "evidence": {
                "memory_command": memory_command,
                "persona": memory_payload.get("persona").and_then(Value::as_str).unwrap_or(""),
                "scope": memory_payload.get("scope").and_then(Value::as_str).unwrap_or(""),
                "consent": memory_payload.get("consent").and_then(Value::as_bool).unwrap_or(false),
                "consent_scope_digest": memory_payload.get("consent_scope_digest").and_then(Value::as_str).unwrap_or("")
            }
        })],
        "memory-evolve" | "stable-memory-evolve" => vec![json!({
            "id": "V6-MEMORY-011.4",
            "claim": "memory_evolve_writes_longitudinal_snapshots_with_generation_and_stability_receipts",
            "evidence": {
                "memory_command": memory_command,
                "generation": memory_payload.get("generation").and_then(Value::as_u64).unwrap_or(0),
                "stability_score": memory_payload.get("stability_score").cloned().unwrap_or(Value::Null),
                "evolution_state_path": memory_payload.get("evolution_state_path").and_then(Value::as_str).unwrap_or(""),
                "evolution_digest": memory_payload.get("evolution_digest").and_then(Value::as_str).unwrap_or("")
            }
        })],
        "memory-enable-causality" | "stable-memory-enable-causality" => vec![
            json!({
                "id": "V6-MEMORY-012.1",
                "claim": "memory_enable_causality_materializes_causality_graph_artifacts_with_edge_receipts",
                "evidence": {
                    "memory_command": memory_command,
                    "node_count": memory_payload.get("node_count").and_then(Value::as_u64).unwrap_or(0),
                    "edge_count": memory_payload.get("edge_count").and_then(Value::as_u64).unwrap_or(0),
                    "graph_path": memory_payload.get("graph_path").and_then(Value::as_str).unwrap_or("")
                }
            }),
            json!({
                "id": "V6-MEMORY-012.5",
                "claim": "causality_activation_commands_route_through_rust_core_with_deterministic_receipts",
                "evidence": {
                    "memory_command": memory_command,
                    "graph_path": memory_payload.get("graph_path").and_then(Value::as_str).unwrap_or("")
                }
            }),
        ],
        "memory-causal-retrieve" | "stable-memory-causal-retrieve" => vec![json!({
            "id": "V6-MEMORY-012.2",
            "claim": "memory_causal_retrieve_executes_deterministic_multi_hop_traversal_with_trace_receipts",
            "evidence": {
                "memory_command": memory_command,
                "depth": parse_arg_value(memory_args, "depth").and_then(|v| v.parse::<u64>().ok()).unwrap_or(2),
                "trace_count": memory_payload.get("trace_count").and_then(Value::as_u64).unwrap_or(0),
                "query": memory_payload.get("query").and_then(Value::as_str).unwrap_or("")
            }
        })],
        "memory-benchmark-ama" | "stable-memory-benchmark-ama" => vec![
            json!({
                "id": "V6-MEMORY-012.3",
                "claim": "memory_benchmark_ama_emits_reproducible_scored_benchmark_receipts",
                "evidence": {
                    "memory_command": memory_command,
                    "ama_score": memory_payload.get("ama_score").cloned().unwrap_or(Value::Null),
                    "pass": memory_payload.get("pass").and_then(Value::as_bool).unwrap_or(false),
                    "benchmark_path": memory_payload.get("benchmark_path").and_then(Value::as_str).unwrap_or("")
                }
            }),
            json!({
                "id": "V6-MEMORY-012.5",
                "claim": "ama_benchmark_commands_route_through_rust_core_with_deterministic_receipts",
                "evidence": {
                    "memory_command": memory_command,
                    "benchmark_path": memory_payload.get("benchmark_path").and_then(Value::as_str).unwrap_or("")
                }
            }),
        ],
        "memory-fuse" | "stable-memory-fuse" => vec![json!({
            "id": "V6-MEMORY-012.4",
            "claim": "memory_fuse_computes_4w_causality_metacognition_fusion_snapshots_with_score_receipts",
            "evidence": {
                "memory_command": memory_command,
                "fusion_score": memory_payload.get("fusion_score").cloned().unwrap_or(Value::Null),
                "fusion_state_path": memory_payload.get("fusion_state_path").and_then(Value::as_str).unwrap_or("")
            }
        })],
        _ => Vec::new(),
    }
}

fn cockpit_claim_evidence(
    memory_command: &str,
    memory_args: &[String],
    telemetry: &Value,
) -> Vec<Value> {
    if !is_nano_memory_command(memory_command) {
        return Vec::new();
    }

    let mut claims = Vec::new();
    match memory_command {
        "stable-nano-chat" => claims.push(json!({
            "id": "V6-COCKPIT-026.1",
            "claim": "chat_nano_routes_through_rust_core_memory_runtime_with_deterministic_receipts",
            "evidence": {
                "memory_command": memory_command
            }
        })),
        "stable-nano-train" => claims.push(json!({
            "id": "V6-COCKPIT-026.2",
            "claim": "train_nano_depth_harness_routes_through_stable_rust_memory_path",
            "evidence": {
                "memory_command": memory_command,
                "depth": parse_arg_value(memory_args, "depth").unwrap_or_else(|| "unknown".to_string())
            }
        })),
        "stable-nano-fork" => claims.push(json!({
            "id": "V6-COCKPIT-026.3",
            "claim": "nano_fork_emits_deterministic_fork_artifact_path_contract_receipts",
            "evidence": {
                "memory_command": memory_command,
                "target": parse_arg_value(memory_args, "target").unwrap_or_else(|| ".nanochat/fork".to_string())
            }
        })),
        _ => {}
    }

    claims.push(json!({
        "id": "V6-COCKPIT-026.4",
        "claim": "all_nano_commands_route_through_rust_core_memory_runtime_with_fail_closed_conduit_boundary",
        "evidence": {
            "memory_command": memory_command,
            "memory_args_count": memory_args.len()
        }
    }));

    claims.push(json!({
        "id": "V6-COCKPIT-026.5",
        "claim": "nano_mode_receipts_include_live_telemetry_for_dashboard_observability",
        "evidence": {
            "memory_command": memory_command,
            "tokens_total": telemetry
                .get("tokens")
                .and_then(|v| v.get("total"))
                .and_then(Value::as_i64)
                .unwrap_or(0),
            "retrieval_mode": telemetry
                .get("retrieval_mode")
                .and_then(Value::as_str)
                .unwrap_or("index_only")
        }
    }));

    claims
}

fn classify_retrieval_mode(memory_command: &str, memory_args: &[String]) -> String {
    if memory_command == "get-node" {
        return "node_read".to_string();
    }
    if memory_command != "query-index" {
        return "index_only".to_string();
    }
    let expand_lines = parse_arg_value(memory_args, "expand-lines")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    if expand_lines >= 120 {
        return "full_file".to_string();
    }
    if expand_lines > 0 {
        return "node_read".to_string();
    }
    "index_only".to_string()
}

fn token_threshold() -> i64 {
    std::env::var("MEMORY_RECALL_TOKEN_BURN_THRESHOLD")
        .ok()
        .and_then(|raw| raw.trim().parse::<i64>().ok())
        .filter(|value| *value >= 50)
        .unwrap_or(200)
}

fn telemetry_reasons(
    retrieval_mode: &str,
    total_tokens: i64,
    threshold_tokens: i64,
    memory_args: &[String],
) -> Vec<String> {
    let mut out = Vec::new();
    match retrieval_mode {
        "full_file" => out.push("full_file_mode".to_string()),
        "node_read" => out.push("node_expansion_path".to_string()),
        _ => out.push("index_first_path".to_string()),
    }

    let expand_lines = parse_arg_value(memory_args, "expand-lines")
        .and_then(|value| value.parse::<i64>().ok())
        .unwrap_or(0);
    if expand_lines > 40 {
        out.push("large_expand_lines".to_string());
    }
    if total_tokens > threshold_tokens {
        out.push("high_burn_threshold_exceeded".to_string());
    }
    out
}

fn build_token_telemetry(memory_command: &str, memory_args: &[String], payload: &Value) -> Value {
    let command = command_label(memory_command);
    let retrieval_mode = classify_retrieval_mode(memory_command, memory_args);
    let threshold_tokens = token_threshold();
    let retrieval_input = json!({
        "cmd": command,
        "q": parse_arg_value(memory_args, "q").unwrap_or_default(),
        "tags": parse_arg_value(memory_args, "tags").unwrap_or_default(),
        "top": parse_arg_value(memory_args, "top").unwrap_or_default(),
        "expand_lines": parse_arg_value(memory_args, "expand-lines").unwrap_or_default(),
        "node_id": parse_arg_value(memory_args, "node-id").unwrap_or_default(),
        "uid": parse_arg_value(memory_args, "uid").unwrap_or_default(),
        "args_count": memory_args.len()
    });
    let hydration_tokens = 0_i64;
    let retrieval_tokens = estimate_tokens(&retrieval_input);
    let response_tokens = estimate_tokens(payload);
    let total_tokens = hydration_tokens + retrieval_tokens + response_tokens;
    let reason_codes =
        telemetry_reasons(&retrieval_mode, total_tokens, threshold_tokens, memory_args);

    json!({
        "version": "1.0",
        "command": command,
        "retrieval_mode": retrieval_mode,
        "threshold_tokens": threshold_tokens,
        "tokens": {
            "hydration": hydration_tokens,
            "retrieval": retrieval_tokens,
            "response": response_tokens,
            "total": total_tokens
        },
        "reason_codes": reason_codes
    })
}

fn token_telemetry_path(root: &Path) -> PathBuf {
    if let Ok(custom) = std::env::var("MEMORY_RECALL_TOKEN_TELEMETRY_PATH") {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed);
            if candidate.is_absolute() {
                return candidate;
            }
            return root.join(candidate);
        }
    }
    root.join("client")
        .join("runtime")
        .join("local")
        .join("state")
        .join("memory")
        .join("query_token_metrics.jsonl")
}

fn normalize_path(root: &Path, value: Option<&Value>, fallback: &str) -> PathBuf {
    let raw = value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback);
    let candidate = PathBuf::from(raw);
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

fn parse_json_payload(stdout: &str) -> Option<Value> {
    let raw = stdout.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(payload) = serde_json::from_str::<Value>(raw) {
        return Some(payload);
    }
    for line in raw.lines().rev() {
        let trimmed = line.trim();
        if !trimmed.starts_with('{') {
            continue;
        }
        if let Ok(payload) = serde_json::from_str::<Value>(trimmed) {
            return Some(payload);
        }
    }
    None
}

fn load_policy(root: &Path) -> MemoryAmbientPolicy {
    let default_policy = root.join("config").join("mech_suit_mode_policy.json");
    let policy_path = std::env::var("MECH_SUIT_MODE_POLICY_PATH")
        .ok()
        .map(PathBuf::from)
        .map(|p| if p.is_absolute() { p } else { root.join(p) })
        .unwrap_or(default_policy);
    let policy = read_json(&policy_path).unwrap_or_else(|| json!({}));
    let enabled = bool_from_env("MECH_SUIT_MODE_FORCE").unwrap_or_else(|| {
        policy
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true)
    });
    let eyes = policy.get("eyes");
    let receipts = policy.get("receipts");
    let memory = policy.get("memory");
    let state = policy.get("state");

    let surface_levels = parse_string_array(memory.and_then(|v| v.get("surface_levels")), 6, 24)
        .into_iter()
        .map(|row| row.to_ascii_lowercase())
        .filter(|row| matches!(row.as_str(), "critical" | "warn" | "info"))
        .collect::<Vec<_>>();

    MemoryAmbientPolicy {
        enabled,
        rust_authoritative: memory
            .and_then(|v| v.get("rust_authoritative"))
            .and_then(Value::as_bool)
            .unwrap_or(true),
        push_attention_queue: memory
            .and_then(|v| v.get("push_attention_queue"))
            .and_then(Value::as_bool)
            .or_else(|| {
                eyes.and_then(|v| v.get("push_attention_queue"))
                    .and_then(Value::as_bool)
            })
            .unwrap_or(true),
        quiet_non_critical: memory
            .and_then(|v| v.get("quiet_non_critical"))
            .and_then(Value::as_bool)
            .or_else(|| {
                receipts
                    .and_then(|v| v.get("silent_unless_critical"))
                    .and_then(Value::as_bool)
            })
            .unwrap_or(true),
        surface_levels: if surface_levels.is_empty() {
            vec!["warn".to_string(), "critical".to_string()]
        } else {
            surface_levels
        },
        latest_path: normalize_path(
            root,
            memory.and_then(|v| v.get("latest_path")),
            "state/client/memory/ambient/latest.json",
        ),
        receipts_path: normalize_path(
            root,
            memory.and_then(|v| v.get("receipts_path")),
            "state/client/memory/ambient/receipts.jsonl",
        ),
        status_path: normalize_path(
            root,
            state.and_then(|v| v.get("status_path")),
            "state/ops/mech_suit_mode/latest.json",
        ),
        history_path: normalize_path(
            root,
            state.and_then(|v| v.get("history_path")),
            "state/ops/mech_suit_mode/history.jsonl",
        ),
        policy_path,
    }
}

fn resolve_memory_command(root: &PathBuf) -> (String, Vec<String>) {
    let explicit = std::env::var("PROTHEUS_MEMORY_CORE_BIN").ok();
    if let Some(bin) = explicit {
        let trimmed = bin.trim();
        if !trimmed.is_empty() {
            return (trimmed.to_string(), Vec::new());
        }
    }

    // Prefer the authoritative layer0/memory_runtime binary. Older paths may still
    // leave a `memory-cli` executable from legacy crates, so check both names.
    let release_primary = root
        .join("target")
        .join("release")
        .join("protheus-memory-core");
    if release_primary.exists() {
        return (release_primary.to_string_lossy().to_string(), Vec::new());
    }
    let debug_primary = root
        .join("target")
        .join("debug")
        .join("protheus-memory-core");
    if debug_primary.exists() {
        return (debug_primary.to_string_lossy().to_string(), Vec::new());
    }

    // If runtime roots point at tenant/temp paths, still resolve the compiled
    // authoritative binary from the workspace target directory.
    let workspace_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let ws_release_primary = workspace_root
        .join("target")
        .join("release")
        .join("protheus-memory-core");
    if ws_release_primary.exists() {
        return (ws_release_primary.to_string_lossy().to_string(), Vec::new());
    }
    let ws_debug_primary = workspace_root
        .join("target")
        .join("debug")
        .join("protheus-memory-core");
    if ws_debug_primary.exists() {
        return (ws_debug_primary.to_string_lossy().to_string(), Vec::new());
    }

    let release_compat = root.join("target").join("release").join("memory-cli");
    if release_compat.exists() {
        return (release_compat.to_string_lossy().to_string(), Vec::new());
    }
    let debug_compat = root.join("target").join("debug").join("memory-cli");
    if debug_compat.exists() {
        return (debug_compat.to_string_lossy().to_string(), Vec::new());
    }

    let manifest_path = workspace_root.join("core/layer0/memory_runtime/Cargo.toml");
    (
        "cargo".to_string(),
        vec![
            "run".to_string(),
            "--manifest-path".to_string(),
            manifest_path.to_string_lossy().to_string(),
            "--bin".to_string(),
            "protheus-memory-core".to_string(),
            "--".to_string(),
        ],
    )
}

fn resolve_protheus_ops_command(root: &PathBuf, domain: &str) -> (String, Vec<String>) {
    let explicit = std::env::var("PROTHEUS_OPS_BIN").ok();
    if let Some(bin) = explicit {
        let trimmed = bin.trim();
        if !trimmed.is_empty() {
            return (trimmed.to_string(), vec![domain.to_string()]);
        }
    }

    let release = root.join("target").join("release").join("protheus-ops");
    if release.exists() {
        return (
            release.to_string_lossy().to_string(),
            vec![domain.to_string()],
        );
    }
    let debug = root.join("target").join("debug").join("protheus-ops");
    if debug.exists() {
        return (
            debug.to_string_lossy().to_string(),
            vec![domain.to_string()],
        );
    }

    (
        "cargo".to_string(),
        vec![
            "run".to_string(),
            "--quiet".to_string(),
            "--manifest-path".to_string(),
            "core/layer0/ops/Cargo.toml".to_string(),
            "--bin".to_string(),
            "protheus-ops".to_string(),
            "--".to_string(),
            domain.to_string(),
        ],
    )
}

fn is_allowed_memory_command(command: &str) -> bool {
    matches!(
        command,
        "recall"
            | "query-index"
            | "probe"
            | "build-index"
            | "verify-envelope"
            | "compress"
            | "set-hot-state"
            | "ingest"
            | "get"
            | "clear-cache"
            | "ebbinghaus-score"
            | "crdt-exchange"
            | "load-embedded-heartbeat"
            | "load-embedded-execution-replay"
            | "load-embedded-vault-policy"
            | "load-embedded-observability-profile"
            | "pack-memory-blobs"
            | "pack-heartbeat-blob"
            | "cryonics-tier"
            | "memory-matrix"
            | "memory-auto-recall"
            | "dream-sequencer"
            | "rag-ingest"
            | "rag-search"
            | "rag-chat"
            | "rag-status"
            | "rag-merge-vault"
            | "memory-upgrade-byterover"
            | "memory-taxonomy"
            | "memory-enable-metacognitive"
            | "memory-enable-causality"
            | "memory-benchmark-ama"
            | "memory-share"
            | "memory-evolve"
            | "memory-causal-retrieve"
            | "memory-fuse"
            | "stable-status"
            | "stable-search"
            | "stable-get-node"
            | "stable-build-index"
            | "stable-rag-ingest"
            | "stable-rag-search"
            | "stable-rag-chat"
            | "stable-nano-chat"
            | "stable-nano-train"
            | "stable-nano-fork"
            | "stable-memory-upgrade-byterover"
            | "stable-memory-taxonomy"
            | "stable-memory-enable-metacognitive"
            | "stable-memory-enable-causality"
            | "stable-memory-benchmark-ama"
            | "stable-memory-share"
            | "stable-memory-evolve"
            | "stable-memory-causal-retrieve"
            | "stable-memory-fuse"
            | "help"
    )
}

fn run_memory_command(
    root: &Path,
    memory_command: &str,
    memory_args: &[String],
) -> Result<(Value, String, String, i32, Value), String> {
    let root_buf = root.to_path_buf();
    let (command, mut args) = resolve_memory_command(&root_buf);
    args.push(memory_command.to_string());
    args.extend(memory_args.iter().cloned());

    let output = Command::new(&command)
        .args(&args)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("memory_cli_spawn_failed:{err}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let exit_code = output.status.code().unwrap_or(1);

    let payload = parse_json_payload(&stdout).unwrap_or_else(|| {
        json!({
            "ok": false,
            "type": "memory_cli_invalid_payload",
            "reason": "memory_cli_invalid_json"
        })
    });

    let command_info = json!({
        "binary": command,
        "args": args,
        "exit_code": exit_code
    });

    Ok((payload, stdout, stderr, exit_code, command_info))
}

fn extract_memory_invocation(argv: &[String]) -> Result<(String, Vec<String>, String), String> {
    let flags = parse_cli_flags(argv);
    let run_context = clean_text(flags.get("run-context").map(String::as_str), 40);
    let run_context = if run_context.is_empty() {
        "memory".to_string()
    } else {
        run_context
    };

    if let Some(command) = flags
        .get("memory-command")
        .map(|raw| clean_text(Some(raw), 64).to_ascii_lowercase())
        .filter(|raw| !raw.is_empty())
    {
        let mut memory_args = collect_flag_values(argv, "memory-arg")
            .into_iter()
            .filter(|row| !row.trim().is_empty())
            .collect::<Vec<_>>();

        if let Some(encoded) = flags.get("memory-args-json") {
            let parsed = serde_json::from_str::<Value>(encoded)
                .map_err(|err| format!("memory_args_json_invalid:{err}"))?;
            let rows = parse_string_array(Some(&parsed), 128, 4_096);
            memory_args.extend(rows);
        }

        return Ok((command, memory_args, run_context));
    }

    let mut memory_command = String::new();
    let mut memory_args = Vec::new();
    let mut used_command = false;
    for token in argv {
        if token.starts_with("--") {
            continue;
        }
        if !used_command {
            memory_command = clean_text(Some(token), 64).to_ascii_lowercase();
            used_command = true;
            continue;
        }
        memory_args.push(token.clone());
    }

    if memory_command.is_empty() {
        return Err("missing_memory_command".to_string());
    }

    Ok((memory_command, memory_args, run_context))
}

fn classify_severity(memory_command: &str, op_ok: bool, payload: &Value) -> String {
    if !op_ok {
        return "critical".to_string();
    }
    if memory_command == "recall"
        && payload
            .get("hit_count")
            .and_then(Value::as_u64)
            .unwrap_or(0)
            == 0
    {
        return "warn".to_string();
    }
    "info".to_string()
}

fn should_surface(policy: &MemoryAmbientPolicy, severity: &str) -> bool {
    policy
        .surface_levels
        .iter()
        .any(|level| level.as_str() == severity)
}

fn enqueue_attention(
    root: &Path,
    memory_command: &str,
    severity: &str,
    op_ok: bool,
    run_context: &str,
    summary_line: &str,
) -> Result<Value, String> {
    let summary_hash = deterministic_receipt_hash(&json!({
        "memory_command": memory_command,
        "severity": severity,
        "ok": op_ok,
        "summary": summary_line
    }));
    let event = json!({
        "ts": now_iso(),
        "source": "memory_ambient",
        "source_type": "memory_operation",
        "severity": severity,
        "summary": summary_line,
        "attention_key": format!("memory:{memory_command}:{}", &summary_hash[..16]),
        "memory_command": memory_command,
        "operation_ok": op_ok
    });

    let payload = serde_json::to_string(&event)
        .map_err(|err| format!("attention_event_encode_failed:{err}"))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(payload.as_bytes());

    let root_buf = root.to_path_buf();
    let (command, mut args) = resolve_protheus_ops_command(&root_buf, "attention-queue");
    args.push("enqueue".to_string());
    args.push(format!("--event-json-base64={encoded}"));
    args.push(format!("--run-context={run_context}"));

    let output = Command::new(command)
        .args(args)
        .current_dir(root)
        .env(
            "PROTHEUS_NODE_BINARY",
            std::env::var("PROTHEUS_NODE_BINARY").unwrap_or_else(|_| "node".to_string()),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|err| format!("attention_queue_spawn_failed:{err}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let mut receipt = parse_json_payload(&stdout).unwrap_or_else(|| {
        json!({
            "ok": false,
            "type": "attention_queue_enqueue_error",
            "reason": "attention_queue_invalid_payload"
        })
    });

    if !receipt.is_object() {
        receipt = json!({
            "ok": false,
            "type": "attention_queue_enqueue_error",
            "reason": "attention_queue_invalid_payload"
        });
    }
    receipt["bridge_exit_code"] = Value::Number((output.status.code().unwrap_or(1) as i64).into());
    if !stderr.trim().is_empty() {
        receipt["bridge_stderr"] = Value::String(clean_text(Some(&stderr), 280));
    }

    let decision = receipt
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let accepted = matches!(
        decision,
        "admitted" | "deduped" | "backpressure_drop" | "disabled"
    );

    if !output.status.success() && !accepted {
        return Err(format!("attention_queue_enqueue_failed:{decision}"));
    }

    Ok(receipt)
}

fn policy_snapshot(policy: &MemoryAmbientPolicy) -> Value {
    json!({
        "enabled": policy.enabled,
        "rust_authoritative": policy.rust_authoritative,
        "push_attention_queue": policy.push_attention_queue,
        "quiet_non_critical": policy.quiet_non_critical,
        "surface_levels": policy.surface_levels,
        "latest_path": policy.latest_path.to_string_lossy().to_string(),
        "receipts_path": policy.receipts_path.to_string_lossy().to_string()
    })
}

fn update_mech_suit_status(policy: &MemoryAmbientPolicy, patch: Value) {
    let mut latest = read_json(&policy.status_path).unwrap_or_else(|| {
        json!({
            "ts": Value::Null,
            "active": policy.enabled,
            "components": {}
        })
    });
    if !latest.is_object() {
        latest = json!({
            "ts": Value::Null,
            "active": policy.enabled,
            "components": {}
        });
    }

    latest["ts"] = Value::String(now_iso());
    latest["active"] = Value::Bool(policy.enabled);
    if !latest
        .get("components")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        latest["components"] = json!({});
    }
    latest["policy_path"] = Value::String(policy.policy_path.to_string_lossy().to_string());
    latest["components"]["memory"] = patch.clone();
    write_json(&policy.status_path, &latest);

    append_jsonl(
        &policy.history_path,
        &json!({
            "ts": now_iso(),
            "type": "mech_suit_status",
            "component": "memory",
            "active": policy.enabled,
            "patch": patch
        }),
    );
}

fn cli_error_receipt(
    policy: &MemoryAmbientPolicy,
    command: &str,
    reason: &str,
    exit_code: i32,
) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "memory_ambient_error",
        "ts": now_iso(),
        "command": command,
        "reason": reason,
        "exit_code": exit_code,
        "ambient_mode_active": policy.enabled,
        "rust_authoritative": policy.rust_authoritative,
        "policy": policy_snapshot(policy)
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn cryonics_action(memory_args: &[String]) -> String {
    for token in memory_args {
        if let Some(v) = token.strip_prefix("--action=") {
            let out = clean_text(Some(v), 48).to_ascii_lowercase();
            if !out.is_empty() {
                return out;
            }
        }
    }
    memory_args
        .iter()
        .find(|row| !row.trim().starts_with("--"))
        .map(|row| clean_text(Some(row), 48).to_ascii_lowercase())
        .filter(|row| !row.is_empty())
        .unwrap_or_else(|| "run".to_string())
}

fn cryonics_compat_receipt(
    policy: &MemoryAmbientPolicy,
    command: &str,
    run_context: &str,
    memory_args: &[String],
) -> Value {
    let action = cryonics_action(memory_args);
    let mut out = json!({
        "ok": true,
        "type": "memory_ambient_compat",
        "ts": now_iso(),
        "command": command,
        "ambient_mode_active": policy.enabled,
        "rust_authoritative": policy.rust_authoritative,
        "memory_command": "cryonics-tier",
        "compatibility_only": true,
        "action": action,
        "run_context": run_context,
        "memory_args_count": memory_args.len(),
        "memory_args_hash": deterministic_receipt_hash(&json!(memory_args)),
        "severity": "info",
        "surfaced": false,
        "attention_queue": {
            "ok": true,
            "queued": false,
            "decision": "compatibility_no_enqueue",
            "routed_via": "rust_attention_queue"
        },
        "memory_payload": {
            "ok": true,
            "type": "cryonics_tier_compat",
            "action": action,
            "compatibility_only": true
        },
        "policy": policy_snapshot(policy)
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let policy = load_policy(root);
    if argv.is_empty() {
        usage();
        let receipt = cli_error_receipt(&policy, "unknown", "missing_command", 2);
        println!(
            "{}",
            serde_json::to_string(&receipt).unwrap_or_else(|_| "{\"ok\":false}".to_string())
        );
        return 2;
    }

    let command = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_default();

    if command == "status" {
        let latest = read_json(&policy.latest_path).unwrap_or_else(|| json!({}));
        let status_source = if latest.get("type").and_then(Value::as_str) == Some("memory_ambient")
        {
            "cached_latest"
        } else {
            "cold_status"
        };
        let mut claim_evidence = Vec::new();
        if latest
            .get("memory_command")
            .and_then(Value::as_str)
            .map(is_nano_memory_command)
            .unwrap_or(false)
        {
            claim_evidence.push(json!({
                "id": "V6-COCKPIT-026.5",
                "claim": "nano_mode_observability_is_surfaceable_through_status_dashboard_receipts",
                "evidence": {
                    "status_source": status_source,
                    "last_memory_command": latest
                        .get("memory_command")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                }
            }));
        }
        if latest
            .get("memory_command")
            .and_then(Value::as_str)
            .map(|cmd| matches!(cmd, "memory-taxonomy" | "stable-memory-taxonomy"))
            .unwrap_or(false)
        {
            claim_evidence.push(json!({
                "id": "V6-MEMORY-011.5",
                "claim": "taxonomy_health_metrics_are_surfaceable_through_status_dashboard_receipts",
                "evidence": {
                    "status_source": status_source,
                    "last_memory_command": latest
                        .get("memory_command")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown"),
                    "row_count": latest
                        .get("memory_payload")
                        .and_then(|v| v.get("row_count"))
                        .and_then(Value::as_u64)
                        .unwrap_or(0)
                }
            }));
        }
        let mut receipt = json!({
            "ok": true,
            "type": "memory_ambient_status",
            "ts": now_iso(),
            "status_source": status_source,
            "ambient_mode_active": policy.enabled,
            "rust_authoritative": policy.rust_authoritative,
            "policy": policy_snapshot(&policy),
            "last": latest,
            "claim_evidence": claim_evidence
        });
        receipt["receipt_hash"] = Value::String(deterministic_receipt_hash(&receipt));
        println!(
            "{}",
            serde_json::to_string(&receipt).unwrap_or_else(|_| "{\"ok\":false}".to_string())
        );
        return 0;
    }

    if command != "run" {
        usage();
        let receipt = cli_error_receipt(&policy, &command, "unknown_command", 2);
        println!(
            "{}",
            serde_json::to_string(&receipt).unwrap_or_else(|_| "{\"ok\":false}".to_string())
        );
        return 2;
    }

    let invocation =
        match extract_memory_invocation(&argv.iter().skip(1).cloned().collect::<Vec<_>>()) {
            Ok(v) => v,
            Err(reason) => {
                let receipt = cli_error_receipt(&policy, &command, &reason, 2);
                println!(
                    "{}",
                    serde_json::to_string(&receipt)
                        .unwrap_or_else(|_| "{\"ok\":false}".to_string())
                );
                return 2;
            }
        };

    let (memory_command, memory_args, run_context) = invocation;
    let run_flags = parse_cli_flags(&argv.iter().skip(1).cloned().collect::<Vec<_>>());
    let strict = parse_bool_value(run_flags.get("strict").map(String::as_str), false)
        || parse_bool_value(parse_arg_value(&memory_args, "strict").as_deref(), false);
    let bypass_requested = parse_bool_value(run_flags.get("bypass").map(String::as_str), false)
        || parse_bool_value(run_flags.get("client-bypass").map(String::as_str), false)
        || parse_bool_value(parse_arg_value(&memory_args, "bypass").as_deref(), false)
        || parse_bool_value(
            parse_arg_value(&memory_args, "client-bypass").as_deref(),
            false,
        );
    if strict
        && bypass_requested
        && (is_nano_memory_command(&memory_command) || is_batch22_memory_command(&memory_command))
    {
        let gate_claim_ids = if is_nano_memory_command(&memory_command) {
            vec!["V6-COCKPIT-026.4"]
        } else {
            memory_batch22_command_claim_ids(&memory_command).to_vec()
        };
        let gate_claim_evidence = gate_claim_ids
            .iter()
            .map(|claim_id| {
                json!({
                    "id": claim_id,
                    "claim": "memory_commands_fail_closed_when_conduit_bypass_is_requested",
                    "evidence": {
                        "memory_command": memory_command.clone(),
                        "bypass_requested": bypass_requested
                    }
                })
            })
            .collect::<Vec<Value>>();
        let mut receipt = json!({
            "ok": false,
            "type": "memory_ambient_conduit_gate",
            "ts": now_iso(),
            "command": command.clone(),
            "memory_command": memory_command.clone(),
            "strict": strict,
            "errors": ["conduit_bypass_rejected"],
            "claim_evidence": gate_claim_evidence,
            "policy": policy_snapshot(&policy)
        });
        receipt["receipt_hash"] = Value::String(deterministic_receipt_hash(&receipt));
        write_json(&policy.latest_path, &receipt);
        append_jsonl(&policy.receipts_path, &receipt);
        update_mech_suit_status(
            &policy,
            json!({
                "ambient": policy.enabled,
                "rust_authoritative": policy.rust_authoritative,
                "push_attention_queue": policy.push_attention_queue,
                "quiet_non_critical": policy.quiet_non_critical,
                "last_result": "memory_ambient_conduit_gate",
                "last_command": command,
                "last_memory_command": memory_command,
                "last_ok": false,
                "last_severity": "critical",
                "last_attention_decision": "conduit_bypass_rejected"
            }),
        );
        println!(
            "{}",
            serde_json::to_string(&receipt).unwrap_or_else(|_| "{\"ok\":false}".to_string())
        );
        return 1;
    }

    if memory_command == "cryonics-tier" {
        let receipt = cryonics_compat_receipt(&policy, &command, &run_context, &memory_args);
        write_json(&policy.latest_path, &receipt);
        append_jsonl(&policy.receipts_path, &receipt);
        update_mech_suit_status(
            &policy,
            json!({
                "ambient": policy.enabled,
                "rust_authoritative": policy.rust_authoritative,
                "push_attention_queue": policy.push_attention_queue,
                "quiet_non_critical": policy.quiet_non_critical,
                "last_result": "memory_ambient_compat",
                "last_command": command,
                "last_memory_command": "cryonics-tier",
                "last_ok": true,
                "last_severity": "info",
                "last_attention_decision": "compatibility_no_enqueue"
            }),
        );
        println!(
            "{}",
            serde_json::to_string(&receipt).unwrap_or_else(|_| "{\"ok\":false}".to_string())
        );
        return 0;
    }

    if !is_allowed_memory_command(&memory_command) {
        let receipt = cli_error_receipt(
            &policy,
            &command,
            &format!("memory_command_not_allowed:{memory_command}"),
            1,
        );
        println!(
            "{}",
            serde_json::to_string(&receipt).unwrap_or_else(|_| "{\"ok\":false}".to_string())
        );
        return 1;
    }

    let (mut memory_payload, stdout, stderr, exit_code, command_info) =
        match run_memory_command(root, &memory_command, &memory_args) {
            Ok(value) => value,
            Err(reason) => {
                let receipt = cli_error_receipt(&policy, &command, &reason, 1);
                println!(
                    "{}",
                    serde_json::to_string(&receipt)
                        .unwrap_or_else(|_| "{\"ok\":false}".to_string())
                );
                return 1;
            }
        };
    ensure_memory_contract_digests(&memory_command, &memory_args, &mut memory_payload);

    let memory_ok = memory_payload
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let op_ok = exit_code == 0 && memory_ok;
    let severity = classify_severity(&memory_command, op_ok, &memory_payload);
    let surfaced = policy.enabled
        && policy.push_attention_queue
        && should_surface(&policy, &severity)
        && (!policy.quiet_non_critical || severity == "critical");

    let summary_line = if op_ok {
        format!("memory op ok ({memory_command})")
    } else {
        format!("memory op failed ({memory_command})")
    };
    let token_telemetry = build_token_telemetry(&memory_command, &memory_args, &memory_payload);
    let mut claim_evidence =
        cockpit_claim_evidence(&memory_command, &memory_args, &token_telemetry);
    claim_evidence.extend(memory_batch22_claim_evidence(
        &memory_command,
        &memory_args,
        &memory_payload,
    ));

    let attention_queue = if surfaced {
        match enqueue_attention(
            root,
            &memory_command,
            &severity,
            op_ok,
            &run_context,
            &summary_line,
        ) {
            Ok(value) => value,
            Err(reason) => {
                let receipt = cli_error_receipt(&policy, &command, &reason, 1);
                println!(
                    "{}",
                    serde_json::to_string(&receipt)
                        .unwrap_or_else(|_| "{\"ok\":false}".to_string())
                );
                return 1;
            }
        }
    } else {
        json!({
            "ok": true,
            "queued": false,
            "decision": if !policy.enabled { "ambient_disabled" } else if !policy.push_attention_queue { "attention_queue_disabled" } else if !should_surface(&policy, &severity) { "below_threshold" } else if policy.quiet_non_critical && severity != "critical" { "quiet_non_critical" } else { "not_enqueued" },
            "routed_via": "rust_attention_queue"
        })
    };

    let mut receipt = json!({
        "ok": op_ok,
        "type": "memory_ambient",
        "ts": now_iso(),
        "command": command,
        "run_context": run_context,
        "ambient_mode_active": policy.enabled,
        "rust_authoritative": policy.rust_authoritative,
        "memory_command": memory_command,
        "memory_args_count": memory_args.len(),
        "memory_args_hash": deterministic_receipt_hash(&json!(memory_args)),
        "severity": severity,
        "surfaced": surfaced,
        "attention_queue": attention_queue,
        "memory_payload": memory_payload,
        "memory_command_info": command_info,
        "stdout": if op_ok && policy.quiet_non_critical { "".to_string() } else { clean_text(Some(&stdout), 2_000) },
        "stderr": clean_text(Some(&stderr), 2_000),
        "exit_code": exit_code,
        "token_telemetry": token_telemetry,
        "claim_evidence": claim_evidence,
        "policy": policy_snapshot(&policy)
    });
    receipt["receipt_hash"] = Value::String(deterministic_receipt_hash(&receipt));

    append_jsonl(
        &token_telemetry_path(root),
        &json!({
            "ts": now_iso(),
            "lane": "memory_recall",
            "retrieval_mode": receipt
                .get("token_telemetry")
                .and_then(|v| v.get("retrieval_mode"))
                .and_then(Value::as_str)
                .unwrap_or("index_only"),
            "reason_codes": receipt
                .get("token_telemetry")
                .and_then(|v| v.get("reason_codes"))
                .cloned()
                .unwrap_or_else(|| json!([])),
            "tokens": receipt
                .get("token_telemetry")
                .and_then(|v| v.get("tokens"))
                .cloned()
                .unwrap_or_else(|| json!({})),
            "threshold_tokens": receipt
                .get("token_telemetry")
                .and_then(|v| v.get("threshold_tokens"))
                .and_then(Value::as_i64)
                .unwrap_or(200),
            "command": receipt
                .get("token_telemetry")
                .and_then(|v| v.get("command"))
                .and_then(Value::as_str)
                .unwrap_or("query")
        }),
    );

    write_json(&policy.latest_path, &receipt);
    append_jsonl(&policy.receipts_path, &receipt);

    update_mech_suit_status(
        &policy,
        json!({
            "ambient": policy.enabled,
            "rust_authoritative": policy.rust_authoritative,
            "push_attention_queue": policy.push_attention_queue,
            "quiet_non_critical": policy.quiet_non_critical,
            "last_result": "memory_ambient",
            "last_command": command,
            "last_memory_command": receipt.get("memory_command").and_then(Value::as_str).unwrap_or("unknown"),
            "last_ok": op_ok,
            "last_severity": severity,
            "last_attention_decision": receipt
                .get("attention_queue")
                .and_then(|v| v.get("decision"))
                .and_then(Value::as_str)
                .unwrap_or("unknown")
        }),
    );

    println!(
        "{}",
        serde_json::to_string(&receipt).unwrap_or_else(|_| "{\"ok\":false}".to_string())
    );

    if op_ok {
        0
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surface_policy_respects_level_filter() {
        let policy = MemoryAmbientPolicy {
            enabled: true,
            rust_authoritative: true,
            push_attention_queue: true,
            quiet_non_critical: false,
            surface_levels: vec!["warn".to_string(), "critical".to_string()],
            latest_path: PathBuf::from("/tmp/latest.json"),
            receipts_path: PathBuf::from("/tmp/receipts.jsonl"),
            status_path: PathBuf::from("/tmp/status.json"),
            history_path: PathBuf::from("/tmp/history.jsonl"),
            policy_path: PathBuf::from("/tmp/policy.json"),
        };
        assert!(!should_surface(&policy, "info"));
        assert!(should_surface(&policy, "warn"));
        assert!(should_surface(&policy, "critical"));
    }
}
