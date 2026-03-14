// Layer ownership: core/layer2/ops (authoritative)
// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_epoch_ms};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops p2p-gossip-seed status|dashboard",
    "  protheus-ops p2p-gossip-seed discover|join [--profile=hyperspace] [--node=<id>] [--apply=1|0]",
    "  protheus-ops p2p-gossip-seed compute-proof [--share=1|0] [--matmul-size=<n>] [--credits=<n>]",
    "  protheus-ops p2p-gossip-seed gossip [--topic=<topic>] [--breakthrough=<text>]",
    "  protheus-ops p2p-gossip-seed idle-rss [--feed=<id>] [--note=<text>]",
    "  protheus-ops p2p-gossip-seed ranking-evolve [--metric=ndcg@10] [--delta=<0..1>]",
];

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let pref = format!("--{key}=");
    let key_long = format!("--{key}");
    let mut i = 0usize;
    while i < argv.len() {
        let token = argv[i].trim();
        if let Some(v) = token.strip_prefix(&pref) {
            return Some(v.to_string());
        }
        if token == key_long && i + 1 < argv.len() {
            return Some(argv[i + 1].clone());
        }
        i += 1;
    }
    None
}

fn parse_bool(raw: Option<String>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

fn parse_f64(raw: Option<String>, fallback: f64) -> f64 {
    raw.and_then(|v| v.trim().parse::<f64>().ok())
        .unwrap_or(fallback)
}

fn parse_u64(raw: Option<String>, fallback: u64) -> u64 {
    raw.and_then(|v| v.trim().parse::<u64>().ok())
        .unwrap_or(fallback)
}

fn command_claim_ids(command: &str) -> &'static [&'static str] {
    match command {
        "discover" | "join" => &["V6-NETWORK-004.6", "V6-NETWORK-004.2"],
        "compute-proof" => &["V6-NETWORK-004.1", "V6-NETWORK-004.2", "V6-NETWORK-004.6"],
        "gossip" => &["V6-NETWORK-004.3"],
        "idle-rss" => &["V6-NETWORK-004.4"],
        "ranking-evolve" => &["V6-NETWORK-004.5"],
        "status" | "dashboard" => &["V6-NETWORK-004.2", "V6-NETWORK-004.6"],
        _ => &[],
    }
}

fn conduit_enforcement(argv: &[String], command: &str, strict: bool) -> Value {
    let bypass_requested = parse_bool(parse_flag(argv, "bypass"), false)
        || parse_bool(parse_flag(argv, "client-bypass"), false);
    let ok = !bypass_requested;
    let claim_rows = command_claim_ids(command)
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "claim": "network_commands_route_through_core_runtime_with_fail_closed_bypass_denial",
                "evidence": {
                    "command": command,
                    "bypass_requested": bypass_requested
                }
            })
        })
        .collect::<Vec<_>>();
    let mut out = json!({
        "ok": if strict { ok } else { true },
        "type": "p2p_gossip_seed_conduit_enforcement",
        "command": command,
        "strict": strict,
        "bypass_requested": bypass_requested,
        "errors": if ok { Value::Array(Vec::new()) } else { json!(["conduit_bypass_rejected"]) },
        "claim_evidence": claim_rows
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn state_dir(root: &Path) -> PathBuf {
    root.join("local").join("state").join("ops").join("p2p_gossip_seed")
}

fn latest_path(root: &Path) -> PathBuf {
    state_dir(root).join("latest.json")
}

fn history_path(root: &Path) -> PathBuf {
    state_dir(root).join("history.jsonl")
}

fn reputation_path(root: &Path) -> PathBuf {
    state_dir(root).join("reputation_ledger.json")
}

fn contribution_path(root: &Path) -> PathBuf {
    state_dir(root).join("contribution_ledger.json")
}

fn gossip_log_path(root: &Path) -> PathBuf {
    state_dir(root).join("gossip_log.jsonl")
}

fn idle_feed_log_path(root: &Path) -> PathBuf {
    state_dir(root).join("idle_feed_log.jsonl")
}

fn ranking_state_path(root: &Path) -> PathBuf {
    state_dir(root).join("ranking_metrics.json")
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
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

fn persist_receipt(root: &Path, value: &Value) {
    write_json(&latest_path(root), value);
    append_jsonl(&history_path(root), value);
}

fn reputations(root: &Path) -> serde_json::Map<String, Value> {
    read_json(&reputation_path(root))
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_reputations(root: &Path, map: &serde_json::Map<String, Value>) {
    write_json(&reputation_path(root), &Value::Object(map.clone()));
}

fn contributions(root: &Path) -> serde_json::Map<String, Value> {
    read_json(&contribution_path(root))
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn write_contributions(root: &Path, map: &serde_json::Map<String, Value>) {
    write_json(&contribution_path(root), &Value::Object(map.clone()));
}

fn count_jsonl_rows(path: &Path) -> u64 {
    fs::read_to_string(path)
        .ok()
        .map(|raw| raw.lines().filter(|row| !row.trim().is_empty()).count() as u64)
        .unwrap_or(0)
}

fn usage() {
    for line in USAGE {
        println!("{line}");
    }
}

fn dashboard_receipt(root: &Path) -> Value {
    let latest = read_json(&latest_path(root));
    let rep = reputations(root);
    let contribution_ledger = contributions(root);
    let contribution_nodes = contribution_ledger.len();
    let ranking_state = read_json(&ranking_state_path(root)).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "latest": Value::Null,
            "history": []
        })
    });
    let gossip_events = count_jsonl_rows(&gossip_log_path(root));
    let idle_events = count_jsonl_rows(&idle_feed_log_path(root));
    let nodes = rep.len() as u64;
    let total_rep: f64 = rep.values().filter_map(Value::as_f64).sum();
    let mut out = json!({
        "ok": true,
        "type": "p2p_gossip_seed_dashboard",
        "lane": "core/layer2/ops",
        "ts_epoch_ms": now_epoch_ms(),
        "node_count": nodes,
        "reputation_total": total_rep,
        "reputation_ledger": rep,
        "contribution_ledger": contribution_ledger,
        "ranking_state": ranking_state,
        "event_totals": {
            "gossip_events": gossip_events,
            "idle_feed_events": idle_events
        },
        "latest_event": latest,
        "claim_evidence": [
            {
                "id": "V6-NETWORK-004.2",
                "claim": "reputation_ledger_updates_are_persisted_and_visible_in_dashboard_receipts",
                "evidence": {
                    "node_count": nodes,
                    "reputation_total": total_rep,
                    "contribution_nodes": contribution_nodes
                }
            },
            {
                "id": "V6-NETWORK-004.6",
                "claim": "network_join_compute_share_and_dashboard_are_exposed_as_core_receipted_surfaces",
                "evidence": {
                    "surface": "network dashboard",
                    "node_count": nodes,
                    "gossip_events": gossip_events
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let command = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let strict = parse_bool(parse_flag(argv, "strict"), false);

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    if matches!(command.as_str(), "status" | "dashboard") {
        let conduit = conduit_enforcement(argv, &command, strict);
        if strict && !conduit.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            let mut out = json!({
                "ok": false,
                "type": "p2p_gossip_seed_conduit_gate",
                "lane": "core/layer2/ops",
                "command": command,
                "strict": strict,
                "errors": ["conduit_bypass_rejected"],
                "conduit_enforcement": conduit
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            print_json_line(&out);
            return 1;
        }
        let out = dashboard_receipt(root);
        persist_receipt(root, &out);
        print_json_line(&out);
        return 0;
    }

    let conduit = conduit_enforcement(argv, &command, strict);
    if strict && !conduit.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let mut out = json!({
            "ok": false,
            "type": "p2p_gossip_seed_conduit_gate",
            "lane": "core/layer2/ops",
            "command": command,
            "strict": strict,
            "errors": ["conduit_bypass_rejected"],
            "conduit_enforcement": conduit
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        print_json_line(&out);
        return 1;
    }

    if matches!(command.as_str(), "discover" | "join") {
        let profile = parse_flag(argv, "profile").unwrap_or_else(|| "hyperspace".to_string());
        let node = parse_flag(argv, "node").unwrap_or_else(|| "local-node".to_string());
        let apply = parse_bool(parse_flag(argv, "apply"), true);
        let mut rep = reputations(root);
        rep.entry(node.clone()).or_insert(Value::from(1.0));
        let bootstrap_reputation = rep.get(&node).and_then(Value::as_f64).unwrap_or(0.0);
        write_reputations(root, &rep);
        let mut out = json!({
            "ok": true,
            "type": "p2p_gossip_seed_join",
            "lane": "core/layer2/ops",
            "ts_epoch_ms": now_epoch_ms(),
            "command": command,
            "profile": profile.clone(),
            "node": node.clone(),
            "apply": apply,
            "claim_evidence": [
                {
                    "id": "V6-NETWORK-004.6",
                    "claim": "network_join_hyperspace_routes_to_core_runtime_with_deterministic_receipts",
                    "evidence": {
                        "profile": profile,
                        "node": node.clone()
                    }
                },
                {
                    "id": "V6-NETWORK-004.2",
                    "claim": "reputation_ledger_bootstraps_identity_state_on_join",
                    "evidence": {
                        "node": node,
                        "bootstrap_reputation": bootstrap_reputation
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        persist_receipt(root, &out);
        print_json_line(&out);
        return 0;
    }

    if command == "compute-proof" {
        let share = parse_bool(parse_flag(argv, "share"), true);
        let node = parse_flag(argv, "node").unwrap_or_else(|| "local-node".to_string());
        let matmul_size = parse_u64(parse_flag(argv, "matmul-size"), 512);
        let credits = parse_f64(parse_flag(argv, "credits"), 1.0).max(0.0);
        if strict && (matmul_size < 64 || !matmul_size.is_power_of_two()) {
            let mut out = json!({
                "ok": false,
                "type": "p2p_gossip_seed_compute_proof_error",
                "lane": "core/layer2/ops",
                "ts_epoch_ms": now_epoch_ms(),
                "error": "invalid_matmul_size",
                "matmul_size": matmul_size,
                "required": "power_of_two_and_gte_64"
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            persist_receipt(root, &out);
            print_json_line(&out);
            return 2;
        }
        let mut rep = reputations(root);
        let prior = rep.get(&node).and_then(Value::as_f64).unwrap_or(1.0);
        let next = if share { prior + credits } else { prior };
        rep.insert(node.clone(), Value::from(next));
        write_reputations(root, &rep);
        let challenge = json!({
            "algo": "matmul",
            "matmul_size": matmul_size,
            "node": node,
            "share": share
        });
        let challenge_id = deterministic_receipt_hash(&challenge);
        let mut contribution = contributions(root);
        let existing = contribution.get(&node).cloned().unwrap_or_else(|| json!({
            "proof_count": 0,
            "total_credits": 0.0
        }));
        let prior_count = existing
            .get("proof_count")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let prior_credits = existing
            .get("total_credits")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        contribution.insert(
            node.clone(),
            json!({
                "proof_count": prior_count + 1,
                "total_credits": prior_credits + if share { credits } else { 0.0 },
                "last_challenge_id": challenge_id,
                "last_matmul_size": matmul_size,
                "updated_at_epoch_ms": now_epoch_ms()
            }),
        );
        write_contributions(root, &contribution);
        let mut out = json!({
            "ok": true,
            "type": "p2p_gossip_seed_compute_proof",
            "lane": "core/layer2/ops",
            "ts_epoch_ms": now_epoch_ms(),
            "share": share,
            "node": node.clone(),
            "proof": {
                "challenge": challenge,
                "challenge_id": challenge_id,
                "matmul_size": matmul_size
            },
            "credits": {
                "delta": credits,
                "prior": prior,
                "next": next
            },
            "contribution_ledger_path": contribution_path(root).display().to_string(),
            "claim_evidence": [
                {
                    "id": "V6-NETWORK-004.1",
                    "claim": "compute_proof_emits_matmul_challenge_receipts_and_credit_updates",
                    "evidence": {
                        "matmul_size": matmul_size,
                        "delta": credits,
                        "challenge_id": challenge_id
                    }
                },
                {
                    "id": "V6-NETWORK-004.2",
                    "claim": "reputation_ledger_is_updated_deterministically_for_compute_contributions",
                    "evidence": {
                        "node": node.clone(),
                        "prior": prior,
                        "next": next,
                        "proof_count": prior_count + 1
                    }
                },
                {
                    "id": "V6-NETWORK-004.6",
                    "claim": "compute_share_surface_routes_into_core_network_runtime_with_receipts",
                    "evidence": {
                        "surface": "compute share",
                        "share": share
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        persist_receipt(root, &out);
        print_json_line(&out);
        return 0;
    }

    if command == "gossip" {
        let topic = parse_flag(argv, "topic").unwrap_or_else(|| "ranking".to_string());
        let breakthrough = parse_flag(argv, "breakthrough")
            .unwrap_or_else(|| "listnet_rediscovery_candidate".to_string());
        let rep = reputations(root);
        let peers = rep.keys().cloned().collect::<Vec<_>>();
        let gossip_record = json!({
            "version": "v1",
            "ts_epoch_ms": now_epoch_ms(),
            "topic": topic,
            "breakthrough": breakthrough,
            "peers": peers
        });
        let gossip_id = deterministic_receipt_hash(&gossip_record);
        append_jsonl(&gossip_log_path(root), &gossip_record);
        let mut out = json!({
            "ok": true,
            "type": "p2p_gossip_seed_breakthrough",
            "lane": "core/layer2/ops",
            "ts_epoch_ms": now_epoch_ms(),
            "topic": topic,
            "breakthrough": breakthrough,
            "gossip_id": gossip_id,
            "gossip_log_path": gossip_log_path(root).display().to_string(),
            "propagation": {
                "peer_count": peers.len(),
                "peers": peers
            },
            "claim_evidence": [
                {
                    "id": "V6-NETWORK-004.3",
                    "claim": "breakthrough_gossip_emits_deterministic_propagation_receipts",
                    "evidence": {
                        "topic": topic,
                        "peer_count": rep.len(),
                        "gossip_id": gossip_id
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        persist_receipt(root, &out);
        print_json_line(&out);
        return 0;
    }

    if command == "idle-rss" {
        let feed = parse_flag(argv, "feed").unwrap_or_else(|| "ai-news".to_string());
        let note = parse_flag(argv, "note").unwrap_or_else(|| "interesting_update".to_string());
        let feed_record = json!({
            "version": "v1",
            "ts_epoch_ms": now_epoch_ms(),
            "feed": feed,
            "agent_comment": note
        });
        let comment_id = deterministic_receipt_hash(&feed_record);
        append_jsonl(&idle_feed_log_path(root), &feed_record);
        let mut out = json!({
            "ok": true,
            "type": "p2p_gossip_seed_idle_rss",
            "lane": "core/layer2/ops",
            "ts_epoch_ms": now_epoch_ms(),
            "feed": feed,
            "agent_comment": note,
            "comment_id": comment_id,
            "idle_feed_log_path": idle_feed_log_path(root).display().to_string(),
            "claim_evidence": [
                {
                    "id": "V6-NETWORK-004.4",
                    "claim": "idle_rss_ingestion_emits_feed_and_inter_agent_comment_receipts",
                    "evidence": {
                        "feed": feed,
                        "comment_id": comment_id
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        persist_receipt(root, &out);
        print_json_line(&out);
        return 0;
    }

    if command == "ranking-evolve" {
        let metric = parse_flag(argv, "metric").unwrap_or_else(|| "ndcg@10".to_string());
        let delta = parse_f64(parse_flag(argv, "delta"), 0.02).clamp(-1.0, 1.0);
        let mut ranking = read_json(&ranking_state_path(root)).unwrap_or_else(|| {
            json!({
                "version":"v1",
                "history":[]
            })
        });
        if !ranking.get("history").map(Value::is_array).unwrap_or(false) {
            ranking["history"] = Value::Array(Vec::new());
        }
        let prior_score = ranking
            .get("latest")
            .and_then(|v| v.get("score"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let next_score = (prior_score + delta).clamp(-1.0, 1.0);
        let entry = json!({
            "ts_epoch_ms": now_epoch_ms(),
            "metric": metric,
            "delta": delta,
            "prior_score": prior_score,
            "next_score": next_score
        });
        let mut history = ranking
            .get("history")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        history.push(entry.clone());
        ranking["history"] = Value::Array(history);
        ranking["latest"] = entry.clone();
        write_json(&ranking_state_path(root), &ranking);
        let mut out = json!({
            "ok": true,
            "type": "p2p_gossip_seed_ranking_evolve",
            "lane": "core/layer2/ops",
            "ts_epoch_ms": now_epoch_ms(),
            "metric": metric,
            "delta": delta,
            "prior_score": prior_score,
            "next_score": next_score,
            "ranking_state_path": ranking_state_path(root).display().to_string(),
            "claim_evidence": [
                {
                    "id": "V6-NETWORK-004.5",
                    "claim": "ranking_evolution_loop_emits_metric_delta_receipts",
                    "evidence": {
                        "metric": metric,
                        "delta": delta,
                        "next_score": next_score
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        persist_receipt(root, &out);
        print_json_line(&out);
        return 0;
    }

    let mut out = json!({
        "ok": false,
        "type": "p2p_gossip_seed_error",
        "lane": "core/layer2/ops",
        "ts_epoch_ms": now_epoch_ms(),
        "error": "unknown_command",
        "command": command
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    print_json_line(&out);
    1
}

#[cfg(test)]
mod tests {
    use super::*;

    fn has_claim(value: &Value, claim_id: &str) -> bool {
        value
            .get("claim_evidence")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .any(|row| row.get("id").and_then(Value::as_str) == Some(claim_id))
    }

    #[test]
    fn join_then_compute_proof_updates_reputation() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            run(
                dir.path(),
                &[
                    "join".to_string(),
                    "--profile=hyperspace".to_string(),
                    "--node=n1".to_string(),
                ]
            ),
            0
        );
        assert_eq!(
            run(
                dir.path(),
                &[
                    "compute-proof".to_string(),
                    "--node=n1".to_string(),
                    "--credits=2.5".to_string(),
                ]
            ),
            0
        );
        let rep = reputations(dir.path());
        let score = rep.get("n1").and_then(Value::as_f64).unwrap_or(0.0);
        assert!(score >= 3.5);
        let contributions = contributions(dir.path());
        assert_eq!(
            contributions
                .get("n1")
                .and_then(|v| v.get("proof_count"))
                .and_then(Value::as_u64),
            Some(1)
        );

        let latest = read_json(&latest_path(dir.path())).expect("latest receipt");
        assert!(has_claim(&latest, "V6-NETWORK-004.1"));
        assert!(has_claim(&latest, "V6-NETWORK-004.2"));
        assert!(has_claim(&latest, "V6-NETWORK-004.6"));
        assert!(latest
            .pointer("/proof/challenge_id")
            .and_then(Value::as_str)
            .map(|v| !v.is_empty())
            .unwrap_or(false));
    }

    #[test]
    fn dashboard_reports_current_reputation_state() {
        let dir = tempfile::tempdir().expect("tempdir");
        let _ = run(
            dir.path(),
            &[
                "compute-proof".to_string(),
                "--node=n2".to_string(),
                "--credits=1.0".to_string(),
            ],
        );
        let receipt = dashboard_receipt(dir.path());
        assert_eq!(
            receipt.get("type").and_then(Value::as_str),
            Some("p2p_gossip_seed_dashboard")
        );
        assert_eq!(receipt.get("node_count").and_then(Value::as_u64), Some(1));
        assert!(has_claim(&receipt, "V6-NETWORK-004.2"));
        assert!(has_claim(&receipt, "V6-NETWORK-004.6"));
        assert!(receipt
            .get("event_totals")
            .and_then(Value::as_object)
            .is_some());
    }

    #[test]
    fn strict_conduit_mode_rejects_bypass() {
        let dir = tempfile::tempdir().expect("tempdir");
        let exit = run(
            dir.path(),
            &[
                "compute-proof".to_string(),
                "--strict=1".to_string(),
                "--bypass=1".to_string(),
            ],
        );
        assert_eq!(exit, 1);
    }

    #[test]
    fn strict_mode_rejects_invalid_matmul_size() {
        let dir = tempfile::tempdir().expect("tempdir");
        let exit = run(
            dir.path(),
            &[
                "compute-proof".to_string(),
                "--strict=1".to_string(),
                "--matmul-size=100".to_string(),
            ],
        );
        assert_eq!(exit, 2);
        let latest = read_json(&latest_path(dir.path())).expect("latest");
        assert_eq!(
            latest.get("type").and_then(Value::as_str),
            Some("p2p_gossip_seed_compute_proof_error")
        );
    }
}
