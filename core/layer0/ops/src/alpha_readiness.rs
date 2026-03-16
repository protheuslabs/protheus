// SPDX-License-Identifier: Apache-2.0
use crate::{clean, deterministic_receipt_hash, now_iso, parse_args};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

const LANE_ID: &str = "V7-ALPHA-READY-001";
const LATEST_REL_PATH: &str = "local/state/ops/alpha_readiness/latest.json";
const GATE_STDOUT_TAIL: usize = 240;

#[derive(Clone)]
struct GateCommand {
    id: &'static str,
    program: &'static str,
    args: &'static [&'static str],
    required: bool,
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops alpha-readiness run [--strict=1|0] [--run-gates=1|0]");
    println!("  protheus-ops alpha-readiness status");
}

fn parse_bool_flag(value: Option<&String>, fallback: bool) -> bool {
    value
        .map(|raw| {
            matches!(
                raw.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(fallback)
}

fn latest_path(root: &Path) -> PathBuf {
    root.join(LATEST_REL_PATH)
}

fn write_latest(root: &Path, payload: &Value) {
    let out_path = latest_path(root);
    if let Some(parent) = out_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(payload) {
        let _ = fs::write(out_path, format!("{raw}\n"));
    }
}

fn read_latest(root: &Path) -> Option<Value> {
    let raw = fs::read_to_string(latest_path(root)).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn check_file_tokens(root: &Path, id: &str, rel_path: &str, required_tokens: &[&str]) -> Value {
    let abs = root.join(rel_path);
    let source = match fs::read_to_string(&abs) {
        Ok(raw) => raw,
        Err(err) => {
            return json!({
                "id": id,
                "ok": false,
                "path": rel_path,
                "reason": clean(format!("read_failed:{err}"), 220),
                "missing_tokens": required_tokens
            });
        }
    };
    let missing_tokens = required_tokens
        .iter()
        .filter(|token| !source.contains(**token))
        .map(|token| token.to_string())
        .collect::<Vec<_>>();
    json!({
        "id": id,
        "ok": missing_tokens.is_empty(),
        "path": rel_path,
        "missing_tokens": missing_tokens
    })
}

fn check_package_bins(root: &Path) -> Value {
    let package_path = root.join("package.json");
    let parsed = fs::read_to_string(&package_path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
    let required = [
        "infring",
        "infringctl",
        "infringd",
        "protheus",
        "protheusctl",
        "protheusd",
    ];
    let mut missing = Vec::<String>::new();
    match parsed
        .as_ref()
        .and_then(|payload| payload.get("bin"))
        .and_then(Value::as_object)
    {
        Some(bin_map) => {
            for name in required {
                if !bin_map.contains_key(name) {
                    missing.push(name.to_string());
                }
            }
            json!({
                "id": "cli_bin_map",
                "ok": missing.is_empty(),
                "path": "package.json#bin",
                "missing_bins": missing
            })
        }
        None => json!({
            "id": "cli_bin_map",
            "ok": false,
            "path": "package.json#bin",
            "reason": "bin_map_missing",
            "missing_bins": required
        }),
    }
}

fn check_release_workflows(root: &Path) -> Value {
    let workflows = [
        ".github/workflows/release.yml",
        ".github/workflows/size-gate.yml",
        ".github/workflows/protheusd-static-size-gate.yml",
    ];
    let missing = workflows
        .iter()
        .filter(|rel| !root.join(rel).exists())
        .map(|rel| rel.to_string())
        .collect::<Vec<_>>();
    json!({
        "id": "release_and_size_workflows",
        "ok": missing.is_empty(),
        "missing_paths": missing
    })
}

fn check_assistant_templates(root: &Path) -> Value {
    let required = [
        "docs/workspace/templates/assistant/SOUL.md",
        "docs/workspace/templates/assistant/USER.md",
        "docs/workspace/templates/assistant/HEARTBEAT.md",
        "docs/workspace/templates/assistant/IDENTITY.md",
        "docs/workspace/templates/assistant/TOOLS.md",
    ];
    let missing = required
        .iter()
        .filter(|rel| !root.join(rel).exists())
        .map(|rel| rel.to_string())
        .collect::<Vec<_>>();
    json!({
        "id": "assistant_templates_bootstrap",
        "ok": missing.is_empty(),
        "missing_paths": missing
    })
}

fn check_git_clean(root: &Path) -> Value {
    if !root.join(".git").exists() {
        return json!({
            "id": "git_tree_clean",
            "ok": true,
            "skipped": true,
            "reason": "git_root_missing"
        });
    }
    let output = Command::new("git")
        .arg("status")
        .arg("--porcelain")
        .current_dir(root)
        .output();
    match output {
        Ok(out) => {
            let dirty_entries = String::from_utf8_lossy(&out.stdout)
                .lines()
                .filter(|line| !line.trim().is_empty())
                .count();
            json!({
                "id": "git_tree_clean",
                "ok": out.status.success() && dirty_entries == 0,
                "dirty_entries": dirty_entries,
                "status_code": out.status.code().unwrap_or(1)
            })
        }
        Err(err) => json!({
            "id": "git_tree_clean",
            "ok": false,
            "reason": clean(format!("git_status_failed:{err}"), 220)
        }),
    }
}

fn run_gate_command(root: &Path, gate: &GateCommand) -> Value {
    let output = Command::new(gate.program)
        .args(gate.args)
        .current_dir(root)
        .output();
    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let stderr = String::from_utf8_lossy(&out.stderr);
            json!({
                "id": gate.id,
                "ok": out.status.success(),
                "required": gate.required,
                "program": gate.program,
                "args": gate.args,
                "status_code": out.status.code().unwrap_or(1),
                "stdout_tail": clean(stdout.chars().rev().take(GATE_STDOUT_TAIL).collect::<String>().chars().rev().collect::<String>(), GATE_STDOUT_TAIL),
                "stderr_tail": clean(stderr.chars().rev().take(GATE_STDOUT_TAIL).collect::<String>().chars().rev().collect::<String>(), GATE_STDOUT_TAIL)
            })
        }
        Err(err) => json!({
            "id": gate.id,
            "ok": false,
            "required": gate.required,
            "program": gate.program,
            "args": gate.args,
            "reason": clean(format!("spawn_failed:{err}"), 220)
        }),
    }
}

fn evaluate(root: &Path, run_gates: bool) -> Value {
    let mut checks = vec![
        check_file_tokens(
            root,
            "installer_shell_modes",
            "install.sh",
            &["--pure", "--tiny-max", "--repair"],
        ),
        check_file_tokens(
            root,
            "installer_powershell_modes",
            "install.ps1",
            &["$Pure", "$TinyMax", "$Repair"],
        ),
        check_file_tokens(
            root,
            "verify_proof_timeout_override",
            "verify.sh",
            &["PROTHEUS_VERIFY_PROOF_TIMEOUT_SEC"],
        ),
        check_file_tokens(
            root,
            "alpha_readiness_docs",
            "README.md",
            &["Alpha Readiness Checklist", "infring alpha-check"],
        ),
        check_release_workflows(root),
        check_assistant_templates(root),
        check_package_bins(root),
        check_git_clean(root),
    ];

    let gate_commands = [
        GateCommand {
            id: "repo_surface_audit",
            program: "npm",
            args: &["run", "-s", "ops:repo-surface:audit"],
            required: true,
        },
        GateCommand {
            id: "root_surface_check",
            program: "npm",
            args: &["run", "-s", "ops:root-surface:check"],
            required: false,
        },
        GateCommand {
            id: "churn_guard",
            program: "npm",
            args: &["run", "-s", "ops:churn:guard"],
            required: true,
        },
    ];
    let gate_runs = if run_gates {
        gate_commands
            .iter()
            .map(|gate| run_gate_command(root, gate))
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };

    let mut failed = checks
        .iter()
        .filter(|row| !row.get("ok").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    failed.extend(
        gate_runs
            .iter()
            .filter(|row| !row.get("ok").and_then(Value::as_bool).unwrap_or(false))
            .filter(|row| row.get("required").and_then(Value::as_bool).unwrap_or(true))
            .filter_map(|row| row.get("id").and_then(Value::as_str))
            .map(ToString::to_string),
    );
    checks.sort_by_key(|row| {
        row.get("id")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    });

    json!({
        "ok": failed.is_empty(),
        "type": "alpha_readiness",
        "lane": LANE_ID,
        "ts": now_iso(),
        "checks": checks,
        "gate_runs": gate_runs,
        "failed": failed
    })
}

pub fn run(root: &Path, args: &[String]) -> i32 {
    let command = args
        .first()
        .map(|token| token.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "run".to_string());

    if command == "help" || command == "--help" || command == "-h" {
        usage();
        return 0;
    }

    let flags = if args.len() > 1 {
        parse_args(&args[1..])
    } else {
        parse_args(&[])
    };
    let strict = parse_bool_flag(flags.flags.get("strict"), false);
    let run_gates = parse_bool_flag(flags.flags.get("run-gates"), false)
        || parse_bool_flag(flags.flags.get("run_gates"), false);

    let payload = if command == "status" {
        match read_latest(root) {
            Some(mut latest) => {
                latest["type"] = Value::String("alpha_readiness_status".to_string());
                latest["lane"] = Value::String(LANE_ID.to_string());
                latest["ts"] = Value::String(now_iso());
                latest["strict"] = Value::Bool(strict);
                latest["run_gates"] = Value::Bool(run_gates);
                latest
            }
            None => {
                let mut current = evaluate(root, false);
                current["type"] = Value::String("alpha_readiness_status".to_string());
                current["strict"] = Value::Bool(strict);
                current["run_gates"] = Value::Bool(false);
                current
            }
        }
    } else if command == "run" {
        let mut current = evaluate(root, run_gates);
        current["strict"] = Value::Bool(strict);
        current["run_gates"] = Value::Bool(run_gates);
        write_latest(root, &current);
        current
    } else {
        let payload = json!({
            "ok": false,
            "type": "alpha_readiness_cli_error",
            "lane": LANE_ID,
            "error": "unknown_command",
            "command": command,
            "allowed": ["run", "status", "help"]
        });
        println!(
            "{}",
            serde_json::to_string(&payload).unwrap_or_else(|_| "{}".to_string())
        );
        return 1;
    };

    let mut with_hash = payload.clone();
    with_hash["receipt_hash"] = Value::String(deterministic_receipt_hash(&payload));
    println!(
        "{}",
        serde_json::to_string(&with_hash).unwrap_or_else(|_| "{}".to_string())
    );
    if strict
        && !with_hash
            .get("ok")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        2
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn seed_alpha_ready_workspace(root: &Path) {
        let files = [
            ("install.sh", "--pure\n--tiny-max\n--repair\n"),
            (
                "install.ps1",
                "param([switch]$Pure,[switch]$TinyMax,[switch]$Repair)\n",
            ),
            (
                "verify.sh",
                "PROTHEUS_VERIFY_PROOF_TIMEOUT_SEC=${PROTHEUS_VERIFY_PROOF_TIMEOUT_SEC:-420}\n",
            ),
            (
                "README.md",
                "## Alpha Readiness Checklist\ninfring alpha-check\n",
            ),
            (
                "package.json",
                r#"{"bin":{"infring":"a","infringctl":"b","infringd":"c","protheus":"d","protheusctl":"e","protheusd":"f"}}"#,
            ),
            (".github/workflows/release.yml", "name: release\n"),
            (".github/workflows/size-gate.yml", "name: size gate\n"),
            (
                ".github/workflows/protheusd-static-size-gate.yml",
                "name: static size gate\n",
            ),
            ("docs/workspace/templates/assistant/SOUL.md", "seed\n"),
            ("docs/workspace/templates/assistant/USER.md", "seed\n"),
            ("docs/workspace/templates/assistant/HEARTBEAT.md", "seed\n"),
            ("docs/workspace/templates/assistant/IDENTITY.md", "seed\n"),
            ("docs/workspace/templates/assistant/TOOLS.md", "seed\n"),
        ];
        for (rel, content) in files {
            let path = root.join(rel);
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).expect("parent");
            }
            fs::write(path, content).expect("write");
        }
    }

    #[test]
    fn evaluate_reports_ok_for_seeded_workspace() {
        let dir = tempdir().expect("tempdir");
        seed_alpha_ready_workspace(dir.path());
        let payload = evaluate(dir.path(), false);
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            payload
                .get("failed")
                .and_then(Value::as_array)
                .map(Vec::len),
            Some(0)
        );
    }

    #[test]
    fn strict_run_fails_when_required_tokens_missing() {
        let dir = tempdir().expect("tempdir");
        seed_alpha_ready_workspace(dir.path());
        fs::write(dir.path().join("install.sh"), "--pure\n").expect("truncate install");
        let code = run(
            dir.path(),
            &[
                "run".to_string(),
                "--strict=1".to_string(),
                "--run-gates=0".to_string(),
            ],
        );
        assert_eq!(code, 2);
    }

    #[test]
    fn status_returns_snapshot_when_latest_exists() {
        let dir = tempdir().expect("tempdir");
        seed_alpha_ready_workspace(dir.path());
        let _ = run(dir.path(), &["run".to_string()]);
        let code = run(dir.path(), &["status".to_string()]);
        assert_eq!(code, 0);
    }
}
