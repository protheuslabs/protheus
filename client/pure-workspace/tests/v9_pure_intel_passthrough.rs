#[cfg(unix)]
mod tests {
    use std::env;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = env::temp_dir().join(format!("pure-workspace-{label}-{nanos}"));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn make_fake_daemon(script_path: &Path, log_path: &Path, label: &str) {
        let body = format!(
            "#!/bin/sh\nprintf '%s|%s\\n' '{label}' \"$*\" >> '{}'\nprintf '{{\"ok\":true,\"label\":\"{}\",\"argv\":\"%s\"}}\\n' \"$*\"\n",
            log_path.display(),
            label,
        );
        fs::write(script_path, body).expect("write fake daemon");
        let mut perms = fs::metadata(script_path)
            .expect("script metadata")
            .permissions();
        perms.set_mode(0o755);
        fs::set_permissions(script_path, perms).expect("chmod");
    }

    fn run_pure(bin: &Path, path_env: &str, args: &[&str]) -> std::process::Output {
        Command::new(bin)
            .env("PATH", path_env)
            .args(args)
            .output()
            .expect("run pure workspace")
    }

    #[test]
    // V9-PURE-INTEL-001.4
    fn v9_pure_intel_001_4_prefers_sibling_daemon_before_path_fallback() {
        let temp = unique_temp_dir("sibling-pref");
        let copied_bin = temp.join("protheus-pure-workspace");
        fs::copy(env!("CARGO_BIN_EXE_protheus-pure-workspace"), &copied_bin).expect("copy bin");

        let sibling_log = temp.join("sibling.log");
        let path_dir = temp.join("path-bin");
        fs::create_dir_all(&path_dir).expect("path dir");
        let path_log = temp.join("path.log");

        make_fake_daemon(&temp.join("protheusd"), &sibling_log, "sibling");
        make_fake_daemon(&path_dir.join("protheusd"), &path_log, "path");

        let path_env = format!(
            "{}:{}",
            path_dir.display(),
            env::var("PATH").unwrap_or_default()
        );
        let output = run_pure(&copied_bin, &path_env, &["think", "--prompt=hello"]);
        assert!(
            output.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(stdout.contains("\"label\":\"sibling\""));
        assert!(sibling_log.exists(), "expected sibling daemon log");
        assert!(
            !path_log.exists(),
            "path daemon should not run when sibling daemon is available"
        );
    }

    #[test]
    // V9-PURE-INTEL-001.4
    fn v9_pure_intel_001_4_uses_path_fallback_for_think_research_memory_and_conduit() {
        let temp = unique_temp_dir("path-fallback");
        let log_path = temp.join("path.log");
        let path_dir = temp.join("path-bin");
        let copied_bin = temp.join("protheus-pure-workspace");
        fs::create_dir_all(&path_dir).expect("path dir");
        fs::copy(env!("CARGO_BIN_EXE_protheus-pure-workspace"), &copied_bin).expect("copy bin");
        make_fake_daemon(&path_dir.join("protheusd"), &log_path, "path");
        let path_env = format!(
            "{}:{}",
            path_dir.display(),
            env::var("PATH").unwrap_or_default()
        );
        let bin = copied_bin.as_path();

        for args in [
            vec!["think", "--prompt=hello"],
            vec!["research"],
            vec!["memory"],
            vec!["conduit", "status"],
        ] {
            let output = run_pure(bin, &path_env, &args);
            assert!(
                output.status.success(),
                "stderr: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let stdout = String::from_utf8_lossy(&output.stdout);
            assert!(stdout.contains("\"label\":\"path\""));
        }

        let log = fs::read_to_string(&log_path).expect("read path log");
        assert!(log.contains("path|think --prompt=hello"));
        assert!(log.contains("path|research status"));
        assert!(log.contains("path|memory status"));
        assert!(log.contains("path|status"));
    }
}
