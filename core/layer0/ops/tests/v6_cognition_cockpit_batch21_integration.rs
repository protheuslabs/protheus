// SPDX-License-Identifier: Apache-2.0

use protheus_ops_core::{assimilation_controller, memory_ambient, rag_cli};
use serde_json::Value;
use std::fs;
use std::path::{Path, PathBuf};

fn read_json(path: &Path) -> Value {
    let raw = fs::read_to_string(path).expect("read json");
    serde_json::from_str(&raw).expect("decode json")
}

fn has_claim(receipt: &Value, claim_id: &str) -> bool {
    receipt
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some(claim_id))
}

fn write_mock_memory_bin(root: &Path) -> PathBuf {
    let bin = root.join("mock-memory-core.sh");
    let script = r#"#!/bin/sh
cmd="$1"
case "$cmd" in
  stable-nano-chat)
    echo '{"ok":true,"type":"memory_core_nano_chat","message":"chat ready"}'
    ;;
  stable-nano-train)
    echo '{"ok":true,"type":"memory_core_nano_train","depth":"accepted"}'
    ;;
  stable-nano-fork)
    echo '{"ok":true,"type":"memory_core_nano_fork","artifact":{"path":".nanochat/fork"}}'
    ;;
  *)
    echo '{"ok":true,"type":"memory_core_generic"}'
    ;;
esac
"#;
    fs::write(&bin, script).expect("write mock binary");
    let status = std::process::Command::new("chmod")
        .arg("+x")
        .arg(&bin)
        .status()
        .expect("chmod");
    assert!(status.success());
    bin
}

#[test]
fn v6_batch21_cognition_and_cockpit_lanes_are_receipted() {
    let root = tempfile::tempdir().expect("tempdir");
    let root_path = root.path();

    assert_eq!(
        assimilation_controller::run(
            root_path,
            &[
                "skills-enable".to_string(),
                "perplexity-mode".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    let cognition_latest = root_path.join("local/state/ops/assimilation_controller/latest.json");
    let enable = read_json(&cognition_latest);
    assert_eq!(
        enable.get("type").and_then(Value::as_str),
        Some("assimilation_controller_skills_enable")
    );
    assert!(has_claim(&enable, "V6-COGNITION-012.1"));

    assert_eq!(
        assimilation_controller::run(
            root_path,
            &[
                "skill-create".to_string(),
                "--task=create summarizer skill".to_string(),
            ],
        ),
        0
    );
    let create = read_json(&cognition_latest);
    assert_eq!(
        create.get("type").and_then(Value::as_str),
        Some("assimilation_controller_skill_create")
    );
    assert!(has_claim(&create, "V6-COGNITION-012.2"));
    let deterministic_skill_id = create
        .get("skill_id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    assert!(!deterministic_skill_id.is_empty());

    assert_eq!(
        assimilation_controller::run(
            root_path,
            &[
                "skill-create".to_string(),
                "--task=create summarizer skill".to_string(),
            ],
        ),
        0
    );
    let create_repeat = read_json(&cognition_latest);
    assert_eq!(
        create_repeat.get("skill_id").and_then(Value::as_str),
        Some(deterministic_skill_id.as_str())
    );

    assert_eq!(
        assimilation_controller::run(
            root_path,
            &[
                "skills-spawn-subagents".to_string(),
                "--task=investigate launch regressions".to_string(),
                "--roles=researcher,executor".to_string(),
            ],
        ),
        0
    );
    let spawn = read_json(&cognition_latest);
    assert_eq!(
        spawn.get("type").and_then(Value::as_str),
        Some("assimilation_controller_skills_spawn_subagents")
    );
    assert!(has_claim(&spawn, "V6-COGNITION-012.3"));

    assert_eq!(
        assimilation_controller::run(
            root_path,
            &[
                "skills-computer-use".to_string(),
                "--action=fill form".to_string(),
                "--target=browser".to_string(),
                "--apply=1".to_string(),
            ],
        ),
        0
    );
    let computer_use = read_json(&cognition_latest);
    assert_eq!(
        computer_use.get("type").and_then(Value::as_str),
        Some("assimilation_controller_skills_computer_use")
    );
    assert!(has_claim(&computer_use, "V6-COGNITION-012.4"));
    assert!(computer_use
        .get("replay")
        .and_then(|v| v.get("replay_id"))
        .and_then(Value::as_str)
        .map(|v| !v.is_empty())
        .unwrap_or(false));

    assert_eq!(
        assimilation_controller::run(root_path, &["skills-dashboard".to_string()]),
        0
    );
    let dashboard = read_json(&cognition_latest);
    assert_eq!(
        dashboard.get("type").and_then(Value::as_str),
        Some("assimilation_controller_skills_dashboard")
    );
    assert!(has_claim(&dashboard, "V6-COGNITION-012.5"));
    assert!(dashboard
        .get("history_events")
        .and_then(Value::as_u64)
        .map(|v| v >= 5)
        .unwrap_or(false));

    let mock_bin = write_mock_memory_bin(root_path);
    std::env::set_var("PROTHEUS_MEMORY_CORE_BIN", &mock_bin);

    assert_eq!(
        rag_cli::run(
            root_path,
            &[
                "chat".to_string(),
                "nano".to_string(),
                "--q=hello".to_string(),
            ],
        ),
        0
    );
    let ambient_latest = root_path.join("local/state/client/memory/ambient/latest.json");
    let chat = read_json(&ambient_latest);
    assert_eq!(
        chat.get("memory_command").and_then(Value::as_str),
        Some("stable-nano-chat")
    );
    assert!(has_claim(&chat, "V6-COCKPIT-026.1"));
    assert!(has_claim(&chat, "V6-COCKPIT-026.4"));
    assert!(has_claim(&chat, "V6-COCKPIT-026.5"));
    assert_eq!(
        chat.get("token_telemetry")
            .and_then(|v| v.get("retrieval_mode"))
            .and_then(Value::as_str),
        Some("index_only")
    );

    assert_eq!(
        rag_cli::run(
            root_path,
            &[
                "train".to_string(),
                "nano".to_string(),
                "--depth=12".to_string(),
            ],
        ),
        0
    );
    let train = read_json(&ambient_latest);
    assert_eq!(
        train.get("memory_command").and_then(Value::as_str),
        Some("stable-nano-train")
    );
    assert!(has_claim(&train, "V6-COCKPIT-026.2"));
    assert!(has_claim(&train, "V6-COCKPIT-026.4"));
    assert_eq!(
        train
            .get("token_telemetry")
            .and_then(|v| v.get("tokens"))
            .and_then(|v| v.get("total"))
            .and_then(Value::as_i64)
            .map(|v| v > 0),
        Some(true)
    );

    assert_eq!(
        rag_cli::run(
            root_path,
            &[
                "nano".to_string(),
                "fork".to_string(),
                "--target=.nanochat/fork".to_string(),
            ],
        ),
        0
    );
    let fork = read_json(&ambient_latest);
    assert_eq!(
        fork.get("memory_command").and_then(Value::as_str),
        Some("stable-nano-fork")
    );
    assert!(has_claim(&fork, "V6-COCKPIT-026.3"));
    assert!(has_claim(&fork, "V6-COCKPIT-026.4"));
    assert!(has_claim(&fork, "V6-COCKPIT-026.5"));

    assert_eq!(memory_ambient::run(root_path, &["status".to_string()]), 0);
    let status = read_json(&ambient_latest);
    assert_eq!(
        status.get("type").and_then(Value::as_str),
        Some("memory_ambient")
    );
    assert!(has_claim(&status, "V6-COCKPIT-026.5"));
    assert_eq!(
        status.get("memory_command").and_then(Value::as_str),
        Some("stable-nano-fork")
    );

    std::env::remove_var("PROTHEUS_MEMORY_CORE_BIN");
}

#[test]
fn v6_batch21_cognition_and_cockpit_reject_strict_bypass() {
    let root = tempfile::tempdir().expect("tempdir");
    let root_path = root.path();

    assert_eq!(
        assimilation_controller::run(
            root_path,
            &[
                "skills-enable".to_string(),
                "perplexity-mode".to_string(),
                "--strict=1".to_string(),
                "--bypass=1".to_string(),
            ],
        ),
        1
    );

    assert_eq!(
        memory_ambient::run(
            root_path,
            &[
                "run".to_string(),
                "--memory-command=stable-nano-chat".to_string(),
                "--memory-arg=--q=hello".to_string(),
                "--memory-arg=--strict=1".to_string(),
                "--memory-arg=--bypass=1".to_string(),
            ],
        ),
        1
    );

    let ambient_latest = root_path.join("local/state/client/memory/ambient/latest.json");
    let gate = read_json(&ambient_latest);
    assert_eq!(
        gate.get("type").and_then(Value::as_str),
        Some("memory_ambient_conduit_gate")
    );
    assert!(has_claim(&gate, "V6-COCKPIT-026.4"));
}
