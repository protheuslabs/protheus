use crate::legacy_bridge;
use burn_oracle_budget_gate::CHECK_ID as BURN_ORACLE_BUDGET_GATE_CHECK_ID;
use persona_dispatch_security_gate::CHECK_ID as PERSONA_DISPATCH_SECURITY_GATE_CHECK_ID;
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

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let args = with_foundation_check_ids(argv);
    legacy_bridge::run_passthrough(root, LEGACY_SCRIPT_REL, &args)
}

#[cfg(test)]
fn execute_with_bin(root: &Path, argv: &[String], node_bin: &str) -> Result<Output, String> {
    legacy_bridge::execute_with_bin(root, LEGACY_SCRIPT_REL, argv, node_bin)
}

#[cfg(test)]
mod tests {
    use super::*;
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
}
