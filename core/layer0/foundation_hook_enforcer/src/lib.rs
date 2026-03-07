// SPDX-License-Identifier: Apache-2.0
use std::collections::BTreeSet;

pub const RECEIPT_SCHEMA_ID: &str = "foundation_hook_enforcer/v1";
pub const CHECK_ID_FOUNDATION_HOOKS: &str = "contract_check:foundation_hooks";
pub const CHECK_ID_GUARD_REGISTRY_CONSUMPTION: &str =
    "guard_check_registry:contract_check_consumes_manifest";
pub const CHECK_ID_MERGE_GUARD_HOOK_COVERAGE: &str = "foundation_contract_gate:hook_coverage";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HookCoverageReceipt {
    pub schema_id: &'static str,
    pub check_id: String,
    pub ok: bool,
    pub fail_closed: bool,
    pub claim: String,
    pub evidence: Vec<String>,
    pub required_hooks: Vec<String>,
    pub observed_hooks: Vec<String>,
    pub missing_hooks: Vec<String>,
    pub receipt_key: String,
}

fn normalize_hook(raw: &str) -> Option<String> {
    let normalized = raw.trim().to_ascii_lowercase();
    if normalized.is_empty() {
        return None;
    }
    Some(normalized)
}

fn sorted_unique<I, S>(values: I) -> Vec<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut set = BTreeSet::new();
    for value in values {
        if let Some(normalized) = normalize_hook(value.as_ref()) {
            set.insert(normalized);
        }
    }
    set.into_iter().collect()
}

fn build_receipt_key(
    check_id: &str,
    ok: bool,
    fail_closed: bool,
    required_hooks: &[String],
    observed_hooks: &[String],
    missing_hooks: &[String],
) -> String {
    let normalized_check_id =
        normalize_hook(check_id).unwrap_or_else(|| "unknown_check".to_string());
    format!(
        "{normalized_check_id}|ok={}|fail_closed={}|required={}|observed={}|missing={}",
        i32::from(ok),
        i32::from(fail_closed),
        required_hooks.join(","),
        observed_hooks.join(","),
        missing_hooks.join(",")
    )
}

fn source_claim(fail_closed: bool, missing_hooks: &[String]) -> &'static str {
    if fail_closed {
        return "unable_to_prove_source_hook_coverage";
    }
    if missing_hooks.is_empty() {
        return "all_required_hooks_observed_in_source";
    }
    "required_hooks_missing_from_source"
}

fn completeness_claim(fail_closed: bool, missing_hooks: &[String]) -> &'static str {
    if fail_closed {
        return "unable_to_prove_required_hook_completeness";
    }
    if missing_hooks.is_empty() {
        return "required_hook_list_is_complete";
    }
    "required_hook_list_missing_mandatory_hooks"
}

pub fn evaluate_source_hook_coverage(
    check_id: &str,
    required_hooks: &[&str],
    source: &str,
) -> HookCoverageReceipt {
    let required_hooks = sorted_unique(required_hooks.iter().copied());
    let normalized_source = source.to_ascii_lowercase();
    let observed_hooks = required_hooks
        .iter()
        .filter(|hook| normalized_source.contains(hook.as_str()))
        .cloned()
        .collect::<Vec<_>>();
    let missing_hooks = required_hooks
        .iter()
        .filter(|hook| !observed_hooks.contains(*hook))
        .cloned()
        .collect::<Vec<_>>();
    let fail_closed = required_hooks.is_empty() || source.trim().is_empty();
    let ok = !fail_closed && missing_hooks.is_empty();
    let check_id = normalize_hook(check_id).unwrap_or_else(|| "unknown_check".to_string());
    let evidence = vec![
        format!("required_count={}", required_hooks.len()),
        format!("observed_count={}", observed_hooks.len()),
        format!("missing_count={}", missing_hooks.len()),
        format!("source_nonempty={}", i32::from(!source.trim().is_empty())),
        format!("required={}", required_hooks.join(",")),
        format!("observed={}", observed_hooks.join(",")),
        format!("missing={}", missing_hooks.join(",")),
    ];
    let claim = source_claim(fail_closed, &missing_hooks).to_string();
    let receipt_key = build_receipt_key(
        &check_id,
        ok,
        fail_closed,
        &required_hooks,
        &observed_hooks,
        &missing_hooks,
    );
    HookCoverageReceipt {
        schema_id: RECEIPT_SCHEMA_ID,
        check_id,
        ok,
        fail_closed,
        claim,
        evidence,
        required_hooks,
        observed_hooks,
        missing_hooks,
        receipt_key,
    }
}

pub fn evaluate_required_hook_completeness(
    check_id: &str,
    required_hooks: &[&str],
    mandatory_hooks: &[&str],
) -> HookCoverageReceipt {
    let required_hooks = sorted_unique(required_hooks.iter().copied());
    let mandatory_hooks = sorted_unique(mandatory_hooks.iter().copied());
    let observed_hooks = mandatory_hooks
        .iter()
        .filter(|hook| required_hooks.contains(*hook))
        .cloned()
        .collect::<Vec<_>>();
    let missing_hooks = mandatory_hooks
        .iter()
        .filter(|hook| !required_hooks.contains(*hook))
        .cloned()
        .collect::<Vec<_>>();
    let fail_closed = required_hooks.is_empty() || mandatory_hooks.is_empty();
    let ok = !fail_closed && missing_hooks.is_empty();
    let check_id = normalize_hook(check_id).unwrap_or_else(|| "unknown_check".to_string());
    let evidence = vec![
        format!("required_count={}", required_hooks.len()),
        format!("mandatory_count={}", mandatory_hooks.len()),
        format!("observed_count={}", observed_hooks.len()),
        format!("missing_count={}", missing_hooks.len()),
        format!("required={}", required_hooks.join(",")),
        format!("mandatory={}", mandatory_hooks.join(",")),
        format!("observed={}", observed_hooks.join(",")),
        format!("missing={}", missing_hooks.join(",")),
    ];
    let claim = completeness_claim(fail_closed, &missing_hooks).to_string();
    let receipt_key = build_receipt_key(
        &check_id,
        ok,
        fail_closed,
        &mandatory_hooks,
        &observed_hooks,
        &missing_hooks,
    );
    HookCoverageReceipt {
        schema_id: RECEIPT_SCHEMA_ID,
        check_id,
        ok,
        fail_closed,
        claim,
        evidence,
        required_hooks: mandatory_hooks,
        observed_hooks,
        missing_hooks,
        receipt_key,
    }
}

#[cfg(test)]
mod tests {
    use super::{
        evaluate_required_hook_completeness, evaluate_source_hook_coverage, HookCoverageReceipt,
        CHECK_ID_FOUNDATION_HOOKS, CHECK_ID_MERGE_GUARD_HOOK_COVERAGE,
    };

    fn assert_deterministic(lhs: &HookCoverageReceipt, rhs: &HookCoverageReceipt) {
        assert_eq!(lhs, rhs);
        assert_eq!(lhs.receipt_key, rhs.receipt_key);
    }

    #[test]
    fn source_coverage_fails_when_required_hooks_missing() {
        let receipt = evaluate_source_hook_coverage(
            CHECK_ID_FOUNDATION_HOOKS,
            &["alpha.js", "beta.js"],
            "includes alpha.js only",
        );
        assert!(!receipt.ok);
        assert!(!receipt.fail_closed);
        assert_eq!(receipt.missing_hooks, vec!["beta.js".to_string()]);
    }

    #[test]
    fn source_coverage_is_deterministic_for_duplicate_unordered_inputs() {
        let source = "BETA.js ... alpha.js ... beta.js";
        let first = evaluate_source_hook_coverage(
            CHECK_ID_FOUNDATION_HOOKS,
            &["beta.js", "alpha.js", "alpha.js"],
            source,
        );
        let second = evaluate_source_hook_coverage(
            CHECK_ID_FOUNDATION_HOOKS,
            &["alpha.js", "beta.js"],
            source,
        );
        assert_deterministic(&first, &second);
    }

    #[test]
    fn completeness_fails_when_mandatory_hook_missing() {
        let receipt = evaluate_required_hook_completeness(
            CHECK_ID_MERGE_GUARD_HOOK_COVERAGE,
            &["hook_a", "hook_b"],
            &["hook_a", "hook_b", "hook_c"],
        );
        assert!(!receipt.ok);
        assert_eq!(receipt.missing_hooks, vec!["hook_c".to_string()]);
    }

    #[test]
    fn completeness_is_fail_closed_when_required_or_mandatory_is_empty() {
        let no_required =
            evaluate_required_hook_completeness(CHECK_ID_MERGE_GUARD_HOOK_COVERAGE, &[], &["hook"]);
        assert!(!no_required.ok);
        assert!(no_required.fail_closed);

        let no_mandatory =
            evaluate_required_hook_completeness(CHECK_ID_MERGE_GUARD_HOOK_COVERAGE, &["hook"], &[]);
        assert!(!no_mandatory.ok);
        assert!(no_mandatory.fail_closed);
    }
}
