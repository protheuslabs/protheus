use crate::contract_check::{foundation_hook_coverage_receipt, guard_registry_contract_receipt};
use crate::legacy_bridge;
use burn_oracle_budget_gate::CHECK_ID as BURN_ORACLE_BUDGET_GATE_CHECK_ID;
use persona_dispatch_security_gate::CHECK_ID as PERSONA_DISPATCH_SECURITY_GATE_CHECK_ID;
use foundation_hook_enforcer::{
    evaluate_required_hook_completeness, HookCoverageReceipt, CHECK_ID_FOUNDATION_HOOKS,
    CHECK_ID_GUARD_REGISTRY_CONSUMPTION, CHECK_ID_MERGE_GUARD_HOOK_COVERAGE,
};
use std::path::Path;
#[cfg(test)]
use std::process::Output;

pub const LEGACY_SCRIPT_REL: &str = "systems/ops/foundation_contract_gate_legacy.js";
const CHECK_IDS_FLAG_PREFIX: &str = "--rust-foundation-check-ids=";

pub const FOUNDATION_CONTRACT_CHECK_IDS: &[&str] = &[
    BURN_ORACLE_BUDGET_GATE_CHECK_ID,
    PERSONA_DISPATCH_SECURITY_GATE_CHECK_ID,
];

fn with_foundation_check_ids(args: &[String]) -> Vec<String> {
    if args
        .iter()
        .any(|arg| arg.starts_with(CHECK_IDS_FLAG_PREFIX))
    {
        return args.to_vec();
    }

    let mut out = args.to_vec();
    out.push(format!(
        "{CHECK_IDS_FLAG_PREFIX}{}",
        FOUNDATION_CONTRACT_CHECK_IDS.join(",")
    ));
    out
}
pub const REQUIRED_HOOK_COVERAGE_CHECK_IDS: &[&str] = &[
    CHECK_ID_GUARD_REGISTRY_CONSUMPTION,
    CHECK_ID_FOUNDATION_HOOKS,
];

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let args = with_foundation_check_ids(argv);
    legacy_bridge::run_passthrough(root, LEGACY_SCRIPT_REL, &args)
}

pub fn merge_guard_hook_coverage_receipt(merge_guard_ids: &[&str]) -> HookCoverageReceipt {
    evaluate_required_hook_completeness(
        CHECK_ID_MERGE_GUARD_HOOK_COVERAGE,
        merge_guard_ids,
        REQUIRED_HOOK_COVERAGE_CHECK_IDS,
    )
}

pub fn contract_check_hook_coverage_receipts(
    contract_check_source: &str,
) -> Vec<HookCoverageReceipt> {
    vec![
        guard_registry_contract_receipt(contract_check_source),
        foundation_hook_coverage_receipt(contract_check_source),
    ]
}

#[cfg(test)]
fn execute_with_bin(root: &Path, argv: &[String], node_bin: &str) -> Result<Output, String> {
    legacy_bridge::execute_with_bin(root, LEGACY_SCRIPT_REL, argv, node_bin)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contract_check::{FOUNDATION_HOOK_REQUIRED_TOKENS, GUARD_REGISTRY_REQUIRED_TOKENS};
    use std::fs;

    #[test]
    fn injects_foundation_check_ids_when_missing() {
        let args = vec!["run".to_string()];
        let resolved = with_foundation_check_ids(&args);
        assert_eq!(resolved.len(), 2);
        assert!(resolved[1].starts_with(CHECK_IDS_FLAG_PREFIX));
        assert!(resolved[1].contains(BURN_ORACLE_BUDGET_GATE_CHECK_ID));
        assert!(resolved[1].contains(PERSONA_DISPATCH_SECURITY_GATE_CHECK_ID));
    }

    #[test]
    fn does_not_duplicate_foundation_check_id_flag() {
        let args = vec![
            "run".to_string(),
            format!("{CHECK_IDS_FLAG_PREFIX}already-set"),
        ];
        let resolved = with_foundation_check_ids(&args);
        assert_eq!(resolved, args);
    }

    #[test]
    fn forwards_cli_args_to_legacy_script() {
        let root = tempfile::tempdir().expect("tempdir");
        let script = root.path().join(LEGACY_SCRIPT_REL);
        if let Some(parent) = script.parent() {
            fs::create_dir_all(parent).expect("create_parent");
        }
        fs::write(
            &script,
            r#"#!/bin/sh
printf '{"ok":true,"argv":"%s"}\n' "$*"
"#,
        )
        .expect("write_script");

        let out = execute_with_bin(
            root.path(),
            &with_foundation_check_ids(&["run".to_string(), "--strict=1".to_string()]),
            "sh",
        )
        .expect("execute_ok");
        assert_eq!(out.status.code(), Some(0));
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("run --strict=1"));
        assert!(stdout.contains(BURN_ORACLE_BUDGET_GATE_CHECK_ID));
        assert!(stdout.contains(PERSONA_DISPATCH_SECURITY_GATE_CHECK_ID));
    }

    #[test]
    fn merge_guard_hook_coverage_receipt_fails_when_required_check_ids_are_missing() {
        let receipt = merge_guard_hook_coverage_receipt(&[CHECK_ID_FOUNDATION_HOOKS]);
        assert!(!receipt.ok);
        assert!(!receipt.fail_closed);
        assert_eq!(
            receipt.missing_hooks,
            vec![CHECK_ID_GUARD_REGISTRY_CONSUMPTION.to_string()]
        );
    }

    #[test]
    fn contract_check_hook_coverage_receipts_report_both_required_checks() {
        let mut tokens: Vec<&str> = Vec::new();
        tokens.extend(GUARD_REGISTRY_REQUIRED_TOKENS);
        tokens.extend(FOUNDATION_HOOK_REQUIRED_TOKENS);
        let source = tokens.join(" ");
        let receipts = contract_check_hook_coverage_receipts(&source);
        assert_eq!(receipts.len(), 2);
        assert!(receipts.iter().all(|receipt| receipt.ok));
    }
}
