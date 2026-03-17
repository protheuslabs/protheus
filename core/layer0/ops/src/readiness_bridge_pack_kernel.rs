// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::contract_lane_utils as lane_utils;
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_POLICY_REL: &str = "client/runtime/config/readiness_bridge_pack_policy.json";
const DEFAULT_LATEST_REL: &str = "local/state/ops/readiness_bridge_pack/latest.json";
const DEFAULT_RECEIPTS_REL: &str = "local/state/ops/readiness_bridge_pack/receipts.jsonl";

#[derive(Clone, Debug)]
struct ReadinessPolicy {
    enabled: bool,
    strict_default: bool,
    latest_path: String,
    receipts_path: String,
}

#[derive(Clone, Debug)]
struct CheckRun {
    status: i32,
    payload_type: Option<String>,
    stderr: String,
}

fn usage() {
    println!("readiness-bridge-pack-kernel commands:");
    println!("  protheus-ops readiness-bridge-pack-kernel run [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops readiness-bridge-pack-kernel status [--policy=<path>]");
}

fn cli_receipt(kind: &str, payload: Value) -> Value {
    let ts = now_iso();
    let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(true);
    let mut out = json!({
        "ok": ok,
        "type": kind,
        "ts": ts,
        "date": ts[..10].to_string(),
        "payload": payload,
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn cli_error(kind: &str, error: &str) -> Value {
    let ts = now_iso();
    let mut out = json!({
        "ok": false,
        "type": kind,
        "ts": ts,
        "date": ts[..10].to_string(),
        "error": error,
        "fail_closed": true,
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn workspace_root(root: &Path) -> PathBuf {
    if let Some(raw) = std::env::var_os("OPENCLAW_WORKSPACE") {
        let value = PathBuf::from(raw);
        if value.is_absolute() {
            return value;
        }
    }
    root.to_path_buf()
}

fn resolve_path(root: &Path, raw: &str, fallback_rel: &str) -> PathBuf {
    let workspace = workspace_root(root);
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return workspace.join(fallback_rel);
    }
    let candidate = PathBuf::from(trimmed);
    if candidate.is_absolute() {
        candidate
    } else {
        workspace.join(trimmed)
    }
}

fn read_json(path: &Path) -> Option<Value> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    lane_utils::write_json(path, value)
}

fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    lane_utils::append_jsonl(path, value)
}

fn parse_last_json(text: &str) -> Option<Value> {
    let raw = text.trim();
    if raw.is_empty() {
        return None;
    }
    if let Ok(value) = serde_json::from_str::<Value>(raw) {
        return Some(value);
    }
    let first_brace = raw.find('{')?;
    let last_brace = raw.rfind('}')?;
    if last_brace > first_brace {
        if let Ok(value) = serde_json::from_str::<Value>(&raw[first_brace..=last_brace]) {
            return Some(value);
        }
    }
    for line in raw.lines().rev() {
        let line = line.trim();
        if !(line.starts_with('{') && line.ends_with('}')) {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(line) {
            return Some(value);
        }
    }
    None
}

fn load_policy(root: &Path, argv: &[String]) -> ReadinessPolicy {
    let policy_path = resolve_path(
        root,
        lane_utils::parse_flag(argv, "policy", false)
            .as_deref()
            .unwrap_or(DEFAULT_POLICY_REL),
        DEFAULT_POLICY_REL,
    );
    let parsed = read_json(&policy_path).unwrap_or_else(|| json!({}));
    ReadinessPolicy {
        enabled: parsed
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        strict_default: parsed
            .get("strict_default")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        latest_path: parsed
            .get("latest_path")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_LATEST_REL)
            .to_string(),
        receipts_path: parsed
            .get("receipts_path")
            .and_then(Value::as_str)
            .unwrap_or(DEFAULT_RECEIPTS_REL)
            .to_string(),
    }
}

fn run_ops_capture(domain: &str, args: &[&str]) -> CheckRun {
    let command = std::env::var("PROTHEUS_OPS_BIN")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_exe().unwrap_or_else(|_| PathBuf::from("protheus-ops"))
        });
    let output = Command::new(command).arg(domain).args(args).output();
    let Ok(output) = output else {
        return CheckRun {
            status: 1,
            payload_type: None,
            stderr: "spawn_failed".to_string(),
        };
    };
    let status = output.status.code().unwrap_or(1);
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    let payload_type = parse_last_json(&stdout).and_then(|value| {
        value
            .get("type")
            .and_then(Value::as_str)
            .map(|row| row.to_string())
    });
    let stderr_tail = if stderr.len() > 320 {
        stderr[stderr.len() - 320..].to_string()
    } else {
        stderr
    };
    CheckRun {
        status,
        payload_type,
        stderr: stderr_tail,
    }
}

fn build_readiness_snapshot_with_runner<F>(strict: bool, mut runner: F) -> Value
where
    F: FnMut(&str, &[&str]) -> CheckRun,
{
    let checks = [
        (
            "alpha_readiness",
            "alpha-readiness",
            vec![
                "run",
                if strict { "--strict=1" } else { "--strict=0" },
                "--run-gates=1",
            ],
        ),
        (
            "f100_readiness",
            "f100-readiness-program",
            vec![
                "run-all",
                if strict { "--strict=1" } else { "--strict=0" },
                "--apply=0",
            ],
        ),
        (
            "control_plane_status",
            "protheus-control-plane",
            vec!["status", if strict { "--strict=1" } else { "--strict=0" }],
        ),
    ]
    .into_iter()
    .map(|(id, domain, args)| {
        let run = runner(domain, &args);
        json!({
            "id": id,
            "ok": run.status == 0,
            "status_code": run.status,
            "payload_type": run.payload_type,
            "stderr_tail": run.stderr
        })
    })
    .collect::<Vec<_>>();
    let failed = checks
        .iter()
        .filter(|row| row.get("ok").and_then(Value::as_bool) != Some(true))
        .filter_map(|row| {
            row.get("id")
                .and_then(Value::as_str)
                .map(|row| row.to_string())
        })
        .collect::<Vec<_>>();
    json!({
        "ok": failed.is_empty(),
        "type": "readiness_bridge_pack",
        "generated_at": now_iso(),
        "strict": strict,
        "checks": checks,
        "failed": failed
    })
}

fn build_readiness_snapshot(strict: bool) -> Value {
    build_readiness_snapshot_with_runner(strict, |domain, args| run_ops_capture(domain, args))
}

fn status_payload(root: &Path, policy: &ReadinessPolicy) -> Result<Value, String> {
    let latest_path = resolve_path(root, &policy.latest_path, DEFAULT_LATEST_REL);
    let latest = fs::read_to_string(&latest_path)
        .map_err(|_| "missing_latest_readiness_bridge_pack".to_string())?;
    serde_json::from_str::<Value>(&latest)
        .map_err(|err| format!("readiness_bridge_pack_kernel_decode_latest_failed:{err}"))
}

fn run_command(root: &Path, argv: &[String]) -> Result<(Value, i32), String> {
    let command = argv.first().map(|value| value.as_str()).unwrap_or("run");
    let strict_requested = lane_utils::parse_bool(
        lane_utils::parse_flag(argv, "strict", false).as_deref(),
        true,
    );
    let policy = load_policy(root, argv);
    let strict = strict_requested && policy.strict_default;

    if !policy.enabled {
        return Ok((
            json!({
                "ok": false,
                "type": "readiness_bridge_pack",
                "generated_at": now_iso(),
                "error": "lane_disabled_by_policy"
            }),
            1,
        ));
    }

    match command {
        "status" => Ok((status_payload(root, &policy)?, 0)),
        "run" => {
            let out = build_readiness_snapshot(strict);
            let latest_path = resolve_path(root, &policy.latest_path, DEFAULT_LATEST_REL);
            let receipts_path = resolve_path(root, &policy.receipts_path, DEFAULT_RECEIPTS_REL);
            write_json(&latest_path, &out)?;
            append_jsonl(&receipts_path, &out)?;
            let exit_code = if out.get("ok").and_then(Value::as_bool) == Some(true) {
                0
            } else {
                2
            };
            Ok((out, exit_code))
        }
        _ => Err("readiness_bridge_pack_kernel_unknown_command".to_string()),
    }
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let Some(command) = argv.first().map(|value| value.as_str()) else {
        usage();
        return 1;
    };
    if matches!(command, "help" | "--help" | "-h") {
        usage();
        return 0;
    }
    match run_command(root, argv) {
        Ok((payload, exit_code)) => {
            print_json_line(&cli_receipt("readiness_bridge_pack_kernel", payload));
            exit_code
        }
        Err(err) => {
            print_json_line(&cli_error("readiness_bridge_pack_kernel", &err));
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_snapshot_marks_failed_checks() {
        let snapshot = build_readiness_snapshot_with_runner(true, |domain, _args| CheckRun {
            status: if domain == "f100-readiness-program" {
                1
            } else {
                0
            },
            payload_type: Some(format!("{domain}_status")),
            stderr: String::new(),
        });
        assert_eq!(snapshot.get("ok").and_then(Value::as_bool), Some(false));
        assert_eq!(
            snapshot.pointer("/failed/0").and_then(Value::as_str),
            Some("f100_readiness")
        );
    }
}
