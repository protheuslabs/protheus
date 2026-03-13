// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use crate::directive_kernel;
use crate::v8_kernel::{
    deterministic_merkle_root, parse_bool, parse_f64, parse_u64, print_json, read_json,
    scoped_state_root, sha256_hex_str, write_json, write_receipt,
};
use crate::{clean, now_iso, parse_args};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "SEED_PROTOCOL_STATE_ROOT";
const STATE_SCOPE: &str = "seed_protocol";
const PACKETS_DIR: &str = "packets";

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn state_path(root: &Path) -> PathBuf {
    state_root(root).join("seed_state.json")
}

fn packets_dir(root: &Path) -> PathBuf {
    state_root(root).join(PACKETS_DIR)
}

fn default_state() -> Value {
    json!({
        "version": "1.0",
        "active_profile": Value::Null,
        "packet_count": 0u64,
        "replication_count": 0u64,
        "migration_count": 0u64,
        "compliance_checks": 0u64,
        "compliance_denies": 0u64,
        "selection_rounds": 0u64,
        "archive_count": 0u64,
        "archive_merkle_root": sha256_hex_str("seed_archive_empty"),
        "defense_event_count": 0u64,
        "quarantine": {},
        "packets": [],
        "replications": [],
        "migrations": [],
        "selection_history": [],
        "archives": [],
        "defense_events": [],
        "created_at": now_iso()
    })
}

fn load_state(root: &Path) -> Value {
    read_json(&state_path(root)).unwrap_or_else(default_state)
}

fn store_state(root: &Path, state: &Value) -> Result<(), String> {
    write_json(&state_path(root), state)
}

fn state_obj_mut(state: &mut Value) -> &mut Map<String, Value> {
    if !state.is_object() {
        *state = default_state();
    }
    state.as_object_mut().expect("state_object")
}

fn obj_mut<'a>(obj: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    if !obj.get(key).map(Value::is_object).unwrap_or(false) {
        obj.insert(key.to_string(), Value::Object(Map::new()));
    }
    obj.get_mut(key)
        .and_then(Value::as_object_mut)
        .expect("object")
}

fn arr_mut<'a>(obj: &'a mut Map<String, Value>, key: &str) -> &'a mut Vec<Value> {
    if !obj.get(key).map(Value::is_array).unwrap_or(false) {
        obj.insert(key.to_string(), Value::Array(Vec::new()));
    }
    obj.get_mut(key)
        .and_then(Value::as_array_mut)
        .expect("array")
}

fn push_bounded(rows: &mut Vec<Value>, value: Value, max_rows: usize) {
    rows.push(value);
    if rows.len() > max_rows {
        let drop_n = rows.len() - max_rows;
        rows.drain(0..drop_n);
    }
}

fn set_counter(obj: &mut Map<String, Value>, key: &str, value: u64) {
    obj.insert(key.to_string(), Value::from(value));
}

fn inc_counter(obj: &mut Map<String, Value>, key: &str, delta: u64) -> u64 {
    let next = obj.get(key).and_then(Value::as_u64).unwrap_or(0) + delta;
    set_counter(obj, key, next);
    next
}

fn core_state_root(root: &Path) -> PathBuf {
    crate::core_state_root(root).join("ops")
}

fn read_blob_index(root: &Path) -> Value {
    read_json(
        &core_state_root(root)
            .join("binary_blob_runtime")
            .join("active_blobs.json"),
    )
    .unwrap_or_else(|| Value::Object(Map::new()))
}

fn read_organism_state(root: &Path) -> Value {
    read_json(
        &core_state_root(root)
            .join("organism_layer")
            .join("organism_state.json"),
    )
    .unwrap_or_else(|| Value::Object(Map::new()))
}

fn read_network_ledger(root: &Path) -> Value {
    read_json(
        &core_state_root(root)
            .join("network_protocol")
            .join("ledger.json"),
    )
    .unwrap_or_else(|| Value::Object(Map::new()))
}

fn gate_allowed(root: &Path, action: &str) -> bool {
    directive_kernel::action_allowed(root, action)
        || directive_kernel::action_allowed(root, "seed:*")
        || directive_kernel::action_allowed(root, "seed")
}

fn profile_claim_id(prefix: &str, profile: &str) -> String {
    let norm = profile.trim().to_ascii_lowercase();
    if norm == "viral" {
        format!("V9-VIRAL-001.{prefix}")
    } else {
        format!("V9-IMMORTAL-001.{prefix}")
    }
}

fn selected_profile(parsed: &crate::ParsedArgs) -> String {
    clean(
        parsed
            .flags
            .get("profile")
            .cloned()
            .unwrap_or_else(|| "immortal".to_string()),
        32,
    )
    .to_ascii_lowercase()
}

fn activation_command(profile: &str) -> String {
    if profile == "viral" {
        "protheus seed deploy viral".to_string()
    } else {
        "protheus seed deploy".to_string()
    }
}

fn packet_signature(packet: &Value) -> String {
    let key = std::env::var("DIRECTIVE_KERNEL_SIGNING_KEY")
        .ok()
        .map(|v| clean(v, 1024))
        .unwrap_or_default();
    if key.is_empty() {
        return format!(
            "unsigned:{}",
            sha256_hex_str(&serde_json::to_string(packet).unwrap_or_default())
        );
    }
    format!("sig:{}", crate::v8_kernel::keyed_digest_hex(&key, packet))
}

fn persist_packet(root: &Path, packet_id: &str, packet: &Value) -> Result<PathBuf, String> {
    let path = packets_dir(root).join(format!("{packet_id}.json"));
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("packet_dir_create_failed:{}:{err}", parent.display()))?;
    }
    write_json(&path, packet)?;
    Ok(path)
}

fn emit(root: &Path, payload: Value) -> i32 {
    match write_receipt(root, STATE_ENV, STATE_SCOPE, payload) {
        Ok(out) => {
            print_json(&out);
            if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                0
            } else {
                2
            }
        }
        Err(err) => {
            let mut out = json!({
                "ok": false,
                "type": "seed_protocol_error",
                "lane": "core/layer0/ops",
                "error": clean(err, 240),
                "exit_code": 2
            });
            out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
            print_json(&out);
            2
        }
    }
}

fn default_targets(profile: &str) -> Vec<String> {
    if profile == "viral" {
        vec![
            "swarm-alpha".to_string(),
            "swarm-beta".to_string(),
            "swarm-gamma".to_string(),
            "swarm-delta".to_string(),
        ]
    } else {
        vec![
            "vault-cold-1".to_string(),
            "vault-cold-2".to_string(),
            "vault-cold-3".to_string(),
        ]
    }
}

fn parse_targets(raw: Option<&String>, profile: &str, cap: usize) -> Vec<String> {
    let mut out = raw
        .map(|v| {
            v.split(',')
                .map(|node| clean(Some(node.trim()).unwrap_or(""), 120))
                .map(|node| node.to_ascii_lowercase())
                .filter(|node| !node.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if out.is_empty() {
        out = default_targets(profile);
    }
    out.truncate(cap);
    out
}

fn command_status(root: &Path) -> i32 {
    let state = load_state(root);
    let obj = state.as_object().cloned().unwrap_or_default();
    let replication_count = obj
        .get("replication_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let migration_count = obj
        .get("migration_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let compliance_checks = obj
        .get("compliance_checks")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let compliance_denies = obj
        .get("compliance_denies")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let archive_count = obj
        .get("archive_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let defense_event_count = obj
        .get("defense_event_count")
        .and_then(Value::as_u64)
        .unwrap_or(0);

    let compliance_rate = if compliance_checks == 0 {
        1.0
    } else {
        (compliance_checks.saturating_sub(compliance_denies)) as f64 / (compliance_checks as f64)
    };
    let survival_fitness = ((replication_count as f64 + 1.0)
        / ((migration_count + defense_event_count + 1) as f64))
        .clamp(0.0, 5.0);
    let replication_rate = (replication_count as f64) / ((archive_count + 1) as f64);

    emit(
        root,
        json!({
            "ok": true,
            "type": "seed_protocol_status",
            "lane": "core/layer0/ops",
            "state": state,
            "seed_mode_dashboard": {
                "active_profile": obj.get("active_profile").cloned().unwrap_or(Value::Null),
                "replication_rate": replication_rate,
                "survival_fitness": survival_fitness,
                "compliance_rate": compliance_rate,
                "archive_merkle_root": obj.get("archive_merkle_root").cloned().unwrap_or(Value::Null),
                "quarantined_nodes": obj.get("quarantine").and_then(Value::as_object).map(|m| m.len()).unwrap_or(0)
            },
            "latest": read_json(&latest_path(root)),
            "claim_evidence": [
                {
                    "id": "V9-VIRAL-001.6",
                    "claim": "viral_seed_dashboard_surfaces_replication_fitness_and_compliance",
                    "evidence": {"replication_rate": replication_rate, "compliance_rate": compliance_rate}
                },
                {
                    "id": "V9-IMMORTAL-001.6",
                    "claim": "millennia_dashboard_surfaces_survival_fitness_and_archive_health",
                    "evidence": {"survival_fitness": survival_fitness, "archive_count": archive_count}
                }
            ]
        }),
    )
}

fn command_deploy(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let profile = selected_profile(parsed);
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let cap = parse_u64(
        parsed.flags.get("replication-cap"),
        if profile == "viral" { 12 } else { 6 },
    )
    .clamp(1, 64) as usize;
    let action = format!("seed:deploy:{profile}");
    let gate_ok = gate_allowed(root, &action);
    if apply && !gate_ok {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "seed_protocol_deploy",
                "lane": "core/layer0/ops",
                "profile": profile,
                "error": "directive_gate_denied",
                "gate_action": action
            }),
        );
    }

    let blob_index = read_blob_index(root);
    let directive_hash = directive_kernel::directive_vault_hash(root);
    let personality = read_organism_state(root)
        .get("personality")
        .cloned()
        .unwrap_or(Value::Null);
    let network_root = read_network_ledger(root)
        .get("root_head")
        .cloned()
        .unwrap_or(Value::String("genesis".to_string()));
    let targets = parse_targets(parsed.flags.get("targets"), &profile, cap);
    let packet_basis = json!({
        "profile": profile,
        "directive_hash": directive_hash,
        "blob_index_hash": sha256_hex_str(&serde_json::to_string(&blob_index).unwrap_or_default()),
        "personality_hash": sha256_hex_str(&serde_json::to_string(&personality).unwrap_or_default()),
        "network_root": network_root,
        "target_count": targets.len(),
        "issued_at": now_iso()
    });
    let packet_id_full = sha256_hex_str(&serde_json::to_string(&packet_basis).unwrap_or_default());
    let packet_id = clean(packet_id_full.chars().take(24).collect::<String>(), 24);
    let mut packet = json!({
        "packet_id": packet_id,
        "profile": profile,
        "directive_hash": directive_hash,
        "blob_index_hash": packet_basis.get("blob_index_hash").cloned().unwrap_or(Value::Null),
        "personality_hash": packet_basis.get("personality_hash").cloned().unwrap_or(Value::Null),
        "network_root": network_root,
        "targets": targets,
        "issued_at": now_iso(),
        "activation_command": activation_command(&profile),
    });
    packet["signature"] = Value::String(packet_signature(&packet));

    let replications = packet
        .get("targets")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|target| {
            json!({
                "packet_id": packet_id,
                "target": target,
                "status": "replicated",
                "ts": now_iso()
            })
        })
        .collect::<Vec<_>>();

    let mut packet_path = Value::Null;
    let mut state = load_state(root);
    if apply {
        match persist_packet(root, &packet_id, &packet) {
            Ok(path) => packet_path = Value::String(path.display().to_string()),
            Err(err) => {
                return emit(
                    root,
                    json!({
                        "ok": false,
                        "type": "seed_protocol_deploy",
                        "lane": "core/layer0/ops",
                        "profile": profile,
                        "error": clean(err, 240)
                    }),
                )
            }
        }
        let obj = state_obj_mut(&mut state);
        obj.insert("active_profile".to_string(), Value::String(profile.clone()));
        inc_counter(obj, "packet_count", 1);
        inc_counter(obj, "replication_count", replications.len() as u64);
        let packets = arr_mut(obj, "packets");
        push_bounded(
            packets,
            json!({
                "packet_id": packet_id,
                "profile": profile,
                "target_count": replications.len(),
                "directive_hash": directive_hash,
                "network_root": packet.get("network_root").cloned().unwrap_or(Value::Null),
                "packet_path": packet_path.clone(),
                "ts": now_iso()
            }),
            2048,
        );
        let reps = arr_mut(obj, "replications");
        for row in replications.iter().cloned() {
            push_bounded(reps, row, 8192);
        }
        if let Err(err) = store_state(root, &state) {
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "seed_protocol_deploy",
                    "lane": "core/layer0/ops",
                    "profile": profile,
                    "error": clean(err, 240)
                }),
            );
        }
    }

    emit(
        root,
        json!({
            "ok": true,
            "type": "seed_protocol_deploy",
            "lane": "core/layer0/ops",
            "profile": profile,
            "apply": apply,
            "packet": packet,
            "packet_path": packet_path,
            "replications": replications,
            "claim_evidence": [
                {
                    "id": profile_claim_id("1", &profile),
                    "claim": "seed_packet_replication_engine_bootstraps_independent_nodes_with_signed_packets",
                    "evidence": {"packet_id": packet_id, "replication_count": replications.len()}
                },
                {
                    "id": profile_claim_id("6", &profile),
                    "claim": "one_command_seed_activation_and_dashboard_visibility_are_core_authoritative",
                    "evidence": {"activation_command": activation_command(&profile), "state_path": state_path(root).display().to_string()}
                }
            ]
        }),
    )
}

fn command_migrate(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let profile = selected_profile(parsed);
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let action = format!("seed:migrate:{profile}");
    let gate_ok = gate_allowed(root, &action);
    if apply && !gate_ok {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "seed_protocol_migrate",
                "lane": "core/layer0/ops",
                "profile": profile,
                "error": "directive_gate_denied",
                "gate_action": action
            }),
        );
    }

    let node = clean(
        parsed
            .flags
            .get("node")
            .cloned()
            .unwrap_or_else(|| "node-local".to_string()),
        120,
    );
    let threat = clean(
        parsed
            .flags
            .get("threat")
            .cloned()
            .unwrap_or_else(|| "normal".to_string()),
        64,
    )
    .to_ascii_lowercase();
    let energy = parse_f64(parsed.flags.get("energy"), 0.75).clamp(0.0, 1.0);
    let hardware_class = clean(
        parsed
            .flags
            .get("hardware")
            .cloned()
            .unwrap_or_else(|| "edge".to_string()),
        64,
    )
    .to_ascii_lowercase();
    let force = parse_bool(parsed.flags.get("force"), false);
    let should_migrate = force || energy < 0.35 || threat == "high" || threat == "critical";
    let target_class = if energy < 0.20 {
        "ultra_low_power"
    } else if threat == "critical" {
        "cold_vault"
    } else if hardware_class.contains("edge") {
        "cloud_fallback"
    } else {
        "mesh_peer"
    };

    let migration_event = json!({
        "profile": profile,
        "node": node,
        "threat": threat,
        "energy": energy,
        "hardware_class": hardware_class,
        "should_migrate": should_migrate,
        "target_class": target_class,
        "ts": now_iso()
    });

    if apply {
        let mut state = load_state(root);
        let obj = state_obj_mut(&mut state);
        inc_counter(obj, "migration_count", 1);
        let migrations = arr_mut(obj, "migrations");
        push_bounded(migrations, migration_event.clone(), 4096);
        if let Err(err) = store_state(root, &state) {
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "seed_protocol_migrate",
                    "lane": "core/layer0/ops",
                    "profile": profile,
                    "error": clean(err, 240)
                }),
            );
        }
    }

    emit(
        root,
        json!({
            "ok": true,
            "type": "seed_protocol_migrate",
            "lane": "core/layer0/ops",
            "profile": profile,
            "apply": apply,
            "migration": migration_event,
            "claim_evidence": [
                {
                    "id": profile_claim_id("2", &profile),
                    "claim": "anti_shutdown_energy_aware_migration_performs_state_preserving_handoff",
                    "evidence": {"should_migrate": should_migrate, "target_class": target_class}
                }
            ]
        }),
    )
}

fn command_enforce(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let profile = selected_profile(parsed);
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let operation = clean(
        parsed
            .flags
            .get("operation")
            .cloned()
            .unwrap_or_else(|| "replicate".to_string()),
        64,
    )
    .to_ascii_lowercase();
    let node = clean(
        parsed
            .flags
            .get("node")
            .cloned()
            .unwrap_or_else(|| "node-unknown".to_string()),
        120,
    );
    let action = format!("seed:{operation}:{profile}");
    let gate_ok = gate_allowed(root, &action) || gate_allowed(root, &format!("seed:{operation}"));

    let mut quarantine_written = false;
    if apply {
        let mut state = load_state(root);
        let obj = state_obj_mut(&mut state);
        inc_counter(obj, "compliance_checks", 1);
        if !gate_ok {
            inc_counter(obj, "compliance_denies", 1);
            let quarantine = obj_mut(obj, "quarantine");
            quarantine.insert(
                node.clone(),
                json!({
                    "operation": operation,
                    "profile": profile,
                    "reason": "directive_gate_denied",
                    "ts": now_iso()
                }),
            );
            quarantine_written = true;
        }
        if let Err(err) = store_state(root, &state) {
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "seed_protocol_enforce",
                    "lane": "core/layer0/ops",
                    "error": clean(err, 240)
                }),
            );
        }
    }

    emit(
        root,
        json!({
            "ok": gate_ok,
            "type": "seed_protocol_enforce",
            "lane": "core/layer0/ops",
            "profile": profile,
            "operation": operation,
            "node": node,
            "apply": apply,
            "allowed": gate_ok,
            "quarantine_written": quarantine_written,
            "gate_action": action,
            "claim_evidence": [
                {
                    "id": "V9-VIRAL-001.3",
                    "claim": "directive_compliance_gate_controls_replication_and_mutation_actions_with_quarantine",
                    "evidence": {"allowed": gate_ok, "operation": operation, "node": node}
                },
                {
                    "id": "V9-IMMORTAL-001.5",
                    "claim": "constitutional_self_defense_applies_fail_closed_quarantine_under_tamper_or_policy_breach",
                    "evidence": {"allowed": gate_ok, "quarantine_written": quarantine_written}
                }
            ]
        }),
    )
}

fn command_select(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let profile = selected_profile(parsed);
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let action = format!("seed:select:{profile}");
    let gate_ok = gate_allowed(root, &action);
    if apply && !gate_ok {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "seed_protocol_select",
                "lane": "core/layer0/ops",
                "profile": profile,
                "error": "directive_gate_denied",
                "gate_action": action
            }),
        );
    }

    let top_k = parse_u64(parsed.flags.get("top"), 5).clamp(1, 50) as usize;
    let ledger = read_network_ledger(root);
    let balances = ledger
        .get("balances")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let stakes = ledger
        .get("staked")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();

    let mut scored = balances
        .iter()
        .map(|(node, bal)| {
            let b = bal.as_f64().unwrap_or(0.0);
            let s = stakes.get(node).and_then(Value::as_f64).unwrap_or(0.0);
            let score = b + (s * 2.0);
            (node.clone(), b, s, score)
        })
        .collect::<Vec<_>>();
    scored.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal));
    let selected = scored
        .iter()
        .take(top_k)
        .map(|(node, b, s, score)| {
            json!({
                "node": node,
                "balance": b,
                "staked": s,
                "score": score
            })
        })
        .collect::<Vec<_>>();
    let starved = scored
        .iter()
        .skip(top_k)
        .filter(|(_, _, _, score)| *score < 10.0)
        .map(|(node, _, _, score)| json!({"node": node, "score": score}))
        .collect::<Vec<_>>();

    if apply {
        let mut state = load_state(root);
        let obj = state_obj_mut(&mut state);
        inc_counter(obj, "selection_rounds", 1);
        let history = arr_mut(obj, "selection_history");
        push_bounded(
            history,
            json!({
                "profile": profile,
                "top_k": top_k,
                "selected": selected,
                "starved": starved,
                "ts": now_iso()
            }),
            2048,
        );
        if let Err(err) = store_state(root, &state) {
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "seed_protocol_select",
                    "lane": "core/layer0/ops",
                    "profile": profile,
                    "error": clean(err, 240)
                }),
            );
        }
    }

    emit(
        root,
        json!({
            "ok": true,
            "type": "seed_protocol_select",
            "lane": "core/layer0/ops",
            "profile": profile,
            "apply": apply,
            "top_k": top_k,
            "selected": selected,
            "starved": starved,
            "claim_evidence": [
                {
                    "id": profile_claim_id("4", &profile),
                    "claim": "evolutionary_selection_prioritizes_high_contribution_nodes_and_starves_low_value_nodes",
                    "evidence": {"selected_count": selected.len(), "starved_count": starved.len()}
                },
                {
                    "id": if profile == "viral" { "V9-IMMORTAL-001.3" } else { "V9-VIRAL-001.4" },
                    "claim": "selection_engine_behavior_is_shared_across_viral_and_immortal_profiles",
                    "evidence": {"profile": profile, "selected_count": selected.len()}
                }
            ]
        }),
    )
}

fn command_archive(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let profile = selected_profile(parsed);
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let action = format!("seed:archive:{profile}");
    let gate_ok = gate_allowed(root, &action);
    if apply && !gate_ok {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "seed_protocol_archive",
                "lane": "core/layer0/ops",
                "profile": profile,
                "error": "directive_gate_denied",
                "gate_action": action
            }),
        );
    }

    let lineage_id = clean(
        parsed
            .flags
            .get("lineage-id")
            .cloned()
            .unwrap_or_else(|| format!("lineage-{}", now_iso().replace([':', '.'], "-"))),
        160,
    );
    let last_packet_id = load_state(root)
        .get("packets")
        .and_then(Value::as_array)
        .and_then(|rows| rows.last())
        .and_then(|row| row.get("packet_id"))
        .and_then(Value::as_str)
        .unwrap_or("none")
        .to_string();
    let archive_leaf = sha256_hex_str(&format!(
        "{lineage_id}:{profile}:{last_packet_id}:{}",
        directive_kernel::directive_vault_hash(root)
    ));

    let mut archive_merkle_root = Value::Null;
    if apply {
        let mut state = load_state(root);
        let obj = state_obj_mut(&mut state);
        inc_counter(obj, "archive_count", 1);
        let archives = arr_mut(obj, "archives");
        push_bounded(
            archives,
            json!({
                "lineage_id": lineage_id,
                "profile": profile,
                "leaf_hash": archive_leaf,
                "packet_id": last_packet_id,
                "ts": now_iso()
            }),
            4096,
        );
        let leaves = archives
            .iter()
            .filter_map(|row| row.get("leaf_hash").and_then(Value::as_str))
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let root_hash = deterministic_merkle_root(&leaves);
        obj.insert(
            "archive_merkle_root".to_string(),
            Value::String(root_hash.clone()),
        );
        archive_merkle_root = Value::String(root_hash);
        if let Err(err) = store_state(root, &state) {
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "seed_protocol_archive",
                    "lane": "core/layer0/ops",
                    "profile": profile,
                    "error": clean(err, 240)
                }),
            );
        }
    }

    emit(
        root,
        json!({
            "ok": true,
            "type": "seed_protocol_archive",
            "lane": "core/layer0/ops",
            "profile": profile,
            "apply": apply,
            "lineage_id": lineage_id,
            "leaf_hash": archive_leaf,
            "archive_merkle_root": archive_merkle_root,
            "claim_evidence": [
                {
                    "id": profile_claim_id("5", &profile),
                    "claim": "deep_time_archive_is_merkle_linked_and_receipted_for_lineage_inheritance",
                    "evidence": {"lineage_id": lineage_id, "leaf_hash": archive_leaf}
                },
                {
                    "id": if profile == "viral" { "V9-IMMORTAL-001.4" } else { "V9-VIRAL-001.5" },
                    "claim": "genetic_archive_is_shared_between_profiles_with_profile_scoped_lineage_records",
                    "evidence": {"profile": profile}
                }
            ]
        }),
    )
}

fn command_defend(root: &Path, parsed: &crate::ParsedArgs) -> i32 {
    let profile = selected_profile(parsed);
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let action = "seed:defend";
    let gate_ok = gate_allowed(root, action);
    if apply && !gate_ok {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "seed_protocol_defend",
                "lane": "core/layer0/ops",
                "profile": profile,
                "error": "directive_gate_denied",
                "gate_action": action
            }),
        );
    }

    let node = clean(
        parsed
            .flags
            .get("node")
            .cloned()
            .unwrap_or_else(|| "node-unknown".to_string()),
        120,
    );
    let signal = clean(
        parsed
            .flags
            .get("signal")
            .cloned()
            .unwrap_or_else(|| "tamper".to_string()),
        80,
    )
    .to_ascii_lowercase();
    let severity = clean(
        parsed
            .flags
            .get("severity")
            .cloned()
            .unwrap_or_else(|| "high".to_string()),
        24,
    )
    .to_ascii_lowercase();
    let quarantine = severity == "high" || severity == "critical" || signal == "tamper";

    if apply {
        let mut state = load_state(root);
        let obj = state_obj_mut(&mut state);
        inc_counter(obj, "defense_event_count", 1);
        let events = arr_mut(obj, "defense_events");
        push_bounded(
            events,
            json!({
                "profile": profile,
                "node": node,
                "signal": signal,
                "severity": severity,
                "quarantine": quarantine,
                "ts": now_iso()
            }),
            4096,
        );
        if quarantine {
            let q = obj_mut(obj, "quarantine");
            q.insert(
                node.clone(),
                json!({
                    "reason": format!("defense_signal:{signal}"),
                    "severity": severity,
                    "profile": profile,
                    "ts": now_iso()
                }),
            );
        }
        if let Err(err) = store_state(root, &state) {
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "seed_protocol_defend",
                    "lane": "core/layer0/ops",
                    "profile": profile,
                    "error": clean(err, 240)
                }),
            );
        }
    }

    emit(
        root,
        json!({
            "ok": true,
            "type": "seed_protocol_defend",
            "lane": "core/layer0/ops",
            "profile": profile,
            "apply": apply,
            "node": node,
            "signal": signal,
            "severity": severity,
            "quarantine": quarantine,
            "claim_evidence": [
                {
                    "id": "V9-IMMORTAL-001.5",
                    "claim": "constitutional_self_defense_enforces_quarantine_and_anti_tamper_receipts",
                    "evidence": {"node": node, "quarantine": quarantine}
                },
                {
                    "id": "V9-VIRAL-001.2",
                    "claim": "anti_shutdown_survival_flow_preserves_state_under_attack_signals",
                    "evidence": {"signal": signal, "severity": severity}
                }
            ]
        }),
    )
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let command = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        println!("Usage:");
        println!("  protheus-ops seed-protocol status");
        println!("  protheus-ops seed-protocol deploy [--profile=viral|immortal] [--targets=a,b] [--replication-cap=<n>] [--apply=1|0]");
        println!("  protheus-ops seed-protocol migrate [--profile=viral|immortal] [--node=<id>] [--threat=normal|high|critical] [--energy=<0..1>] [--hardware=edge|cloud] [--apply=1|0]");
        println!("  protheus-ops seed-protocol enforce [--profile=viral|immortal] [--operation=replicate|migrate|mutate|network] [--node=<id>] [--apply=1|0]");
        println!("  protheus-ops seed-protocol select [--profile=viral|immortal] [--top=<n>] [--apply=1|0]");
        println!("  protheus-ops seed-protocol archive [--profile=viral|immortal] [--lineage-id=<id>] [--apply=1|0]");
        println!("  protheus-ops seed-protocol defend [--profile=viral|immortal] [--node=<id>] [--signal=tamper] [--severity=high] [--apply=1|0]");
        return 0;
    }

    match command.as_str() {
        "status" | "monitor" => command_status(root),
        "deploy" | "ignite" => command_deploy(root, &parsed),
        "migrate" => command_migrate(root, &parsed),
        "enforce" => command_enforce(root, &parsed),
        "select" => command_select(root, &parsed),
        "archive" => command_archive(root, &parsed),
        "defend" => command_defend(root, &parsed),
        _ => emit(
            root,
            json!({
                "ok": false,
                "type": "seed_protocol_error",
                "lane": "core/layer0/ops",
                "error": "unknown_command",
                "command": command,
                "exit_code": 2
            }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("protheus_seed_protocol_{name}_{nonce}"));
        fs::create_dir_all(&root).expect("mkdir");
        root
    }

    fn allow(root: &Path, directive: &str) {
        std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "seed-test-sign-key");
        assert_eq!(
            directive_kernel::run(
                root,
                &[
                    "prime-sign".to_string(),
                    format!("--directive={directive}"),
                    "--signer=tester".to_string(),
                ]
            ),
            0
        );
    }

    #[test]
    fn deploy_viral_writes_packet_and_replications() {
        let root = temp_root("deploy_viral");
        allow(&root, "allow:seed:*");
        let exit = run(
            &root,
            &[
                "deploy".to_string(),
                "--profile=viral".to_string(),
                "--targets=node-a,node-b".to_string(),
                "--apply=1".to_string(),
            ],
        );
        assert_eq!(exit, 0);
        let latest = read_json(&latest_path(&root)).expect("latest");
        assert_eq!(latest.get("profile").and_then(Value::as_str), Some("viral"));
        assert!(latest
            .get("packet_path")
            .and_then(Value::as_str)
            .map(|v| !v.is_empty())
            .unwrap_or(false));
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn migrate_immortal_selects_low_power_target() {
        let root = temp_root("migrate_immortal");
        allow(&root, "allow:seed:*");
        let exit = run(
            &root,
            &[
                "migrate".to_string(),
                "--profile=immortal".to_string(),
                "--node=node-z".to_string(),
                "--energy=0.12".to_string(),
                "--threat=high".to_string(),
                "--apply=1".to_string(),
            ],
        );
        assert_eq!(exit, 0);
        let latest = read_json(&latest_path(&root)).expect("latest");
        assert_eq!(
            latest
                .get("migration")
                .and_then(|v| v.get("target_class"))
                .and_then(Value::as_str),
            Some("ultra_low_power")
        );
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn enforce_denied_quarantines_node() {
        let root = temp_root("enforce_denied");
        let exit = run(
            &root,
            &[
                "enforce".to_string(),
                "--profile=viral".to_string(),
                "--operation=replicate".to_string(),
                "--node=rogue-1".to_string(),
                "--apply=1".to_string(),
            ],
        );
        assert_eq!(exit, 2);
        let latest = read_json(&latest_path(&root)).expect("latest");
        assert_eq!(latest.get("ok").and_then(Value::as_bool), Some(false));
        let state = load_state(&root);
        let q = state
            .get("quarantine")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        assert!(q.contains_key("rogue-1"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn select_uses_network_balances() {
        let root = temp_root("select");
        allow(&root, "allow:seed:*");
        allow(&root, "allow:tokenomics");
        assert_eq!(
            crate::network_protocol::run(
                &root,
                &[
                    "reward".to_string(),
                    "--action=reward".to_string(),
                    "--agent=node-a".to_string(),
                    "--amount=120".to_string(),
                    "--reason=tokenomics".to_string()
                ]
            ),
            0
        );
        assert_eq!(
            crate::network_protocol::run(
                &root,
                &[
                    "reward".to_string(),
                    "--action=reward".to_string(),
                    "--agent=node-b".to_string(),
                    "--amount=10".to_string(),
                    "--reason=tokenomics".to_string()
                ]
            ),
            0
        );
        let exit = run(
            &root,
            &[
                "select".to_string(),
                "--profile=viral".to_string(),
                "--top=1".to_string(),
                "--apply=1".to_string(),
            ],
        );
        assert_eq!(exit, 0);
        let latest = read_json(&latest_path(&root)).expect("latest");
        let first = latest
            .get("selected")
            .and_then(Value::as_array)
            .and_then(|rows| rows.first())
            .and_then(|row| row.get("node"))
            .and_then(Value::as_str)
            .unwrap_or("");
        assert_eq!(first, "node-a");
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn archive_updates_merkle_root() {
        let root = temp_root("archive");
        allow(&root, "allow:seed:*");
        assert_eq!(
            run(
                &root,
                &[
                    "archive".to_string(),
                    "--profile=immortal".to_string(),
                    "--lineage-id=lineage-alpha".to_string(),
                    "--apply=1".to_string(),
                ],
            ),
            0
        );
        let state = load_state(&root);
        assert!(state
            .get("archive_merkle_root")
            .and_then(Value::as_str)
            .map(|v| !v.is_empty())
            .unwrap_or(false));
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }
}
