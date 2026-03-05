use crate::legacy_bridge;
use std::path::Path;
#[cfg(test)]
use std::process::Output;

pub const LEGACY_SCRIPT_REL: &str = "systems/ops/state_kernel_legacy.js";

pub fn run(root: &Path, argv: &[String]) -> i32 {
    legacy_bridge::run_passthrough(root, LEGACY_SCRIPT_REL, argv)
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
    fn forwards_state_kernel_commands() {
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
            &[
                "queue-enqueue".to_string(),
                "--queue-name=autonomy".to_string(),
                "--payload-json={\"job\":\"x\"}".to_string(),
            ],
            "sh",
        )
        .expect("execute_ok");
        assert_eq!(out.status.code(), Some(0));
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("queue-enqueue"));
        assert!(stdout.contains("--queue-name=autonomy"));
    }
}
