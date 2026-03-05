use crate::clean;
use serde_json::json;
use std::env;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};

pub fn node_binary() -> String {
    env::var("PROTHEUS_NODE_BINARY").unwrap_or_else(|_| "node".to_string())
}

pub fn resolve_script_path(root: &Path, env_key: &str, default_rel: &str) -> PathBuf {
    let from_env = env::var(env_key)
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty());

    let script = from_env.unwrap_or_else(|| default_rel.to_string());
    let path = PathBuf::from(script);
    if path.is_absolute() {
        path
    } else {
        root.join(path)
    }
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

pub fn run_legacy_script(
    root: &Path,
    domain: &str,
    script_path: &Path,
    args: &[String],
    forward_stdin: bool,
) -> i32 {
    let mut cmd = Command::new(node_binary());
    cmd.arg(script_path)
        .args(args)
        .current_dir(root)
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    if forward_stdin {
        cmd.stdin(Stdio::inherit());
    } else {
        cmd.stdin(Stdio::null());
    }

    match cmd.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(err) => {
            eprintln!(
                "{}",
                json!({
                    "ok": false,
                    "type": "rust_bridge_dispatch",
                    "domain": domain,
                    "error": format!("spawn_failed:{err}")
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
    use tempfile::tempdir;

    fn write_script(path: &Path, body: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create_parent");
        }
        fs::write(path, body).expect("write_script");
    }

    #[test]
    fn resolve_script_path_uses_default_relative() {
        let root = tempdir().expect("tempdir");
        let path = resolve_script_path(root.path(), "NO_SUCH_ENV_KEY", "systems/foo.js");
        assert_eq!(path, root.path().join("systems/foo.js"));
    }

    #[test]
    fn resolve_script_path_honors_absolute_env_path() {
        let root = tempdir().expect("tempdir");
        let abs = root.path().join("x/y/z.js");
        env::set_var("BRIDGE_TEST_ABS", abs.to_string_lossy().to_string());
        let path = resolve_script_path(root.path(), "BRIDGE_TEST_ABS", "fallback.js");
        env::remove_var("BRIDGE_TEST_ABS");
        assert_eq!(path, abs);
    }

    #[test]
    fn resolve_script_path_honors_relative_env_path() {
        let root = tempdir().expect("tempdir");
        env::set_var("BRIDGE_TEST_REL", "systems/legacy.js");
        let path = resolve_script_path(root.path(), "BRIDGE_TEST_REL", "fallback.js");
        env::remove_var("BRIDGE_TEST_REL");
        assert_eq!(path, root.path().join("systems/legacy.js"));
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
