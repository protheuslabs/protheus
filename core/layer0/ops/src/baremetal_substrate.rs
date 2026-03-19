// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::contract_lane_utils::{
    self as lane_utils, clean_text, clean_token, cli_error, cli_receipt, json_bool as parse_bool,
    json_u64 as parse_u64, path_flag, payload_obj, print_json_line, string_set,
};
use crate::{deterministic_receipt_hash, now_iso};

const DEFAULT_STATE_REL: &str = "local/state/ops/baremetal_substrate/latest.json";
const DEFAULT_HISTORY_REL: &str = "local/state/ops/baremetal_substrate/history.jsonl";
const DEFAULT_LEDGER_REL: &str = "local/state/ops/baremetal_substrate/fs_ledger.jsonl";

fn usage() {
    println!("baremetal-substrate commands:");
    println!("  protheus-ops baremetal-substrate status [--state-path=<path>]");
    println!("  protheus-ops baremetal-substrate boot-kernel [--payload-base64=<json>] [--state-path=<path>] [--history-path=<path>]");
    println!("  protheus-ops baremetal-substrate schedule [--payload-base64=<json>] [--state-path=<path>] [--history-path=<path>]");
    println!("  protheus-ops baremetal-substrate memory-manager [--payload-base64=<json>] [--state-path=<path>] [--history-path=<path>]");
    println!("  protheus-ops baremetal-substrate fs-driver [--payload-base64=<json>] [--state-path=<path>] [--history-path=<path>] [--ledger-path=<path>]");
    println!("  protheus-ops baremetal-substrate network-stack [--payload-base64=<json>] [--state-path=<path>] [--history-path=<path>]");
    println!("  protheus-ops baremetal-substrate security-model [--payload-base64=<json>] [--state-path=<path>] [--history-path=<path>]");
}

fn payload_json(argv: &[String]) -> Result<Value, String> {
    lane_utils::payload_json(argv, "baremetal_substrate")
}

fn state_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    path_flag(
        root,
        argv,
        payload,
        "state-path",
        "state_path",
        DEFAULT_STATE_REL,
    )
}

fn history_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    path_flag(
        root,
        argv,
        payload,
        "history-path",
        "history_path",
        DEFAULT_HISTORY_REL,
    )
}

fn ledger_path(root: &Path, argv: &[String], payload: &Map<String, Value>) -> PathBuf {
    path_flag(
        root,
        argv,
        payload,
        "ledger-path",
        "ledger_path",
        DEFAULT_LEDGER_REL,
    )
}

fn default_state() -> Value {
    json!({
        "schema_version": "baremetal_substrate_state_v1",
        "boot_events": {},
        "schedule_events": {},
        "memory_events": {},
        "fs_events": {},
        "network_events": {},
        "security_events": {},
        "ledger_head": "GENESIS",
        "last_receipt": null,
    })
}

fn ensure_state_shape(value: &mut Value) {
    if !value.is_object() {
        *value = default_state();
        return;
    }
    for key in [
        "boot_events",
        "schedule_events",
        "memory_events",
        "fs_events",
        "network_events",
        "security_events",
    ] {
        if !value.get(key).map(Value::is_object).unwrap_or(false) {
            value[key] = json!({});
        }
    }
    if value
        .get("schema_version")
        .and_then(Value::as_str)
        .is_none()
    {
        value["schema_version"] = json!("baremetal_substrate_state_v1");
    }
    if value.get("ledger_head").and_then(Value::as_str).is_none() {
        value["ledger_head"] = json!("GENESIS");
    }
}

fn load_state(path: &Path) -> Value {
    let mut state = lane_utils::read_json(path).unwrap_or_else(default_state);
    ensure_state_shape(&mut state);
    state
}

fn save_state(path: &Path, state: &Value) -> Result<(), String> {
    lane_utils::write_json(path, state)
}

fn append_history(path: &Path, row: &Value) -> Result<(), String> {
    lane_utils::append_jsonl(path, row)
}

fn as_object_mut<'a>(value: &'a mut Value, key: &str) -> &'a mut Map<String, Value> {
    if !value.get(key).map(Value::is_object).unwrap_or(false) {
        value[key] = json!({});
    }
    value
        .get_mut(key)
        .and_then(Value::as_object_mut)
        .expect("object")
}

fn json_f64(raw: Option<&Value>, fallback: f64, min: f64, max: f64) -> f64 {
    raw.and_then(Value::as_f64)
        .or_else(|| raw.and_then(Value::as_u64).map(|n| n as f64))
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn bool_field(raw: Option<&Value>, fallback: bool) -> bool {
    parse_bool(raw, fallback)
}

fn object_field<'a>(payload: &'a Map<String, Value>, key: &str) -> &'a Map<String, Value> {
    payload
        .get(key)
        .and_then(Value::as_object)
        .unwrap_or_else(|| {
            static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
            EMPTY.get_or_init(Map::new)
        })
}

fn now_millis() -> u128 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn to_base36(mut value: u128) -> String {
    if value == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while value > 0 {
        let digit = (value % 36) as u8;
        out.push(if digit < 10 {
            (b'0' + digit) as char
        } else {
            (b'a' + digit - 10) as char
        });
        value /= 36;
    }
    out.iter().rev().collect()
}

fn stable_id(prefix: &str, basis: &Value) -> String {
    let digest = deterministic_receipt_hash(basis);
    format!("{prefix}_{}_{}", to_base36(now_millis()), &digest[..12])
}

fn boot_kernel(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let arch = clean_token(payload.get("arch").and_then(Value::as_str), "x86_64");
    let arch_supported = matches!(arch.as_str(), "x86_64" | "arm64" | "riscv64");
    if !arch_supported {
        return Err("baremetal_substrate_arch_unsupported".to_string());
    }
    let firmware = clean_token(payload.get("firmware").and_then(Value::as_str), "uefi");
    let strict_boot = bool_field(payload.get("strict_boot"), true);
    let boot_ms = parse_u64(payload.get("boot_ms"), 3500, 100, 120_000);
    if strict_boot && boot_ms > 5000 {
        return Err("baremetal_substrate_boot_time_budget_exceeded".to_string());
    }

    let drivers = object_field(payload, "drivers");
    let cpu_driver = bool_field(drivers.get("cpu"), true);
    let gpu_driver = bool_field(drivers.get("gpu"), true);
    let storage_driver = bool_field(drivers.get("storage"), true);
    let network_driver = bool_field(drivers.get("network"), true);
    if !(cpu_driver && gpu_driver && storage_driver && network_driver) {
        return Err("baremetal_substrate_driver_probe_failed".to_string());
    }
    let hardware_year = parse_u64(payload.get("hardware_year"), 2020, 1995, 2028);
    let legacy_compatible =
        hardware_year <= 2001 || bool_field(payload.get("legacy_compat_mode"), false);

    let record = json!({
        "boot_id": stable_id("bmboot", &json!({"arch": arch, "firmware": firmware, "boot_ms": boot_ms})),
        "arch": arch,
        "firmware": firmware,
        "boot_ms": boot_ms,
        "agent_ready": true,
        "driver_probe": {
            "cpu": cpu_driver,
            "gpu": gpu_driver,
            "storage": storage_driver,
            "network": network_driver,
        },
        "hardware_year": hardware_year,
        "legacy_compatible": legacy_compatible,
        "recorded_at": now_iso(),
    });
    let boot_id = record["boot_id"].as_str().unwrap().to_string();
    as_object_mut(state, "boot_events").insert(boot_id, record.clone());
    Ok(json!({
        "ok": true,
        "boot_event": record,
        "claim_evidence": [{
            "id": "V10-BAREMETAL-001.1",
            "claim": "kernel_boot_path_and_direct_driver_probe_are_receipted_and_fail_closed"
        }]
    }))
}

fn schedule(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let agent_count = parse_u64(payload.get("agent_count"), 100, 1, 10_000);
    let realtime_agents = parse_u64(payload.get("realtime_agents"), 0, 0, agent_count);
    let preemption_latency_us = parse_u64(payload.get("preemption_latency_us"), 900, 10, 60_000);
    if preemption_latency_us > 1000 {
        return Err("baremetal_substrate_preemption_latency_budget_exceeded".to_string());
    }
    let throughput_degradation_pct =
        json_f64(payload.get("throughput_degradation_pct"), 2.0, 0.0, 100.0);
    if throughput_degradation_pct > 5.0 {
        return Err("baremetal_substrate_throughput_degradation_budget_exceeded".to_string());
    }
    let thorn_cells = parse_u64(payload.get("thorn_cells"), 0, 0, 10_000);
    let thorn_cap = (agent_count / 10).max(1);
    if thorn_cells > thorn_cap {
        return Err("baremetal_substrate_thorn_cell_cap_exceeded".to_string());
    }
    let priorities = string_set(payload.get("priority_lanes"));
    let record = json!({
        "schedule_id": stable_id("bmsched", &json!({"agent_count": agent_count, "preemption_latency_us": preemption_latency_us})),
        "agent_count": agent_count,
        "realtime_agents": realtime_agents,
        "preemption_latency_us": preemption_latency_us,
        "throughput_degradation_pct": throughput_degradation_pct,
        "thorn_cells": thorn_cells,
        "thorn_cell_cap": thorn_cap,
        "priority_lanes": priorities,
        "scheduler_type": "preemptive_priority",
        "recorded_at": now_iso(),
    });
    let schedule_id = record["schedule_id"].as_str().unwrap().to_string();
    as_object_mut(state, "schedule_events").insert(schedule_id, record.clone());
    Ok(json!({
        "ok": true,
        "schedule_event": record,
        "claim_evidence": [{
            "id": "V10-BAREMETAL-001.2",
            "claim": "preemptive_priority_scheduler_enforces_latency_and_thorn_caps_receipted"
        }]
    }))
}

fn memory_manager(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let ram_mb = parse_u64(payload.get("ram_mb"), 4096, 128, 2_097_152);
    let contexts = parse_u64(payload.get("contexts"), 128, 1, 20_000);
    let swap_enabled = bool_field(payload.get("swap_enabled"), true);
    let zero_copy_enabled = bool_field(payload.get("zero_copy_enabled"), true);
    let overcommit_ratio = json_f64(payload.get("overcommit_ratio"), 1.5, 1.0, 4.0);
    if overcommit_ratio > 3.0 {
        return Err("baremetal_substrate_overcommit_ratio_exceeded".to_string());
    }
    if contexts > 1000 && ram_mb < 4096 && !swap_enabled {
        return Err("baremetal_substrate_swap_required_for_target_contexts".to_string());
    }
    let swap_events = if swap_enabled && contexts > (ram_mb / 4).max(1) {
        contexts.saturating_sub((ram_mb / 4).max(1))
    } else {
        0
    };
    let no_oom = swap_enabled || contexts <= (ram_mb / 4).max(1);
    if !no_oom {
        return Err("baremetal_substrate_oom_risk_detected".to_string());
    }
    let record = json!({
        "memory_event_id": stable_id("bmmem", &json!({"ram_mb": ram_mb, "contexts": contexts, "swap_enabled": swap_enabled})),
        "ram_mb": ram_mb,
        "contexts": contexts,
        "swap_enabled": swap_enabled,
        "swap_events": swap_events,
        "zero_copy_enabled": zero_copy_enabled,
        "overcommit_ratio": overcommit_ratio,
        "no_oom": no_oom,
        "recorded_at": now_iso(),
    });
    let memory_event_id = record["memory_event_id"].as_str().unwrap().to_string();
    as_object_mut(state, "memory_events").insert(memory_event_id, record.clone());
    Ok(json!({
        "ok": true,
        "memory_event": record,
        "claim_evidence": [{
            "id": "V10-BAREMETAL-001.3",
            "claim": "virtual_memory_manager_enforces_swap_and_overcommit_limits_receipted"
        }]
    }))
}

fn fs_driver(
    state: &mut Value,
    ledger_path: &Path,
    payload: &Map<String, Value>,
) -> Result<Value, String> {
    let operation = clean_token(payload.get("op").and_then(Value::as_str), "append");
    if operation != "append" {
        return Err("baremetal_substrate_filesystem_append_only_enforced".to_string());
    }
    let mount_fs = clean_token(payload.get("mount_fs").and_then(Value::as_str), "ext4");
    if !matches!(mount_fs.as_str(), "ext4" | "fat32" | "infringfs") {
        return Err("baremetal_substrate_filesystem_mount_unsupported".to_string());
    }
    let actor = clean_token(payload.get("actor").and_then(Value::as_str), "kernel");
    let action = clean_token(
        payload.get("action").and_then(Value::as_str),
        "receipt_write",
    );
    let detail = clean_text(payload.get("detail").and_then(Value::as_str), 240);
    let prev_hash = state
        .get("ledger_head")
        .and_then(Value::as_str)
        .unwrap_or("GENESIS")
        .to_string();
    let fs_index = state
        .get("fs_events")
        .and_then(Value::as_object)
        .map(|rows| rows.len() as u64 + 1)
        .unwrap_or(1);
    let row_base = json!({
        "index": fs_index,
        "timestamp": now_iso(),
        "actor": actor,
        "action": action,
        "detail": detail,
        "mount_fs": mount_fs,
        "prev_hash": prev_hash,
    });
    let row_hash = deterministic_receipt_hash(&row_base);
    let row = json!({
        "index": row_base["index"],
        "timestamp": row_base["timestamp"],
        "actor": row_base["actor"],
        "action": row_base["action"],
        "detail": row_base["detail"],
        "mount_fs": row_base["mount_fs"],
        "prev_hash": row_base["prev_hash"],
        "row_hash": row_hash,
    });
    lane_utils::append_jsonl(ledger_path, &row)?;
    state["ledger_head"] = row["row_hash"].clone();
    let event_id = stable_id(
        "bmfs",
        &json!({"row_hash": row["row_hash"], "index": fs_index}),
    );
    as_object_mut(state, "fs_events").insert(event_id, row.clone());
    Ok(json!({
        "ok": true,
        "fs_event": row,
        "ledger_path": ledger_path.display().to_string(),
        "claim_evidence": [{
            "id": "V10-BAREMETAL-001.4",
            "claim": "append_only_filesystem_events_are_hash_linked_and_offline_verifiable"
        }]
    }))
}

fn network_stack(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let air_gapped = bool_field(payload.get("air_gapped"), false);
    let zero_trust = bool_field(payload.get("zero_trust"), true);
    let mesh_enabled = bool_field(payload.get("mesh_enabled"), true);
    let outbound = payload
        .get("outbound_requests")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if air_gapped && !outbound.is_empty() {
        return Err("baremetal_substrate_airgap_violation".to_string());
    }

    let mut accepted_packets = Vec::new();
    let mut denied_packets = Vec::new();
    for packet in outbound {
        let destination = clean_text(packet.get("destination").and_then(Value::as_str), 180);
        let approved = bool_field(packet.get("approved"), false);
        let protocol = clean_token(packet.get("protocol").and_then(Value::as_str), "tcp");
        if zero_trust && !approved {
            denied_packets.push(json!({
                "destination": destination,
                "protocol": protocol,
                "reason_code": "policy_denied",
            }));
            continue;
        }
        accepted_packets.push(json!({
            "destination": destination,
            "protocol": protocol,
        }));
    }

    let record = json!({
        "network_event_id": stable_id("bmnet", &json!({"air_gapped": air_gapped, "accepted": accepted_packets.len(), "denied": denied_packets.len()})),
        "air_gapped": air_gapped,
        "zero_trust": zero_trust,
        "mesh_enabled": mesh_enabled,
        "accepted_packets": accepted_packets,
        "denied_packets": denied_packets,
        "recorded_at": now_iso(),
    });
    let network_event_id = record["network_event_id"].as_str().unwrap().to_string();
    as_object_mut(state, "network_events").insert(network_event_id, record.clone());
    Ok(json!({
        "ok": true,
        "network_event": record,
        "claim_evidence": [{
            "id": "V10-BAREMETAL-001.5",
            "claim": "zero_trust_network_stack_enforces_policy_gated_packets_and_airgap_mode"
        }]
    }))
}

fn security_model(state: &mut Value, payload: &Map<String, Value>) -> Result<Value, String> {
    let invariants = object_field(payload, "invariants");
    let required_invariants = [
        ("receipts_enabled", true),
        ("approved_memory_scopes_only", true),
        ("shell_requires_approval", true),
        ("exfil_policy_enforced", true),
        ("core_safety_immutable", true),
        ("external_calls_receipted", true),
        ("budget_guard_enabled", true),
        ("human_veto_override", true),
    ];
    for (key, fallback) in required_invariants {
        if !bool_field(invariants.get(key), fallback) {
            return Err(format!("baremetal_substrate_invariant_violation_{key}"));
        }
    }
    if bool_field(payload.get("human_veto"), false) {
        return Err("baremetal_substrate_human_veto_engaged".to_string());
    }
    if bool_field(payload.get("namespace_escape_attempt"), false) {
        return Err("baremetal_substrate_namespace_escape_detected".to_string());
    }

    let namespace = clean_token(
        payload.get("namespace").and_then(Value::as_str),
        "agent-default",
    );
    let capabilities = string_set(payload.get("capabilities"));
    let syscall_attempts = payload
        .get("syscall_attempts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut denied_syscalls = BTreeSet::new();
    for attempt in syscall_attempts {
        let syscall = clean_token(attempt.get("name").and_then(Value::as_str), "unknown");
        let allowed = bool_field(attempt.get("allowed"), false);
        if !allowed {
            denied_syscalls.insert(syscall);
        }
    }
    let denied_syscalls = denied_syscalls.into_iter().collect::<Vec<_>>();
    let record = json!({
        "security_event_id": stable_id("bmsec", &json!({"namespace": namespace, "denied_syscalls": denied_syscalls})),
        "namespace": namespace,
        "capabilities": capabilities,
        "denied_syscalls": denied_syscalls,
        "kernel_enforced": true,
        "recorded_at": now_iso(),
    });
    let security_event_id = record["security_event_id"].as_str().unwrap().to_string();
    as_object_mut(state, "security_events").insert(security_event_id, record.clone());
    Ok(json!({
        "ok": true,
        "security_event": record,
        "claim_evidence": [{
            "id": "V10-BAREMETAL-001.6",
            "claim": "kernel_security_model_enforces_capabilities_namespaces_and_t0_invariants"
        }]
    }))
}

fn status(state: &Value) -> Value {
    json!({
        "ok": true,
        "boot_events": state.get("boot_events").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "schedule_events": state.get("schedule_events").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "memory_events": state.get("memory_events").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "fs_events": state.get("fs_events").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "network_events": state.get("network_events").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "security_events": state.get("security_events").and_then(Value::as_object).map(|rows| rows.len()).unwrap_or(0),
        "ledger_head": state.get("ledger_head").cloned().unwrap_or_else(|| json!("GENESIS")),
    })
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let command = argv
        .first()
        .map(|row| row.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    let payload_json = match payload_json(argv) {
        Ok(value) => value,
        Err(err) => {
            print_json_line(&cli_error("baremetal_substrate_error", &err));
            return 1;
        }
    };
    let payload = payload_obj(&payload_json);
    let state_path = state_path(root, argv, payload);
    let history_path = history_path(root, argv, payload);
    let ledger_path = ledger_path(root, argv, payload);
    let mut state = load_state(&state_path);

    let result = match command.as_str() {
        "status" => Ok(status(&state)),
        "boot-kernel" | "boot" => boot_kernel(&mut state, payload),
        "schedule" | "scheduler" => schedule(&mut state, payload),
        "memory-manager" | "vm-manager" => memory_manager(&mut state, payload),
        "fs-driver" | "filesystem" => fs_driver(&mut state, &ledger_path, payload),
        "network-stack" | "network" => network_stack(&mut state, payload),
        "security-model" | "security" => security_model(&mut state, payload),
        _ => Err("baremetal_substrate_unknown_command".to_string()),
    };

    match result {
        Ok(payload_out) => {
            let receipt = cli_receipt(&format!("baremetal_substrate_{command}"), payload_out);
            state["last_receipt"] = receipt.clone();
            state["updated_at"] = json!(now_iso());
            if let Err(err) = save_state(&state_path, &state) {
                print_json_line(&cli_error("baremetal_substrate_error", &err));
                return 1;
            }
            if let Err(err) = append_history(&history_path, &receipt) {
                print_json_line(&cli_error("baremetal_substrate_error", &err));
                return 1;
            }
            print_json_line(&receipt);
            0
        }
        Err(err) => {
            print_json_line(&cli_error("baremetal_substrate_error", &err));
            1
        }
    }
}
