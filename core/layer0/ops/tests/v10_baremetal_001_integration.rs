// SPDX-License-Identifier: Apache-2.0
// SRS coverage: V10-BAREMETAL-001.1, V10-BAREMETAL-001.2, V10-BAREMETAL-001.3,
// V10-BAREMETAL-001.4, V10-BAREMETAL-001.5, V10-BAREMETAL-001.6

use protheus_ops_core::baremetal_substrate;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

fn run_lane(root: &Path, args: &[String]) -> i32 {
    baremetal_substrate::run(root, args)
}

fn read_json(path: &Path) -> Value {
    serde_json::from_str(&fs::read_to_string(path).expect("read json")).expect("parse json")
}

fn latest_receipt(state_path: &Path) -> Value {
    read_json(state_path)
        .get("last_receipt")
        .cloned()
        .expect("last receipt")
}

#[test]
fn baremetal_001_runtime_lane_executes_all_contract_commands() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/baremetal/latest.json");
    let history_path = root.path().join("state/baremetal/history.jsonl");
    let ledger_path = root.path().join("state/baremetal/fs_ledger.jsonl");

    assert_eq!(
        run_lane(
            root.path(),
            &[
                "boot-kernel".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "arch": "x86_64",
                        "firmware": "uefi",
                        "boot_ms": 4200,
                        "strict_boot": true,
                        "hardware_year": 1999,
                        "drivers": {
                            "cpu": true,
                            "gpu": true,
                            "storage": true,
                            "network": true
                        }
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let boot_receipt = latest_receipt(&state_path);
    assert_eq!(
        boot_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V10-BAREMETAL-001.1")
    );
    assert_eq!(
        boot_receipt["payload"]["boot_event"]["agent_ready"].as_bool(),
        Some(true)
    );

    assert_eq!(
        run_lane(
            root.path(),
            &[
                "schedule".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "agent_count": 1000,
                        "realtime_agents": 180,
                        "preemption_latency_us": 850,
                        "throughput_degradation_pct": 3.7,
                        "thorn_cells": 90,
                        "priority_lanes": ["safety", "robotics", "latency"]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let schedule_receipt = latest_receipt(&state_path);
    assert_eq!(
        schedule_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V10-BAREMETAL-001.2")
    );
    assert_eq!(
        schedule_receipt["payload"]["schedule_event"]["preemption_latency_us"].as_u64(),
        Some(850)
    );

    assert_eq!(
        run_lane(
            root.path(),
            &[
                "memory-manager".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "ram_mb": 4096,
                        "contexts": 1500,
                        "swap_enabled": true,
                        "zero_copy_enabled": true,
                        "overcommit_ratio": 2.2
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let memory_receipt = latest_receipt(&state_path);
    assert_eq!(
        memory_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V10-BAREMETAL-001.3")
    );
    assert_eq!(
        memory_receipt["payload"]["memory_event"]["no_oom"].as_bool(),
        Some(true)
    );

    assert_eq!(
        run_lane(
            root.path(),
            &[
                "fs-driver".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "op": "append",
                        "mount_fs": "ext4",
                        "actor": "kernel.scheduler",
                        "action": "memory.swap",
                        "detail": "swap_event_committed_to_append_only_ledger"
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
                format!("--ledger-path={}", ledger_path.display()),
            ],
        ),
        0
    );
    let fs_receipt = latest_receipt(&state_path);
    assert_eq!(
        fs_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V10-BAREMETAL-001.4")
    );
    assert!(ledger_path.exists());
    let ledger_lines = fs::read_to_string(&ledger_path).expect("read ledger");
    let row = ledger_lines
        .lines()
        .next()
        .and_then(|line| serde_json::from_str::<Value>(line).ok())
        .expect("ledger row");
    assert_eq!(row["prev_hash"].as_str(), Some("GENESIS"));
    assert!(row["row_hash"].as_str().unwrap_or("").len() > 20);

    assert_eq!(
        run_lane(
            root.path(),
            &[
                "network-stack".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "air_gapped": false,
                        "zero_trust": true,
                        "mesh_enabled": true,
                        "outbound_requests": [
                            {"destination": "mesh.node.local", "protocol": "tcp", "approved": true},
                            {"destination": "unknown.remote", "protocol": "udp", "approved": false}
                        ]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let network_receipt = latest_receipt(&state_path);
    assert_eq!(
        network_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V10-BAREMETAL-001.5")
    );
    assert_eq!(
        network_receipt["payload"]["network_event"]["accepted_packets"]
            .as_array()
            .map(|rows| rows.len()),
        Some(1)
    );
    assert_eq!(
        network_receipt["payload"]["network_event"]["denied_packets"]
            .as_array()
            .map(|rows| rows.len()),
        Some(1)
    );

    assert_eq!(
        run_lane(
            root.path(),
            &[
                "security-model".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "namespace": "swarm-cell-a",
                        "capabilities": ["receipts", "memory:approved", "network:policy-gated"],
                        "invariants": {
                            "receipts_enabled": true,
                            "approved_memory_scopes_only": true,
                            "shell_requires_approval": true,
                            "exfil_policy_enforced": true,
                            "core_safety_immutable": true,
                            "external_calls_receipted": true,
                            "budget_guard_enabled": true,
                            "human_veto_override": true
                        },
                        "syscall_attempts": [
                            {"name": "read", "allowed": true},
                            {"name": "ptrace", "allowed": false}
                        ]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let security_receipt = latest_receipt(&state_path);
    assert_eq!(
        security_receipt["payload"]["claim_evidence"][0]["id"].as_str(),
        Some("V10-BAREMETAL-001.6")
    );
    assert_eq!(
        security_receipt["payload"]["security_event"]["denied_syscalls"]
            .as_array()
            .map(|rows| rows.len()),
        Some(1)
    );

    assert_eq!(
        run_lane(
            root.path(),
            &[
                "status".to_string(),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        0
    );
    let status_receipt = latest_receipt(&state_path);
    assert_eq!(status_receipt["payload"]["boot_events"], json!(1));
    assert_eq!(status_receipt["payload"]["schedule_events"], json!(1));
    assert_eq!(status_receipt["payload"]["memory_events"], json!(1));
    assert_eq!(status_receipt["payload"]["fs_events"], json!(1));
    assert_eq!(status_receipt["payload"]["network_events"], json!(1));
    assert_eq!(status_receipt["payload"]["security_events"], json!(1));
}

#[test]
fn baremetal_001_runtime_lane_fail_closes_on_airgap_egress_and_human_veto() {
    let root = tempfile::tempdir().expect("tempdir");
    let state_path = root.path().join("state/baremetal/latest.json");
    let history_path = root.path().join("state/baremetal/history.jsonl");

    assert_eq!(
        run_lane(
            root.path(),
            &[
                "network-stack".to_string(),
                format!(
                    "--payload={}",
                    json!({
                        "air_gapped": true,
                        "outbound_requests": [{"destination": "mesh.node.local", "protocol": "tcp", "approved": true}]
                    })
                ),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        1
    );

    assert_eq!(
        run_lane(
            root.path(),
            &[
                "security-model".to_string(),
                format!("--payload={}", json!({"human_veto": true})),
                format!("--state-path={}", state_path.display()),
                format!("--history-path={}", history_path.display()),
            ],
        ),
        1
    );
}
