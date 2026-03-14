// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer2/autonomy (authoritative).

use crate::{
    append_jsonl, clamp_int, clamp_num, clean_text, normalize_token, now_iso, parse_date_or_today,
    read_json, read_jsonl, resolve_runtime_path, round_to, write_json_atomic,
};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug)]
struct RoleCfg {
    weight: f64,
    bias: String,
}

#[derive(Clone, Debug)]
struct DebatePolicy {
    version: String,
    enabled: bool,
    shadow_only: bool,
    rounds_max: i64,
    rounds_min_agents: i64,
    consensus_threshold: f64,
    confidence_floor: f64,
    disagreement_gap_threshold: f64,
    runoff_enabled: bool,
    max_runoff_rounds: i64,
    runoff_consensus_threshold: f64,
    require_distinct_roles_for_quorum: bool,
    roles: HashMap<String, RoleCfg>,
    latest_path: PathBuf,
    history_path: PathBuf,
    receipts_path: PathBuf,
}

#[derive(Clone, Debug)]
struct Candidate {
    id: String,
    score: f64,
    confidence: f64,
    risk: String,
}

#[derive(Clone, Debug)]
struct Agent {
    id: String,
    role: String,
}

fn default_policy(root: &Path) -> DebatePolicy {
    let mut roles = HashMap::new();
    roles.insert(
        "soldier_guard".to_string(),
        RoleCfg {
            weight: 1.1,
            bias: "safety".to_string(),
        },
    );
    roles.insert(
        "creative_probe".to_string(),
        RoleCfg {
            weight: 1.0,
            bias: "growth".to_string(),
        },
    );
    roles.insert(
        "orderly_executor".to_string(),
        RoleCfg {
            weight: 1.15,
            bias: "delivery".to_string(),
        },
    );

    DebatePolicy {
        version: "1.0".to_string(),
        enabled: true,
        shadow_only: true,
        rounds_max: 2,
        rounds_min_agents: 3,
        consensus_threshold: 0.62,
        confidence_floor: 0.58,
        disagreement_gap_threshold: 0.08,
        runoff_enabled: true,
        max_runoff_rounds: 1,
        runoff_consensus_threshold: 0.57,
        require_distinct_roles_for_quorum: true,
        roles,
        latest_path: resolve_runtime_path(
            root,
            Some("local/state/autonomy/multi_agent_debate/latest.json"),
            "local/state/autonomy/multi_agent_debate/latest.json",
        ),
        history_path: resolve_runtime_path(
            root,
            Some("local/state/autonomy/multi_agent_debate/history.jsonl"),
            "local/state/autonomy/multi_agent_debate/history.jsonl",
        ),
        receipts_path: resolve_runtime_path(
            root,
            Some("local/state/autonomy/multi_agent_debate/receipts.jsonl"),
            "local/state/autonomy/multi_agent_debate/receipts.jsonl",
        ),
    }
}

fn policy_path(root: &Path, explicit: Option<&Path>) -> PathBuf {
    explicit
        .map(|p| p.to_path_buf())
        .or_else(|| {
            std::env::var("MULTI_AGENT_DEBATE_POLICY_PATH")
                .ok()
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| {
            resolve_runtime_path(
                root,
                Some("config/multi_agent_debate_policy.json"),
                "config/multi_agent_debate_policy.json",
            )
        })
}

fn load_policy(root: &Path, explicit: Option<&Path>) -> DebatePolicy {
    let p = policy_path(root, explicit);
    let mut policy = default_policy(root);
    let raw = read_json(&p);
    let obj = raw.as_object();

    if let Some(v) = obj
        .and_then(|m| m.get("version"))
        .and_then(Value::as_str)
        .map(|s| clean_text(s, 40))
    {
        if !v.is_empty() {
            policy.version = v;
        }
    }
    if let Some(v) = obj.and_then(|m| m.get("enabled")).and_then(Value::as_bool) {
        policy.enabled = v;
    }
    if let Some(v) = obj
        .and_then(|m| m.get("shadow_only"))
        .and_then(Value::as_bool)
    {
        policy.shadow_only = v;
    }

    if let Some(rounds) = obj.and_then(|m| m.get("rounds")).and_then(Value::as_object) {
        policy.rounds_max = clamp_int(
            rounds
                .get("max_rounds")
                .and_then(Value::as_i64)
                .unwrap_or(policy.rounds_max),
            1,
            8,
            policy.rounds_max,
        );
        policy.rounds_min_agents = clamp_int(
            rounds
                .get("min_agents")
                .and_then(Value::as_i64)
                .unwrap_or(policy.rounds_min_agents),
            1,
            16,
            policy.rounds_min_agents,
        );
        policy.consensus_threshold = clamp_num(
            rounds
                .get("consensus_threshold")
                .and_then(Value::as_f64)
                .unwrap_or(policy.consensus_threshold),
            0.0,
            1.0,
            policy.consensus_threshold,
        );
    }

    if let Some(res) = obj
        .and_then(|m| m.get("debate_resolution"))
        .and_then(Value::as_object)
    {
        policy.confidence_floor = clamp_num(
            res.get("confidence_floor")
                .and_then(Value::as_f64)
                .unwrap_or(policy.confidence_floor),
            0.0,
            1.0,
            policy.confidence_floor,
        );
        policy.disagreement_gap_threshold = clamp_num(
            res.get("disagreement_gap_threshold")
                .and_then(Value::as_f64)
                .unwrap_or(policy.disagreement_gap_threshold),
            0.0,
            1.0,
            policy.disagreement_gap_threshold,
        );
        if let Some(v) = res.get("runoff_enabled").and_then(Value::as_bool) {
            policy.runoff_enabled = v;
        }
        policy.max_runoff_rounds = clamp_int(
            res.get("max_runoff_rounds")
                .and_then(Value::as_i64)
                .unwrap_or(policy.max_runoff_rounds),
            0,
            3,
            policy.max_runoff_rounds,
        );
        policy.runoff_consensus_threshold = clamp_num(
            res.get("runoff_consensus_threshold")
                .and_then(Value::as_f64)
                .unwrap_or(policy.runoff_consensus_threshold),
            0.0,
            1.0,
            policy.runoff_consensus_threshold,
        );
        if let Some(v) = res
            .get("require_distinct_roles_for_quorum")
            .and_then(Value::as_bool)
        {
            policy.require_distinct_roles_for_quorum = v;
        }
    }

    if let Some(role_map) = obj
        .and_then(|m| m.get("agent_roles"))
        .and_then(Value::as_object)
    {
        let mut next = HashMap::new();
        for (k, row) in role_map {
            let role_key = normalize_token(k, 80);
            if role_key.is_empty() {
                continue;
            }
            let src = row.as_object();
            next.insert(
                role_key,
                RoleCfg {
                    weight: clamp_num(
                        src.and_then(|r| r.get("weight"))
                            .and_then(Value::as_f64)
                            .unwrap_or(1.0),
                        0.2,
                        5.0,
                        1.0,
                    ),
                    bias: {
                        let b = src
                            .and_then(|r| r.get("bias"))
                            .and_then(Value::as_str)
                            .map(|v| normalize_token(v, 40))
                            .unwrap_or_else(|| "delivery".to_string());
                        if b.is_empty() {
                            "delivery".to_string()
                        } else {
                            b
                        }
                    },
                },
            );
        }
        if !next.is_empty() {
            policy.roles = next;
        }
    }

    if let Some(outputs) = obj
        .and_then(|m| m.get("outputs"))
        .and_then(Value::as_object)
    {
        policy.latest_path = resolve_runtime_path(
            root,
            outputs.get("latest_path").and_then(Value::as_str),
            "local/state/autonomy/multi_agent_debate/latest.json",
        );
        policy.history_path = resolve_runtime_path(
            root,
            outputs.get("history_path").and_then(Value::as_str),
            "local/state/autonomy/multi_agent_debate/history.jsonl",
        );
        policy.receipts_path = resolve_runtime_path(
            root,
            outputs.get("receipts_path").and_then(Value::as_str),
            "local/state/autonomy/multi_agent_debate/receipts.jsonl",
        );
    }

    policy
}

fn normalize_candidates(input: &Value) -> Vec<Candidate> {
    let rows = input
        .get("candidates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let mut out = Vec::new();
    for (idx, row) in rows.iter().enumerate() {
        let obj = row.as_object();
        let mut candidate_id = obj
            .and_then(|m| m.get("candidate_id"))
            .and_then(Value::as_str)
            .map(|v| normalize_token(v, 120))
            .unwrap_or_default();
        if candidate_id.is_empty() {
            candidate_id = obj
                .and_then(|m| m.get("metric_id"))
                .and_then(Value::as_str)
                .map(|v| normalize_token(v, 120))
                .unwrap_or_else(|| format!("candidate_{}", idx + 1));
        }
        if candidate_id.is_empty() {
            continue;
        }
        out.push(Candidate {
            id: candidate_id,
            score: clamp_num(
                obj.and_then(|m| m.get("score"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.5),
                0.0,
                1.0,
                0.5,
            ),
            confidence: clamp_num(
                obj.and_then(|m| m.get("confidence"))
                    .and_then(Value::as_f64)
                    .unwrap_or(0.5),
                0.0,
                1.0,
                0.5,
            ),
            risk: {
                let r = obj
                    .and_then(|m| m.get("risk"))
                    .and_then(Value::as_str)
                    .map(|v| normalize_token(v, 32))
                    .unwrap_or_else(|| "medium".to_string());
                if matches!(r.as_str(), "low" | "medium" | "high") {
                    r
                } else {
                    "medium".to_string()
                }
            },
        });
    }

    out
}

fn build_agents(policy: &DebatePolicy, input: &Value) -> Vec<Agent> {
    let explicit = input.get("agents").and_then(Value::as_array);
    if let Some(rows) = explicit {
        let mut out = Vec::new();
        for (idx, row) in rows.iter().enumerate() {
            let obj = row.as_object();
            let agent_id = obj
                .and_then(|m| m.get("agent_id"))
                .and_then(Value::as_str)
                .map(|v| normalize_token(v, 120))
                .unwrap_or_else(|| format!("agent_{}", idx + 1));
            if agent_id.is_empty() {
                continue;
            }
            let role = obj
                .and_then(|m| m.get("role"))
                .and_then(Value::as_str)
                .map(|v| normalize_token(v, 80))
                .filter(|v| !v.is_empty())
                .unwrap_or_else(|| "orderly_executor".to_string());
            out.push(Agent { id: agent_id, role });
        }
        if !out.is_empty() {
            return out;
        }
    }

    policy
        .roles
        .keys()
        .map(|k| Agent {
            id: k.clone(),
            role: k.clone(),
        })
        .collect()
}

fn score_candidate_for_role(role_cfg: &RoleCfg, candidate: &Candidate) -> f64 {
    let base = candidate.score * candidate.confidence;
    let bias_boost = match role_cfg.bias.as_str() {
        "safety" => match candidate.risk.as_str() {
            "low" => 0.25,
            "medium" => 0.08,
            _ => -0.15,
        },
        "growth" => match candidate.risk.as_str() {
            "high" => 0.18,
            "medium" => 0.10,
            _ => 0.02,
        },
        "delivery" => match candidate.risk.as_str() {
            "medium" => 0.14,
            "low" => 0.10,
            _ => -0.08,
        },
        _ => 0.0,
    };
    round_to(
        clamp_num((base + bias_boost) * role_cfg.weight, 0.0, 1.0, 0.0),
        6,
    )
}

pub fn run_multi_agent_debate(
    root: &Path,
    input: &Value,
    explicit_policy_path: Option<&Path>,
    persist: bool,
    date_override: Option<&str>,
) -> Value {
    let policy = load_policy(root, explicit_policy_path);
    if !policy.enabled {
        return json!({
            "ok": false,
            "type": "multi_agent_debate_orchestrator",
            "error": "policy_disabled"
        });
    }

    let ts = now_iso();
    let date = parse_date_or_today(
        date_override
            .or_else(|| input.get("date").and_then(Value::as_str))
            .or_else(|| Some(&ts[..10])),
    );
    let objective_id = input
        .get("objective_id")
        .or_else(|| input.get("objectiveId"))
        .and_then(Value::as_str)
        .map(|v| normalize_token(v, 120))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "generic_objective".to_string());
    let objective_text = input
        .get("objective")
        .or_else(|| input.get("objective_text"))
        .and_then(Value::as_str)
        .map(|v| clean_text(v, 300))
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| objective_id.clone());

    let candidates = normalize_candidates(input);
    let agents = build_agents(&policy, input);
    let rounds = policy.rounds_max.max(1);

    let mut transcript: Vec<Value> = Vec::new();
    let mut vote_totals: HashMap<String, f64> = HashMap::new();
    let mut distinct_roles: HashSet<String> = HashSet::new();
    let mut disagreement_votes: i64 = 0;
    let mut total_votes: i64 = 0;

    for round in 1..=rounds {
        for agent in &agents {
            let role = if agent.role.is_empty() {
                "orderly_executor".to_string()
            } else {
                agent.role.clone()
            };
            distinct_roles.insert(role.clone());
            let role_cfg = policy.roles.get(&role).cloned().unwrap_or(RoleCfg {
                weight: 1.0,
                bias: "delivery".to_string(),
            });

            let mut scored: Vec<(String, f64)> = candidates
                .iter()
                .map(|candidate| {
                    (
                        candidate.id.clone(),
                        score_candidate_for_role(&role_cfg, candidate),
                    )
                })
                .collect();
            scored.sort_by(|a, b| {
                b.1.partial_cmp(&a.1)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then_with(|| a.0.cmp(&b.0))
            });

            let Some(top) = scored.first() else {
                continue;
            };
            let runner_up = scored.get(1);
            let gap = runner_up.map(|r| round_to(top.1 - r.1, 6)).unwrap_or(1.0);
            let contested = gap <= policy.disagreement_gap_threshold;
            let certainty = round_to(clamp_num((gap + 0.45).max(0.05), 0.0, 1.0, 0.5), 6);

            if contested {
                disagreement_votes += 1;
            }
            total_votes += 1;
            let vote_weight = round_to(top.1 * certainty, 6);
            *vote_totals.entry(top.0.clone()).or_insert(0.0) += vote_weight;

            transcript.push(json!({
                "round": round,
                "agent_id": agent.id,
                "role": role,
                "selected_candidate_id": top.0,
                "vote_score": top.1,
                "certainty": certainty,
                "contested": contested,
                "gap_to_runner_up": gap,
                "runner_up_candidate_id": runner_up.map(|r| r.0.clone())
            }));
        }
    }

    let mut ranked: Vec<(String, f64)> = vote_totals
        .iter()
        .map(|(k, v)| (k.clone(), round_to(*v, 6)))
        .collect();
    ranked.sort_by(|a, b| {
        b.1.partial_cmp(&a.1)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.0.cmp(&b.0))
    });
    let top = ranked.first().cloned();
    let total_score: f64 = ranked.iter().map(|(_, s)| *s).sum();
    let consensus_share = if total_score > 0.0 {
        round_to(top.clone().map(|(_, s)| s).unwrap_or(0.0) / total_score, 6)
    } else {
        0.0
    };
    let disagreement_index = if total_votes > 0 {
        round_to(disagreement_votes as f64 / total_votes as f64, 6)
    } else {
        0.0
    };

    let min_agents = policy.rounds_min_agents.max(1) as usize;
    let quorum_met = agents.len() >= min_agents
        && (!policy.require_distinct_roles_for_quorum
            || distinct_roles.len() >= std::cmp::min(3usize, min_agents));
    let confidence_score = round_to(
        clamp_num(
            consensus_share * (1.0 - disagreement_index * 0.5),
            0.0,
            1.0,
            0.0,
        ),
        6,
    );

    let mut consensus = quorum_met
        && consensus_share >= policy.consensus_threshold
        && confidence_score >= policy.confidence_floor;
    let mut recommended_candidate_id = top.clone().map(|(id, _)| id);
    if !consensus {
        recommended_candidate_id = None;
    }

    let mut runoff_executed = false;
    let mut runoff_consensus = false;
    let mut runoff_recommended_candidate_id: Option<String> = None;

    if !consensus && policy.runoff_enabled && policy.max_runoff_rounds > 0 && ranked.len() >= 2 {
        runoff_executed = true;
        let runoff_candidates = vec![ranked[0].0.clone(), ranked[1].0.clone()];
        let mut runoff_totals: HashMap<String, f64> = HashMap::new();

        for round in 1..=policy.max_runoff_rounds {
            for agent in &agents {
                let role = if agent.role.is_empty() {
                    "orderly_executor".to_string()
                } else {
                    agent.role.clone()
                };
                let role_cfg = policy.roles.get(&role).cloned().unwrap_or(RoleCfg {
                    weight: 1.0,
                    bias: "delivery".to_string(),
                });

                let mut scored: Vec<(String, f64)> = runoff_candidates
                    .iter()
                    .map(|candidate_id| {
                        let source = candidates
                            .iter()
                            .find(|row| row.id == *candidate_id)
                            .cloned()
                            .unwrap_or(Candidate {
                                id: candidate_id.clone(),
                                score: 0.5,
                                confidence: 0.5,
                                risk: "medium".to_string(),
                            });
                        (
                            candidate_id.clone(),
                            score_candidate_for_role(&role_cfg, &source),
                        )
                    })
                    .collect();

                scored.sort_by(|a, b| {
                    b.1.partial_cmp(&a.1)
                        .unwrap_or(std::cmp::Ordering::Equal)
                        .then_with(|| a.0.cmp(&b.0))
                });

                let Some(pick) = scored.first() else {
                    continue;
                };
                *runoff_totals.entry(pick.0.clone()).or_insert(0.0) += pick.1;
                transcript.push(json!({
                    "round": rounds + round,
                    "phase": "runoff",
                    "agent_id": agent.id,
                    "role": role,
                    "selected_candidate_id": pick.0,
                    "vote_score": pick.1,
                    "runoff_candidates": runoff_candidates
                }));
            }
        }

        let mut runoff_ranked: Vec<(String, f64)> = runoff_totals
            .iter()
            .map(|(k, v)| (k.clone(), round_to(*v, 6)))
            .collect();
        runoff_ranked.sort_by(|a, b| {
            b.1.partial_cmp(&a.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.0.cmp(&b.0))
        });
        let runoff_top = runoff_ranked.first().cloned();
        let runoff_total: f64 = runoff_ranked.iter().map(|(_, s)| *s).sum();
        let runoff_share = if runoff_total > 0.0 {
            round_to(
                runoff_top.clone().map(|(_, s)| s).unwrap_or(0.0) / runoff_total,
                6,
            )
        } else {
            0.0
        };
        let runoff_confidence = round_to(
            clamp_num(
                runoff_share * (1.0 - disagreement_index * 0.35),
                0.0,
                1.0,
                0.0,
            ),
            6,
        );

        runoff_consensus = quorum_met
            && runoff_share >= policy.runoff_consensus_threshold
            && runoff_confidence >= policy.confidence_floor;
        if runoff_consensus {
            consensus = true;
            runoff_recommended_candidate_id = runoff_top.clone().map(|(id, _)| id);
            recommended_candidate_id = runoff_top.map(|(id, _)| id);
        }
    }

    let ranked_json: Vec<Value> = ranked
        .iter()
        .map(|(candidate_id, score)| json!({ "candidate_id": candidate_id, "score": score }))
        .collect();

    let mut reason_codes = vec![];
    if consensus {
        if runoff_executed && runoff_consensus {
            reason_codes.push("multi_agent_consensus_reached_after_runoff".to_string());
        } else {
            reason_codes.push("multi_agent_consensus_reached".to_string());
        }
    } else {
        reason_codes.push("multi_agent_consensus_not_reached".to_string());
    }
    reason_codes.push(format!("confidence_score_{:.3}", confidence_score));

    let out = json!({
        "ok": true,
        "type": "multi_agent_debate_orchestrator",
        "ts": ts,
        "date": date,
        "shadow_only": policy.shadow_only,
        "objective_id": objective_id,
        "objective_text": objective_text,
        "rounds_executed": rounds,
        "quorum_met": quorum_met,
        "quorum_rule": {
            "min_agents": min_agents,
            "require_distinct_roles_for_quorum": policy.require_distinct_roles_for_quorum,
            "distinct_roles": distinct_roles.into_iter().collect::<Vec<_>>()
        },
        "consensus": consensus,
        "confidence_score": confidence_score,
        "confidence_floor": policy.confidence_floor,
        "consensus_share": consensus_share,
        "disagreement_index": disagreement_index,
        "disagreement_votes": disagreement_votes,
        "total_votes": total_votes,
        "recommended_candidate_id": recommended_candidate_id,
        "debate_resolution": {
            "runoff_executed": runoff_executed,
            "runoff_consensus": runoff_consensus,
            "runoff_rounds": if runoff_executed { policy.max_runoff_rounds } else { 0 },
            "runoff_recommended_candidate_id": runoff_recommended_candidate_id
        },
        "ranked_candidates": ranked_json,
        "debate_transcript": transcript,
        "reason_codes": reason_codes
    });

    if persist {
        let _ = write_json_atomic(&policy.latest_path, &out);
        let _ = append_jsonl(&policy.history_path, &out);
        let _ = append_jsonl(&policy.receipts_path, &out);
    }

    out
}

pub fn debate_status(root: &Path, explicit_policy_path: Option<&Path>, key: Option<&str>) -> Value {
    let policy = load_policy(root, explicit_policy_path);
    let key = clean_text(key.unwrap_or("latest"), 40);

    let payload = if key == "latest" {
        read_json(&policy.latest_path)
    } else {
        let day = parse_date_or_today(Some(&key));
        let rows = read_jsonl(&policy.history_path);
        rows.into_iter()
            .filter(|row| row.get("date").and_then(Value::as_str) == Some(day.as_str()))
            .last()
            .unwrap_or(Value::Null)
    };

    if !payload.is_object() {
        return json!({
            "ok": false,
            "type": "multi_agent_debate_status",
            "error": "snapshot_missing",
            "date": key
        });
    }

    json!({
        "ok": true,
        "type": "multi_agent_debate_status",
        "ts": payload.get("ts").cloned().unwrap_or(Value::Null),
        "date": payload.get("date").cloned().unwrap_or(Value::Null),
        "objective_id": payload.get("objective_id").cloned().unwrap_or(Value::Null),
        "consensus": payload.get("consensus").cloned().unwrap_or(json!(false)),
        "confidence_score": payload.get("confidence_score").cloned().unwrap_or(json!(0.0)),
        "consensus_share": payload.get("consensus_share").cloned().unwrap_or(json!(0.0)),
        "disagreement_index": payload.get("disagreement_index").cloned().unwrap_or(json!(0.0)),
        "recommended_candidate_id": payload
            .get("recommended_candidate_id")
            .cloned()
            .unwrap_or(Value::Null),
        "rounds_executed": payload.get("rounds_executed").cloned().unwrap_or(json!(0)),
        "shadow_only": payload.get("shadow_only").cloned().unwrap_or(json!(true))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn run_debate_reaches_runoff_consensus() {
        let dir = tempdir().expect("tmp");
        let root = dir.path();
        let policy_path = root.join("policy.json");
        let latest = root.join("local/state/latest.json");
        let history = root.join("local/state/history.jsonl");
        let receipts = root.join("local/state/receipts.jsonl");

        let policy = json!({
            "enabled": true,
            "rounds": { "max_rounds": 2, "min_agents": 3, "consensus_threshold": 0.7 },
            "debate_resolution": {
                "confidence_floor": 0.35,
                "disagreement_gap_threshold": 0.12,
                "runoff_enabled": true,
                "max_runoff_rounds": 1,
                "runoff_consensus_threshold": 0.57,
                "require_distinct_roles_for_quorum": true
            },
            "agent_roles": {
                "soldier_guard": { "weight": 1.1, "bias": "safety" },
                "creative_probe": { "weight": 1.0, "bias": "growth" },
                "orderly_executor": { "weight": 1.2, "bias": "delivery" }
            },
            "outputs": {
                "latest_path": latest,
                "history_path": history,
                "receipts_path": receipts
            }
        });
        write_json_atomic(&policy_path, &policy).expect("write policy");

        let input = json!({
            "objective_id": "mac_test",
            "objective": "Choose best value axis",
            "candidates": [
                { "candidate_id": "quality", "score": 0.72, "confidence": 0.72, "risk": "low" },
                { "candidate_id": "revenue", "score": 0.75, "confidence": 0.74, "risk": "high" },
                { "candidate_id": "learning", "score": 0.74, "confidence": 0.73, "risk": "medium" }
            ]
        });

        let out = run_multi_agent_debate(root, &input, Some(&policy_path), true, None);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            out.get("type").and_then(Value::as_str),
            Some("multi_agent_debate_orchestrator")
        );
        assert_eq!(
            out.get("debate_resolution")
                .and_then(Value::as_object)
                .and_then(|m| m.get("runoff_executed"))
                .and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(
            out.get("debate_resolution")
                .and_then(Value::as_object)
                .and_then(|m| m.get("runoff_consensus"))
                .and_then(Value::as_bool),
            Some(true)
        );

        let status = debate_status(root, Some(&policy_path), None);
        assert_eq!(status.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            status.get("objective_id").and_then(Value::as_str),
            Some("mac_test")
        );
    }
}
