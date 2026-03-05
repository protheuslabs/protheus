use crate::clean;
use serde_json::json;
use std::env;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Output};

pub fn node_binary() -> String {
    env::var("PROTHEUS_NODE_BINARY").unwrap_or_else(|_| "node".to_string())
}

pub fn execute_with_bin(
    root: &Path,
    script_rel: &str,
    args: &[String],
    node_bin: &str,
) -> Result<Output, String> {
    let script_abs = root.join(script_rel);
    Command::new(node_bin)
        .arg(script_abs)
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|e| format!("spawn_failed:{e}"))
}

pub fn execute(root: &Path, script_rel: &str, args: &[String]) -> Result<Output, String> {
    let node_bin = node_binary();
    execute_with_bin(root, script_rel, args, &node_bin)
}

fn emit_output(output: &Output) -> Result<(), String> {
    std::io::stdout()
        .write_all(&output.stdout)
        .map_err(|e| format!("stdout_write_failed:{e}"))?;
    std::io::stderr()
        .write_all(&output.stderr)
        .map_err(|e| format!("stderr_write_failed:{e}"))?;
    Ok(())
}

pub fn run_passthrough(root: &Path, script_rel: &str, args: &[String]) -> i32 {
    match execute(root, script_rel, args) {
        Ok(output) => {
            if let Err(err) = emit_output(&output) {
                eprintln!(
                    "{}",
                    json!({
                        "ok": false,
                        "type": "legacy_bridge",
                        "script": clean(script_rel, 220),
                        "error": clean(err, 220)
                    })
                );
                return 1;
            }
            output.status.code().unwrap_or(1)
        }
        Err(err) => {
            eprintln!(
                "{}",
                json!({
                    "ok": false,
                    "type": "legacy_bridge",
                    "script": clean(script_rel, 220),
                    "error": clean(err, 220)
                })
            );
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_script(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create_parent");
        }
        fs::write(path, body).expect("write_script");
    }

    #[test]
    fn execute_with_bin_captures_stdout() {
        let root = tempfile::tempdir().expect("tempdir");
        let rel = "systems/ops/fake_bridge.js";
        let script = root.path().join(rel);
        write_script(
            &script,
            r#"#!/bin/sh
printf '{"ok":true,"argv":"%s"}\n' "$*"
"#,
        );

        let out = execute_with_bin(
            root.path(),
            rel,
            &["run".to_string(), "--strict=1".to_string()],
            "sh",
        )
        .expect("execute_ok");
        assert_eq!(out.status.code(), Some(0));
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(stdout.contains("run --strict=1"));
    }

    #[test]
    fn execute_with_bin_propagates_exit_code() {
        let root = tempfile::tempdir().expect("tempdir");
        let rel = "systems/ops/fake_bridge_fail.js";
        let script = root.path().join(rel);
        write_script(
            &script,
            r#"#!/bin/sh
echo "boom" 1>&2
exit 7
"#,
        );

        let out = execute_with_bin(root.path(), rel, &[], "sh").expect("execute_ok");
        assert_eq!(out.status.code(), Some(7));
        let stderr = String::from_utf8_lossy(&out.stderr);
        assert!(stderr.contains("boom"));
    }
}
