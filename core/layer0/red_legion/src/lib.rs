// SPDX-License-Identifier: Apache-2.0
mod blob;

use protheus_observability_core_v1::{
    run_chaos_resilience, ChaosResilienceReport, ChaosScenarioRequest, TraceEvent,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

pub use blob::{
    decode_manifest, fold_blob, generate_manifest, load_embedded_red_legion_doctrine,
    RedLegionDoctrine, RED_LEGION_DOCTRINE_BLOB_ID,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChaosGameRequest {
    pub mission_id: String,
    pub cycles: u32,
    pub inject_fault_every: u32,
    pub enforce_fail_closed: bool,
    #[serde(default)]
    pub event_seed: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FormalInvariant {
    pub id: String,
    pub passed: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChaosGameReceipt {
    pub mission_id: String,
    pub doctrine_id: String,
    pub resilient: bool,
    pub fail_closed: bool,
    pub invariants: Vec<FormalInvariant>,
    pub sovereignty_index_pct: f64,
    pub drift_score_pct: f64,
    pub telemetry_overhead_ms: f64,
    pub battery_pct_24h: f64,
    pub hooks_fired: Vec<String>,
    pub report: ChaosResilienceReport,
    pub receipt_digest: String,
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn synthesize_events(request: &ChaosGameRequest) -> Vec<TraceEvent> {
    let mut events = Vec::new();
    let count = usize::min(12, usize::max(4, (request.cycles / 25000) as usize));
    for i in 0..count {
        let severity = if request.inject_fault_every > 0 && (i as u32 + 1) % 5 == 0 {
            "high"
        } else if i % 3 == 0 {
            "medium"
        } else {
            "low"
        };
        let mut tags = vec!["chaos.replay".to_string(), "runtime.guardrails".to_string()];
        if request.inject_fault_every > 0 && i % 4 == 0 {
            tags.push("drift.signal".to_string());
        }
        events.push(TraceEvent {
            trace_id: format!("{}-evt-{}", request.mission_id, i + 1),
            ts_millis: request.event_seed.saturating_add((i as u64) * 120),
            source: "client/systems/red_legion".to_string(),
            operation: if i % 2 == 0 {
                "chaos.inject".to_string()
            } else {
                "chaos.observe".to_string()
            },
            severity: severity.to_string(),
            tags,
            payload_digest: format!("sha256:{}", i + 1),
            signed: true,
        });
    }
    events
}

fn verify_invariants(
    doctrine: &RedLegionDoctrine,
    report: &ChaosResilienceReport,
) -> (Vec<FormalInvariant>, bool) {
    let mut invariants = Vec::<FormalInvariant>::new();

    let sovereignty_ok = report.sovereignty.score_pct >= doctrine.min_sovereignty_pct;
    invariants.push(FormalInvariant {
        id: "invariant.sovereignty.floor".to_string(),
        passed: sovereignty_ok,
        reason: format!(
            "score={} floor={}",
            round3(report.sovereignty.score_pct),
            doctrine.min_sovereignty_pct
        ),
    });

    let drift_ok = report.trace_report.drift_score_pct <= doctrine.max_drift_pct;
    invariants.push(FormalInvariant {
        id: "invariant.drift.max".to_string(),
        passed: drift_ok,
        reason: format!(
            "drift={} max={}",
            round3(report.trace_report.drift_score_pct),
            doctrine.max_drift_pct
        ),
    });

    let overhead_ok = report.telemetry_overhead_ms <= doctrine.max_telemetry_overhead_ms;
    invariants.push(FormalInvariant {
        id: "invariant.telemetry.overhead".to_string(),
        passed: overhead_ok,
        reason: format!(
            "overhead={} max={}",
            round3(report.telemetry_overhead_ms),
            doctrine.max_telemetry_overhead_ms
        ),
    });

    let battery_ok = report.chaos_battery_pct_24h <= doctrine.max_battery_pct_24h;
    invariants.push(FormalInvariant {
        id: "invariant.battery.floor".to_string(),
        passed: battery_ok,
        reason: format!(
            "battery={} max={}",
            round3(report.chaos_battery_pct_24h),
            doctrine.max_battery_pct_24h
        ),
    });

    let violations = invariants.iter().filter(|inv| !inv.passed).count();
    let fail_closed = doctrine.fail_closed_on_violation && violations > 0;
    (invariants, fail_closed)
}

fn receipt_digest(receipt: &ChaosGameReceipt) -> String {
    let mut hasher = Sha256::new();
    hasher.update(receipt.mission_id.as_bytes());
    hasher.update(receipt.doctrine_id.as_bytes());
    hasher.update(format!("{:.3}", receipt.sovereignty_index_pct).as_bytes());
    hasher.update(format!("{:.3}", receipt.drift_score_pct).as_bytes());
    hasher.update(format!("{:.3}", receipt.telemetry_overhead_ms).as_bytes());
    hasher.update(format!("{:.3}", receipt.battery_pct_24h).as_bytes());
    for hook in &receipt.hooks_fired {
        hasher.update(hook.as_bytes());
    }
    hex::encode(hasher.finalize())
}

pub fn run_chaos_game(request: &ChaosGameRequest) -> Result<ChaosGameReceipt, String> {
    let doctrine = load_embedded_red_legion_doctrine().map_err(|e| e.to_string())?;
    let scenario = ChaosScenarioRequest {
        scenario_id: request.mission_id.clone(),
        events: synthesize_events(request),
        cycles: request.cycles,
        inject_fault_every: request.inject_fault_every,
        enforce_fail_closed: request.enforce_fail_closed,
    };

    let report = run_chaos_resilience(&scenario).map_err(|e| e.to_string())?;
    let (invariants, mut fail_closed) = verify_invariants(&doctrine, &report);
    if report.sovereignty.fail_closed {
        fail_closed = true;
    }

    let mut receipt = ChaosGameReceipt {
        mission_id: request.mission_id.clone(),
        doctrine_id: doctrine.doctrine_id,
        resilient: report.resilient && !fail_closed,
        fail_closed,
        invariants,
        sovereignty_index_pct: round3(report.sovereignty.score_pct),
        drift_score_pct: round3(report.trace_report.drift_score_pct),
        telemetry_overhead_ms: round3(report.telemetry_overhead_ms),
        battery_pct_24h: round3(report.chaos_battery_pct_24h),
        hooks_fired: report.hooks_fired.clone(),
        report,
        receipt_digest: String::new(),
    };
    receipt.receipt_digest = receipt_digest(&receipt);
    Ok(receipt)
}

pub fn run_chaos_game_json(request_json: &str) -> Result<String, String> {
    let request: ChaosGameRequest =
        serde_json::from_str(request_json).map_err(|e| format!("request_parse_failed:{e}"))?;
    let receipt = run_chaos_game(&request)?;
    serde_json::to_string(&receipt).map_err(|e| format!("receipt_encode_failed:{e}"))
}

#[no_mangle]
pub extern "C" fn run_chaos_game_ffi(request_json_ptr: *const c_char) -> *mut c_char {
    let payload = if request_json_ptr.is_null() {
        serde_json::json!({ "ok": false, "error": "request_parse_failed:null_request" }).to_string()
    } else {
        let request_json = unsafe { CStr::from_ptr(request_json_ptr) }
            .to_str()
            .unwrap_or("{}")
            .to_string();
        match run_chaos_game_json(&request_json) {
            Ok(v) => v,
            Err(err) => serde_json::json!({ "ok": false, "error": err }).to_string(),
        }
    };
    CString::new(payload)
        .map(|v| v.into_raw())
        .unwrap_or(std::ptr::null_mut())
}

#[no_mangle]
pub extern "C" fn red_legion_free(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        let _ = CString::from_raw(ptr);
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn run_chaos_game_wasm(request_json: &str) -> String {
    match run_chaos_game_json(request_json) {
        Ok(v) => v,
        Err(err) => serde_json::json!({ "ok": false, "error": err }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn game_returns_receipt() {
        let request = ChaosGameRequest {
            mission_id: "rl-demo".to_string(),
            cycles: 200000,
            inject_fault_every: 500,
            enforce_fail_closed: true,
            event_seed: 1_000,
        };
        let receipt = run_chaos_game(&request).expect("game");
        assert!(!receipt.receipt_digest.is_empty());
        assert!(!receipt.invariants.is_empty());
    }

    #[test]
    fn wasm_json_path_stable() {
        let payload = serde_json::json!({
            "mission_id": "rl-demo",
            "cycles": 160000,
            "inject_fault_every": 700,
            "enforce_fail_closed": true,
            "event_seed": 100
        })
        .to_string();
        let result = run_chaos_game_json(&payload).expect("json");
        assert!(result.contains("mission_id"));
    }

    #[test]
    fn ffi_roundtrip_works() {
        let payload = serde_json::json!({
            "mission_id": "ffi-demo",
            "cycles": 120000,
            "inject_fault_every": 800,
            "enforce_fail_closed": true,
            "event_seed": 42
        })
        .to_string();
        let req = CString::new(payload).unwrap();
        let out_ptr = run_chaos_game_ffi(req.as_ptr());
        assert!(!out_ptr.is_null());
        let out_text = unsafe { CStr::from_ptr(out_ptr) }
            .to_str()
            .unwrap()
            .to_string();
        red_legion_free(out_ptr);
        let parsed: serde_json::Value = serde_json::from_str(&out_text).unwrap();
        assert_eq!(parsed["mission_id"], "ffi-demo");
    }
}
