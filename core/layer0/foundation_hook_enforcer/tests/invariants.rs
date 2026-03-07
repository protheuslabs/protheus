// SPDX-License-Identifier: Apache-2.0
use foundation_hook_enforcer::{
    evaluate_required_hook_completeness, evaluate_source_hook_coverage, CHECK_ID_FOUNDATION_HOOKS,
    CHECK_ID_GUARD_REGISTRY_CONSUMPTION, CHECK_ID_MERGE_GUARD_HOOK_COVERAGE, RECEIPT_SCHEMA_ID,
};

#[test]
fn deterministic_receipts_for_source_coverage_inputs() {
    let source = "foundation_contract_gate.js scale_envelope_baseline.js";
    let first = evaluate_source_hook_coverage(
        CHECK_ID_FOUNDATION_HOOKS,
        &["scale_envelope_baseline.js", "foundation_contract_gate.js"],
        source,
    );
    let second = evaluate_source_hook_coverage(
        CHECK_ID_FOUNDATION_HOOKS,
        &["foundation_contract_gate.js", "scale_envelope_baseline.js"],
        source,
    );
    assert_eq!(first, second);
    assert_eq!(first.receipt_key, second.receipt_key);
    assert_eq!(first.schema_id, RECEIPT_SCHEMA_ID);
}

#[test]
fn claim_and_evidence_contract_for_success_receipts() {
    let source = "guard_check_registry required_merge_guard_ids";
    let receipt = evaluate_source_hook_coverage(
        CHECK_ID_GUARD_REGISTRY_CONSUMPTION,
        &["guard_check_registry", "required_merge_guard_ids"],
        source,
    );
    assert!(receipt.ok);
    assert!(!receipt.fail_closed);
    assert_eq!(receipt.claim, "all_required_hooks_observed_in_source");
    assert!(receipt.evidence.iter().any(|row| row == "missing_count=0"));
    assert!(receipt.missing_hooks.is_empty());
}

#[test]
fn fail_closed_when_source_or_required_hooks_are_missing() {
    let missing_source = evaluate_source_hook_coverage(
        CHECK_ID_FOUNDATION_HOOKS,
        &["foundation_contract_gate.js"],
        "",
    );
    assert!(!missing_source.ok);
    assert!(missing_source.fail_closed);
    assert_eq!(missing_source.claim, "unable_to_prove_source_hook_coverage");

    let missing_required =
        evaluate_source_hook_coverage(CHECK_ID_FOUNDATION_HOOKS, &[], "anything");
    assert!(!missing_required.ok);
    assert!(missing_required.fail_closed);
    assert_eq!(
        missing_required.claim,
        "unable_to_prove_source_hook_coverage"
    );
}

#[test]
fn required_hook_completeness_must_include_mandatory_hooks() {
    let ok_receipt = evaluate_required_hook_completeness(
        CHECK_ID_MERGE_GUARD_HOOK_COVERAGE,
        &[
            "guard_check_registry:contract_check_consumes_manifest",
            "contract_check:foundation_hooks",
        ],
        &[
            "guard_check_registry:contract_check_consumes_manifest",
            "contract_check:foundation_hooks",
        ],
    );
    assert!(ok_receipt.ok);
    assert!(ok_receipt.missing_hooks.is_empty());

    let failed_receipt = evaluate_required_hook_completeness(
        CHECK_ID_MERGE_GUARD_HOOK_COVERAGE,
        &["contract_check:foundation_hooks"],
        &[
            "guard_check_registry:contract_check_consumes_manifest",
            "contract_check:foundation_hooks",
        ],
    );
    assert!(!failed_receipt.ok);
    assert!(!failed_receipt.fail_closed);
    assert_eq!(
        failed_receipt.missing_hooks,
        vec!["guard_check_registry:contract_check_consumes_manifest".to_string()]
    );
    assert_eq!(
        failed_receipt.claim,
        "required_hook_list_missing_mandatory_hooks"
    );
}
