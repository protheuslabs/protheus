use serde_json::json;
use std::path::Path;
use std::process::{Command, Stdio};

fn print_json(value: &serde_json::Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn resolve_node_binary() -> String {
    std::env::var("PROTHEUS_NODE_BINARY")
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| "node".to_string())
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
        print_json(&json!({
            "ok": false,
            "error": "legacy_script_missing",
            "domain": domain,
            "script": script_rel
        }));
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
            print_json(&json!({
                "ok": false,
                "error": "legacy_spawn_failed",
                "domain": domain,
                "script": script_rel,
                "reason": err.to_string()
            }));
            1
        }
    }
}

pub fn run_legacy_script(root: &Path, script_rel: &str, argv: &[String], domain: &str) -> i32 {
    let node_binary = resolve_node_binary();
    run_legacy_script_with_node(root, script_rel, argv, domain, &node_binary, &[])
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
}
