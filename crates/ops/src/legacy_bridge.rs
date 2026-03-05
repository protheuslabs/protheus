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

pub(crate) fn run_legacy_script_with_node(
    root: &Path,
    script_rel: &str,
    argv: &[String],
    domain: &str,
    node_binary: &str,
    extra_env: &[(String, String)],
) -> i32 {
    let script_path = root.join(script_rel);
    if !script_path.exists() {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "ok": false,
                "error": "legacy_script_missing",
                "domain": domain,
                "script": script_rel
            }))
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
        );
        return 1;
    }

    let mut cmd = Command::new(node_binary);
    cmd.arg(&script_path)
        .args(argv)
        .current_dir(root)
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .env("PROTHEUS_RUST_LEGACY_BRIDGE", "1");
    for (k, v) in extra_env {
        cmd.env(k, v);
    }

    match cmd.status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(err) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&json!({
                    "ok": false,
                    "error": "legacy_spawn_failed",
                    "domain": domain,
                    "script": script_rel,
                    "reason": err.to_string()
                }))
                .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
            );
            1
        }
    }
}

pub fn run_legacy_script(root: &Path, script_rel: &str, argv: &[String], domain: &str) -> i32 {
    let node = node_binary();
    run_legacy_script_with_node(root, script_rel, argv, domain, &node, &[])
}

pub fn run_legacy_script_compat(
    root: &Path,
    domain: &str,
    script_path: &Path,
    args: &[String],
    _forward_stdin: bool,
) -> i32 {
    let rel = script_path
        .strip_prefix(root)
        .unwrap_or(script_path)
        .to_string_lossy()
        .replace('\\', "/");
    run_legacy_script(root, &rel, args, domain)
}

fn parse_bool_flag(v: Option<&str>) -> bool {
    let Some(raw) = v else {
        return false;
    };
    matches!(
        raw.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

pub fn split_legacy_fallback_flag(argv: &[String], module_env_key: &str) -> (bool, Vec<String>) {
    let mut fallback_from_arg = None::<bool>;
    let mut cleaned = Vec::with_capacity(argv.len());

    let mut i = 0usize;
    while i < argv.len() {
        let tok = argv[i].trim().to_string();
        if let Some((k, v)) = tok.split_once('=') {
            if k == "--legacy-fallback" {
                fallback_from_arg = Some(parse_bool_flag(Some(v)));
                i += 1;
                continue;
            }
        }
        if tok == "--legacy-fallback" {
            if let Some(next) = argv.get(i + 1) {
                if !next.starts_with("--") {
                    fallback_from_arg = Some(parse_bool_flag(Some(next)));
                    i += 2;
                    continue;
                }
            }
            fallback_from_arg = Some(true);
            i += 1;
            continue;
        }
        cleaned.push(argv[i].clone());
        i += 1;
    }

    let fallback = fallback_from_arg.unwrap_or_else(|| {
        parse_bool_flag(std::env::var(module_env_key).ok().as_deref())
            || parse_bool_flag(
                std::env::var("PROTHEUS_OPS_LEGACY_FALLBACK")
                    .ok()
                    .as_deref(),
            )
    });

    (fallback, cleaned)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write_script(root: &Path, script_rel: &str, content: &str) {
        let script_path = root.join(script_rel);
        fs::create_dir_all(script_path.parent().expect("parent")).expect("mkdir");
        fs::write(script_path, content).expect("write script");
    }

    fn write_shell_script(path: &Path, body: &str) {
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
        write_shell_script(
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
        write_shell_script(
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

    #[test]
    fn missing_script_fails_closed() {
        let dir = tempdir().expect("tempdir");
        let exit = run_legacy_script_with_node(
            dir.path(),
            "systems/ops/autotest_controller_legacy.js",
            &[],
            "autotest_controller",
            "/bin/sh",
            &[],
        );
        assert_eq!(exit, 1);
    }

    #[test]
    fn forwards_args_and_exit_code() {
        let dir = tempdir().expect("tempdir");
        let args_path = dir.path().join("args.txt");
        write_script(
            dir.path(),
            "systems/ops/autotest_controller_legacy.js",
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$BRIDGE_ARGS_OUT\"\nexit \"${BRIDGE_EXIT_CODE:-0}\"\n",
        );

        let argv = vec![
            "run".to_string(),
            "latest".to_string(),
            "--apply=0".to_string(),
        ];
        let extra_env = vec![
            (
                "BRIDGE_ARGS_OUT".to_string(),
                args_path.to_string_lossy().into_owned(),
            ),
            ("BRIDGE_EXIT_CODE".to_string(), "7".to_string()),
        ];

        let exit = run_legacy_script_with_node(
            dir.path(),
            "systems/ops/autotest_controller_legacy.js",
            &argv,
            "autotest_controller",
            "/bin/sh",
            &extra_env,
        );

        assert_eq!(exit, 7);
        let got = fs::read_to_string(args_path)
            .expect("args output")
            .lines()
            .map(|line| line.to_string())
            .collect::<Vec<_>>();
        assert_eq!(got, argv);
    }

    #[test]
    fn splits_and_detects_fallback_flag() {
        let args = vec![
            "run".to_string(),
            "--legacy-fallback=1".to_string(),
            "--strict=1".to_string(),
        ];
        let (fallback, cleaned) = split_legacy_fallback_flag(&args, "NO_SUCH_ENV");
        assert!(fallback);
        assert_eq!(cleaned, vec!["run".to_string(), "--strict=1".to_string()]);
    }
}
