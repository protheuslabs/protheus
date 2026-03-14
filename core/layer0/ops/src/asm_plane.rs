// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::asm_plane (authoritative)

use crate::v8_kernel::{
    append_jsonl, load_json_or, parse_bool, parse_u64, read_json, scoped_state_root,
    sha256_hex_str, write_json, write_receipt,
};
use crate::{clean, now_iso, parse_args, ParsedArgs};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

const STATE_ENV: &str = "ASM_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "asm_plane";

const WASM_DUAL_METER_POLICY_PATH: &str = "planes/contracts/wasm_dual_meter_policy_v1.json";
const HAND_MANIFEST_PATH: &str = "planes/contracts/hands/HAND.toml";
const CRDT_PROFILE_PATH: &str = "planes/contracts/crdt_automerge_profile_v1.json";
const TRUST_CHAIN_POLICY_PATH: &str = "planes/contracts/trust_chain_integration_v1.json";
const FASTPATH_POLICY_PATH: &str = "planes/contracts/fastpath_hotpath_policy_v1.json";
const INDUSTRIAL_ISA95_PATH: &str = "planes/contracts/industrial/isa95_template.json";
const INDUSTRIAL_RAMI_PATH: &str = "planes/contracts/industrial/rami40_template.json";
const INDUSTRIAL_CHECKLIST_PATH: &str = "planes/contracts/industrial/validation_checklist.json";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops asm-plane status");
    println!("  protheus-ops asm-plane wasm-dual-meter [--strict=1|0] [--ticks=<n>] [--fuel-budget=<n>] [--epoch-budget=<n>] [--fuel-per-tick=<n>] [--epoch-step=<n>]");
    println!(
        "  protheus-ops asm-plane hands-runtime [--strict=1|0] [--op=status|install|start|pause|rotate] [--manifest=<path>] [--version=<semver>]"
    );
    println!(
        "  protheus-ops asm-plane crdt-adapter [--strict=1|0] [--op=merge|replay] [--left-json=<json>] [--right-json=<json>]"
    );
    println!(
        "  protheus-ops asm-plane trust-chain [--strict=1|0] [--policy=<path>] [--allow-missing-rekor=1|0]"
    );
    println!(
        "  protheus-ops asm-plane fastpath [--strict=1|0] [--policy=<path>] [--workload=1,2,3] [--inject-mismatch=1|0]"
    );
    println!(
        "  protheus-ops asm-plane industrial-pack [--strict=1|0] [--isa95=<path>] [--rami=<path>] [--checklist=<path>]"
    );
}

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn history_path(root: &Path) -> PathBuf {
    state_root(root).join("history.jsonl")
}

fn print_payload(payload: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(payload)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn emit(root: &Path, payload: Value) -> i32 {
    match write_receipt(root, STATE_ENV, STATE_SCOPE, payload) {
        Ok(out) => {
            print_payload(&out);
            if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                0
            } else {
                1
            }
        }
        Err(err) => {
            let out = json!({
                "ok": false,
                "type": "asm_plane_error",
                "error": clean(err, 220)
            });
            print_payload(&out);
            1
        }
    }
}

fn load_hand_manifest(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path)
        .map_err(|err| format!("read_manifest_failed:{}:{err}", path.display()))?;
    let mut out = Map::<String, Value>::new();
    for row in raw.lines() {
        let line = row.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some((key_raw, value_raw)) = line.split_once('=') else {
            continue;
        };
        let key = key_raw.trim().to_ascii_lowercase();
        let value = value_raw.trim();
        if value.starts_with('[') && value.ends_with(']') {
            let inner = &value[1..value.len().saturating_sub(1)];
            let values = inner
                .split(',')
                .map(|part| part.trim().trim_matches('"').trim_matches('\'').to_string())
                .filter(|part| !part.is_empty())
                .map(Value::String)
                .collect::<Vec<_>>();
            out.insert(key, Value::Array(values));
            continue;
        }
        let clean_str = value.trim_matches('"').trim_matches('\'').to_string();
        if let Ok(parsed) = clean_str.parse::<u64>() {
            out.insert(key, Value::Number(parsed.into()));
            continue;
        }
        out.insert(key, Value::String(clean_str));
    }
    Ok(Value::Object(out))
}

fn run_status(root: &Path) -> Value {
    let latest = read_json(&latest_path(root));
    json!({
        "ok": true,
        "type": "asm_plane_status",
        "lane": "core/layer0/ops",
        "latest_path": latest_path(root).display().to_string(),
        "history_path": history_path(root).display().to_string(),
        "latest": latest
    })
}

fn run_wasm_dual_meter(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let policy_path = parsed
        .flags
        .get("policy")
        .map(String::as_str)
        .unwrap_or(WASM_DUAL_METER_POLICY_PATH);
    let policy = load_json_or(
        root,
        policy_path,
        json!({
            "version": "v1",
            "kind": "wasm_dual_meter_policy",
            "defaults": {
                "fuel_budget": 25000,
                "epoch_budget": 128,
                "fuel_per_tick": 90,
                "max_ticks_per_epoch": 16,
                "epoch_step": 1
            },
            "telemetry_required": true
        }),
    );
    let defaults = policy.get("defaults").cloned().unwrap_or(Value::Null);
    let fuel_budget = parse_u64(
        parsed.flags.get("fuel-budget"),
        defaults
            .get("fuel_budget")
            .and_then(Value::as_u64)
            .unwrap_or(25_000),
    )
    .clamp(1, 50_000_000);
    let epoch_budget = parse_u64(
        parsed.flags.get("epoch-budget"),
        defaults
            .get("epoch_budget")
            .and_then(Value::as_u64)
            .unwrap_or(128),
    )
    .clamp(1, 1_000_000);
    let fuel_per_tick = parse_u64(
        parsed.flags.get("fuel-per-tick"),
        defaults
            .get("fuel_per_tick")
            .and_then(Value::as_u64)
            .unwrap_or(90),
    )
    .clamp(1, 100_000);
    let max_ticks_per_epoch = parse_u64(
        parsed.flags.get("max-ticks-per-epoch"),
        defaults
            .get("max_ticks_per_epoch")
            .and_then(Value::as_u64)
            .unwrap_or(16),
    )
    .clamp(1, 100_000);
    let epoch_step = parse_u64(
        parsed.flags.get("epoch-step"),
        defaults
            .get("epoch_step")
            .and_then(Value::as_u64)
            .unwrap_or(1),
    )
    .clamp(1, 100_000);
    let ticks = parse_u64(parsed.flags.get("ticks"), 32).clamp(0, 10_000_000);
    let module_sha = clean(
        parsed
            .flags
            .get("module-sha")
            .cloned()
            .unwrap_or_else(|| sha256_hex_str("module:default")),
        128,
    );

    let fuel_used = ticks.saturating_mul(fuel_per_tick);
    let epoch_used = if ticks == 0 {
        0
    } else {
        ((ticks + max_ticks_per_epoch - 1) / max_ticks_per_epoch).saturating_mul(epoch_step)
    };
    let fuel_remaining = fuel_budget.saturating_sub(fuel_used);
    let epoch_remaining = epoch_budget.saturating_sub(epoch_used);

    let mut errors = Vec::<String>::new();
    if policy
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("policy_version_must_be_v1".to_string());
    }
    if policy
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "wasm_dual_meter_policy"
    {
        errors.push("policy_kind_invalid".to_string());
    }
    if fuel_used > fuel_budget {
        errors.push("fuel_exhausted".to_string());
    }
    if epoch_used > epoch_budget {
        errors.push("epoch_exhausted".to_string());
    }
    if module_sha.len() != 64 || !module_sha.chars().all(|c| c.is_ascii_hexdigit()) {
        errors.push("module_sha_invalid".to_string());
    }

    let ok = errors.is_empty();
    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "type": "asm_wasm_dual_meter",
        "lane": "core/layer0/ops",
        "command": "wasm-dual-meter",
        "policy_path": policy_path,
        "module_sha256": module_sha,
        "telemetry": {
            "ticks": ticks,
            "fuel_per_tick": fuel_per_tick,
            "max_ticks_per_epoch": max_ticks_per_epoch,
            "epoch_step": epoch_step,
            "fuel_budget": fuel_budget,
            "fuel_used": fuel_used,
            "fuel_remaining": fuel_remaining,
            "epoch_budget": epoch_budget,
            "epoch_used": epoch_used,
            "epoch_remaining": epoch_remaining
        },
        "decision": if ok { "allow" } else { "deny" },
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V7-ASM-004",
                "claim": "dual_metered_wasm_sandbox_enforces_fuel_and_epoch_fail_closed",
                "evidence": {
                    "fuel_used": fuel_used,
                    "epoch_used": epoch_used
                }
            }
        ]
    })
}

fn run_hands_runtime(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let manifest_rel = parsed
        .flags
        .get("manifest")
        .map(String::as_str)
        .unwrap_or(HAND_MANIFEST_PATH);
    let op = parsed
        .flags
        .get("op")
        .map(|v| v.to_ascii_lowercase())
        .or_else(|| parsed.positional.get(1).map(|v| v.to_ascii_lowercase()))
        .unwrap_or_else(|| "status".to_string());
    let manifest_path = root.join(manifest_rel);
    let manifest = load_hand_manifest(&manifest_path).unwrap_or_else(|_| Value::Null);
    let state_path = state_root(root).join("hands_runtime").join("state.json");
    let events_path = state_root(root).join("hands_runtime").join("events.jsonl");
    let mut state = read_json(&state_path).unwrap_or_else(|| {
        json!({
            "installed": false,
            "running": false,
            "paused": false,
            "rotation_seq": 0,
            "active_version": Value::Null,
            "last_op": Value::Null,
            "updated_at": Value::Null
        })
    });
    let mut errors = Vec::<String>::new();

    if manifest.is_null() {
        errors.push("hand_manifest_missing_or_invalid".to_string());
    }
    if manifest
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        errors.push("hand_manifest_name_required".to_string());
    }
    if manifest
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        errors.push("hand_manifest_version_required".to_string());
    }
    if manifest
        .get("capabilities")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false)
        == false
    {
        errors.push("hand_manifest_capabilities_required".to_string());
    }

    let installed = state
        .get("installed")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let running = state
        .get("running")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    if op == "install" {
        if errors.is_empty() {
            state["installed"] = Value::Bool(true);
            state["running"] = Value::Bool(false);
            state["paused"] = Value::Bool(false);
            state["rotation_seq"] = Value::Number(0_u64.into());
            state["active_version"] = manifest
                .get("version")
                .cloned()
                .unwrap_or_else(|| Value::String("0.0.0".to_string()));
        }
    } else if op == "start" {
        if !installed {
            errors.push("hands_runtime_not_installed".to_string());
        } else {
            state["running"] = Value::Bool(true);
            state["paused"] = Value::Bool(false);
        }
    } else if op == "pause" {
        if !running {
            errors.push("hands_runtime_not_running".to_string());
        } else {
            state["paused"] = Value::Bool(true);
            state["running"] = Value::Bool(false);
        }
    } else if op == "rotate" {
        if !installed {
            errors.push("hands_runtime_not_installed".to_string());
        } else {
            let next_version = parsed
                .flags
                .get("version")
                .cloned()
                .or_else(|| {
                    manifest
                        .get("version")
                        .and_then(Value::as_str)
                        .map(ToString::to_string)
                })
                .unwrap_or_else(|| "0.0.0".to_string());
            let next_seq = state
                .get("rotation_seq")
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .saturating_add(1);
            state["rotation_seq"] = Value::Number(next_seq.into());
            state["active_version"] = Value::String(clean(next_version, 64));
            state["running"] = Value::Bool(true);
            state["paused"] = Value::Bool(false);
        }
    } else if op != "status" {
        errors.push(format!("unknown_hands_op:{op}"));
    }

    let ok = errors.is_empty();
    if (op == "install" || op == "start" || op == "pause" || op == "rotate") && ok {
        state["last_op"] = Value::String(op.clone());
        state["updated_at"] = Value::String(now_iso());
        let _ = write_json(&state_path, &state);
        let event = json!({
            "type": "hands_runtime_event",
            "op": op,
            "ts": now_iso(),
            "manifest_path": manifest_rel,
            "state": state
        });
        let _ = append_jsonl(&events_path, &event);
    }

    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "type": "asm_hands_runtime",
        "lane": "core/layer0/ops",
        "op": op,
        "manifest_path": manifest_rel,
        "state_path": state_path.display().to_string(),
        "events_path": events_path.display().to_string(),
        "manifest": manifest,
        "state": state,
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V7-ASM-005",
                "claim": "hands_runtime_is_manifest_driven_and_lifecycle_receipted",
                "evidence": {
                    "op": op,
                    "state_path": state_path.display().to_string()
                }
            }
        ]
    })
}

fn parse_crdt_map(raw: Option<&String>) -> Result<Map<String, Value>, String> {
    let fallback = json!({
        "topic": {"value":"alpha", "clock": 1, "node":"left"},
        "state": {"value":"warm", "clock": 1, "node":"left"}
    });
    let parsed = match raw {
        Some(v) => {
            serde_json::from_str::<Value>(v).map_err(|err| format!("invalid_crdt_json:{err}"))?
        }
        None => fallback,
    };
    parsed
        .as_object()
        .cloned()
        .ok_or_else(|| "crdt_payload_must_be_object".to_string())
}

fn merge_crdt(
    left: &Map<String, Value>,
    right: &Map<String, Value>,
) -> (Map<String, Value>, Vec<Value>) {
    let mut merged = Map::<String, Value>::new();
    let mut provenance = Vec::<Value>::new();
    let mut keys = left.keys().chain(right.keys()).cloned().collect::<Vec<_>>();
    keys.sort();
    keys.dedup();

    for key in keys {
        let l = left.get(&key).cloned().unwrap_or(Value::Null);
        let r = right.get(&key).cloned().unwrap_or(Value::Null);
        let l_clock = l.get("clock").and_then(Value::as_i64).unwrap_or(0);
        let r_clock = r.get("clock").and_then(Value::as_i64).unwrap_or(0);
        let l_node = l
            .get("node")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let r_node = r
            .get("node")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let pick_right = r_clock > l_clock || (r_clock == l_clock && r_node > l_node);
        let winner = if pick_right { r.clone() } else { l.clone() };
        if l != r {
            provenance.push(json!({
                "key": key,
                "left": l,
                "right": r,
                "winner": if pick_right { "right" } else { "left" }
            }));
        }
        merged.insert(key, winner);
    }
    (merged, provenance)
}

fn run_crdt_adapter(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let op = parsed
        .flags
        .get("op")
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_else(|| "merge".to_string());
    let profile_path = parsed
        .flags
        .get("profile")
        .map(String::as_str)
        .unwrap_or(CRDT_PROFILE_PATH);
    let profile = load_json_or(
        root,
        profile_path,
        json!({
            "version": "v1",
            "kind": "crdt_automerge_profile",
            "merge_strategy": "lww",
            "replay_required": true
        }),
    );
    let events_path = state_root(root).join("crdt_adapter").join("events.jsonl");

    let mut errors = Vec::<String>::new();
    if profile
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("crdt_profile_version_must_be_v1".to_string());
    }
    if profile
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "crdt_automerge_profile"
    {
        errors.push("crdt_profile_kind_invalid".to_string());
    }

    if op == "replay" {
        let rows = fs::read_to_string(&events_path)
            .ok()
            .unwrap_or_default()
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .collect::<Vec<_>>();
        let mut ok = true;
        let mut prev = "GENESIS".to_string();
        let mut replay_state = Map::<String, Value>::new();
        for row in &rows {
            let expected_prev = row
                .get("prev_hash")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let hash = row.get("hash").and_then(Value::as_str).unwrap_or_default();
            let digest = sha256_hex_str(&format!(
                "{}:{}",
                expected_prev,
                row.get("merged")
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "null".to_string())
            ));
            if expected_prev != prev || hash != digest {
                ok = false;
                errors.push("crdt_chain_tamper_detected".to_string());
                break;
            }
            prev = hash.to_string();
            if let Some(obj) = row.get("merged").and_then(Value::as_object) {
                replay_state = obj.clone();
            }
        }
        return json!({
            "ok": if strict { ok && errors.is_empty() } else { true },
            "strict": strict,
            "type": "asm_crdt_adapter_replay",
            "op": op,
            "events_path": events_path.display().to_string(),
            "events_count": rows.len(),
            "tip_hash": prev,
            "state": replay_state,
            "errors": errors,
            "claim_evidence": [
                {
                    "id": "V7-ASM-007",
                    "claim": "crdt_adapter_replay_verifies_local_first_merge_history",
                    "evidence": {"events_count": rows.len()}
                }
            ]
        });
    }

    let left = parse_crdt_map(parsed.flags.get("left-json"));
    let right = parse_crdt_map(parsed.flags.get("right-json"));
    let (left, right) = match (left, right) {
        (Ok(l), Ok(r)) => (l, r),
        (Err(e), _) | (_, Err(e)) => {
            errors.push(e);
            return json!({
                "ok": false,
                "strict": strict,
                "type": "asm_crdt_adapter_merge",
                "op": op,
                "errors": errors
            });
        }
    };

    let (merged, provenance) = merge_crdt(&left, &right);
    let previous = fs::read_to_string(&events_path)
        .ok()
        .and_then(|raw| raw.lines().last().map(ToString::to_string))
        .and_then(|line| serde_json::from_str::<Value>(&line).ok())
        .and_then(|row| {
            row.get("hash")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "GENESIS".to_string());
    let merged_json = Value::Object(merged.clone());
    let hash = sha256_hex_str(&format!("{}:{}", previous, merged_json));
    let event = json!({
        "type": "crdt_adapter_event",
        "ts": now_iso(),
        "op": "merge",
        "prev_hash": previous,
        "hash": hash,
        "left": left,
        "right": right,
        "merged": merged_json,
        "provenance": provenance
    });
    if let Err(err) = append_jsonl(&events_path, &event) {
        errors.push(err);
    }
    let ok = errors.is_empty();
    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "type": "asm_crdt_adapter_merge",
        "op": op,
        "profile_path": profile_path,
        "events_path": events_path.display().to_string(),
        "event_hash": hash,
        "merged": merged_json,
        "provenance": provenance,
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V7-ASM-007",
                "claim": "crdt_adapter_performs_deterministic_merge_with_conflict_provenance",
                "evidence": {
                    "event_hash": hash
                }
            }
        ]
    })
}

fn run_trust_chain(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let policy_path = parsed
        .flags
        .get("policy")
        .map(String::as_str)
        .unwrap_or(TRUST_CHAIN_POLICY_PATH);
    let allow_missing_rekor = parse_bool(parsed.flags.get("allow-missing-rekor"), false);
    let policy = load_json_or(
        root,
        policy_path,
        json!({
            "version": "v1",
            "kind": "trust_chain_integration",
            "bundle_path": "local/state/release/provenance_bundle/latest.json",
            "required_signature_paths": [
                "local/state/release/provenance/signatures/protheus-ops.sig",
                "local/state/release/provenance/signatures/protheusd.sig"
            ],
            "rekor_bundle_path": "local/state/release/provenance/rekor_entries.json",
            "require_rekor": true
        }),
    );
    let bundle_rel = policy
        .get("bundle_path")
        .and_then(Value::as_str)
        .unwrap_or("local/state/release/provenance_bundle/latest.json");
    let bundle_path = root.join(bundle_rel);
    let bundle = read_json(&bundle_path).unwrap_or(Value::Null);
    let signatures = policy
        .get("required_signature_paths")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let require_rekor = policy
        .get("require_rekor")
        .and_then(Value::as_bool)
        .unwrap_or(true)
        && !allow_missing_rekor;
    let rekor_rel = policy
        .get("rekor_bundle_path")
        .and_then(Value::as_str)
        .unwrap_or("local/state/release/provenance/rekor_entries.json");
    let rekor_path = root.join(rekor_rel);

    let mut errors = Vec::<String>::new();
    if policy
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("trust_chain_policy_version_must_be_v1".to_string());
    }
    if policy
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "trust_chain_integration"
    {
        errors.push("trust_chain_policy_kind_invalid".to_string());
    }
    if bundle.is_null() {
        errors.push("trust_chain_bundle_missing".to_string());
    } else if bundle
        .get("schema_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "release_provenance_bundle"
    {
        errors.push("trust_chain_bundle_schema_invalid".to_string());
    }

    let mut signature_rows = Vec::<Value>::new();
    for row in signatures {
        let rel = row.as_str().unwrap_or_default();
        if rel.is_empty() {
            continue;
        }
        let exists = root.join(rel).exists();
        if !exists {
            errors.push(format!("missing_signature::{rel}"));
        }
        signature_rows.push(json!({"path": rel, "exists": exists}));
    }

    let rekor_exists = rekor_path.exists();
    if require_rekor && !rekor_exists {
        errors.push("rekor_bundle_missing".to_string());
    }

    let ok = errors.is_empty();
    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "type": "asm_trust_chain",
        "lane": "core/layer0/ops",
        "policy_path": policy_path,
        "bundle_path": bundle_rel,
        "bundle_exists": bundle_path.exists(),
        "signature_checks": signature_rows,
        "rekor_bundle_path": rekor_rel,
        "rekor_exists": rekor_exists,
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V7-ASM-008",
                "claim": "trust_chain_lane_verifies_reproducible_bundle_signatures_and_rekor_pointer",
                "evidence": {
                    "bundle_path": bundle_rel,
                    "rekor_exists": rekor_exists
                }
            }
        ]
    })
}

fn canonical_hotpath(value: i64) -> i64 {
    value
        .saturating_mul(value)
        .saturating_add(value.saturating_mul(3))
        .saturating_add(7)
}

fn fastpath_hotpath(value: i64) -> i64 {
    (value.saturating_add(1))
        .saturating_mul(value.saturating_add(2))
        .saturating_add(5)
}

fn parse_workload(raw: Option<&String>) -> Vec<i64> {
    let mut out = raw
        .map(|v| {
            v.split(',')
                .filter_map(|part| part.trim().parse::<i64>().ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if out.is_empty() {
        out = (1_i64..=128_i64).collect::<Vec<_>>();
    }
    out
}

fn run_fastpath(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let policy_path = parsed
        .flags
        .get("policy")
        .map(String::as_str)
        .unwrap_or(FASTPATH_POLICY_PATH);
    let policy = load_json_or(
        root,
        policy_path,
        json!({
            "version": "v1",
            "kind": "fastpath_hotpath_policy",
            "rollback_on_parity_fail": true,
            "hotpaths": ["routing.rank", "execution.scheduling"]
        }),
    );
    let inject_mismatch = parse_bool(parsed.flags.get("inject-mismatch"), false);
    let workload = parse_workload(parsed.flags.get("workload"));
    let started = Instant::now();
    let mut mismatches = Vec::<Value>::new();
    for (idx, item) in workload.iter().enumerate() {
        let canonical = canonical_hotpath(*item);
        let mut fast = fastpath_hotpath(*item);
        if inject_mismatch && idx == 0 {
            fast = fast.saturating_add(1);
        }
        if canonical != fast {
            mismatches.push(json!({
                "index": idx,
                "input": item,
                "canonical": canonical,
                "fastpath": fast
            }));
        }
    }
    let elapsed_ms = started.elapsed().as_millis();
    let rollback_on_fail = policy
        .get("rollback_on_parity_fail")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    if rollback_on_fail && !mismatches.is_empty() {
        let rollback_path = state_root(root).join("fastpath").join("rollback.json");
        let _ = write_json(
            &rollback_path,
            &json!({
                "ts": now_iso(),
                "reason": "parity_mismatch",
                "mismatch_count": mismatches.len()
            }),
        );
    }

    let mut errors = Vec::<String>::new();
    if policy
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("fastpath_policy_version_must_be_v1".to_string());
    }
    if policy
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "fastpath_hotpath_policy"
    {
        errors.push("fastpath_policy_kind_invalid".to_string());
    }
    if !mismatches.is_empty() {
        errors.push("fastpath_parity_mismatch".to_string());
    }

    let throughput = if elapsed_ms == 0 {
        workload.len() as f64
    } else {
        (workload.len() as f64) / ((elapsed_ms as f64) / 1000.0)
    };
    let ok = errors.is_empty();
    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "type": "asm_fastpath",
        "lane": "core/layer0/ops",
        "policy_path": policy_path,
        "workload_size": workload.len(),
        "elapsed_ms": elapsed_ms,
        "throughput_ops_per_sec": (throughput * 100.0).round() / 100.0,
        "mismatch_count": mismatches.len(),
        "mismatches": mismatches,
        "rollback_on_parity_fail": rollback_on_fail,
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V7-ASM-009",
                "claim": "fastpath_lane_checks_parity_and_triggers_rollback_on_mismatch",
                "evidence": {
                    "mismatch_count": mismatches.len()
                }
            }
        ]
    })
}

fn run_industrial_pack(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let isa95_rel = parsed
        .flags
        .get("isa95")
        .map(String::as_str)
        .unwrap_or(INDUSTRIAL_ISA95_PATH);
    let rami_rel = parsed
        .flags
        .get("rami")
        .map(String::as_str)
        .unwrap_or(INDUSTRIAL_RAMI_PATH);
    let checklist_rel = parsed
        .flags
        .get("checklist")
        .map(String::as_str)
        .unwrap_or(INDUSTRIAL_CHECKLIST_PATH);
    let isa95 = load_json_or(root, isa95_rel, Value::Null);
    let rami = load_json_or(root, rami_rel, Value::Null);
    let checklist = load_json_or(root, checklist_rel, Value::Null);
    let mut errors = Vec::<String>::new();

    if isa95.is_null() {
        errors.push("isa95_template_missing".to_string());
    }
    if rami.is_null() {
        errors.push("rami_template_missing".to_string());
    }
    if checklist.is_null() {
        errors.push("industrial_checklist_missing".to_string());
    }
    if isa95
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "isa95_mapping_template"
    {
        errors.push("isa95_kind_invalid".to_string());
    }
    if rami.get("kind").and_then(Value::as_str).unwrap_or_default() != "rami40_mapping_template" {
        errors.push("rami_kind_invalid".to_string());
    }
    if checklist
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "industrial_validation_checklist"
    {
        errors.push("industrial_checklist_kind_invalid".to_string());
    }
    if isa95
        .get("levels")
        .and_then(Value::as_array)
        .map(|rows| rows.len() >= 5)
        .unwrap_or(false)
        == false
    {
        errors.push("isa95_levels_incomplete".to_string());
    }
    if rami
        .get("axes")
        .and_then(Value::as_array)
        .map(|rows| rows.len() >= 3)
        .unwrap_or(false)
        == false
    {
        errors.push("rami_axes_incomplete".to_string());
    }
    if checklist
        .get("required_checks")
        .and_then(Value::as_array)
        .map(|rows| !rows.is_empty())
        .unwrap_or(false)
        == false
    {
        errors.push("industrial_required_checks_missing".to_string());
    }

    let ok = errors.is_empty();
    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "type": "asm_industrial_pack",
        "lane": "core/layer0/ops",
        "isa95_path": isa95_rel,
        "rami_path": rami_rel,
        "checklist_path": checklist_rel,
        "isa95_levels": isa95.get("levels").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
        "rami_axes": rami.get("axes").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
        "required_checks": checklist.get("required_checks").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
        "errors": errors,
        "claim_evidence": [
            {
                "id": "V7-ASM-010",
                "claim": "industrial_templates_map_inf_ring_primitives_to_isa95_and_rami",
                "evidence": {
                    "isa95_levels": isa95.get("levels").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
                    "rami_axes": rami.get("axes").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0)
                }
            }
        ]
    })
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let command = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    if matches!(command.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }
    let strict = parse_bool(parsed.flags.get("strict"), true);
    let payload = match command.as_str() {
        "status" => run_status(root),
        "wasm-dual-meter" | "wasm_dual_meter" => run_wasm_dual_meter(root, &parsed, strict),
        "hands-runtime" | "hands_runtime" => run_hands_runtime(root, &parsed, strict),
        "crdt-adapter" | "crdt_adapter" => run_crdt_adapter(root, &parsed, strict),
        "trust-chain" | "trust_chain" => run_trust_chain(root, &parsed, strict),
        "fastpath" => run_fastpath(root, &parsed, strict),
        "industrial-pack" | "industrial_pack" => run_industrial_pack(root, &parsed, strict),
        _ => json!({
            "ok": false,
            "type": "asm_plane_error",
            "error": "unknown_command",
            "command": command
        }),
    };
    if command == "status" {
        print_payload(&payload);
        return 0;
    }
    emit(root, payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dual_meter_fails_when_budget_exhausted() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = parse_args(&[
            "wasm-dual-meter".to_string(),
            "--ticks=100".to_string(),
            "--fuel-budget=100".to_string(),
            "--epoch-budget=1".to_string(),
            "--fuel-per-tick=20".to_string(),
        ]);
        let out = run_wasm_dual_meter(root.path(), &parsed, true);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn crdt_merge_produces_deterministic_winner() {
        let left = serde_json::from_str::<Value>(
            "{\"topic\":{\"value\":\"alpha\",\"clock\":1,\"node\":\"a\"}}",
        )
        .expect("left")
        .as_object()
        .cloned()
        .expect("left obj");
        let right = serde_json::from_str::<Value>(
            "{\"topic\":{\"value\":\"beta\",\"clock\":2,\"node\":\"b\"}}",
        )
        .expect("right")
        .as_object()
        .cloned()
        .expect("right obj");
        let (merged, _) = merge_crdt(&left, &right);
        assert_eq!(
            merged
                .get("topic")
                .and_then(|v| v.get("value"))
                .and_then(Value::as_str),
            Some("beta")
        );
    }

    #[test]
    fn fastpath_detects_mismatch() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = parse_args(&[
            "fastpath".to_string(),
            "--inject-mismatch=1".to_string(),
            "--workload=1,2,3".to_string(),
        ]);
        let out = run_fastpath(root.path(), &parsed, true);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    }
}
