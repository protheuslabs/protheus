use serde_json::json;

pub fn build_envelope(within_target: bool, completed_lanes: usize) -> serde_json::Value {
    let status = if completed_lanes >= 9 {
        "ready_for_guardrail_gate"
    } else {
        "incomplete"
    };
    let action = if within_target {
        "freeze_share_and_optimize_hotpaths"
    } else {
        "continue_incremental_rust_cutovers"
    };

    json!({
        "ok": true,
        "lane": "V5-RUST-HYB-010",
        "completed_lanes": completed_lanes,
        "within_target": within_target,
        "status": status,
        "action": action,
        "guardrails": [
            "keep_ts_for_operator_surfaces",
            "restrict_rust_to_hotpaths_and_safety_critical_lanes",
            "require_canary_and_rollback_receipts"
        ]
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_includes_guardrails() {
        let v = build_envelope(false, 9);
        assert_eq!(v.get("ok").and_then(|x| x.as_bool()), Some(true));
        assert!(v
            .get("guardrails")
            .and_then(|x| x.as_array())
            .map(|a| !a.is_empty())
            .unwrap_or(false));
    }
}
