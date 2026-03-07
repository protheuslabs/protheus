// SPDX-License-Identifier: Apache-2.0
mod blob;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

pub use blob::{
    decode_manifest, fold_blob, generate_manifest, load_embedded_swarm_strategy,
    SwarmStrategyProfile, SWARM_STRATEGY_BLOB_ID,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SwarmAgent {
    pub id: String,
    pub skills: Vec<String>,
    pub capacity: u32,
    pub reliability_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SwarmTask {
    pub id: String,
    pub required_skill: String,
    pub weight: u32,
    pub priority: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SwarmRequest {
    pub swarm_id: String,
    pub agents: Vec<SwarmAgent>,
    pub tasks: Vec<SwarmTask>,
    #[serde(default)]
    pub mode: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TaskAssignment {
    pub task_id: String,
    pub agent_id: String,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SwarmReceipt {
    pub swarm_id: String,
    pub assignments: Vec<TaskAssignment>,
    pub unassigned_tasks: Vec<String>,
    pub consensus_pct: f64,
    pub sovereignty_index_pct: f64,
    pub profile_id: String,
    pub digest: String,
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn normalize_text(raw: &str, fallback: &str) -> String {
    let cleaned = raw.trim();
    if cleaned.is_empty() {
        fallback.to_string()
    } else {
        cleaned.to_string()
    }
}

fn has_skill(agent: &SwarmAgent, skill: &str) -> bool {
    let target = skill.to_ascii_lowercase();
    agent
        .skills
        .iter()
        .any(|s| s.to_ascii_lowercase() == target)
}

fn candidate_score(
    profile: &SwarmStrategyProfile,
    agent: &SwarmAgent,
    current_load: u32,
    task: &SwarmTask,
) -> f64 {
    let reliability = agent.reliability_pct.clamp(0.0, 100.0) / 100.0;
    let fairness = if agent.capacity == 0 {
        0.0
    } else {
        1.0 - (current_load as f64 / agent.capacity as f64).clamp(0.0, 1.0)
    };
    let priority_boost = (task.priority as f64 / 10.0).clamp(0.0, 1.5);

    ((reliability * profile.reliability_weight_pct)
        + (fairness * profile.fairness_weight_pct)
        + priority_boost)
        * 100.0
}

fn digest_receipt(receipt: &SwarmReceipt) -> String {
    let mut hasher = Sha256::new();
    hasher.update(receipt.swarm_id.as_bytes());
    for assignment in &receipt.assignments {
        hasher.update(
            format!(
                "{}:{}:{:.3}",
                assignment.task_id, assignment.agent_id, assignment.score
            )
            .as_bytes(),
        );
    }
    for task in &receipt.unassigned_tasks {
        hasher.update(task.as_bytes());
    }
    hasher.update(format!("{:.3}", receipt.consensus_pct).as_bytes());
    hasher.update(format!("{:.3}", receipt.sovereignty_index_pct).as_bytes());
    hex::encode(hasher.finalize())
}

pub fn orchestrate_swarm(request: &SwarmRequest) -> Result<SwarmReceipt, String> {
    let profile = load_embedded_swarm_strategy().map_err(|e| e.to_string())?;
    let mut assignments = Vec::<TaskAssignment>::new();
    let mut unassigned_tasks = Vec::<String>::new();
    let mut load: BTreeMap<String, u32> = BTreeMap::new();

    let mut tasks = request.tasks.clone();
    tasks.sort_by(|a, b| b.priority.cmp(&a.priority).then_with(|| a.id.cmp(&b.id)));

    for task in &tasks {
        let mut best: Option<(String, f64)> = None;

        for agent in &request.agents {
            if !has_skill(agent, &task.required_skill) {
                continue;
            }
            let current_load = load.get(&agent.id).copied().unwrap_or(0);
            let cap = u32::min(agent.capacity, profile.max_tasks_per_agent);
            if current_load >= cap {
                continue;
            }
            let score = candidate_score(&profile, agent, current_load, task);
            match &best {
                Some((best_id, best_score)) => {
                    if score > *best_score || (score == *best_score && agent.id < *best_id) {
                        best = Some((agent.id.clone(), score));
                    }
                }
                None => best = Some((agent.id.clone(), score)),
            }
        }

        match best {
            Some((agent_id, score)) => {
                let entry = load.entry(agent_id.clone()).or_insert(0);
                *entry += 1;
                assignments.push(TaskAssignment {
                    task_id: normalize_text(&task.id, "unknown_task"),
                    agent_id,
                    score: round3(score),
                });
            }
            None => {
                unassigned_tasks.push(normalize_text(&task.id, "unknown_task"));
            }
        }
    }

    let assigned = assignments.len().max(1) as f64;
    let avg_score = assignments.iter().map(|a| a.score).sum::<f64>() / assigned;
    let consensus_pct = round3(avg_score.clamp(0.0, 100.0));

    let coverage = if request.tasks.is_empty() {
        1.0
    } else {
        assignments.len() as f64 / request.tasks.len() as f64
    };
    let consensus_ratio = consensus_pct / 100.0;
    let sovereignty_index_pct = round3(
        (coverage * 60.0) + (consensus_ratio * 30.0) - (unassigned_tasks.len() as f64 * 2.0)
            + if consensus_pct >= profile.consensus_floor_pct {
                10.0
            } else {
                -5.0
            },
    )
    .clamp(0.0, 100.0);

    assignments.sort_by(|a, b| a.task_id.cmp(&b.task_id));
    unassigned_tasks.sort();

    let mut receipt = SwarmReceipt {
        swarm_id: normalize_text(&request.swarm_id, "swarm"),
        assignments,
        unassigned_tasks,
        consensus_pct,
        sovereignty_index_pct,
        profile_id: profile.profile_id,
        digest: String::new(),
    };
    receipt.digest = digest_receipt(&receipt);
    Ok(receipt)
}

pub fn orchestrate_swarm_json(request_json: &str) -> Result<String, String> {
    let request: SwarmRequest =
        serde_json::from_str(request_json).map_err(|e| format!("request_parse_failed:{e}"))?;

    let mut seen = BTreeSet::<String>::new();
    for task in &request.tasks {
        if !seen.insert(task.id.clone()) {
            return Err(format!("duplicate_task_id:{}", task.id));
        }
    }

    let receipt = orchestrate_swarm(&request)?;
    serde_json::to_string(&receipt).map_err(|e| format!("receipt_encode_failed:{e}"))
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn orchestrate_swarm_wasm(request_json: &str) -> String {
    match orchestrate_swarm_json(request_json) {
        Ok(v) => v,
        Err(err) => serde_json::json!({ "ok": false, "error": err }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo_request() -> SwarmRequest {
        SwarmRequest {
            swarm_id: "swarm_demo".to_string(),
            mode: "deterministic".to_string(),
            agents: vec![
                SwarmAgent {
                    id: "a1".to_string(),
                    skills: vec!["research".to_string(), "coding".to_string()],
                    capacity: 3,
                    reliability_pct: 91.0,
                },
                SwarmAgent {
                    id: "a2".to_string(),
                    skills: vec!["coding".to_string()],
                    capacity: 2,
                    reliability_pct: 84.0,
                },
            ],
            tasks: vec![
                SwarmTask {
                    id: "t1".to_string(),
                    required_skill: "coding".to_string(),
                    weight: 2,
                    priority: 8,
                },
                SwarmTask {
                    id: "t2".to_string(),
                    required_skill: "research".to_string(),
                    weight: 1,
                    priority: 6,
                },
            ],
        }
    }

    #[test]
    fn deterministic_assignment_works() {
        let receipt = orchestrate_swarm(&demo_request()).expect("swarm");
        assert_eq!(receipt.assignments.len(), 2);
        assert!(receipt.consensus_pct > 0.0);
    }

    #[test]
    fn json_path_works() {
        let json = serde_json::to_string(&demo_request()).expect("json");
        let out = orchestrate_swarm_json(&json).expect("run");
        assert!(out.contains("swarm_demo"));
    }
}
