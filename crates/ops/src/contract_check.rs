use crate::legacy_bridge::{resolve_script_path, run_legacy_script_compat};
use foundation_hook_enforcer::{
    evaluate_source_hook_coverage, HookCoverageReceipt, CHECK_ID_FOUNDATION_HOOKS,
    CHECK_ID_GUARD_REGISTRY_CONSUMPTION,
};
use std::path::Path;

const LEGACY_SCRIPT_ENV: &str = "PROTHEUS_CONTRACT_CHECK_LEGACY_SCRIPT";
const LEGACY_SCRIPT_DEFAULT: &str = "systems/spine/contract_check_legacy.js";
pub const GUARD_REGISTRY_REQUIRED_TOKENS: &[&str] =
    &["guard_check_registry", "required_merge_guard_ids"];
pub const FOUNDATION_HOOK_REQUIRED_TOKENS: &[&str] = &[
    "foundation_contract_gate.js",
    "scale_envelope_baseline.js",
    "simplicity_budget_gate.js",
    "phone_seed_profile.js",
    "surface_budget_controller.js",
    "compression_transfer_plane.js",
    "opportunistic_offload_plane.js",
    "gated_account_creation_organ.js",
    "siem_bridge.js",
    "soc2_type2_track.js",
    "predictive_capacity_forecast.js",
    "execution_sandbox_envelope.js",
    "organ_state_encryption_plane.js",
    "remote_tamper_heartbeat.js",
    "secure_heartbeat_endpoint.js",
    "gated_self_improvement_loop.js",
    "helix_admission_gate.js",
    "venom_containment_layer.js",
    "adaptive_defense_expansion.js",
    "confirmed_malice_quarantine.js",
    "helix_controller.js",
    "ant_colony_controller.js",
    "neural_dormant_seed.js",
    "pre_neuralink_interface.js",
    "client_relationship_manager.js",
    "capital_allocation_organ.js",
    "economic_entity_manager.js",
    "drift_aware_revenue_optimizer.js",
];

pub fn run(root: &Path, args: &[String]) -> i32 {
    let script = resolve_script_path(root, LEGACY_SCRIPT_ENV, LEGACY_SCRIPT_DEFAULT);
    run_legacy_script_compat(root, "contract_check", &script, args, false)
}

pub fn guard_registry_contract_receipt(source: &str) -> HookCoverageReceipt {
    evaluate_source_hook_coverage(
        CHECK_ID_GUARD_REGISTRY_CONSUMPTION,
        GUARD_REGISTRY_REQUIRED_TOKENS,
        source,
    )
}

pub fn foundation_hook_coverage_receipt(source: &str) -> HookCoverageReceipt {
    evaluate_source_hook_coverage(
        CHECK_ID_FOUNDATION_HOOKS,
        FOUNDATION_HOOK_REQUIRED_TOKENS,
        source,
    )
}

fn compact_json_spacing(token: &str) -> String {
    let mut out = String::with_capacity(token.len());
    let mut chars = token.chars().peekable();
    while let Some(ch) = chars.next() {
        out.push(ch);
        if ch == ':' && out.ends_with("\":") {
            while let Some(next) = chars.peek() {
                if next.is_whitespace() {
                    chars.next();
                } else {
                    break;
                }
            }
        }
    }
    out
}

pub fn missing_tokens(text: &str, tokens: &[String]) -> Vec<String> {
    let mut missing = Vec::new();
    for token in tokens {
        if text.contains(token) {
            continue;
        }
        let compact_json_token = compact_json_spacing(token);
        if compact_json_token != *token && text.contains(&compact_json_token) {
            continue;
        }
        missing.push(token.clone());
    }
    missing
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compact_json_spacing_only_compacts_key_colon_whitespace() {
        let token = r#""schema":   {"id": "x"} value:  keep"#;
        let compacted = compact_json_spacing(token);
        assert_eq!(compacted, r#""schema":{"id":"x"} value:  keep"#);
    }

    #[test]
    fn missing_tokens_accepts_compact_json_variant() {
        let text = r#"{"schema":{"id":"x"}}"#;
        let tokens = vec!["\"schema\": {".to_string()];
        let missing = missing_tokens(text, &tokens);
        assert!(missing.is_empty());
    }

    #[test]
    fn missing_tokens_reports_absent_tokens() {
        let text = "usage run --help";
        let tokens = vec!["status".to_string(), "run".to_string()];
        let missing = missing_tokens(text, &tokens);
        assert_eq!(missing, vec!["status".to_string()]);
    }

    #[test]
    fn missing_tokens_preserves_missing_order() {
        let text = "run --help";
        let tokens = vec![
            "status".to_string(),
            "run".to_string(),
            "contract".to_string(),
        ];
        let missing = missing_tokens(text, &tokens);
        assert_eq!(missing, vec!["status".to_string(), "contract".to_string()]);
    }

    #[test]
    fn guard_registry_contract_receipt_matches_expected_tokens() {
        let source = "guard_check_registry required_merge_guard_ids";
        let receipt = guard_registry_contract_receipt(source);
        assert!(receipt.ok);
        assert!(!receipt.fail_closed);
        assert!(receipt.missing_hooks.is_empty());
    }

    #[test]
    fn foundation_hook_coverage_receipt_detects_missing_tokens() {
        let source = "foundation_contract_gate.js";
        let receipt = foundation_hook_coverage_receipt(source);
        assert!(!receipt.ok);
        assert!(!receipt.fail_closed);
        assert!(!receipt.missing_hooks.is_empty());
        assert!(receipt
            .missing_hooks
            .contains(&"scale_envelope_baseline.js".to_string()));
    }

    #[test]
    fn foundation_hook_coverage_receipt_succeeds_when_all_hooks_are_present() {
        let source = FOUNDATION_HOOK_REQUIRED_TOKENS.join(" ");
        let receipt = foundation_hook_coverage_receipt(&source);
        assert!(receipt.ok);
        assert_eq!(
            receipt.observed_hooks.len(),
            FOUNDATION_HOOK_REQUIRED_TOKENS.len()
        );
    }
}
