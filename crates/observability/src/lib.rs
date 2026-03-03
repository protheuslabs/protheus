mod blob;

use protheus_memory_core_v6::{
    load_embedded_observability_profile as load_embedded_profile_from_memory,
    EmbeddedChaosHook,
    EmbeddedObservabilityProfile,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::{CStr, CString};
use std::fmt::{Display, Formatter};
use std::os::raw::c_char;

pub use blob::{
    load_embedded_observability_runtime_envelope, BlobError, ObservabilityRuntimeEnvelope,
    OBS_RUNTIME_BLOB_ID,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct TraceEvent {
    pub trace_id: String,
    pub ts_millis: u64,
    pub source: String,
    pub operation: String,
    pub severity: String,
    pub tags: Vec<String>,
    pub payload_digest: String,
    pub signed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ChaosScenarioRequest {
    pub scenario_id: String,
    pub events: Vec<TraceEvent>,
    pub cycles: u32,
    pub inject_fault_every: u32,
    pub enforce_fail_closed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TraceWindowReport {
    pub accepted_events: usize,
    pub dropped_events: usize,
    pub high_severity_events: usize,
    pub red_legion_channels_triggered: Vec<String>,
    pub event_digest: String,
    pub drift_score_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SovereigntyIndex {
    pub score_pct: f64,
    pub fail_closed: bool,
    pub status: String,
    pub reasons: Vec<String>,
    pub integrity_component_pct: f64,
    pub continuity_component_pct: f64,
    pub reliability_component_pct: f64,
    pub chaos_penalty_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ChaosResilienceReport {
    pub profile_id: String,
    pub scenario_id: String,
    pub hooks_fired: Vec<String>,
    pub trace_report: TraceWindowReport,
    pub sovereignty: SovereigntyIndex,
    pub telemetry_overhead_ms: f64,
    pub chaos_battery_pct_24h: f64,
    pub resilient: bool,
}

#[derive(Debug, Clone)]
pub enum ObservabilityError {
    ProfileLoadFailed(String),
    InvalidRequest(String),
    EncodeFailed(String),
}

impl Display for ObservabilityError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            ObservabilityError::ProfileLoadFailed(msg) => write!(f, "profile_load_failed:{msg}"),
            ObservabilityError::InvalidRequest(msg) => write!(f, "invalid_request:{msg}"),
            ObservabilityError::EncodeFailed(msg) => write!(f, "encode_failed:{msg}"),
        }
    }
}

impl std::error::Error for ObservabilityError {}

fn normalize_text(input: &str, max: usize) -> String {
    input
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

fn severity_weight(severity: &str) -> f64 {
    match severity.to_ascii_lowercase().as_str() {
        "critical" => 1.0,
        "high" => 0.7,
        "medium" => 0.35,
        "low" => 0.15,
        _ => 0.2,
    }
}

fn event_fingerprint(event: &TraceEvent) -> String {
    let mut parts: Vec<String> = vec![
        normalize_text(&event.trace_id, 160),
        event.ts_millis.to_string(),
        normalize_text(&event.source, 160),
        normalize_text(&event.operation, 160),
        normalize_text(&event.severity, 32),
        normalize_text(&event.payload_digest, 256),
        event.signed.to_string(),
    ];
    let mut tags = event.tags.clone();
    tags.sort();
    for tag in tags {
        parts.push(normalize_text(&tag, 80));
    }
    parts.join("|")
}

fn digest_lines(lines: &[String]) -> String {
    let mut hasher = Sha256::new();
    for (idx, line) in lines.iter().enumerate() {
        hasher.update(format!("{}:{}|", idx, line).as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn channel_triggered(channel: &str, events: &[TraceEvent]) -> bool {
    events.iter().any(|event| {
        event.tags.iter().any(|tag| {
            let t = tag.to_ascii_lowercase();
            let c = channel.to_ascii_lowercase();
            t == c || t.starts_with(&c)
        })
    })
}

fn hook_triggered(hook: &EmbeddedChaosHook, trace: &TraceWindowReport, events: &[TraceEvent]) -> bool {
    if !hook.enabled {
        return false;
    }
    let cond = hook.condition.to_ascii_lowercase();

    if cond.contains("tamper") {
        return events.iter().any(|event| {
            let sev = event.severity.to_ascii_lowercase();
            sev == "critical"
                && event
                    .tags
                    .iter()
                    .any(|tag| tag.to_ascii_lowercase().contains("tamper"))
        });
    }
    if cond.contains("window.events") {
        return trace.dropped_events > 0;
    }
    if cond.contains("replay.drift") {
        return trace.drift_score_pct > 0.0;
    }
    false
}

fn continuity_component(events: &[TraceEvent], window_ms: u32) -> f64 {
    if events.len() <= 1 {
        return 100.0;
    }

    let mut monotonic_ok: usize = 0;
    let mut total_pairs: usize = 0;
    let mut gap_penalties: usize = 0;

    for pair in events.windows(2) {
        let left = &pair[0];
        let right = &pair[1];
        total_pairs += 1;
        if right.ts_millis >= left.ts_millis {
            monotonic_ok += 1;
        }
        if right.ts_millis.saturating_sub(left.ts_millis) > (window_ms as u64 * 2) {
            gap_penalties += 1;
        }
    }

    if total_pairs == 0 {
        return 100.0;
    }

    let monotonic_ratio = monotonic_ok as f64 / total_pairs as f64;
    let gap_penalty = gap_penalties as f64 / total_pairs as f64;
    let score = (monotonic_ratio * 100.0) - (gap_penalty * 35.0);
    score.clamp(0.0, 100.0)
}

fn reliability_component(events: &[TraceEvent], accepted_events: usize) -> f64 {
    if events.is_empty() {
        return 100.0;
    }
    let accepted_ratio = accepted_events as f64 / events.len() as f64;
    let severe_ratio = events
        .iter()
        .filter(|event| {
            let sev = event.severity.to_ascii_lowercase();
            sev == "critical" || sev == "high"
        })
        .count() as f64
        / events.len() as f64;

    let score = (accepted_ratio * 100.0) - (severe_ratio * 25.0);
    score.clamp(0.0, 100.0)
}

pub fn load_embedded_observability_profile() -> Result<EmbeddedObservabilityProfile, ObservabilityError> {
    load_embedded_profile_from_memory().map_err(|err| ObservabilityError::ProfileLoadFailed(err.to_string()))
}

pub fn evaluate_trace_window(
    profile: &EmbeddedObservabilityProfile,
    events: &[TraceEvent],
) -> TraceWindowReport {
    let max_events = profile.stream_policy.max_events_per_window as usize;
    let accepted: Vec<TraceEvent> = events.iter().take(max_events).cloned().collect();
    let dropped_events = events.len().saturating_sub(accepted.len());

    let high_severity_events = accepted
        .iter()
        .filter(|event| {
            let sev = event.severity.to_ascii_lowercase();
            sev == "critical" || sev == "high"
        })
        .count();

    let red_legion_channels_triggered = profile
        .red_legion_trace_channels
        .iter()
        .filter(|channel| channel_triggered(channel, &accepted))
        .cloned()
        .collect::<Vec<_>>();

    let event_digest = digest_lines(
        &accepted
            .iter()
            .map(event_fingerprint)
            .collect::<Vec<String>>(),
    );

    let drift_weight_sum = accepted
        .iter()
        .filter(|event| {
            event
                .tags
                .iter()
                .any(|tag| tag.to_ascii_lowercase().contains("drift"))
        })
        .map(|event| severity_weight(&event.severity))
        .sum::<f64>();

    let drift_score_pct = if accepted.is_empty() {
        0.0
    } else {
        ((drift_weight_sum / accepted.len() as f64) * 100.0).clamp(0.0, 100.0)
    };

    TraceWindowReport {
        accepted_events: accepted.len(),
        dropped_events,
        high_severity_events,
        red_legion_channels_triggered,
        event_digest,
        drift_score_pct: round3(drift_score_pct),
    }
}

pub fn compute_sovereignty_index(
    profile: &EmbeddedObservabilityProfile,
    events: &[TraceEvent],
    trace_report: &TraceWindowReport,
    inject_fault_every: u32,
    enforce_fail_closed: bool,
) -> SovereigntyIndex {
    let accepted_events: Vec<TraceEvent> = events
        .iter()
        .take(profile.stream_policy.max_events_per_window as usize)
        .cloned()
        .collect();

    let integrity_component_pct = if accepted_events.is_empty() {
        100.0
    } else {
        let signed = accepted_events.iter().filter(|event| event.signed).count();
        (signed as f64 / accepted_events.len() as f64) * 100.0
    };

    let continuity_component_pct = continuity_component(&accepted_events, profile.stream_policy.trace_window_ms);
    let reliability_component_pct = reliability_component(events, trace_report.accepted_events);

    let fault_penalty = if inject_fault_every == 0 {
        0.0
    } else {
        (100.0 / inject_fault_every as f64).clamp(0.0, 40.0)
    };
    let drift_penalty = (trace_report.drift_score_pct * 0.25).clamp(0.0, 25.0);
    let chaos_penalty_pct = (fault_penalty + drift_penalty).clamp(0.0, 100.0);

    let weights = &profile.sovereignty_scorer;
    let weighted_score = ((integrity_component_pct * weights.integrity_weight_pct as f64)
        + (continuity_component_pct * weights.continuity_weight_pct as f64)
        + (reliability_component_pct * weights.reliability_weight_pct as f64))
        / 100.0
        - ((chaos_penalty_pct * weights.chaos_penalty_pct as f64) / 100.0);

    let mut score_pct = weighted_score.clamp(0.0, 100.0);
    score_pct = round3(score_pct);

    let mut reasons: Vec<String> = Vec::new();
    if integrity_component_pct < 70.0 {
        reasons.push("integrity_component_below_70".to_string());
    }
    if continuity_component_pct < 70.0 {
        reasons.push("continuity_component_below_70".to_string());
    }
    if reliability_component_pct < 70.0 {
        reasons.push("reliability_component_below_70".to_string());
    }
    if chaos_penalty_pct > 15.0 {
        reasons.push("chaos_penalty_above_15".to_string());
    }

    let tamper_critical = accepted_events.iter().any(|event| {
        event.severity.eq_ignore_ascii_case("critical")
            && event
                .tags
                .iter()
                .any(|tag| tag.to_ascii_lowercase().contains("tamper"))
    });

    if tamper_critical {
        reasons.push("critical_tamper_detected".to_string());
    }

    let threshold = profile.sovereignty_scorer.fail_closed_threshold_pct as f64;
    let fail_closed = (score_pct < threshold && enforce_fail_closed) || (tamper_critical && enforce_fail_closed);
    let status = if fail_closed {
        "fail_closed".to_string()
    } else if score_pct < threshold {
        "degraded".to_string()
    } else {
        "stable".to_string()
    };

    SovereigntyIndex {
        score_pct,
        fail_closed,
        status,
        reasons,
        integrity_component_pct: round3(integrity_component_pct),
        continuity_component_pct: round3(continuity_component_pct),
        reliability_component_pct: round3(reliability_component_pct),
        chaos_penalty_pct: round3(chaos_penalty_pct),
    }
}

pub fn run_chaos_resilience(
    request: &ChaosScenarioRequest,
) -> Result<ChaosResilienceReport, ObservabilityError> {
    let profile = load_embedded_observability_profile()?;
    let runtime_envelope = load_embedded_observability_runtime_envelope().ok();

    let trace_report = evaluate_trace_window(&profile, &request.events);
    let sovereignty = compute_sovereignty_index(
        &profile,
        &request.events,
        &trace_report,
        request.inject_fault_every,
        request.enforce_fail_closed,
    );

    let accepted_events: Vec<TraceEvent> = request
        .events
        .iter()
        .take(profile.stream_policy.max_events_per_window as usize)
        .cloned()
        .collect();

    let hooks_fired = profile
        .chaos_hooks
        .iter()
        .filter(|hook| hook_triggered(hook, &trace_report, &accepted_events))
        .map(|hook| hook.id.clone())
        .collect::<Vec<_>>();

    let telemetry_overhead_ms = round3(
        (trace_report.accepted_events as f64 * 0.00045)
            + (trace_report.red_legion_channels_triggered.len() as f64 * 0.08)
            + 0.12,
    );

    let inject_factor = if request.inject_fault_every == 0 {
        0.0
    } else {
        (250.0 / request.inject_fault_every as f64).clamp(0.05, 2.5)
    };

    let chaos_battery_pct_24h = round3(
        (request.cycles as f64 / 200000.0) * 1.2
            + (trace_report.high_severity_events as f64 * 0.01)
            + inject_factor
            + 0.25,
    );

    let telemetry_cap = runtime_envelope
        .as_ref()
        .map(|v| v.max_telemetry_overhead_ms)
        .unwrap_or(1.0);
    let battery_cap = runtime_envelope
        .as_ref()
        .map(|v| v.max_battery_pct_24h)
        .unwrap_or(3.0);
    let drift_cap = runtime_envelope
        .as_ref()
        .map(|v| v.max_drift_pct)
        .unwrap_or(2.0);

    let drift_exceeded = trace_report.drift_score_pct > drift_cap;
    let envelope_fail_closed = runtime_envelope
        .as_ref()
        .map(|v| {
            v.enforce_fail_closed
                && (drift_exceeded
                    || telemetry_overhead_ms > telemetry_cap
                    || chaos_battery_pct_24h > battery_cap)
        })
        .unwrap_or(false);

    let resilient = !sovereignty.fail_closed
        && !envelope_fail_closed
        && !drift_exceeded
        && telemetry_overhead_ms <= telemetry_cap
        && chaos_battery_pct_24h <= battery_cap;

    Ok(ChaosResilienceReport {
        profile_id: profile.profile_id,
        scenario_id: normalize_text(&request.scenario_id, 160),
        hooks_fired,
        trace_report,
        sovereignty,
        telemetry_overhead_ms,
        chaos_battery_pct_24h,
        resilient,
    })
}

pub fn run_chaos_resilience_json(request_json: &str) -> Result<String, ObservabilityError> {
    let request: ChaosScenarioRequest = serde_json::from_str(request_json)
        .map_err(|err| ObservabilityError::InvalidRequest(format!("request_parse_failed:{err}")))?;
    let report = run_chaos_resilience(&request)?;
    serde_json::to_string(&report).map_err(|err| ObservabilityError::EncodeFailed(err.to_string()))
}

pub fn load_embedded_observability_profile_json() -> Result<String, ObservabilityError> {
    let profile = load_embedded_observability_profile()?;
    serde_json::to_string(&profile).map_err(|err| ObservabilityError::EncodeFailed(err.to_string()))
}

fn c_str_to_string(ptr: *const c_char) -> Result<String, ObservabilityError> {
    if ptr.is_null() {
        return Err(ObservabilityError::InvalidRequest("null_pointer".to_string()));
    }
    // SAFETY: caller owns pointer and guarantees NUL-terminated string.
    let s = unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .map_err(|_| ObservabilityError::InvalidRequest("invalid_utf8".to_string()))?;
    Ok(s.to_string())
}

fn into_c_string_ptr(payload: String) -> *mut c_char {
    let sanitized = payload.replace('\0', "");
    match CString::new(sanitized) {
        Ok(c) => c.into_raw(),
        Err(_) => CString::new("{\"ok\":false,\"error\":\"cstring_encode_failed\"}")
            .unwrap_or_else(|_| CString::new("{}").expect("literal CString should be valid"))
            .into_raw(),
    }
}

#[allow(clippy::not_unsafe_ptr_arg_deref)]
#[no_mangle]
pub extern "C" fn run_chaos_resilience_ffi(request_json: *const c_char) -> *mut c_char {
    let payload = match c_str_to_string(request_json).and_then(|req| run_chaos_resilience_json(&req)) {
        Ok(v) => v,
        Err(err) => serde_json::json!({ "ok": false, "error": err.to_string() }).to_string(),
    };
    into_c_string_ptr(payload)
}

#[no_mangle]
pub extern "C" fn load_embedded_observability_profile_ffi() -> *mut c_char {
    let payload = match load_embedded_observability_profile_json() {
        Ok(v) => v,
        Err(err) => serde_json::json!({ "ok": false, "error": err.to_string() }).to_string(),
    };
    into_c_string_ptr(payload)
}

#[no_mangle]
pub extern "C" fn observability_free(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: pointer originated from CString::into_raw in this crate.
    unsafe {
        let _ = CString::from_raw(ptr);
    }
}

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn run_chaos_resilience_wasm(request_json: &str) -> String {
    match run_chaos_resilience_json(request_json) {
        Ok(v) => v,
        Err(err) => serde_json::json!({ "ok": false, "error": err.to_string() }).to_string(),
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn load_embedded_observability_profile_wasm() -> String {
    match load_embedded_observability_profile_json() {
        Ok(v) => v,
        Err(err) => serde_json::json!({ "ok": false, "error": err.to_string() }).to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_event(id: &str, ts: u64, severity: &str, tag: &str) -> TraceEvent {
        TraceEvent {
            trace_id: id.to_string(),
            ts_millis: ts,
            source: "systems/observability".to_string(),
            operation: "trace.capture".to_string(),
            severity: severity.to_string(),
            tags: vec![tag.to_string()],
            payload_digest: format!("sha256:{}", id),
            signed: true,
        }
    }

    #[test]
    fn profile_loads() {
        let profile = load_embedded_observability_profile().expect("profile should load");
        assert_eq!(profile.profile_id, "observability_profile_primary");
        assert!(!profile.chaos_hooks.is_empty());
    }

    #[test]
    fn chaos_report_stable_for_low_risk_events() {
        let req = ChaosScenarioRequest {
            scenario_id: "stable_case".to_string(),
            events: vec![
                sample_event("e1", 1000, "low", "runtime.guardrails"),
                sample_event("e2", 1100, "medium", "lane.integrity"),
                sample_event("e3", 1200, "low", "chaos.replay"),
            ],
            cycles: 180000,
            inject_fault_every: 400,
            enforce_fail_closed: true,
        };
        let report = run_chaos_resilience(&req).expect("report should build");
        assert_eq!(report.sovereignty.fail_closed, false);
        assert!(report.resilient);
    }

    #[test]
    fn chaos_report_fail_closed_on_critical_tamper() {
        let mut tamper = sample_event("tamper", 1000, "critical", "tamper");
        tamper.signed = false;
        let req = ChaosScenarioRequest {
            scenario_id: "tamper_case".to_string(),
            events: vec![tamper],
            cycles: 250000,
            inject_fault_every: 2,
            enforce_fail_closed: true,
        };
        let report = run_chaos_resilience(&req).expect("report should build");
        assert!(report.sovereignty.fail_closed);
        assert!(!report.resilient);
    }
}
