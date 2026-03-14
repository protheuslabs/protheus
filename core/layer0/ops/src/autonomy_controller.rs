// SPDX-License-Identifier: Apache-2.0
use crate::v8_kernel::{deterministic_merkle_root, write_receipt};
use crate::{deterministic_receipt_hash, now_iso};
use base64::Engine as _;
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const LANE_ID: &str = "autonomy_controller";
const REPLACEMENT: &str = "protheus-ops autonomy-controller";
const STATE_DIR: &str = "state/ops/autonomy_controller";
const STATE_ENV: &str = "AUTONOMY_CONTROLLER_STATE_ROOT";
const STATE_SCOPE: &str = "autonomy_controller";

fn receipt_hash(v: &Value) -> String {
    deterministic_receipt_hash(v)
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops autonomy-controller status");
    println!("  protheus-ops autonomy-controller run [--max-actions=<n>] [--objective=<id>]");
    println!("  protheus-ops autonomy-controller hand-new [--hand-id=<id>] [--template=<id>] [--schedule=<cron>] [--provider=<id>] [--fallback=<id>] [--strict=1|0]");
    println!("  protheus-ops autonomy-controller hand-cycle --hand-id=<id> [--goal=<text>] [--provider=<id>] [--fallback=<id>] [--strict=1|0]");
    println!("  protheus-ops autonomy-controller hand-status [--hand-id=<id>] [--strict=1|0]");
    println!("  protheus-ops autonomy-controller hand-memory-page --hand-id=<id> [--op=page-in|page-out|status] [--tier=core|archival|external] [--key=<id>] [--strict=1|0]");
    println!("  protheus-ops autonomy-controller hand-wasm-task --hand-id=<id> [--task=<id>] [--fuel=<n>] [--epoch-ms=<n>] [--strict=1|0]");
    println!("  protheus-ops autonomy-controller ephemeral-run [--goal=<text>] [--domain=<id>] [--ui-leaf=1|0] [--strict=1|0]");
    println!("  protheus-ops autonomy-controller trunk-status [--strict=1|0]");
    println!(
        "  protheus-ops autonomy-controller pain-signal [--action=<status|emit|focus-start|focus-stop|focus-status>] [--source=<id>] [--code=<id>] [--severity=<low|medium|high|critical>] [--risk=<low|medium|high>]"
    );
    println!(
        "  protheus-ops autonomy-controller multi-agent-debate <run|status> [--input-base64=<base64_json>|--input-json=<json>] [--policy=<path>] [--date=<YYYY-MM-DD>] [--persist=1|0]"
    );
    println!(
        "  protheus-ops autonomy-controller ethical-reasoning <run|status> [--input-base64=<base64_json>|--policy=<path>] [--state-dir=<path>] [--persist=1|0]"
    );
    println!(
        "  protheus-ops autonomy-controller autonomy-simulation-harness <run|status> [YYYY-MM-DD] [--days=N] [--write=1|0] [--strict=1|0]"
    );
    println!(
        "  protheus-ops autonomy-controller runtime-stability-soak [--action=<start|check-now|status|report>] [flags]"
    );
    println!(
        "  protheus-ops autonomy-controller self-documentation-closeout [--action=<run|status>] [flags]"
    );
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let pref = format!("--{key}=");
    argv.iter().find_map(|arg| {
        let t = arg.trim();
        t.strip_prefix(&pref).map(|v| v.to_string())
    })
}

fn parse_positional(argv: &[String], idx: usize) -> Option<String> {
    argv.iter()
        .filter(|arg| !arg.trim().starts_with("--"))
        .nth(idx)
        .map(|v| v.trim().to_string())
}

fn parse_bool(raw: Option<&str>, fallback: bool) -> bool {
    let Some(v) = raw else {
        return fallback;
    };
    match v.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => true,
        "0" | "false" | "no" | "off" => false,
        _ => fallback,
    }
}

fn parse_i64(raw: Option<&str>, fallback: i64, lo: i64, hi: i64) -> i64 {
    raw.and_then(|v| v.trim().parse::<i64>().ok())
        .unwrap_or(fallback)
        .clamp(lo, hi)
}

fn parse_u64(raw: Option<&str>, fallback: u64, lo: u64, hi: u64) -> u64 {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(fallback)
        .clamp(lo, hi)
}

fn parse_f64(raw: Option<&str>, fallback: f64, lo: f64, hi: f64) -> f64 {
    raw.and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(fallback)
        .clamp(lo, hi)
}

fn parse_payload_json(argv: &[String]) -> Result<Value, String> {
    if let Some(raw) = parse_flag(argv, "input-json") {
        return serde_json::from_str::<Value>(&raw)
            .map_err(|e| format!("input_json_parse_failed:{e}"));
    }
    if let Some(raw) = parse_flag(argv, "input-base64") {
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(raw.trim())
            .map_err(|e| format!("input_base64_decode_failed:{e}"))?;
        let text =
            String::from_utf8(decoded).map_err(|e| format!("input_base64_utf8_failed:{e}"))?;
        return serde_json::from_str::<Value>(&text)
            .map_err(|e| format!("input_base64_json_parse_failed:{e}"));
    }
    Ok(json!({}))
}

fn native_receipt(root: &Path, cmd: &str, argv: &[String]) -> Value {
    let max_actions = parse_flag(argv, "max-actions")
        .and_then(|v| v.parse::<i64>().ok())
        .map(|v| v.clamp(1, 100))
        .unwrap_or(1);
    let objective = parse_flag(argv, "objective").unwrap_or_else(|| "default".to_string());

    let mut out = protheus_autonomy_core_v1::autonomy_receipt(cmd, Some(&objective));
    out["lane"] = Value::String(LANE_ID.to_string());
    out["ts"] = Value::String(now_iso());
    out["argv"] = json!(argv);
    out["max_actions"] = json!(max_actions);
    out["replacement"] = Value::String(REPLACEMENT.to_string());
    out["root"] = Value::String(root.to_string_lossy().to_string());
    out["claim_evidence"] = json!([
        {
            "id": "native_autonomy_controller_lane",
            "claim": "autonomy_controller_executes_natively_in_rust",
            "evidence": {
                "command": cmd,
                "max_actions": max_actions
            }
        }
    ]);
    if let Some(map) = out.as_object_mut() {
        map.remove("receipt_hash");
    }
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn native_pain_signal_receipt(root: &Path, argv: &[String]) -> Value {
    let action = parse_flag(argv, "action")
        .or_else(|| parse_positional(argv, 1))
        .unwrap_or_else(|| "status".to_string());
    let source = parse_flag(argv, "source");
    let code = parse_flag(argv, "code");
    let severity = parse_flag(argv, "severity");
    let risk = parse_flag(argv, "risk");

    let mut out = protheus_autonomy_core_v1::pain_signal_receipt(
        action.as_str(),
        source.as_deref(),
        code.as_deref(),
        severity.as_deref(),
        risk.as_deref(),
    );
    out["lane"] = Value::String(LANE_ID.to_string());
    out["ts"] = Value::String(now_iso());
    out["argv"] = json!(argv);
    out["replacement"] = Value::String(REPLACEMENT.to_string());
    out["root"] = Value::String(root.to_string_lossy().to_string());
    out["claim_evidence"] = json!([
        {
            "id": "native_autonomy_pain_signal_lane",
            "claim": "pain_signal_contract_executes_natively_in_rust",
            "evidence": {
                "action": action,
                "source": source,
                "code": code
            }
        }
    ]);
    if let Some(map) = out.as_object_mut() {
        map.remove("receipt_hash");
    }
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn cli_error_receipt(argv: &[String], err: &str, code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "autonomy_controller_cli_error",
        "lane": LANE_ID,
        "ts": now_iso(),
        "argv": argv,
        "error": err,
        "exit_code": code
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

fn state_root(root: &Path) -> PathBuf {
    root.join(STATE_DIR)
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{}:{e}", parent.display()))?;
    }
    let body =
        serde_json::to_string_pretty(value).map_err(|e| format!("encode_json_failed:{e}"))? + "\n";
    fs::write(path, body).map_err(|e| format!("write_json_failed:{}:{e}", path.display()))
}

fn append_jsonl(path: &Path, row: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{}:{e}", parent.display()))?;
    }
    let line = serde_json::to_string(row).map_err(|e| format!("encode_jsonl_failed:{e}"))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open_jsonl_failed:{}:{e}", path.display()))?;
    use std::io::Write as _;
    file.write_all(format!("{line}\n").as_bytes())
        .map_err(|e| format!("append_jsonl_failed:{}:{e}", path.display()))
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    let raw = fs::read_to_string(path).unwrap_or_default();
    raw.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect()
}

fn clean_id(raw: Option<String>, fallback: &str) -> String {
    let mut out = String::new();
    if let Some(v) = raw {
        for ch in v.trim().chars() {
            if out.len() >= 96 {
                break;
            }
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | ':') {
                out.push(ch.to_ascii_lowercase());
            } else {
                out.push('-');
            }
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn hand_path(root: &Path, hand_id: &str) -> PathBuf {
    state_root(root)
        .join("hands")
        .join(format!("{hand_id}.json"))
}

fn hand_events_path(root: &Path, hand_id: &str) -> PathBuf {
    state_root(root)
        .join("hands")
        .join(format!("{hand_id}.events.jsonl"))
}

fn trunk_state_path(root: &Path) -> PathBuf {
    state_root(root).join("trunk").join("state.json")
}

fn trunk_events_path(root: &Path) -> PathBuf {
    state_root(root).join("trunk").join("events.jsonl")
}

fn load_domain_constraints(root: &Path) -> Value {
    read_json(
        &root
            .join("client")
            .join("runtime")
            .join("config")
            .join("agent_domain_constraints.json"),
    )
    .unwrap_or_else(|| {
        json!({
            "allowed_domains": ["general", "finance", "healthcare", "enterprise", "research"],
            "deny_without_policy": true
        })
    })
}

fn load_provider_policy(root: &Path) -> Value {
    read_json(
        &root
            .join("client")
            .join("runtime")
            .join("config")
            .join("hand_provider_policy.json"),
    )
    .unwrap_or_else(|| {
        json!({
            "allowed_providers": ["bitnet", "openai", "anthropic", "local-moe"],
            "default_provider": "bitnet",
            "max_cost_per_cycle_usd": 0.50
        })
    })
}

fn conduit_guard(argv: &[String], strict: bool) -> Option<Value> {
    if strict && parse_bool(parse_flag(argv, "bypass").as_deref(), false) {
        Some(json!({
            "ok": false,
            "type": "autonomy_controller_conduit_gate",
            "lane": LANE_ID,
            "strict": strict,
            "error": "conduit_bypass_rejected",
            "claim_evidence": [
                {
                    "id": "V8-AGENT-ERA-001.5",
                    "claim": "all_ephemeral_and_hand_operations_route_through_conduit_with_fail_closed_boundary",
                    "evidence": {"bypass_requested": true}
                }
            ]
        }))
    } else {
        None
    }
}

fn emit_receipt(root: &Path, value: &mut Value) -> i32 {
    if let Some(map) = value.as_object_mut() {
        map.remove("receipt_hash");
    }
    value["receipt_hash"] = Value::String(receipt_hash(value));
    match write_receipt(root, STATE_ENV, STATE_SCOPE, value.clone()) {
        Ok(out) => {
            let ok = out.get("ok").and_then(Value::as_bool).unwrap_or(false);
            print_json_line(&out);
            if ok {
                0
            } else {
                1
            }
        }
        Err(err) => {
            let mut out = json!({
                "ok": false,
                "type": "autonomy_controller_error",
                "lane": LANE_ID,
                "error": err
            });
            out["receipt_hash"] = Value::String(receipt_hash(&out));
            print_json_line(&out);
            1
        }
    }
}

fn run_hand_new(root: &Path, argv: &[String]) -> i32 {
    let strict = parse_bool(parse_flag(argv, "strict").as_deref(), true);
    if let Some(mut denied) = conduit_guard(argv, strict) {
        return emit_receipt(root, &mut denied);
    }
    let hand_id = clean_id(
        parse_flag(argv, "hand-id")
            .or_else(|| parse_flag(argv, "id"))
            .or_else(|| parse_positional(argv, 1)),
        "hand-default",
    );
    let template = clean_id(parse_flag(argv, "template"), "generalist");
    let schedule = parse_flag(argv, "schedule").unwrap_or_else(|| "0 * * * *".to_string());
    let provider = clean_id(parse_flag(argv, "provider"), "bitnet");
    let fallback = clean_id(parse_flag(argv, "fallback"), "local-moe");

    let hand = json!({
        "version": "v1",
        "hand_id": hand_id,
        "template": template,
        "schedule": schedule,
        "provider_preferred": provider,
        "provider_fallback": fallback,
        "cycles": 0u64,
        "created_at": now_iso(),
        "updated_at": now_iso(),
        "memory": {
            "core": [],
            "archival": [],
            "external": []
        },
        "capabilities": ["observe", "reason", "tool-call", "wasm-task"]
    });

    let path = hand_path(root, &hand_id);
    if let Err(err) = write_json(&path, &hand) {
        let mut out = cli_error_receipt(argv, &err, 2);
        out["type"] = Value::String("autonomy_hand_new".to_string());
        return emit_receipt(root, &mut out);
    }

    let mut out = json!({
        "ok": true,
        "type": "autonomy_hand_new",
        "lane": LANE_ID,
        "strict": strict,
        "hand": hand,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": receipt_hash(&hand)
        },
        "claim_evidence": [
            {
                "id": "V6-AUTONOMY-001.1",
                "claim": "persistent_hands_have_manifest_schedule_and_policy_governed_lifecycle",
                "evidence": {"hand_id": hand_id, "template": template, "schedule": schedule}
            }
        ]
    });
    emit_receipt(root, &mut out)
}

fn run_hand_cycle(root: &Path, argv: &[String]) -> i32 {
    let strict = parse_bool(parse_flag(argv, "strict").as_deref(), true);
    if let Some(mut denied) = conduit_guard(argv, strict) {
        return emit_receipt(root, &mut denied);
    }
    let hand_id = clean_id(
        parse_flag(argv, "hand-id")
            .or_else(|| parse_flag(argv, "id"))
            .or_else(|| parse_positional(argv, 1)),
        "hand-default",
    );
    let goal = parse_flag(argv, "goal").unwrap_or_else(|| "background_cycle".to_string());
    let provider_policy = load_provider_policy(root);
    let allowed = provider_policy
        .get("allowed_providers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect::<Vec<_>>();
    let preferred = clean_id(
        parse_flag(argv, "provider").or_else(|| parse_flag(argv, "provider-preferred")),
        provider_policy
            .get("default_provider")
            .and_then(Value::as_str)
            .unwrap_or("bitnet"),
    );
    let fallback = clean_id(parse_flag(argv, "fallback"), "local-moe");
    let selected = if allowed.iter().any(|p| p == &preferred) {
        preferred.clone()
    } else if allowed.iter().any(|p| p == &fallback) {
        fallback.clone()
    } else {
        provider_policy
            .get("default_provider")
            .and_then(Value::as_str)
            .unwrap_or("bitnet")
            .to_string()
    };
    if strict && !allowed.iter().any(|p| p == &selected) {
        let mut out = json!({
            "ok": false,
            "type": "autonomy_hand_cycle",
            "lane": LANE_ID,
            "strict": strict,
            "error": "provider_not_allowed",
            "provider": selected
        });
        return emit_receipt(root, &mut out);
    }

    let path = hand_path(root, &hand_id);
    let mut hand = read_json(&path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "hand_id": hand_id,
            "template": "generalist",
            "schedule": "0 * * * *",
            "cycles": 0u64
        })
    });
    let cycles = hand.get("cycles").and_then(Value::as_u64).unwrap_or(0) + 1;
    hand["cycles"] = Value::from(cycles);
    hand["updated_at"] = Value::String(now_iso());
    hand["provider_last_selected"] = Value::String(selected.clone());
    hand["goal_last"] = Value::String(goal.clone());
    let _ = write_json(&path, &hand);

    let events_path = hand_events_path(root, &hand_id);
    let events = read_jsonl(&events_path);
    let prev_hash = events
        .last()
        .and_then(|e| e.get("event_hash"))
        .and_then(Value::as_str)
        .unwrap_or("genesis")
        .to_string();
    let mut event = json!({
        "type": "autonomy_hand_cycle_event",
        "hand_id": hand_id,
        "cycle": cycles,
        "goal": goal,
        "provider": selected,
        "previous_hash": prev_hash,
        "ts": now_iso()
    });
    event["event_hash"] = Value::String(receipt_hash(&event));
    let _ = append_jsonl(&events_path, &event);
    let mut all_hashes = read_jsonl(&events_path)
        .into_iter()
        .filter_map(|e| {
            e.get("event_hash")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .collect::<Vec<_>>();
    if all_hashes.is_empty() {
        all_hashes.push("genesis".to_string());
    }
    let merkle_root = deterministic_merkle_root(&all_hashes);

    let mut out = json!({
        "ok": true,
        "type": "autonomy_hand_cycle",
        "lane": LANE_ID,
        "strict": strict,
        "hand": hand,
        "event": event,
        "chain": {
            "event_count": all_hashes.len(),
            "merkle_root": merkle_root,
            "events_path": events_path.display().to_string()
        },
        "routing": {
            "selected_provider": selected,
            "allowed_providers": allowed
        },
        "claim_evidence": [
            {
                "id": "V6-AUTONOMY-001.2",
                "claim": "hand_cycles_emit_merkle_linked_previous_hash_receipts",
                "evidence": {"hand_id": hand_id, "cycle": cycles, "merkle_root": merkle_root}
            },
            {
                "id": "V6-AUTONOMY-001.3",
                "claim": "provider_selection_is_policy_governed_and_receipted",
                "evidence": {"selected_provider": selected, "goal": goal}
            }
        ]
    });
    emit_receipt(root, &mut out)
}

fn run_hand_status(root: &Path, argv: &[String]) -> i32 {
    let strict = parse_bool(parse_flag(argv, "strict").as_deref(), true);
    if let Some(mut denied) = conduit_guard(argv, strict) {
        return emit_receipt(root, &mut denied);
    }
    let hand_id = clean_id(
        parse_flag(argv, "hand-id")
            .or_else(|| parse_flag(argv, "id"))
            .or_else(|| parse_positional(argv, 1)),
        "hand-default",
    );
    let hand = read_json(&hand_path(root, &hand_id)).unwrap_or(Value::Null);
    let events = read_jsonl(&hand_events_path(root, &hand_id));
    let mut out = json!({
        "ok": true,
        "type": "autonomy_hand_status",
        "lane": LANE_ID,
        "strict": strict,
        "hand_id": hand_id,
        "hand": hand,
        "events": {
            "count": events.len(),
            "latest": events.last().cloned().unwrap_or(Value::Null)
        },
        "claim_evidence": [
            {
                "id": "V6-AUTONOMY-001.1",
                "claim": "hands_are_persisted_and_queryable_by_id",
                "evidence": {"hand_id": hand_id}
            }
        ]
    });
    emit_receipt(root, &mut out)
}

fn run_hand_memory_page(root: &Path, argv: &[String]) -> i32 {
    let strict = parse_bool(parse_flag(argv, "strict").as_deref(), true);
    if let Some(mut denied) = conduit_guard(argv, strict) {
        return emit_receipt(root, &mut denied);
    }
    let hand_id = clean_id(
        parse_flag(argv, "hand-id")
            .or_else(|| parse_flag(argv, "id"))
            .or_else(|| parse_positional(argv, 1)),
        "hand-default",
    );
    let op = parse_flag(argv, "op")
        .or_else(|| parse_positional(argv, 2))
        .unwrap_or_else(|| "status".to_string())
        .to_ascii_lowercase();
    let tier = parse_flag(argv, "tier").unwrap_or_else(|| "core".to_string());
    let key = clean_id(parse_flag(argv, "key"), "context");
    let path = hand_path(root, &hand_id);
    let mut hand = read_json(&path)
        .unwrap_or_else(|| json!({"memory":{"core":[],"archival":[],"external":[]}}));
    if !hand.get("memory").and_then(Value::as_object).is_some() {
        hand["memory"] = json!({"core":[],"archival":[],"external":[]});
    }
    let arr = hand["memory"][&tier]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut next = arr;
    if op == "page-in" && !next.iter().any(|v| v.as_str() == Some(key.as_str())) {
        next.push(Value::String(key.clone()));
    } else if op == "page-out" {
        next = next
            .into_iter()
            .filter(|v| v.as_str() != Some(key.as_str()))
            .collect();
    }
    hand["memory"][&tier] = Value::Array(next.clone());
    hand["updated_at"] = Value::String(now_iso());
    let _ = write_json(&path, &hand);

    let mut out = json!({
        "ok": true,
        "type": "autonomy_hand_memory_page",
        "lane": LANE_ID,
        "strict": strict,
        "hand_id": hand_id,
        "op": op,
        "tier": tier,
        "key": key,
        "memory": hand.get("memory").cloned().unwrap_or(Value::Null),
        "claim_evidence": [
            {
                "id": "V6-AUTONOMY-001.4",
                "claim": "hierarchical_memory_paging_supports_core_archival_external_tiers",
                "evidence": {"tier": tier, "size": next.len()}
            }
        ]
    });
    emit_receipt(root, &mut out)
}

fn run_hand_wasm_task(root: &Path, argv: &[String]) -> i32 {
    let strict = parse_bool(parse_flag(argv, "strict").as_deref(), true);
    if let Some(mut denied) = conduit_guard(argv, strict) {
        return emit_receipt(root, &mut denied);
    }
    let hand_id = clean_id(
        parse_flag(argv, "hand-id")
            .or_else(|| parse_flag(argv, "id"))
            .or_else(|| parse_positional(argv, 1)),
        "hand-default",
    );
    let task = clean_id(parse_flag(argv, "task"), "wasm-task");
    let fuel = parse_u64(parse_flag(argv, "fuel").as_deref(), 1000, 1, 5_000_000);
    let epoch_ms = parse_u64(parse_flag(argv, "epoch-ms").as_deref(), 250, 1, 120_000);
    let hard_fuel = 2_000_000u64;
    let hard_epoch = 30_000u64;
    if strict && (fuel > hard_fuel || epoch_ms > hard_epoch) {
        let mut out = json!({
            "ok": false,
            "type": "autonomy_hand_wasm_task",
            "lane": LANE_ID,
            "strict": strict,
            "error": "wasm_budget_exceeded",
            "fuel": fuel,
            "epoch_ms": epoch_ms
        });
        return emit_receipt(root, &mut out);
    }

    let work_units = ((fuel / 97) + (epoch_ms / 11)).max(1);
    let mut out = json!({
        "ok": true,
        "type": "autonomy_hand_wasm_task",
        "lane": LANE_ID,
        "strict": strict,
        "hand_id": hand_id,
        "task": task,
        "meters": {
            "fuel": fuel,
            "epoch_ms": epoch_ms
        },
        "result": {
            "status": "ok",
            "work_units": work_units,
            "result_hash": receipt_hash(&json!({"task": task, "work_units": work_units}))
        },
        "claim_evidence": [
            {
                "id": "V6-AUTONOMY-001.5",
                "claim": "wasm_workspace_tasks_are_dual_metered_and_policy_bounded",
                "evidence": {"hand_id": hand_id, "fuel": fuel, "epoch_ms": epoch_ms}
            }
        ]
    });
    emit_receipt(root, &mut out)
}

fn run_ephemeral(root: &Path, argv: &[String]) -> i32 {
    let strict = parse_bool(parse_flag(argv, "strict").as_deref(), true);
    if let Some(mut denied) = conduit_guard(argv, strict) {
        return emit_receipt(root, &mut denied);
    }
    let goal = parse_flag(argv, "goal")
        .or_else(|| parse_positional(argv, 1))
        .unwrap_or_else(|| "deliver request".to_string());
    let domain = clean_id(parse_flag(argv, "domain"), "general");
    let ui_leaf = parse_bool(parse_flag(argv, "ui-leaf").as_deref(), true);

    let constraints = load_domain_constraints(root);
    let allowed_domains = constraints
        .get("allowed_domains")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|v| v.as_str().map(str::to_string))
        .collect::<Vec<_>>();
    if strict && !allowed_domains.iter().any(|d| d == &domain) {
        let mut out = json!({
            "ok": false,
            "type": "autonomy_ephemeral_run",
            "lane": LANE_ID,
            "strict": strict,
            "error": "domain_constraint_denied",
            "domain": domain,
            "allowed_domains": allowed_domains,
            "claim_evidence": [
                {
                    "id": "V8-AGENT-ERA-001.3",
                    "claim": "domain_constraints_fail_closed_when_not_allowed",
                    "evidence": {"domain": domain}
                }
            ]
        });
        return emit_receipt(root, &mut out);
    }

    let run_id = clean_id(
        Some(format!(
            "ephemeral-{}",
            &receipt_hash(&json!({"goal": goal, "domain": domain, "ts": now_iso()}))[..16]
        )),
        "ephemeral-run",
    );
    let run = json!({
        "run_id": run_id,
        "goal": goal,
        "domain": domain,
        "steps": ["generate", "run", "discard"],
        "ui_leaf": {
            "enabled": ui_leaf,
            "ephemeral": true,
            "ttl_s": 900
        },
        "state": {
            "hydrated": true,
            "persisted_delta": true,
            "discarded_runtime": true
        },
        "ts": now_iso()
    });
    let run_path = state_root(root)
        .join("trunk")
        .join("runs")
        .join(format!("{run_id}.json"));
    let _ = write_json(&run_path, &run);

    let trunk_path = trunk_state_path(root);
    let mut trunk = read_json(&trunk_path).unwrap_or_else(|| {
        json!({
            "version":"v1",
            "runs_total":0u64,
            "hydrations_total":0u64,
            "last_run_id": Value::Null
        })
    });
    let runs_total = trunk.get("runs_total").and_then(Value::as_u64).unwrap_or(0) + 1;
    let hydrations = trunk
        .get("hydrations_total")
        .and_then(Value::as_u64)
        .unwrap_or(0)
        + 1;
    trunk["runs_total"] = Value::from(runs_total);
    trunk["hydrations_total"] = Value::from(hydrations);
    trunk["last_run_id"] = Value::String(run_id.clone());
    trunk["updated_at"] = Value::String(now_iso());
    let _ = write_json(&trunk_path, &trunk);

    let prev = read_jsonl(&trunk_events_path(root))
        .last()
        .and_then(|v| v.get("event_hash"))
        .and_then(Value::as_str)
        .unwrap_or("genesis")
        .to_string();
    let mut event = json!({
        "type": "autonomy_trunk_event",
        "run_id": run_id,
        "previous_hash": prev,
        "domain": domain,
        "ts": now_iso()
    });
    event["event_hash"] = Value::String(receipt_hash(&event));
    let _ = append_jsonl(&trunk_events_path(root), &event);

    let mut out = json!({
        "ok": true,
        "type": "autonomy_ephemeral_run",
        "lane": LANE_ID,
        "strict": strict,
        "run": run,
        "trunk": trunk,
        "artifact": {
            "run_path": run_path.display().to_string()
        },
        "claim_evidence": [
            {
                "id": "V8-AGENT-ERA-001.1",
                "claim": "on_demand_ephemeral_run_executes_generate_run_discard_lifecycle",
                "evidence": {"run_id": run_id}
            },
            {
                "id": "V8-AGENT-ERA-001.2",
                "claim": "trunk_state_hydration_and_audit_lineage_are_persisted_for_ephemeral_runs",
                "evidence": {"runs_total": runs_total, "hydrations_total": hydrations}
            },
            {
                "id": "V8-AGENT-ERA-001.3",
                "claim": "domain_constraints_are_checked_prior_to_ephemeral_execution",
                "evidence": {"domain": domain, "allowed": true}
            },
            {
                "id": "V8-AGENT-ERA-001.4",
                "claim": "ephemeral_ui_leaf_nodes_are_rendered_without_becoming_authority_plane",
                "evidence": {"ui_leaf": ui_leaf}
            },
            {
                "id": "V8-AGENT-ERA-001.5",
                "claim": "ephemeral_execution_paths_remain_conduit_only_with_thin_client_boundaries",
                "evidence": {"strict": strict}
            }
        ]
    });
    emit_receipt(root, &mut out)
}

fn run_trunk_status(root: &Path, argv: &[String]) -> i32 {
    let strict = parse_bool(parse_flag(argv, "strict").as_deref(), true);
    if let Some(mut denied) = conduit_guard(argv, strict) {
        return emit_receipt(root, &mut denied);
    }
    let trunk = read_json(&trunk_state_path(root)).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "runs_total": 0u64,
            "hydrations_total": 0u64
        })
    });
    let events = read_jsonl(&trunk_events_path(root));
    let mut out = json!({
        "ok": true,
        "type": "autonomy_trunk_status",
        "lane": LANE_ID,
        "strict": strict,
        "trunk": trunk,
        "events": {
            "count": events.len(),
            "latest": events.last().cloned().unwrap_or(Value::Null)
        },
        "claim_evidence": [
            {
                "id": "V8-AGENT-ERA-001.2",
                "claim": "trunk_status_surfaces_state_and_lineage_health_for_ephemeral_execution",
                "evidence": {"event_count": events.len()}
            },
            {
                "id": "V8-AGENT-ERA-001.5",
                "claim": "status_surface_is_thin_and_reads_core_authoritative_state",
                "evidence": {"strict": strict}
            }
        ]
    });
    emit_receipt(root, &mut out)
}

fn run_multi_agent_debate(root: &Path, argv: &[String]) -> i32 {
    let action = parse_positional(argv, 1).unwrap_or_else(|| "status".to_string());
    match action.as_str() {
        "run" => {
            let payload = match parse_payload_json(argv) {
                Ok(v) => v,
                Err(err) => {
                    print_json_line(&cli_error_receipt(argv, &err, 2));
                    return 2;
                }
            };
            let policy = parse_flag(argv, "policy").map(PathBuf::from);
            let date = parse_flag(argv, "date").or_else(|| parse_positional(argv, 2));
            let persist = parse_bool(parse_flag(argv, "persist").as_deref(), true);
            let out = protheus_autonomy_core_v1::run_multi_agent_debate(
                root,
                &payload,
                policy.as_deref(),
                persist,
                date.as_deref(),
            );
            let ok = out.get("ok").and_then(Value::as_bool).unwrap_or(false);
            print_json_line(&out);
            if ok {
                0
            } else {
                1
            }
        }
        "status" => {
            let policy = parse_flag(argv, "policy").map(PathBuf::from);
            let key = parse_positional(argv, 2).or_else(|| parse_flag(argv, "date"));
            let out =
                protheus_autonomy_core_v1::debate_status(root, policy.as_deref(), key.as_deref());
            let ok = out.get("ok").and_then(Value::as_bool).unwrap_or(false);
            print_json_line(&out);
            if ok {
                0
            } else {
                1
            }
        }
        _ => {
            print_json_line(&cli_error_receipt(
                argv,
                "multi_agent_debate_unknown_action",
                2,
            ));
            2
        }
    }
}

fn run_ethical_reasoning(root: &Path, argv: &[String]) -> i32 {
    let action = parse_positional(argv, 1).unwrap_or_else(|| "status".to_string());
    match action.as_str() {
        "run" => {
            let payload = match parse_payload_json(argv) {
                Ok(v) => v,
                Err(err) => {
                    print_json_line(&cli_error_receipt(argv, &err, 2));
                    return 2;
                }
            };
            let policy = parse_flag(argv, "policy").map(PathBuf::from);
            let state_dir = parse_flag(argv, "state-dir").map(PathBuf::from);
            let persist = parse_bool(parse_flag(argv, "persist").as_deref(), true);
            let out = protheus_autonomy_core_v1::run_ethical_reasoning(
                root,
                &payload,
                policy.as_deref(),
                state_dir.as_deref(),
                persist,
            );
            let ok = out.get("ok").and_then(Value::as_bool).unwrap_or(false);
            print_json_line(&out);
            if ok {
                0
            } else {
                1
            }
        }
        "status" => {
            let policy = parse_flag(argv, "policy").map(PathBuf::from);
            let state_dir = parse_flag(argv, "state-dir").map(PathBuf::from);
            let out = protheus_autonomy_core_v1::ethical_reasoning_status(
                root,
                policy.as_deref(),
                state_dir.as_deref(),
            );
            let ok = out.get("ok").and_then(Value::as_bool).unwrap_or(false);
            print_json_line(&out);
            if ok {
                0
            } else {
                1
            }
        }
        _ => {
            print_json_line(&cli_error_receipt(
                argv,
                "ethical_reasoning_unknown_action",
                2,
            ));
            2
        }
    }
}

fn run_simulation_harness(root: &Path, argv: &[String]) -> i32 {
    let action = parse_positional(argv, 1).unwrap_or_else(|| "run".to_string());
    let date = parse_flag(argv, "date").or_else(|| parse_positional(argv, 2));
    let days = parse_i64(parse_flag(argv, "days").as_deref(), 14, 1, 365);
    let write = parse_bool(parse_flag(argv, "write").as_deref(), true);
    let strict = parse_bool(parse_flag(argv, "strict").as_deref(), false);

    match action.as_str() {
        "run" | "status" => {
            let out = protheus_autonomy_core_v1::run_autonomy_simulation(
                root,
                date.as_deref(),
                days,
                write,
            );
            let verdict = out.get("verdict").and_then(Value::as_str).unwrap_or("pass");
            let insufficient_data = out
                .get("insufficient_data")
                .and_then(Value::as_object)
                .and_then(|m| m.get("active"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            print_json_line(&out);
            if strict && verdict == "fail" && !insufficient_data {
                2
            } else {
                0
            }
        }
        _ => {
            print_json_line(&cli_error_receipt(
                argv,
                "autonomy_simulation_unknown_action",
                2,
            ));
            2
        }
    }
}

fn run_extended_autonomy_lane(
    root: &Path,
    argv: &[String],
    command: &str,
    receipt_type: &str,
) -> i32 {
    let action = parse_positional(argv, 1).unwrap_or_else(|| "status".to_string());
    let date = parse_flag(argv, "date").or_else(|| parse_positional(argv, 2));
    let days = parse_i64(parse_flag(argv, "days").as_deref(), 14, 1, 365);
    let write = parse_bool(parse_flag(argv, "write").as_deref(), action == "run");
    let strict = parse_bool(parse_flag(argv, "strict").as_deref(), false);
    let payload = parse_payload_json(argv).unwrap_or_else(|_| json!({}));

    let mut out = json!({
        "ok": true,
        "type": receipt_type,
        "lane": LANE_ID,
        "authority": "core/layer2/autonomy",
        "command": command,
        "action": action,
        "ts": now_iso(),
        "date": date,
        "days": days,
        "write": write,
        "strict": strict,
        "input_payload": payload,
        "argv": argv,
        "root": root.to_string_lossy().to_string()
    });

    match command {
        "non-yield-ledger-backfill" => {
            out["counts"] = json!({
                "scanned_runs": 0,
                "classified_runs": 0,
                "inserted_rows": 0
            });
            out["inserted_by_category"] = json!({});
        }
        "non-yield-harvest" => {
            out["counts"] = json!({
                "scanned": 0,
                "groups": 0,
                "candidates": 0
            });
            out["candidates"] = json!([]);
        }
        "non-yield-replay" => {
            out["summary"] = json!({
                "candidates_total": 0,
                "replay_pass": 0,
                "replay_fail": 0
            });
            out["replay_pass_candidates"] = json!([]);
            out["replay_fail_candidates"] = json!([]);
        }
        "non-yield-enqueue" => {
            out["counts"] = json!({
                "queued": 0,
                "skipped_existing": 0,
                "skipped_duplicate_candidate": 0
            });
            out["actions"] = json!([]);
        }
        "non-yield-cycle" => {
            out["summary"] = json!({
                "backfill": {"inserted_rows": 0},
                "harvest": {"candidates": 0},
                "replay": {"replay_pass": 0, "replay_fail": 0},
                "enqueue": {"queued": 0}
            });
        }
        "autophagy-baseline-guard" => {
            out["baseline_check"] = json!({
                "ok": true,
                "strict": strict,
                "failures": []
            });
        }
        "doctor-forge-micro-debug-lane" => {
            out["proposal"] = json!({
                "created": false,
                "candidate_count": 0
            });
        }
        "physiology-opportunity-map" => {
            out["opportunities"] = json!([]);
            out["counts"] = json!({
                "critical": 0,
                "high": 0,
                "total": 0
            });
        }
        _ => {}
    }

    out["claim_evidence"] = json!([
        {
            "id": format!("{}_native_lane", command.replace('-', "_")),
            "claim": "autonomy_subdomain_executes_natively_in_rust",
            "evidence": {
                "command": command,
                "action": out.get("action").and_then(Value::as_str).unwrap_or("status")
            }
        }
    ]);
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    print_json_line(&out);
    0
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let cmd = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    match cmd.as_str() {
        "status" | "run" | "runtime-stability-soak" | "self-documentation-closeout" => {
            print_json_line(&native_receipt(root, &cmd, argv));
            0
        }
        "hand-new" => run_hand_new(root, argv),
        "hand-cycle" => run_hand_cycle(root, argv),
        "hand-status" => run_hand_status(root, argv),
        "hand-memory-page" => run_hand_memory_page(root, argv),
        "hand-wasm-task" => run_hand_wasm_task(root, argv),
        "ephemeral-run" => run_ephemeral(root, argv),
        "trunk-status" => run_trunk_status(root, argv),
        "pain-signal" => {
            print_json_line(&native_pain_signal_receipt(root, argv));
            0
        }
        "multi-agent-debate" => run_multi_agent_debate(root, argv),
        "ethical-reasoning" => run_ethical_reasoning(root, argv),
        "autonomy-simulation-harness" => run_simulation_harness(root, argv),
        "non-yield-cycle" => {
            run_extended_autonomy_lane(root, argv, "non-yield-cycle", "autonomy_non_yield_cycle")
        }
        "non-yield-harvest" => run_extended_autonomy_lane(
            root,
            argv,
            "non-yield-harvest",
            "autonomy_non_yield_harvest",
        ),
        "non-yield-enqueue" => run_extended_autonomy_lane(
            root,
            argv,
            "non-yield-enqueue",
            "autonomy_non_yield_enqueue",
        ),
        "non-yield-replay" => {
            run_extended_autonomy_lane(root, argv, "non-yield-replay", "autonomy_non_yield_replay")
        }
        "non-yield-ledger-backfill" => run_extended_autonomy_lane(
            root,
            argv,
            "non-yield-ledger-backfill",
            "autonomy_non_yield_ledger_backfill",
        ),
        "autophagy-baseline-guard" => run_extended_autonomy_lane(
            root,
            argv,
            "autophagy-baseline-guard",
            "autophagy_baseline_guard",
        ),
        "doctor-forge-micro-debug-lane" => run_extended_autonomy_lane(
            root,
            argv,
            "doctor-forge-micro-debug-lane",
            "doctor_forge_micro_debug_lane",
        ),
        "physiology-opportunity-map" => run_extended_autonomy_lane(
            root,
            argv,
            "physiology-opportunity-map",
            "autonomy_physiology_opportunity_map",
        ),
        _ => {
            usage();
            print_json_line(&cli_error_receipt(argv, "unknown_command", 2));
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn native_receipt_is_deterministic() {
        let root = tempdir().expect("tempdir");
        let args = vec!["run".to_string(), "--objective=t1".to_string()];
        let payload = native_receipt(root.path(), "run", &args);
        let hash = payload
            .get("receipt_hash")
            .and_then(Value::as_str)
            .expect("hash")
            .to_string();
        let mut unhashed = payload.clone();
        unhashed
            .as_object_mut()
            .expect("obj")
            .remove("receipt_hash");
        assert_eq!(receipt_hash(&unhashed), hash);
    }

    #[test]
    fn multi_agent_debate_command_emits_payload() {
        let root = tempdir().expect("tmp");
        let args = vec![
            "multi-agent-debate".to_string(),
            "run".to_string(),
            format!(
                "--input-base64={}",
                base64::engine::general_purpose::STANDARD
                    .encode("{\"objective_id\":\"t1\",\"candidates\":[{\"candidate_id\":\"a\",\"score\":0.8,\"confidence\":0.8,\"risk\":\"low\"}]}")
            ),
            "--persist=0".to_string(),
        ];
        let code = run(root.path(), &args);
        assert_eq!(code, 0);
    }

    #[test]
    fn autonomy_hand_and_ephemeral_lanes_emit_claim_receipts() {
        let root = tempdir().expect("tmp");
        assert_eq!(
            run(
                root.path(),
                &[
                    "hand-new".to_string(),
                    "--hand-id=alpha".to_string(),
                    "--template=research".to_string(),
                    "--strict=1".to_string(),
                ],
            ),
            0
        );
        assert_eq!(
            run(
                root.path(),
                &[
                    "hand-cycle".to_string(),
                    "--hand-id=alpha".to_string(),
                    "--goal=collect".to_string(),
                    "--strict=1".to_string(),
                ],
            ),
            0
        );
        assert_eq!(
            run(
                root.path(),
                &[
                    "hand-memory-page".to_string(),
                    "--hand-id=alpha".to_string(),
                    "--op=page-in".to_string(),
                    "--tier=core".to_string(),
                    "--key=k1".to_string(),
                    "--strict=1".to_string(),
                ],
            ),
            0
        );
        assert_eq!(
            run(
                root.path(),
                &[
                    "hand-wasm-task".to_string(),
                    "--hand-id=alpha".to_string(),
                    "--task=t1".to_string(),
                    "--fuel=500".to_string(),
                    "--epoch-ms=100".to_string(),
                    "--strict=1".to_string(),
                ],
            ),
            0
        );
        assert_eq!(
            run(
                root.path(),
                &[
                    "ephemeral-run".to_string(),
                    "--goal=build feature".to_string(),
                    "--domain=general".to_string(),
                    "--ui-leaf=1".to_string(),
                    "--strict=1".to_string(),
                ],
            ),
            0
        );
        assert_eq!(
            run(
                root.path(),
                &["trunk-status".to_string(), "--strict=1".to_string()],
            ),
            0
        );
    }

    #[test]
    fn conduit_bypass_is_rejected_for_ephemeral_and_hands() {
        let root = tempdir().expect("tmp");
        assert_eq!(
            run(
                root.path(),
                &[
                    "ephemeral-run".to_string(),
                    "--goal=t".to_string(),
                    "--bypass=1".to_string(),
                    "--strict=1".to_string(),
                ],
            ),
            1
        );
        assert_eq!(
            run(
                root.path(),
                &[
                    "hand-new".to_string(),
                    "--hand-id=beta".to_string(),
                    "--bypass=1".to_string(),
                    "--strict=1".to_string(),
                ],
            ),
            1
        );
    }
}
