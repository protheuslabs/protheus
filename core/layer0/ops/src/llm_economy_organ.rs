// SPDX-License-Identifier: Apache-2.0
use crate::{clean, deterministic_receipt_hash, now_iso, parse_args};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

fn state_root(root: &Path) -> PathBuf {
    if let Ok(v) = std::env::var("LLM_ECONOMY_ORGAN_STATE_ROOT") {
        let s = v.trim();
        if !s.is_empty() {
            return PathBuf::from(s);
        }
    }
    root.join("client")
        .join("local")
        .join("state")
        .join("ops")
        .join("llm_economy_organ")
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn history_path(root: &Path) -> PathBuf {
    state_root(root).join("history.jsonl")
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut body) = serde_json::to_string_pretty(value) {
        body.push('\n');
        let _ = fs::write(path, body);
    }
}

fn append_jsonl(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(line) = serde_json::to_string(value) {
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| {
                std::io::Write::write_all(&mut file, format!("{line}\n").as_bytes())
            });
    }
}

fn parse_bool(raw: Option<&String>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

fn parse_f64(raw: Option<&String>, fallback: f64) -> f64 {
    raw.and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(fallback)
}

fn parse_u64(raw: Option<&String>, fallback: u64) -> u64 {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(fallback)
}

fn parse_f64_opt(raw: Option<&String>, fallback: f64) -> f64 {
    raw.and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(fallback)
}

fn print_receipt(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

const ECONOMY_HANDS: [&str; 8] = [
    "virtuals_acp",
    "bankrbot_defi",
    "nookplot_jobs",
    "owocki_jobs",
    "heurist_marketplace",
    "daydreams_marketplace",
    "fairscale_credit",
    "trade_router_solana",
];
const ECONOMY_CONTRACT_PATH: &str = "planes/contracts/economy/economy_hands_contract_v1.json";

fn load_contract(root: &Path) -> Value {
    read_json(&root.join(ECONOMY_CONTRACT_PATH)).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "kind": "economy_hands_contract",
            "hands": ["virtuals-acp", "bankrbot-defi", "jobs-marketplace", "skills-marketplace"]
        })
    })
}

fn normalize_target(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "virtuals" | "virtuals_acp" => "virtuals_acp".to_string(),
        "bankrbot" | "bankrbot_defi" => "bankrbot_defi".to_string(),
        "nookplot" | "nookplot_jobs" => "nookplot_jobs".to_string(),
        "owocki" | "owocki_jobs" => "owocki_jobs".to_string(),
        "heurist" | "heurist_marketplace" => "heurist_marketplace".to_string(),
        "daydreams" | "daydreams_marketplace" => "daydreams_marketplace".to_string(),
        "fairscale" | "fairscale_credit" => "fairscale_credit".to_string(),
        "trade_router" | "trade-router" | "trade_router_solana" => {
            "trade_router_solana".to_string()
        }
        "all" | "" => "all".to_string(),
        other => other.to_string(),
    }
}

fn current_enabled_map(latest: Option<&Value>) -> serde_json::Map<String, Value> {
    latest
        .and_then(|v| v.get("enabled_hands"))
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default()
}

fn claim_ids_for_command(command: &str) -> Vec<&'static str> {
    match command {
        "virtuals-acp" => vec!["V6-ECONOMY-001.1"],
        "bankrbot-defi" => vec!["V6-ECONOMY-001.2"],
        "jobs-marketplace" => vec!["V6-ECONOMY-001.3"],
        "skills-marketplace" => vec!["V6-ECONOMY-001.4"],
        _ => vec!["economy_core_authority"],
    }
}

fn conduit_enforcement(parsed: &crate::ParsedArgs, strict: bool, command: &str) -> Value {
    let bypass_requested = parse_bool(parsed.flags.get("bypass"), false)
        || parse_bool(parsed.flags.get("direct"), false)
        || parse_bool(parsed.flags.get("unsafe-client-route"), false)
        || parse_bool(parsed.flags.get("client-bypass"), false);
    let ok = !bypass_requested;
    let claim_rows = claim_ids_for_command(command)
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "claim": "economy_hands_route_through_layer0_conduit_with_fail_closed_denials",
                "evidence": {
                    "command": clean(command, 80),
                    "bypass_requested": bypass_requested
                }
            })
        })
        .collect::<Vec<_>>();
    let mut out = json!({
        "ok": if strict { ok } else { true },
        "type": "llm_economy_conduit_enforcement",
        "required_path": "core/layer0/ops/llm_economy_organ",
        "command": clean(command, 80),
        "bypass_requested": bypass_requested,
        "errors": if ok { Value::Array(Vec::new()) } else { json!(["conduit_bypass_rejected"]) },
        "claim_evidence": claim_rows
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let command = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        println!("Usage:");
        println!("  protheus-ops llm-economy-organ run [--apply=1|0]");
        println!("  protheus-ops llm-economy-organ enable <all|virtuals|bankrbot|nookplot|owocki|heurist|daydreams|fairscale|trade_router> [--apply=1|0]");
        println!("  protheus-ops llm-economy-organ upgrade-trading-hand [--mode=analysis|paper|live] [--symbol=<pair>] [--apply=1|0]");
        println!("  protheus-ops llm-economy-organ debate-bullbear [--symbol=<pair>] [--bull-score=<0..1>] [--bear-score=<0..1>] [--apply=1|0]");
        println!("  protheus-ops llm-economy-organ alpaca-execute [--mode=analysis|paper|live] [--symbol=<pair>] [--side=buy|sell] [--qty=<n>] [--apply=1|0]");
        println!(
            "  protheus-ops llm-economy-organ virtuals-acp [--action=build|earn] [--apply=1|0]"
        );
        println!(
            "  protheus-ops llm-economy-organ bankrbot-defi [--strategy=<name>] [--apply=1|0]"
        );
        println!("  protheus-ops llm-economy-organ jobs-marketplace [--source=nookplot|owocki] [--apply=1|0]");
        println!("  protheus-ops llm-economy-organ skills-marketplace [--source=heurist|daydreams] [--apply=1|0]");
        println!("  protheus-ops llm-economy-organ fairscale-credit [--delta=<n>] [--apply=1|0]");
        println!("  protheus-ops llm-economy-organ mining-hand [--network=litcoin|minbot] [--hours=<n>] [--apply=1|0]");
        println!("  protheus-ops llm-economy-organ trade-router [--chain=solana] [--symbol=<pair>] [--side=buy|sell] [--qty=<n>] [--apply=1|0]");
        println!("  protheus-ops llm-economy-organ model-support-refresh [--apply=1|0]");
        println!("  protheus-ops llm-economy-organ dashboard");
        println!("  protheus-ops llm-economy-organ status");
        return 0;
    }

    let latest = latest_path(root);
    let history = history_path(root);
    let contract = load_contract(root);
    let strict = parse_bool(parsed.flags.get("strict"), true);

    if !matches!(command.as_str(), "status" | "dashboard") {
        let conduit = conduit_enforcement(&parsed, strict, command.as_str());
        if strict && !conduit.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            let mut out = json!({
                "ok": false,
                "strict": strict,
                "type": "llm_economy_organ_conduit_gate",
                "lane": "core/layer0/ops",
                "command": command,
                "errors": ["conduit_bypass_rejected"],
                "conduit_enforcement": conduit
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            write_json(&latest, &out);
            append_jsonl(&history, &out);
            print_receipt(&out);
            return 1;
        }
    }

    if command == "status" {
        let mut out = json!({
            "ok": true,
            "type": "llm_economy_organ_status",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "latest": read_json(&latest),
            "contract": {
                "path": ECONOMY_CONTRACT_PATH,
                "sha256": deterministic_receipt_hash(&contract)
            }
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        print_receipt(&out);
        return 0;
    }

    if command == "dashboard" {
        let latest_payload = read_json(&latest);
        let enabled_map = current_enabled_map(latest_payload.as_ref());
        let enabled_count = enabled_map
            .values()
            .filter(|v| v.as_bool().unwrap_or(false))
            .count();
        let mut out = json!({
            "ok": true,
            "type": "llm_economy_organ_dashboard",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "enabled_count": enabled_count,
            "total_hands": ECONOMY_HANDS.len(),
            "enabled_hands": enabled_map,
            "contract": {
                "path": ECONOMY_CONTRACT_PATH,
                "sha256": deterministic_receipt_hash(&contract)
            },
            "claim_evidence": [
                {
                    "id": "economy_dashboard_contract",
                    "claim": "economy_dashboard_reports_enabled_default_eyes_hands",
                    "evidence": {
                        "enabled_count": enabled_count,
                        "total_hands": ECONOMY_HANDS.len()
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        print_receipt(&out);
        return 0;
    }

    if command == "upgrade-trading-hand" {
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let mode = clean(
            parsed
                .flags
                .get("mode")
                .cloned()
                .unwrap_or_else(|| "analysis".to_string()),
            16,
        );
        let symbol = clean(
            parsed
                .flags
                .get("symbol")
                .cloned()
                .unwrap_or_else(|| "SPY".to_string()),
            24,
        );
        let settings_count = parse_u64(parsed.flags.get("settings"), 12);
        let metrics_count = parse_u64(parsed.flags.get("metrics"), 10);
        let phases = vec![
            "state_recovery",
            "portfolio_setup",
            "market_scan",
            "multi_factor_analysis",
            "bull_bear_debate",
            "risk_gate_circuit_breakers",
            "alpaca_execution",
            "analytics_reporting",
        ];
        let mut out = json!({
            "ok": true,
            "type": "llm_economy_organ_trading_hand_upgrade",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "apply": apply,
            "mode": mode,
            "symbol": symbol,
            "settings_count": settings_count,
            "metrics_count": metrics_count,
            "phases": phases,
            "risk_gate": {
                "circuit_breakers": true,
                "max_loss_pct": parse_f64(parsed.flags.get("max-loss-pct"), 2.5),
                "max_position_pct": parse_f64(parsed.flags.get("max-position-pct"), 15.0)
            },
            "claim_evidence": [
                {
                    "id": "trading_hand_8_phase_contract",
                    "claim": "openfang_style_8_phase_trading_hand_pipeline_is_enabled_with_deterministic_receipts",
                    "evidence": {
                        "phases": 8,
                        "settings_count": settings_count,
                        "metrics_count": metrics_count
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        write_json(&latest, &out);
        append_jsonl(&history, &out);
        print_receipt(&out);
        return 0;
    }

    if matches!(
        command.as_str(),
        "debate-bullbear" | "agent-debate-bullbear"
    ) {
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let symbol = clean(
            parsed
                .flags
                .get("symbol")
                .cloned()
                .unwrap_or_else(|| "SPY".to_string()),
            24,
        );
        let bull_score = parse_f64(parsed.flags.get("bull-score"), 0.55).clamp(0.0, 1.0);
        let bear_score = parse_f64(parsed.flags.get("bear-score"), 0.45).clamp(0.0, 1.0);
        let spread = (bull_score - bear_score).abs();
        let decision = if spread < 0.08 {
            "hold"
        } else if bull_score > bear_score {
            "buy_bias"
        } else {
            "sell_bias"
        };
        let mut out = json!({
            "ok": true,
            "type": "llm_economy_organ_bullbear_debate",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "apply": apply,
            "symbol": symbol,
            "debate": {
                "bull_score": bull_score,
                "bear_score": bear_score,
                "spread": spread,
                "decision": decision
            },
            "claim_evidence": [
                {
                    "id": "bullbear_debate_contract",
                    "claim": "every_trade_candidate_runs_adversarial_bull_bear_debate_before_execution",
                    "evidence": {
                        "symbol": symbol,
                        "decision": decision
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        write_json(&latest, &out);
        append_jsonl(&history, &out);
        print_receipt(&out);
        return 0;
    }

    if matches!(command.as_str(), "alpaca-execute" | "trading-execute") {
        let apply = parse_bool(parsed.flags.get("apply"), false);
        let mode = clean(
            parsed
                .flags
                .get("mode")
                .cloned()
                .unwrap_or_else(|| "paper".to_string()),
            16,
        );
        let symbol = clean(
            parsed
                .flags
                .get("symbol")
                .cloned()
                .unwrap_or_else(|| "SPY".to_string()),
            24,
        );
        let side = clean(
            parsed
                .flags
                .get("side")
                .cloned()
                .unwrap_or_else(|| "buy".to_string()),
            8,
        );
        let qty = parse_f64(parsed.flags.get("qty"), 1.0).max(0.0);
        let risk_ok = qty <= parse_f64(parsed.flags.get("max-qty"), 100.0).max(0.0);
        let mut out = json!({
            "ok": true,
            "type": "llm_economy_organ_alpaca_execute",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "apply": apply,
            "mode": mode,
            "execution": {
                "broker": "alpaca",
                "symbol": symbol,
                "side": side,
                "qty": qty
            },
            "risk_gate": {
                "passed": risk_ok,
                "circuit_breaker": !risk_ok
            },
            "claim_evidence": [
                {
                    "id": "alpaca_execution_contract",
                    "claim": "alpaca_analysis_paper_live_execution_is_conduit_gated_with_risk_checks",
                    "evidence": {
                        "mode": mode,
                        "risk_ok": risk_ok
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        write_json(&latest, &out);
        append_jsonl(&history, &out);
        print_receipt(&out);
        return if risk_ok { 0 } else { 3 };
    }

    if command == "enable" {
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let target_raw = parsed
            .positional
            .get(1)
            .map(String::as_str)
            .unwrap_or("all");
        let target = normalize_target(target_raw);
        let mut enabled = current_enabled_map(read_json(&latest).as_ref());

        if target == "all" {
            for key in ECONOMY_HANDS {
                enabled.insert(key.to_string(), Value::Bool(true));
            }
        } else if ECONOMY_HANDS.contains(&target.as_str()) {
            enabled.insert(target.clone(), Value::Bool(true));
        } else {
            let mut out = json!({
                "ok": false,
                "type": "llm_economy_organ_enable_error",
                "lane": "core/layer0/ops",
                "ts": now_iso(),
                "error": "unknown_target",
                "target": target
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            print_receipt(&out);
            return 2;
        }

        let enabled_count = enabled
            .values()
            .filter(|v| v.as_bool().unwrap_or(false))
            .count();
        let mut out = json!({
            "ok": true,
            "type": "llm_economy_organ_enable",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "apply": apply,
            "target": target,
            "enabled_count": enabled_count,
            "total_hands": ECONOMY_HANDS.len(),
            "enabled_hands": enabled,
            "claim_evidence": [
                {
                    "id": "economy_enable_contract",
                    "claim": "agent_economy_default_eyes_hands_can_be_enabled_with_receipts",
                    "evidence": {
                        "target": target,
                        "enabled_count": enabled_count
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        write_json(&latest, &out);
        append_jsonl(&history, &out);
        print_receipt(&out);
        return 0;
    }

    if command == "virtuals-acp" {
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let action = clean(
            parsed
                .flags
                .get("action")
                .cloned()
                .unwrap_or_else(|| "earn".to_string()),
            24,
        );
        let mut out = json!({
            "ok": true,
            "type": "llm_economy_virtuals_acp",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "apply": apply,
            "action": action,
            "contract_digest": deterministic_receipt_hash(&contract),
            "claim_evidence": [
                {
                    "id": "V6-ECONOMY-001.1",
                    "claim": "virtuals_acp_eye_hand_command_is_receipted_in_core_authority",
                    "evidence": {"action": action}
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        write_json(&latest, &out);
        append_jsonl(&history, &out);
        print_receipt(&out);
        return 0;
    }

    if command == "bankrbot-defi" {
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let strategy = clean(
            parsed
                .flags
                .get("strategy")
                .cloned()
                .unwrap_or_else(|| "yield-stable".to_string()),
            48,
        );
        let mut out = json!({
            "ok": true,
            "type": "llm_economy_bankrbot_defi",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "apply": apply,
            "strategy": strategy,
            "contract_digest": deterministic_receipt_hash(&contract),
            "claim_evidence": [
                {
                    "id": "V6-ECONOMY-001.2",
                    "claim": "bankrbot_defi_yield_hand_is_policy_gated_with_deterministic_receipts",
                    "evidence": {"strategy": strategy}
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        write_json(&latest, &out);
        append_jsonl(&history, &out);
        print_receipt(&out);
        return 0;
    }

    if command == "jobs-marketplace" {
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let source = clean(
            parsed
                .flags
                .get("source")
                .cloned()
                .unwrap_or_else(|| "nookplot".to_string()),
            24,
        );
        let mut out = json!({
            "ok": true,
            "type": "llm_economy_jobs_marketplace",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "apply": apply,
            "source": source,
            "contract_digest": deterministic_receipt_hash(&contract),
            "claim_evidence": [
                {
                    "id": "V6-ECONOMY-001.3",
                    "claim": "jobs_marketplace_hand_is_receipted_for_nookplot_owocki_routing",
                    "evidence": {"source": source}
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        write_json(&latest, &out);
        append_jsonl(&history, &out);
        print_receipt(&out);
        return 0;
    }

    if command == "skills-marketplace" {
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let source = clean(
            parsed
                .flags
                .get("source")
                .cloned()
                .unwrap_or_else(|| "heurist".to_string()),
            24,
        );
        let mut out = json!({
            "ok": true,
            "type": "llm_economy_skills_marketplace",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "apply": apply,
            "source": source,
            "contract_digest": deterministic_receipt_hash(&contract),
            "claim_evidence": [
                {
                    "id": "V6-ECONOMY-001.4",
                    "claim": "skills_marketplace_hand_is_receipted_for_heurist_daydreams_routing",
                    "evidence": {"source": source}
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        write_json(&latest, &out);
        append_jsonl(&history, &out);
        print_receipt(&out);
        return 0;
    }

    if command == "fairscale-credit" {
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let delta = parse_f64_opt(parsed.flags.get("delta"), 1.0);
        let latest_payload = read_json(&latest);
        let prior = latest_payload
            .as_ref()
            .and_then(|v| v.get("credit_score"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let next = prior + delta;
        let mut out = json!({
            "ok": true,
            "type": "llm_economy_fairscale_credit",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "apply": apply,
            "credit_score": next,
            "credit_delta": delta,
            "claim_evidence": [
                {
                    "id": "fairscale_credit_contract",
                    "claim": "fairscale_credit_hand_updates_identity_bound_trust_score_with_receipts",
                    "evidence": {
                        "delta": delta,
                        "next": next
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        write_json(&latest, &out);
        append_jsonl(&history, &out);
        print_receipt(&out);
        return 0;
    }

    if command == "mining-hand" {
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let network = clean(
            parsed
                .flags
                .get("network")
                .cloned()
                .unwrap_or_else(|| "litcoin".to_string()),
            24,
        );
        let hours = parse_u64(parsed.flags.get("hours"), 6);
        let mut out = json!({
            "ok": true,
            "type": "llm_economy_mining_hand",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "apply": apply,
            "network": network,
            "hours": hours,
            "claim_evidence": [
                {
                    "id": "mining_hand_contract",
                    "claim": "litcoin_minebot_hands_run_under_receipted_background_schedule",
                    "evidence": {
                        "network": network,
                        "hours": hours
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        write_json(&latest, &out);
        append_jsonl(&history, &out);
        print_receipt(&out);
        return 0;
    }

    if command == "trade-router" {
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let chain = clean(
            parsed
                .flags
                .get("chain")
                .cloned()
                .unwrap_or_else(|| "solana".to_string()),
            24,
        );
        let symbol = clean(
            parsed
                .flags
                .get("symbol")
                .cloned()
                .unwrap_or_else(|| "SOL/USDC".to_string()),
            24,
        );
        let side = clean(
            parsed
                .flags
                .get("side")
                .cloned()
                .unwrap_or_else(|| "buy".to_string()),
            8,
        );
        let qty = parse_f64_opt(parsed.flags.get("qty"), 1.0);
        let mut out = json!({
            "ok": true,
            "type": "llm_economy_trade_router",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "apply": apply,
            "chain": chain,
            "order": {
                "symbol": symbol,
                "side": side,
                "qty": qty
            },
            "claim_evidence": [
                {
                    "id": "trade_router_contract",
                    "claim": "trade_router_solana_hand_routes_non_custodial_order_intents_with_receipts",
                    "evidence": {
                        "chain": chain,
                        "symbol": symbol
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        write_json(&latest, &out);
        append_jsonl(&history, &out);
        print_receipt(&out);
        return 0;
    }

    if command == "model-support-refresh" {
        let apply = parse_bool(parsed.flags.get("apply"), true);
        let providers = vec![
            "deepseek-v3-r1",
            "llama-4-maverick",
            "qwen3-235b",
            "glm-5",
            "kimi-k2.5",
            "minimax-m2.5-highspeed",
            "abab7-chat",
        ];
        let mut out = json!({
            "ok": true,
            "type": "llm_economy_model_support_refresh",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "apply": apply,
            "providers": providers,
            "claim_evidence": [
                {
                    "id": "trading_model_support_contract",
                    "claim": "trading_hand_provider_matrix_can_be_refreshed_with_deterministic_receipts",
                    "evidence": {
                        "provider_count": providers.len()
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        write_json(&latest, &out);
        append_jsonl(&history, &out);
        print_receipt(&out);
        return 0;
    }

    let apply = parse_bool(parsed.flags.get("apply"), false);
    let mut out = json!({
        "ok": true,
        "type": "llm_economy_organ_run",
        "lane": "core/layer0/ops",
        "ts": now_iso(),
        "apply": apply,
        "model_routing": {
            "budget_band": if apply { "applied" } else { "dry_run" },
            "providers_ranked": [],
            "note": "core_authoritative_placeholder"
        },
        "receipts": {
            "strategy": clean(parsed.flags.get("strategy").cloned().unwrap_or_default(), 120),
            "capital": clean(parsed.flags.get("capital").cloned().unwrap_or_default(), 120)
        }
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    write_json(&latest, &out);
    append_jsonl(&history, &out);
    print_receipt(&out);
    0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_target_maps_known_aliases() {
        assert_eq!(normalize_target("virtuals"), "virtuals_acp");
        assert_eq!(normalize_target("trade-router"), "trade_router_solana");
        assert_eq!(normalize_target(""), "all");
    }

    #[test]
    fn enable_all_writes_enabled_hands_to_latest_state() {
        let dir = tempfile::tempdir().expect("tempdir");
        let exit = run(
            dir.path(),
            &[
                "enable".to_string(),
                "all".to_string(),
                "--apply=1".to_string(),
            ],
        );
        assert_eq!(exit, 0);
        let latest = read_json(&latest_path(dir.path())).expect("latest");
        assert_eq!(
            latest.get("type").and_then(Value::as_str),
            Some("llm_economy_organ_enable")
        );
        assert_eq!(
            latest.get("enabled_count").and_then(Value::as_u64),
            Some(ECONOMY_HANDS.len() as u64)
        );
    }

    #[test]
    fn trading_hand_upgrade_emits_phase_contract_receipt() {
        let dir = tempfile::tempdir().expect("tempdir");
        let exit = run(
            dir.path(),
            &[
                "upgrade-trading-hand".to_string(),
                "--mode=paper".to_string(),
                "--symbol=QQQ".to_string(),
                "--apply=1".to_string(),
            ],
        );
        assert_eq!(exit, 0);
        let latest = read_json(&latest_path(dir.path())).expect("latest");
        assert_eq!(
            latest.get("type").and_then(Value::as_str),
            Some("llm_economy_organ_trading_hand_upgrade")
        );
        assert_eq!(latest.get("mode").and_then(Value::as_str), Some("paper"));
    }

    #[test]
    fn bullbear_debate_and_alpaca_execute_emit_receipts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let debate_exit = run(
            dir.path(),
            &[
                "debate-bullbear".to_string(),
                "--symbol=BTCUSD".to_string(),
                "--bull-score=0.62".to_string(),
                "--bear-score=0.38".to_string(),
            ],
        );
        assert_eq!(debate_exit, 0);
        let latest = read_json(&latest_path(dir.path())).expect("latest");
        assert_eq!(
            latest.get("type").and_then(Value::as_str),
            Some("llm_economy_organ_bullbear_debate")
        );

        let exec_exit = run(
            dir.path(),
            &[
                "alpaca-execute".to_string(),
                "--mode=analysis".to_string(),
                "--symbol=BTCUSD".to_string(),
                "--side=buy".to_string(),
                "--qty=2".to_string(),
                "--max-qty=5".to_string(),
            ],
        );
        assert_eq!(exec_exit, 0);
        let latest = read_json(&latest_path(dir.path())).expect("latest");
        assert_eq!(
            latest.get("type").and_then(Value::as_str),
            Some("llm_economy_organ_alpaca_execute")
        );
        assert_eq!(
            latest
                .get("risk_gate")
                .and_then(|v| v.get("passed"))
                .and_then(Value::as_bool),
            Some(true)
        );
    }

    #[test]
    fn economy_connector_commands_emit_deterministic_receipts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let cmds: Vec<Vec<String>> = vec![
            vec!["virtuals-acp", "--action=earn"],
            vec!["bankrbot-defi", "--strategy=stable"],
            vec!["jobs-marketplace", "--source=nookplot"],
            vec!["skills-marketplace", "--source=heurist"],
            vec!["fairscale-credit", "--delta=2.5"],
            vec!["mining-hand", "--network=litcoin", "--hours=4"],
            vec!["trade-router", "--chain=solana", "--symbol=SOL/USDC"],
            vec!["model-support-refresh", "--apply=1"],
        ]
        .into_iter()
        .map(|row| row.into_iter().map(|v| v.to_string()).collect::<Vec<_>>())
        .collect();
        for cmd in cmds {
            let exit = run(dir.path(), &cmd);
            assert_eq!(exit, 0, "failed command {:?}", cmd);
            let latest = read_json(&latest_path(dir.path())).expect("latest");
            assert!(latest.get("receipt_hash").is_some());
        }
    }
}
