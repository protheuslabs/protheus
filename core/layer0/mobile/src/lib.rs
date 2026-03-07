// SPDX-License-Identifier: Apache-2.0
mod blob;

use execution_core::run_workflow;
use protheus_graph_core_v1::run_workflow as run_graph_workflow;
use protheus_observability_core_v1::{run_chaos_resilience, ChaosScenarioRequest, TraceEvent};
use protheus_pinnacle_core_v1::merge_delta;
use protheus_red_legion_core_v1::{run_chaos_game, ChaosGameRequest};
use protheus_swarm_core_v1::{orchestrate_swarm, SwarmAgent, SwarmRequest, SwarmTask};
use protheus_vault_core_v1::{
    evaluate_vault_policy, load_embedded_vault_policy, VaultOperationRequest,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

pub use blob::{
    fold_blob, load_embedded_mobile_profile, MobileRuntimeProfile, MOBILE_PROFILE_BLOB_ID,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MobileCycleRequest {
    pub cycle_id: String,
    pub cycles: u32,
    pub run_swarm: bool,
    pub run_red_legion: bool,
    pub run_observability: bool,
    pub run_graph: bool,
    pub run_execution: bool,
    pub run_vault: bool,
    pub run_pinnacle: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MobileCycleReport {
    pub cycle_id: String,
    pub battery_pct_24h: f64,
    pub battery_budget_pct_24h: f64,
    pub within_budget: bool,
    pub fail_closed: bool,
    pub subsystem_status: Vec<String>,
    pub sovereignty_index_pct: f64,
    pub digest: String,
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn default_request() -> MobileCycleRequest {
    MobileCycleRequest {
        cycle_id: "mobile_demo_cycle".to_string(),
        cycles: 180000,
        run_swarm: true,
        run_red_legion: true,
        run_observability: true,
        run_graph: true,
        run_execution: true,
        run_vault: true,
        run_pinnacle: true,
    }
}

fn digest_report(report: &MobileCycleReport) -> String {
    let mut hasher = Sha256::new();
    hasher.update(report.cycle_id.as_bytes());
    hasher.update(format!("{:.3}", report.battery_pct_24h).as_bytes());
    hasher.update(format!("{:.3}", report.sovereignty_index_pct).as_bytes());
    for status in &report.subsystem_status {
        hasher.update(status.as_bytes());
    }
    hex::encode(hasher.finalize())
}

pub fn run_mobile_cycle(request: Option<MobileCycleRequest>) -> Result<MobileCycleReport, String> {
    let profile = load_embedded_mobile_profile().map_err(|e| e.to_string())?;
    let request = request.unwrap_or_else(default_request);

    let capped_cycles = request.cycles.min(profile.max_cycles);
    let mut subsystem_status = Vec::<String>::new();
    let mut sovereignty_components = Vec::<f64>::new();

    if request.run_execution {
        let wf = serde_json::json!({
            "workflow_id": "mobile_execution",
            "deterministic_seed": "mobile_seed",
            "steps": [
                {"id": "collect", "kind": "task", "action": "collect", "command": "collect"},
                {"id": "score", "kind": "task", "action": "score", "command": "score"},
                {"id": "ship", "kind": "task", "action": "ship", "command": "ship"}
            ]
        })
        .to_string();
        let receipt = run_workflow(&wf);
        subsystem_status.push(format!("execution:{}", receipt.status));
        sovereignty_components.push(if receipt.status == "completed" {
            92.0
        } else {
            55.0
        });
    }

    if request.run_pinnacle {
        let left = serde_json::json!({
            "node_id": "a",
            "changes": {
                "topic/revenue": {
                    "payload": 42,
                    "vector_clock": {"a": 2},
                    "signed": true
                }
            }
        })
        .to_string();
        let right = serde_json::json!({
            "node_id": "b",
            "changes": {
                "topic/revenue": {
                    "payload": 44,
                    "vector_clock": {"b": 2},
                    "signed": true
                }
            }
        })
        .to_string();
        let merged = merge_delta(&left, &right)?;
        subsystem_status.push(format!("pinnacle:conflicts={}", merged.conflicts.len()));
        sovereignty_components.push(merged.sovereignty_index_pct);
    }

    if request.run_vault {
        let policy = load_embedded_vault_policy().map_err(|e| e.to_string())?;
        let decision = evaluate_vault_policy(
            &policy,
            &VaultOperationRequest {
                operation_id: "mobile_vault_cycle".to_string(),
                key_id: "mobile_key".to_string(),
                action: "seal".to_string(),
                zk_proof: Some("zkp:mobile".to_string()),
                ciphertext_digest: Some("sha256:mobile-cipher".to_string()),
                fhe_noise_budget: 18,
                key_age_hours: 6,
                tamper_signal: false,
                operator_quorum: 2,
                audit_receipt_nonce: Some("mobile_nonce".to_string()),
            },
        );
        subsystem_status.push(format!("vault:{}", decision.status));
        sovereignty_components.push(if decision.allowed { 95.0 } else { 50.0 });
    }

    if request.run_graph {
        let graph_yaml = serde_json::json!({
            "workflow_id": "mobile_graph",
            "nodes": [
                {"id": "collect", "kind": "task"},
                {"id": "score", "kind": "task"},
                {"id": "ship", "kind": "task"}
            ],
            "edges": [
                {"from": "collect", "to": "score"},
                {"from": "score", "to": "ship"}
            ]
        })
        .to_string();
        let receipt = run_graph_workflow(&graph_yaml)?;
        subsystem_status.push(format!("graph:steps={}", receipt.step_count));
        sovereignty_components.push(if receipt.cyclic { 45.0 } else { 90.0 });
    }

    if request.run_swarm && profile.enable_background_swarm {
        let swarm = orchestrate_swarm(&SwarmRequest {
            swarm_id: "mobile_swarm".to_string(),
            mode: "deterministic".to_string(),
            agents: vec![
                SwarmAgent {
                    id: "a1".to_string(),
                    skills: vec!["coding".to_string(), "research".to_string()],
                    capacity: 3,
                    reliability_pct: 91.0,
                },
                SwarmAgent {
                    id: "a2".to_string(),
                    skills: vec!["coding".to_string()],
                    capacity: 2,
                    reliability_pct: 86.0,
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
        })
        .map_err(|e| e.to_string())?;
        subsystem_status.push(format!("swarm:assigned={}", swarm.assignments.len()));
        sovereignty_components.push(swarm.sovereignty_index_pct);
    }

    if request.run_observability {
        let report = run_chaos_resilience(&ChaosScenarioRequest {
            scenario_id: "mobile_observability".to_string(),
            events: vec![
                TraceEvent {
                    trace_id: "m1".to_string(),
                    ts_millis: 100,
                    source: "mobile".to_string(),
                    operation: "trace.capture".to_string(),
                    severity: "low".to_string(),
                    tags: vec!["runtime.guardrails".to_string()],
                    payload_digest: "sha256:m1".to_string(),
                    signed: true,
                },
                TraceEvent {
                    trace_id: "m2".to_string(),
                    ts_millis: 220,
                    source: "mobile".to_string(),
                    operation: "trace.score".to_string(),
                    severity: "medium".to_string(),
                    tags: vec!["drift".to_string()],
                    payload_digest: "sha256:m2".to_string(),
                    signed: true,
                },
            ],
            cycles: capped_cycles,
            inject_fault_every: 650,
            enforce_fail_closed: profile.enforce_fail_closed,
        })
        .map_err(|e| e.to_string())?;
        subsystem_status.push(format!("observability:{}", report.sovereignty.status));
        sovereignty_components.push(report.sovereignty.score_pct);
    }

    if request.run_red_legion {
        let red = run_chaos_game(&ChaosGameRequest {
            mission_id: "mobile_red_legion".to_string(),
            cycles: capped_cycles,
            inject_fault_every: 700,
            enforce_fail_closed: profile.enforce_fail_closed,
            event_seed: 500,
        })
        .map_err(|e| e.to_string())?;
        subsystem_status.push(format!("red_legion:resilient={}", red.resilient));
        sovereignty_components.push(red.sovereignty_index_pct);
    }

    let sovereignty_index_pct = if sovereignty_components.is_empty() {
        0.0
    } else {
        round3(sovereignty_components.iter().sum::<f64>() / sovereignty_components.len() as f64)
    };

    let battery_pct_24h = round3(
        0.55 + ((capped_cycles as f64 / 220000.0) * 1.65) + (subsystem_status.len() as f64 * 0.19),
    );
    let within_budget = battery_pct_24h <= profile.battery_budget_pct_24h;

    let fail_closed =
        profile.enforce_fail_closed && (!within_budget || sovereignty_index_pct < 55.0);

    let mut report = MobileCycleReport {
        cycle_id: request.cycle_id,
        battery_pct_24h,
        battery_budget_pct_24h: profile.battery_budget_pct_24h,
        within_budget,
        fail_closed,
        subsystem_status,
        sovereignty_index_pct,
        digest: String::new(),
    };
    report.digest = digest_report(&report);

    Ok(report)
}

pub fn run_mobile_cycle_json(request_json: &str) -> Result<String, String> {
    let request: MobileCycleRequest =
        serde_json::from_str(request_json).map_err(|e| format!("request_parse_failed:{e}"))?;
    let report = run_mobile_cycle(Some(request))?;
    serde_json::to_string(&report).map_err(|e| format!("report_encode_failed:{e}"))
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn run_mobile_cycle_wasm(request_json: &str) -> String {
    match run_mobile_cycle_json(request_json) {
        Ok(v) => v,
        Err(err) => serde_json::json!({ "ok": false, "error": err }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_cycle_runs_under_budget() {
        let report = run_mobile_cycle(None).expect("mobile");
        assert!(report.battery_pct_24h < 5.0);
        assert!(!report.digest.is_empty());
    }

    #[test]
    fn json_path_valid() {
        let payload = serde_json::json!({
            "cycle_id": "json_cycle",
            "cycles": 120000,
            "run_swarm": true,
            "run_red_legion": true,
            "run_observability": true,
            "run_graph": true,
            "run_execution": true,
            "run_vault": true,
            "run_pinnacle": true
        })
        .to_string();
        let out = run_mobile_cycle_json(&payload).expect("json");
        assert!(out.contains("json_cycle"));
    }
}
