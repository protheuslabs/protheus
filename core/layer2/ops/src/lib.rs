// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer2/ops (authoritative daemon control contracts).

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

pub mod ops_lane_runtime;
pub mod autoresearch_loop;
pub mod autophagy_auto_approval;
pub mod biological_computing_adapter;
pub mod bookmark_knowledge_pipeline;
pub mod company_layer_orchestration;
pub mod context_doctor;
pub mod decentralized_data_marketplace;
pub mod discord_swarm_orchestration;
pub mod gui_drift_manager;
pub mod intel_sweep_router;
pub mod observability_automation_engine;
pub mod opendev_dual_agent;
pub mod p2p_gossip_seed;
pub mod persistent_background_runtime;
pub mod public_api_catalog;
pub mod startup_agency_builder;
pub mod timeseries_receipt_engine;
pub mod webgpu_inference_adapter;
pub mod wifi_csi_engine;
pub mod workspace_gateway_runtime;

pub fn deterministic_receipt_hash(payload: &Value) -> String {
    let mut hasher = Sha256::new();
    hasher.update(serde_json::to_vec(payload).unwrap_or_default());
    hex::encode(hasher.finalize())
}

pub fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn daemon_control_receipt(command: &str, mode: Option<&str>) -> Value {
    let mut out = json!({
        "ok": true,
        "type": "daemon_control_receipt",
        "authority": "core/layer2/ops",
        "command": command,
        "mode": mode
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn daemon_receipt_has_hash() {
        let payload = daemon_control_receipt("status", Some("persistent"));
        assert!(payload.get("receipt_hash").and_then(Value::as_str).is_some());
    }
}
