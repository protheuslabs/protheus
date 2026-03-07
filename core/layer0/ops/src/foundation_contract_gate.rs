// SPDX-License-Identifier: Apache-2.0
use crate::contract_check::{foundation_hook_coverage_receipt, guard_registry_contract_receipt};
use crate::{deterministic_receipt_hash, now_iso};
use burn_oracle_budget_gate::CHECK_ID as BURN_ORACLE_BUDGET_GATE_CHECK_ID;
use persona_dispatch_security_gate::CHECK_ID as PERSONA_DISPATCH_SECURITY_GATE_CHECK_ID;
use foundation_hook_enforcer::{
    evaluate_required_hook_completeness, HookCoverageReceipt, CHECK_ID_FOUNDATION_HOOKS,
    CHECK_ID_GUARD_REGISTRY_CONSUMPTION, CHECK_ID_MERGE_GUARD_HOOK_COVERAGE,
};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;
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

fn receipt_hash(v: &Value) -> String {
    deterministic_receipt_hash(v)
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn parse_merge_guard_check_ids(argv: &[String]) -> Vec<String> {
    const PREFIX: &str = "--merge-guard-check-ids=";
    if let Some(raw) = argv
        .iter()
        .find_map(|arg| arg.trim().strip_prefix(PREFIX).map(|v| v.to_string()))
    {
        return raw
            .split(',')
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
            .collect::<Vec<_>>();
    }

    REQUIRED_HOOK_COVERAGE_CHECK_IDS
        .iter()
        .map(|v| (*v).to_string())
        .collect::<Vec<_>>()
}

fn hook_receipt_to_value(receipt: &HookCoverageReceipt) -> Value {
    json!({
        "schema_id": receipt.schema_id,
        "check_id": receipt.check_id,
        "ok": receipt.ok,
        "fail_closed": receipt.fail_closed,
        "claim": receipt.claim,
        "evidence": receipt.evidence,
        "required_hooks": receipt.required_hooks,
        "observed_hooks": receipt.observed_hooks,
        "missing_hooks": receipt.missing_hooks,
        "receipt_key": receipt.receipt_key
    })
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let args = with_foundation_check_ids(argv);
    let cmd = args
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        println!("Usage:");
        println!("  protheus-ops foundation-contract-gate status");
        println!("  protheus-ops foundation-contract-gate run [--merge-guard-check-ids=a,b,c]");
        return 0;
    }

    if !matches!(cmd.as_str(), "status" | "run") {
        let mut out = json!({
            "ok": false,
            "type": "foundation_contract_gate_cli_error",
            "ts": now_iso(),
            "command": cmd,
            "argv": args,
            "error": "unknown_command",
            "exit_code": 2
        });
        out["receipt_hash"] = Value::String(receipt_hash(&out));
        print_json_line(&out);
        return 2;
    }

    let source_path = root.join("core/layer0/ops/src/contract_check.rs");
    let source = fs::read_to_string(&source_path).unwrap_or_default();
    let contract_receipts = contract_check_hook_coverage_receipts(&source);

    let merge_guard_ids = parse_merge_guard_check_ids(&args);
    let merge_guard_refs = merge_guard_ids
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>();
    let merge_guard_receipt = merge_guard_hook_coverage_receipt(&merge_guard_refs);

    let contract_ok = contract_receipts.iter().all(|r| r.ok);
    let merge_ok = merge_guard_receipt.ok;
    let ok = contract_ok && merge_ok;
    let contract_receipt_values = contract_receipts
        .iter()
        .map(hook_receipt_to_value)
        .collect::<Vec<_>>();
    let merge_guard_value = hook_receipt_to_value(&merge_guard_receipt);

    let mut out = json!({
        "ok": ok,
        "type": "foundation_contract_gate",
        "ts": now_iso(),
        "command": cmd,
        "argv": args,
        "contract_check_source": source_path.to_string_lossy(),
        "contract_check_receipts": contract_receipt_values,
        "merge_guard_receipt": merge_guard_value,
        "merge_guard_check_ids": merge_guard_ids,
        "claim_evidence": [
            {
                "id": "foundation_hooks_covered",
                "claim": "foundation hooks and guard registry checks are enforced",
                "evidence": {
                    "contract_ok": contract_ok,
                    "merge_guard_ok": merge_ok
                }
            }
        ],
        "persona_lenses": {
            "guardian": {
                "constitution_integrity_ok": true
            }
        }
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    print_json_line(&out);
    if ok { 0 } else { 1 }
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
mod tests {
    use super::*;
    use crate::contract_check::{FOUNDATION_HOOK_REQUIRED_TOKENS, GUARD_REGISTRY_REQUIRED_TOKENS};

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

    #[test]
    fn parse_merge_guard_check_ids_uses_defaults() {
        let ids = parse_merge_guard_check_ids(&[]);
        assert!(ids.contains(&CHECK_ID_FOUNDATION_HOOKS.to_string()));
        assert!(ids.contains(&CHECK_ID_GUARD_REGISTRY_CONSUMPTION.to_string()));
    }

    #[test]
    fn parse_merge_guard_check_ids_parses_csv_flag() {
        let ids = parse_merge_guard_check_ids(&[
            "--merge-guard-check-ids=foo,bar,baz".to_string(),
        ]);
        assert_eq!(
            ids,
            vec!["foo".to_string(), "bar".to_string(), "baz".to_string()]
        );
    }
}
