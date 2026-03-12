// Layer ownership: core/layer2/ops (authoritative)
// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_epoch_ms};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const DEFAULT_STATE_PATH: &str = "state/ops/command_center/session_registry.json";
const USAGE: &[&str] = &[
    "Usage:",
    "  protheus-ops command-center-session status [--session-id=<id>] [--state-path=<path>]",
    "  protheus-ops command-center-session list [--state-path=<path>]",
    "  protheus-ops command-center-session register --session-id=<id> [--lineage-id=<id>] [--status=<running|paused|terminated>] [--task=<text>] [--state-path=<path>]",
    "  protheus-ops command-center-session resume <id> [--state-path=<path>]",
    "  protheus-ops command-center-session send <id> --message=<text> [--state-path=<path>]",
];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct SessionRegistry {
    #[serde(default)]
    sessions: BTreeMap<String, SessionState>,
    #[serde(default)]
    updated_epoch_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SessionState {
    session_id: String,
    lineage_id: String,
    status: String,
    started_epoch_ms: u64,
    #[serde(default)]
    last_attach_epoch_ms: Option<u64>,
    #[serde(default)]
    attach_count: u64,
    #[serde(default)]
    steering_count: u64,
    #[serde(default)]
    last_steering_hash: Option<String>,
    #[serde(default)]
    recent_steering: Vec<SteeringEvent>,
    #[serde(default)]
    metadata: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SteeringEvent {
    ts_epoch_ms: u64,
    message: String,
    message_hash: String,
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let key_pref = format!("--{key}=");
    let key_exact = format!("--{key}");
    let mut idx = 0usize;
    while idx < argv.len() {
        let token = argv[idx].trim();
        if let Some(value) = token.strip_prefix(&key_pref) {
            return Some(value.to_string());
        }
        if token == key_exact && idx + 1 < argv.len() {
            return Some(argv[idx + 1].clone());
        }
        idx += 1;
    }
    None
}

fn first_free_positional(argv: &[String], skip: usize) -> Option<String> {
    argv.iter()
        .skip(skip)
        .find(|token| !token.trim_start().starts_with('-'))
        .cloned()
}

fn state_path(root: &Path, argv: &[String]) -> PathBuf {
    parse_flag(argv, "state-path")
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(DEFAULT_STATE_PATH))
}

fn session_id_from_args(cmd: &str, argv: &[String]) -> Option<String> {
    parse_flag(argv, "session-id")
        .or_else(|| first_free_positional(argv, 1))
        .filter(|v| !v.trim().is_empty())
        .map(|v| {
            if cmd == "send" || cmd == "steer" {
                v
            } else {
                v.trim().to_string()
            }
        })
}

fn load_registry(path: &Path) -> Result<SessionRegistry, String> {
    if !path.exists() {
        return Ok(SessionRegistry::default());
    }
    let raw = fs::read_to_string(path).map_err(|e| format!("state_read_failed:{e}"))?;
    serde_json::from_str(&raw).map_err(|e| format!("state_parse_failed:{e}"))
}

fn save_registry(path: &Path, registry: &SessionRegistry) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("state_dir_create_failed:{e}"))?;
    }
    let encoded =
        serde_json::to_string_pretty(registry).map_err(|e| format!("state_encode_failed:{e}"))?;
    fs::write(path, encoded).map_err(|e| format!("state_write_failed:{e}"))
}

fn sha256_hex(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    hex::encode(hasher.finalize())
}

fn lineage_seed(session_id: &str, now_ms: u64) -> String {
    let digest = sha256_hex(&format!("{session_id}:{now_ms}"));
    format!("lineage-{}", &digest[..12])
}

fn with_hash(mut payload: Value) -> Value {
    payload["receipt_hash"] = Value::String(deterministic_receipt_hash(&payload));
    payload
}

fn error_receipt(
    code: &str,
    message: &str,
    cmd: &str,
    argv: &[String],
    state_path: &Path,
    exit_code: i32,
) -> Value {
    with_hash(json!({
        "ok": false,
        "type": "command_center_session_error",
        "code": code,
        "message": message,
        "command": cmd,
        "argv": argv,
        "state_path": state_path.to_string_lossy(),
        "exit_code": exit_code
    }))
}

fn success_receipt(
    lane_type: &str,
    cmd: &str,
    argv: &[String],
    state_path: &Path,
    payload: Value,
) -> Value {
    with_hash(json!({
        "ok": true,
        "type": lane_type,
        "lane": "command_center_session",
        "command": cmd,
        "argv": argv,
        "ts_epoch_ms": now_epoch_ms(),
        "state_path": state_path.to_string_lossy(),
        "payload": payload,
        "claim_evidence": [
            {
                "id": "v6_cockpit_025_2",
                "claim": "session_resume_and_live_steering_are_core_authoritative",
                "evidence": {
                    "layer": "core/layer2/ops",
                    "surface": "command_center_session"
                }
            }
        ]
    }))
}

fn usage() {
    for row in USAGE {
        println!("{row}");
    }
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let cmd = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    let state_file = state_path(root, argv);
    let mut registry = match load_registry(&state_file) {
        Ok(v) => v,
        Err(err) => {
            print_json_line(&error_receipt(
                "state_load_failed",
                &err,
                &cmd,
                argv,
                &state_file,
                2,
            ));
            return 2;
        }
    };

    let now_ms = now_epoch_ms();
    let exit_code = match cmd.as_str() {
        "list" | "status" => {
            let target = session_id_from_args(&cmd, argv);
            let payload = if let Some(session_id) = target {
                if let Some(session) = registry.sessions.get(&session_id) {
                    json!({
                        "session": session,
                        "session_count": registry.sessions.len()
                    })
                } else {
                    print_json_line(&error_receipt(
                        "unknown_session",
                        "session_id not found",
                        &cmd,
                        argv,
                        &state_file,
                        3,
                    ));
                    return 3;
                }
            } else {
                json!({
                    "sessions": registry.sessions,
                    "session_count": registry.sessions.len()
                })
            };
            print_json_line(&success_receipt(
                "command_center_session_status",
                &cmd,
                argv,
                &state_file,
                payload,
            ));
            0
        }
        "register" | "start" => {
            let Some(session_id) = session_id_from_args(&cmd, argv) else {
                print_json_line(&error_receipt(
                    "missing_session_id",
                    "expected --session-id=<id> or positional session id",
                    &cmd,
                    argv,
                    &state_file,
                    2,
                ));
                return 2;
            };
            let lineage_id =
                parse_flag(argv, "lineage-id").unwrap_or_else(|| lineage_seed(&session_id, now_ms));
            let status = parse_flag(argv, "status").unwrap_or_else(|| "running".to_string());
            let task = parse_flag(argv, "task");

            let existing_started = registry
                .sessions
                .get(&session_id)
                .map(|row| row.started_epoch_ms)
                .unwrap_or(now_ms);
            let mut metadata = registry
                .sessions
                .get(&session_id)
                .map(|row| row.metadata.clone())
                .unwrap_or_else(|| json!({}));
            if let Some(task_name) = task {
                metadata["task"] = Value::String(task_name);
            }

            registry.sessions.insert(
                session_id.clone(),
                SessionState {
                    session_id: session_id.clone(),
                    lineage_id: lineage_id.clone(),
                    status: status.clone(),
                    started_epoch_ms: existing_started,
                    last_attach_epoch_ms: None,
                    attach_count: 0,
                    steering_count: 0,
                    last_steering_hash: None,
                    recent_steering: Vec::new(),
                    metadata,
                },
            );
            registry.updated_epoch_ms = now_ms;
            if let Err(err) = save_registry(&state_file, &registry) {
                print_json_line(&error_receipt(
                    "state_write_failed",
                    &err,
                    &cmd,
                    argv,
                    &state_file,
                    2,
                ));
                return 2;
            }

            let payload = json!({
                "session_id": session_id,
                "lineage_id": lineage_id,
                "status": status
            });
            print_json_line(&success_receipt(
                "command_center_session_register",
                &cmd,
                argv,
                &state_file,
                payload,
            ));
            0
        }
        "resume" | "attach" => {
            let Some(session_id) = session_id_from_args(&cmd, argv) else {
                print_json_line(&error_receipt(
                    "missing_session_id",
                    "expected session id for resume/attach",
                    &cmd,
                    argv,
                    &state_file,
                    2,
                ));
                return 2;
            };
            let payload = {
                let Some(session) = registry.sessions.get_mut(&session_id) else {
                    print_json_line(&error_receipt(
                        "unknown_session",
                        "session_id not found",
                        &cmd,
                        argv,
                        &state_file,
                        3,
                    ));
                    return 3;
                };
                if session.status == "terminated" {
                    print_json_line(&error_receipt(
                        "stale_session",
                        "cannot resume terminated session",
                        &cmd,
                        argv,
                        &state_file,
                        4,
                    ));
                    return 4;
                }
                session.status = "running".to_string();
                session.attach_count = session.attach_count.saturating_add(1);
                session.last_attach_epoch_ms = Some(now_ms);
                registry.updated_epoch_ms = now_ms;

                json!({
                    "session_id": session.session_id,
                    "lineage_id": session.lineage_id,
                    "status": session.status,
                    "attach_count": session.attach_count,
                    "attached_epoch_ms": session.last_attach_epoch_ms,
                    "steering_contract": format!("protheus session send {} --message=\"...\"", session_id),
                    "lineage_receipt_key": format!("{}::{}", session.lineage_id, session.session_id)
                })
            };

            if let Err(err) = save_registry(&state_file, &registry) {
                print_json_line(&error_receipt(
                    "state_write_failed",
                    &err,
                    &cmd,
                    argv,
                    &state_file,
                    2,
                ));
                return 2;
            }
            print_json_line(&success_receipt(
                "command_center_session_resume",
                &cmd,
                argv,
                &state_file,
                payload,
            ));
            0
        }
        "send" | "steer" => {
            let Some(session_id) = session_id_from_args(&cmd, argv) else {
                print_json_line(&error_receipt(
                    "missing_session_id",
                    "expected session id for send/steer",
                    &cmd,
                    argv,
                    &state_file,
                    2,
                ));
                return 2;
            };
            let message = parse_flag(argv, "message")
                .or_else(|| parse_flag(argv, "steer"))
                .or_else(|| first_free_positional(argv, 2))
                .unwrap_or_default();
            if message.trim().is_empty() {
                print_json_line(&error_receipt(
                    "missing_message",
                    "expected --message=<text> for send/steer",
                    &cmd,
                    argv,
                    &state_file,
                    2,
                ));
                return 2;
            }
            let payload = {
                let Some(session) = registry.sessions.get_mut(&session_id) else {
                    print_json_line(&error_receipt(
                        "unknown_session",
                        "session_id not found",
                        &cmd,
                        argv,
                        &state_file,
                        3,
                    ));
                    return 3;
                };
                if session.status == "terminated" {
                    print_json_line(&error_receipt(
                        "stale_session",
                        "cannot steer terminated session",
                        &cmd,
                        argv,
                        &state_file,
                        4,
                    ));
                    return 4;
                }

                let message_hash = sha256_hex(&message);
                let event = SteeringEvent {
                    ts_epoch_ms: now_ms,
                    message: message.clone(),
                    message_hash: message_hash.clone(),
                };
                session.steering_count = session.steering_count.saturating_add(1);
                session.last_steering_hash = Some(message_hash.clone());
                session.recent_steering.push(event);
                if session.recent_steering.len() > 20 {
                    let excess = session.recent_steering.len() - 20;
                    session.recent_steering.drain(0..excess);
                }
                registry.updated_epoch_ms = now_ms;

                json!({
                    "session_id": session.session_id,
                    "lineage_id": session.lineage_id,
                    "intervention_id": format!("{}-{}", session.session_id, session.steering_count),
                    "steering_count": session.steering_count,
                    "message_hash": format!("sha256:{message_hash}"),
                    "lineage_receipt_key": format!("{}::{}", session.lineage_id, session.session_id)
                })
            };

            if let Err(err) = save_registry(&state_file, &registry) {
                print_json_line(&error_receipt(
                    "state_write_failed",
                    &err,
                    &cmd,
                    argv,
                    &state_file,
                    2,
                ));
                return 2;
            }
            print_json_line(&success_receipt(
                "command_center_session_steer",
                &cmd,
                argv,
                &state_file,
                payload,
            ));
            0
        }
        _ => {
            usage();
            print_json_line(&error_receipt(
                "unknown_command",
                "unsupported command",
                &cmd,
                argv,
                &state_file,
                2,
            ));
            2
        }
    };
    exit_code
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn argv(items: &[&str]) -> Vec<String> {
        items.iter().map(|v| (*v).to_string()).collect()
    }

    #[test]
    fn register_resume_and_steer_persist_state() {
        let tmp = tempdir().expect("tmp");
        let root = tmp.path();

        assert_eq!(
            run(
                root,
                &argv(&[
                    "register",
                    "--session-id=session-alpha",
                    "--lineage-id=lineage-alpha",
                    "--task=ship_feature"
                ])
            ),
            0
        );
        assert_eq!(run(root, &argv(&["resume", "session-alpha"])), 0);
        assert_eq!(
            run(
                root,
                &argv(&[
                    "send",
                    "session-alpha",
                    "--message=apply patch and run tests"
                ])
            ),
            0
        );

        let state_file = root.join(DEFAULT_STATE_PATH);
        let registry = load_registry(&state_file).expect("state load");
        let session = registry.sessions.get("session-alpha").expect("session");
        assert_eq!(session.lineage_id, "lineage-alpha");
        assert_eq!(session.attach_count, 1);
        assert_eq!(session.steering_count, 1);
        assert!(session.last_attach_epoch_ms.is_some());
        assert!(session.last_steering_hash.is_some());
    }

    #[test]
    fn cannot_resume_terminated_session() {
        let tmp = tempdir().expect("tmp");
        let root = tmp.path();
        assert_eq!(
            run(
                root,
                &argv(&[
                    "register",
                    "--session-id=session-z",
                    "--status=terminated",
                    "--lineage-id=lineage-z"
                ])
            ),
            0
        );
        assert_eq!(run(root, &argv(&["resume", "session-z"])), 4);
    }
}
