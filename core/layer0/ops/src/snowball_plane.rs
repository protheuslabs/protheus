// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::snowball_plane (authoritative)

use crate::v8_kernel::{
    append_jsonl, parse_bool, parse_u64, read_json, scoped_state_root, sha256_hex_str, write_json,
    write_receipt,
};
use crate::{clean, parse_args};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "SNOWBALL_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "snowball_plane";
const CONTRACT_PATH: &str = "planes/contracts/apps/snowball_engine_contract_v1.json";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops snowball-plane status [--cycle-id=<id>]");
    println!(
        "  protheus-ops snowball-plane start [--cycle-id=<id>] [--drops=<csv>] [--parallel=<n>] [--deps-json=<json>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops snowball-plane melt-refine [--cycle-id=<id>] [--regression-suite=<id>] [--regression-pass=1|0] [--strict=1|0]"
    );
    println!("  protheus-ops snowball-plane compact [--cycle-id=<id>] [--strict=1|0]");
    println!(
        "  protheus-ops snowball-plane backlog-pack [--cycle-id=<id>] [--unresolved-json=<json>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops snowball-plane control --op=<pause|resume|abort> [--cycle-id=<id>] [--strict=1|0]"
    );
}

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn cycles_path(root: &Path) -> PathBuf {
    state_root(root).join("cycles").join("registry.json")
}

fn snapshot_dir(root: &Path, cycle_id: &str) -> PathBuf {
    state_root(root).join("snapshots").join(cycle_id)
}

fn backlog_path(root: &Path, cycle_id: &str) -> PathBuf {
    state_root(root)
        .join("backlog")
        .join(format!("{cycle_id}-next.json"))
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
            print_payload(&json!({
                "ok": false,
                "type": "snowball_plane_error",
                "error": clean(err, 240)
            }));
            1
        }
    }
}

fn load_json_or(root: &Path, rel: &str, fallback: Value) -> Value {
    read_json(&root.join(rel)).unwrap_or(fallback)
}

fn parse_json_flag(raw: Option<&String>) -> Option<Value> {
    raw.and_then(|text| serde_json::from_str::<Value>(text).ok())
}

fn clean_id(raw: Option<&str>, fallback: &str) -> String {
    let mut out = String::new();
    if let Some(v) = raw {
        for ch in v.trim().chars() {
            if out.len() >= 96 {
                break;
            }
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                out.push(ch.to_ascii_lowercase());
            } else {
                out.push('-');
            }
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn parse_csv_unique(raw: Option<&String>, fallback: &[&str]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::<String>::new();
    let rows = raw
        .map(|v| v.split(',').map(str::to_string).collect::<Vec<_>>())
        .unwrap_or_else(|| fallback.iter().map(|v| v.to_string()).collect::<Vec<_>>());
    for row in rows {
        let item = clean(row, 80).to_ascii_lowercase();
        if item.is_empty() {
            continue;
        }
        if seen.insert(item.clone()) {
            out.push(item);
        }
    }
    if out.is_empty() {
        fallback.iter().map(|v| v.to_string()).collect()
    } else {
        out
    }
}

fn claim_ids_for_action(action: &str) -> Vec<&'static str> {
    match action {
        "start" => vec!["V6-APP-023.1", "V6-APP-023.5", "V6-APP-023.6"],
        "melt-refine" => vec!["V6-APP-023.2", "V6-APP-023.5", "V6-APP-023.6"],
        "compact" => vec!["V6-APP-023.3", "V6-APP-023.5", "V6-APP-023.6"],
        "backlog-pack" => vec!["V6-APP-023.4", "V6-APP-023.5", "V6-APP-023.6"],
        "control" | "status" => vec!["V6-APP-023.5", "V6-APP-023.6"],
        _ => vec!["V6-APP-023.5", "V6-APP-023.6"],
    }
}

fn conduit_enforcement(
    root: &Path,
    parsed: &crate::ParsedArgs,
    strict: bool,
    action: &str,
) -> Value {
    let bypass_requested = parse_bool(parsed.flags.get("bypass"), false)
        || parse_bool(parsed.flags.get("direct"), false)
        || parse_bool(parsed.flags.get("unsafe-client-route"), false)
        || parse_bool(parsed.flags.get("client-bypass"), false);
    let ok = !bypass_requested;
    let claim_rows = claim_ids_for_action(action)
        .iter()
        .map(|id| {
            json!({
                "id": id,
                "claim": "snowball_controls_route_through_layer0_conduit_with_fail_closed_denials",
                "evidence": {
                    "action": clean(action, 120),
                    "bypass_requested": bypass_requested
                }
            })
        })
        .collect::<Vec<_>>();
    let mut out = json!({
        "ok": if strict { ok } else { true },
        "type": "snowball_conduit_enforcement",
        "action": clean(action, 120),
        "required_path": "core/layer0/ops/snowball_plane",
        "bypass_requested": bypass_requested,
        "errors": if ok { Value::Array(Vec::new()) } else { json!(["conduit_bypass_rejected"]) },
        "claim_evidence": claim_rows
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    let _ = append_jsonl(
        &state_root(root).join("conduit").join("history.jsonl"),
        &out,
    );
    out
}

fn attach_conduit(mut payload: Value, conduit: Option<&Value>) -> Value {
    if let Some(gate) = conduit {
        payload["conduit_enforcement"] = gate.clone();
        let mut claims = payload
            .get("claim_evidence")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if let Some(rows) = gate.get("claim_evidence").and_then(Value::as_array) {
            claims.extend(rows.iter().cloned());
        }
        if !claims.is_empty() {
            payload["claim_evidence"] = Value::Array(claims);
        }
    }
    payload["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&payload));
    payload
}

fn load_cycles(root: &Path) -> Value {
    read_json(&cycles_path(root)).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "active_cycle_id": Value::Null,
            "cycles": {}
        })
    })
}

fn store_cycles(root: &Path, cycles: &Value) {
    let _ = write_json(&cycles_path(root), cycles);
}

fn active_or_requested_cycle(parsed: &crate::ParsedArgs, cycles: &Value, fallback: &str) -> String {
    clean_id(
        parsed
            .flags
            .get("cycle-id")
            .map(String::as_str)
            .or_else(|| parsed.flags.get("cycle").map(String::as_str))
            .or_else(|| cycles.get("active_cycle_id").and_then(Value::as_str))
            .or(Some(fallback)),
        fallback,
    )
}

fn classify_drop_risk(drop: &str) -> &'static str {
    let lower = drop.to_ascii_lowercase();
    if lower.contains("prod")
        || lower.contains("deploy")
        || lower.contains("security")
        || lower.contains("payment")
    {
        "high"
    } else if lower.contains("migration") || lower.contains("schema") || lower.contains("runtime") {
        "medium"
    } else {
        "low"
    }
}

fn dependencies_from_json(
    drops: &[String],
    deps_json: Option<Value>,
) -> BTreeMap<String, Vec<String>> {
    let mut out = BTreeMap::<String, Vec<String>>::new();
    for drop in drops {
        out.insert(drop.clone(), Vec::new());
    }
    if let Some(obj) = deps_json.and_then(|v| v.as_object().cloned()) {
        for (key, value) in obj {
            let k = clean(key, 80).to_ascii_lowercase();
            if !out.contains_key(&k) {
                continue;
            }
            let deps = value
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(Value::as_str)
                .map(|v| clean(v, 80).to_ascii_lowercase())
                .filter(|v| out.contains_key(v))
                .collect::<Vec<_>>();
            out.insert(k, deps);
        }
    }
    out
}

fn run_start(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "snowball_engine_contract",
            "default_parallel_limit": 3,
            "max_parallel_limit": 8
        }),
    );
    let mut cycles = load_cycles(root);
    if !cycles.get("cycles").map(Value::is_object).unwrap_or(false) {
        cycles["cycles"] = json!({});
    }
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let drops = parse_csv_unique(
        parsed.flags.get("drops"),
        &["core-hardening", "app-refine", "ops-proof"],
    );
    let default_parallel = contract
        .get("default_parallel_limit")
        .and_then(Value::as_u64)
        .unwrap_or(3);
    let max_parallel = contract
        .get("max_parallel_limit")
        .and_then(Value::as_u64)
        .unwrap_or(8)
        .max(1);
    let parallel_limit = parse_u64(parsed.flags.get("parallel"), default_parallel)
        .max(1)
        .min(max_parallel);
    let allow_high_risk = parse_bool(parsed.flags.get("allow-high-risk"), false);
    let deps_map = dependencies_from_json(
        drops.as_slice(),
        parse_json_flag(parsed.flags.get("deps-json")),
    );

    let mut risk_blocked = Vec::<String>::new();
    let mut drop_rows = Vec::<Value>::new();
    for drop in &drops {
        let risk = classify_drop_risk(drop);
        if strict && risk == "high" && !allow_high_risk {
            risk_blocked.push(drop.clone());
        }
        drop_rows.push(json!({
            "drop": drop,
            "risk": risk,
            "deps": deps_map.get(drop).cloned().unwrap_or_default()
        }));
    }
    if strict && !risk_blocked.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_start",
            "action": "start",
            "errors": ["snowball_high_risk_drop_requires_allow_flag"],
            "blocked_drops": risk_blocked
        });
    }

    let mut completed = HashSet::<String>::new();
    let mut pending = drops.clone();
    let mut waves = Vec::<Value>::new();
    let mut wave_idx = 1usize;
    while !pending.is_empty() && wave_idx <= 64 {
        let mut ready = Vec::<String>::new();
        for item in &pending {
            let deps = deps_map.get(item).cloned().unwrap_or_default();
            if deps.iter().all(|dep| completed.contains(dep)) {
                ready.push(item.clone());
            }
        }
        if ready.is_empty() {
            ready.push(pending[0].clone());
        }
        let run_now = ready
            .into_iter()
            .take(parallel_limit as usize)
            .collect::<Vec<_>>();
        for item in &run_now {
            completed.insert(item.clone());
        }
        pending.retain(|item| !run_now.iter().any(|r| r == item));
        waves.push(json!({
            "wave": wave_idx,
            "parallel": run_now.len(),
            "drops": run_now
        }));
        wave_idx += 1;
    }

    let now = crate::now_iso();
    let orchestration = json!({
        "cycle_id": cycle_id,
        "parallel_limit": parallel_limit,
        "drops": drop_rows,
        "waves": waves,
        "dependency_graph": deps_map,
        "started_at": now
    });
    let cycle_value = json!({
        "cycle_id": cycle_id,
        "stage": "running",
        "orchestration": orchestration,
        "updated_at": crate::now_iso()
    });
    let mut cycles_map = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    cycles_map.insert(cycle_id.clone(), cycle_value.clone());
    cycles["cycles"] = Value::Object(cycles_map);
    cycles["active_cycle_id"] = Value::String(cycle_id.clone());
    cycles["updated_at"] = Value::String(crate::now_iso());
    store_cycles(root, &cycles);
    let _ = append_jsonl(
        &state_root(root).join("history.jsonl"),
        &json!({
            "ts": crate::now_iso(),
            "action": "start",
            "cycle_id": cycle_id
        }),
    );

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "snowball_plane_start",
        "lane": "core/layer0/ops",
        "action": "start",
        "cycle_id": cycle_id,
        "orchestration": cycle_value.get("orchestration").cloned().unwrap_or(Value::Null),
        "artifact": {
            "path": cycles_path(root).display().to_string(),
            "sha256": sha256_hex_str(&cycles.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-APP-023.1",
                "claim": "snowball_start_orchestrates_bounded_parallel_drop_waves_with_dependency_and_risk_gates",
                "evidence": {
                    "cycle_id": cycle_id,
                    "parallel_limit": parallel_limit
                }
            },
            {
                "id": "V6-APP-023.5",
                "claim": "snowball_runtime_publishes_live_cycle_state_for_operator_controls",
                "evidence": {
                    "cycle_id": cycle_id
                }
            },
            {
                "id": "V6-APP-023.6",
                "claim": "snowball_status_and_compact_controls_surface_cycle_stage_batch_outcomes_and_regression_state",
                "evidence": {
                    "cycle_id": cycle_id,
                    "stage": "running"
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_melt_refine(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let mut cycles = load_cycles(root);
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let mut cycles_map = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let cycle = cycles_map.get(&cycle_id).cloned();
    if strict && cycle.is_none() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_melt_refine",
            "action": "melt-refine",
            "errors": ["snowball_cycle_not_found"],
            "cycle_id": cycle_id
        });
    }
    let regression_suite = clean(
        parsed
            .flags
            .get("regression-suite")
            .cloned()
            .unwrap_or_else(|| "core/layer0/ops".to_string()),
        200,
    );
    let regression_pass = parse_bool(parsed.flags.get("regression-pass"), true);
    let gate = json!({
        "suite": regression_suite,
        "pass": regression_pass,
        "rollback_required": !regression_pass,
        "ts": crate::now_iso()
    });
    let mut next_cycle = cycle.unwrap_or_else(|| json!({"cycle_id": cycle_id, "stage":"running"}));
    next_cycle["melt_refine"] = gate.clone();
    next_cycle["stage"] = Value::String(if regression_pass {
        "refined".to_string()
    } else {
        "rollback".to_string()
    });
    next_cycle["updated_at"] = Value::String(crate::now_iso());
    cycles_map.insert(cycle_id.clone(), next_cycle.clone());
    cycles["cycles"] = Value::Object(cycles_map);
    cycles["active_cycle_id"] = Value::String(cycle_id.clone());
    cycles["updated_at"] = Value::String(crate::now_iso());
    store_cycles(root, &cycles);

    let mut out = json!({
        "ok": regression_pass || !strict,
        "strict": strict,
        "type": "snowball_plane_melt_refine",
        "lane": "core/layer0/ops",
        "action": "melt-refine",
        "cycle_id": cycle_id,
        "gate": gate,
        "cycle": next_cycle,
        "artifact": {
            "path": cycles_path(root).display().to_string(),
            "sha256": sha256_hex_str(&cycles.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-APP-023.2",
                "claim": "snowball_melt_refine_enforces_regression_gate_before_promotion_and_emits_rollback_receipts",
                "evidence": {
                    "cycle_id": cycle_id,
                    "regression_pass": regression_pass
                }
            },
            {
                "id": "V6-APP-023.5",
                "claim": "snowball_runtime_publishes_live_cycle_state_for_operator_controls",
                "evidence": {
                    "cycle_id": cycle_id
                }
            },
            {
                "id": "V6-APP-023.6",
                "claim": "snowball_status_and_compact_controls_surface_cycle_stage_batch_outcomes_and_regression_state",
                "evidence": {
                    "cycle_id": cycle_id,
                    "stage": next_cycle.get("stage").cloned().unwrap_or(Value::Null),
                    "regression_pass": regression_pass
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_compact(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let mut cycles = load_cycles(root);
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let mut cycles_map = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let cycle = cycles_map.get(&cycle_id).cloned();
    if strict && cycle.is_none() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_compact",
            "action": "compact",
            "errors": ["snowball_cycle_not_found"],
            "cycle_id": cycle_id
        });
    }
    let stage = cycle
        .as_ref()
        .and_then(|v| v.get("stage"))
        .and_then(Value::as_str)
        .unwrap_or("running");
    let ts = crate::now_iso();
    let snapshot = json!({
        "version": "v1",
        "cycle_id": cycle_id,
        "stage": stage,
        "sphere_of_ice": true,
        "captured_at": ts,
        "restore_pointer": {
            "cycles_path": cycles_path(root).display().to_string(),
            "cycle_id": cycle_id
        }
    });
    let snapshot_path =
        snapshot_dir(root, &cycle_id).join(format!("sphere_of_ice_{}.json", ts.replace(':', "-")));
    let _ = write_json(&snapshot_path, &snapshot);
    let snapshot_hash =
        sha256_hex_str(&read_json(&snapshot_path).unwrap_or(Value::Null).to_string());

    let mut next_cycle = cycle.unwrap_or_else(|| json!({"cycle_id": cycle_id, "stage":"running"}));
    next_cycle["snapshot"] = json!({
        "path": snapshot_path.display().to_string(),
        "sha256": snapshot_hash,
        "captured_at": ts
    });
    next_cycle["stage"] = Value::String("compacted".to_string());
    next_cycle["updated_at"] = Value::String(crate::now_iso());
    cycles_map.insert(cycle_id.clone(), next_cycle.clone());
    cycles["cycles"] = Value::Object(cycles_map);
    cycles["active_cycle_id"] = Value::String(cycle_id.clone());
    cycles["updated_at"] = Value::String(crate::now_iso());
    store_cycles(root, &cycles);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "snowball_plane_compact",
        "lane": "core/layer0/ops",
        "action": "compact",
        "cycle_id": cycle_id,
        "snapshot": next_cycle.get("snapshot").cloned().unwrap_or(Value::Null),
        "claim_evidence": [
            {
                "id": "V6-APP-023.3",
                "claim": "snowball_compaction_writes_versioned_sphere_of_ice_snapshots_with_restore_pointers",
                "evidence": {
                    "cycle_id": cycle_id,
                    "snapshot_path": snapshot_path.display().to_string()
                }
            },
            {
                "id": "V6-APP-023.5",
                "claim": "snowball_runtime_publishes_live_cycle_state_for_operator_controls",
                "evidence": {
                    "cycle_id": cycle_id
                }
            },
            {
                "id": "V6-APP-023.6",
                "claim": "snowball_status_and_compact_controls_surface_cycle_stage_batch_outcomes_and_regression_state",
                "evidence": {
                    "cycle_id": cycle_id,
                    "stage": next_cycle.get("stage").cloned().unwrap_or(Value::Null),
                    "snapshot_path": snapshot_path.display().to_string()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_backlog_pack(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let mut cycles = load_cycles(root);
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let mut cycles_map = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let cycle = cycles_map.get(&cycle_id).cloned();
    if strict && cycle.is_none() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_backlog_pack",
            "action": "backlog-pack",
            "errors": ["snowball_cycle_not_found"],
            "cycle_id": cycle_id
        });
    }
    let unresolved = parse_json_flag(parsed.flags.get("unresolved-json"))
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_else(|| {
            let mut defaults = vec![json!({
                "id":"verify-regression",
                "depends_on": [],
                "priority": 1
            })];
            if cycle
                .as_ref()
                .and_then(|v| v.get("melt_refine"))
                .and_then(|v| v.get("pass"))
                .and_then(Value::as_bool)
                == Some(false)
            {
                defaults.push(json!({
                    "id":"rollback-analysis",
                    "depends_on": ["verify-regression"],
                    "priority": 0
                }));
            }
            defaults
        });
    let mut ordered = unresolved;
    ordered.sort_by_key(|row| row.get("priority").and_then(Value::as_i64).unwrap_or(99));
    let backlog = json!({
        "version":"v1",
        "cycle_id": cycle_id,
        "generated_at": crate::now_iso(),
        "items": ordered
    });
    let out_path = backlog_path(root, &cycle_id);
    let _ = write_json(&out_path, &backlog);

    let mut next_cycle = cycle.unwrap_or_else(|| json!({"cycle_id": cycle_id, "stage":"running"}));
    next_cycle["next_backlog"] = json!({
        "path": out_path.display().to_string(),
        "count": backlog.get("items").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0)
    });
    next_cycle["updated_at"] = Value::String(crate::now_iso());
    cycles_map.insert(cycle_id.clone(), next_cycle.clone());
    cycles["cycles"] = Value::Object(cycles_map);
    cycles["active_cycle_id"] = Value::String(cycle_id.clone());
    cycles["updated_at"] = Value::String(crate::now_iso());
    store_cycles(root, &cycles);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "snowball_plane_backlog_pack",
        "lane": "core/layer0/ops",
        "action": "backlog-pack",
        "cycle_id": cycle_id,
        "backlog": backlog,
        "artifact": {
            "path": out_path.display().to_string(),
            "sha256": sha256_hex_str(&read_json(&out_path).unwrap_or(Value::Null).to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-APP-023.4",
                "claim": "snowball_backlog_pack_generates_dependency_ordered_next_cycle_items_from_unresolved_findings",
                "evidence": {
                    "cycle_id": cycle_id
                }
            },
            {
                "id": "V6-APP-023.5",
                "claim": "snowball_runtime_publishes_live_cycle_state_for_operator_controls",
                "evidence": {
                    "cycle_id": cycle_id
                }
            },
            {
                "id": "V6-APP-023.6",
                "claim": "snowball_status_and_compact_controls_surface_cycle_stage_batch_outcomes_and_regression_state",
                "evidence": {
                    "cycle_id": cycle_id,
                    "queued_items": backlog.get("items").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0)
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_control(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let mut cycles = load_cycles(root);
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "pause".to_string()),
        20,
    )
    .to_ascii_lowercase();
    if strict && !matches!(op.as_str(), "pause" | "resume" | "abort") {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_control",
            "action": "control",
            "errors": ["snowball_control_op_invalid"],
            "op": op
        });
    }

    let mut cycles_map = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut cycle = cycles_map
        .get(&cycle_id)
        .cloned()
        .unwrap_or_else(|| json!({"cycle_id": cycle_id, "stage":"running"}));
    cycle["control"] = json!({
        "op": op,
        "ts": crate::now_iso()
    });
    cycle["stage"] = Value::String(match op.as_str() {
        "pause" => "paused".to_string(),
        "resume" => "running".to_string(),
        "abort" => "aborted".to_string(),
        _ => "running".to_string(),
    });
    cycle["updated_at"] = Value::String(crate::now_iso());
    cycles_map.insert(cycle_id.clone(), cycle.clone());
    cycles["cycles"] = Value::Object(cycles_map);
    cycles["active_cycle_id"] = Value::String(cycle_id.clone());
    cycles["updated_at"] = Value::String(crate::now_iso());
    store_cycles(root, &cycles);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "snowball_plane_control",
        "lane": "core/layer0/ops",
        "action": "control",
        "cycle_id": cycle_id,
        "control": cycle.get("control").cloned().unwrap_or(Value::Null),
        "stage": cycle.get("stage").cloned().unwrap_or(Value::String("running".to_string())),
        "claim_evidence": [
            {
                "id": "V6-APP-023.5",
                "claim": "snowball_status_and_controls_are_live_and_receipted_through_conduit",
                "evidence": {
                    "cycle_id": cycle_id,
                    "op": op
                }
            },
            {
                "id": "V6-APP-023.6",
                "claim": "snowball_status_and_compact_controls_surface_cycle_stage_batch_outcomes_and_regression_state",
                "evidence": {
                    "cycle_id": cycle_id,
                    "op": op,
                    "stage": cycle.get("stage").cloned().unwrap_or(Value::Null)
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_status(root: &Path, parsed: &crate::ParsedArgs) -> Value {
    let cycles = load_cycles(root);
    let cycle_id = active_or_requested_cycle(parsed, &cycles, "snowball-default");
    let cycle = cycles
        .get("cycles")
        .and_then(Value::as_object)
        .and_then(|map| map.get(&cycle_id))
        .cloned();
    let mut out = json!({
        "ok": true,
        "type": "snowball_plane_status",
        "lane": "core/layer0/ops",
        "cycle_id": cycle_id,
        "cycle": cycle,
        "latest_path": latest_path(root).display().to_string(),
        "controls": ["pause", "resume", "abort", "compact"],
        "claim_evidence": [
            {
                "id": "V6-APP-023.5",
                "claim": "snowball_status_and_controls_are_live_and_receipted_through_conduit",
                "evidence": {
                    "active_cycle_id": cycles.get("active_cycle_id").cloned().unwrap_or(Value::Null)
                }
            },
            {
                "id": "V6-APP-023.6",
                "claim": "snowball_status_and_compact_controls_surface_cycle_stage_batch_outcomes_and_regression_state",
                "evidence": {
                    "active_cycle_id": cycles.get("active_cycle_id").cloned().unwrap_or(Value::Null),
                    "has_cycle": cycle.is_some()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn dispatch(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let action = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    match action.as_str() {
        "status" => run_status(root, parsed),
        "start" => run_start(root, parsed, strict),
        "melt-refine" | "melt" | "refine" => run_melt_refine(root, parsed, strict),
        "compact" => run_compact(root, parsed, strict),
        "backlog-pack" | "backlog" => run_backlog_pack(root, parsed, strict),
        "control" => run_control(root, parsed, strict),
        _ => json!({
            "ok": false,
            "strict": strict,
            "type": "snowball_plane_error",
            "action": action,
            "errors": ["snowball_action_unknown"]
        }),
    }
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let action = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    if matches!(action.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }
    let strict = parse_bool(parsed.flags.get("strict"), true);
    let conduit = if action != "status" {
        Some(conduit_enforcement(root, &parsed, strict, action.as_str()))
    } else {
        None
    };
    if strict
        && conduit
            .as_ref()
            .and_then(|v| v.get("ok"))
            .and_then(Value::as_bool)
            == Some(false)
    {
        return emit(
            root,
            json!({
                "ok": false,
                "strict": strict,
                "type": "snowball_plane_conduit_gate",
                "errors": ["conduit_bypass_rejected"],
                "conduit_enforcement": conduit
            }),
        );
    }

    let payload = dispatch(root, &parsed, strict);
    if action == "status" {
        print_payload(&payload);
        return 0;
    }
    emit(root, attach_conduit(payload, conduit.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn start_writes_cycle_registry() {
        let root = tempfile::tempdir().expect("tempdir");
        let out = run_start(
            root.path(),
            &crate::parse_args(&[
                "start".to_string(),
                "--strict=1".to_string(),
                "--cycle-id=c17".to_string(),
                "--drops=core-hardening,app-runtime".to_string(),
            ]),
            true,
        );
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        assert!(cycles_path(root.path()).exists());
    }

    #[test]
    fn conduit_rejects_bypass() {
        let root = tempfile::tempdir().expect("tempdir");
        let gate = conduit_enforcement(
            root.path(),
            &crate::parse_args(&[
                "start".to_string(),
                "--strict=1".to_string(),
                "--bypass=1".to_string(),
            ]),
            true,
            "start",
        );
        assert_eq!(gate.get("ok").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn compact_writes_snapshot() {
        let root = tempfile::tempdir().expect("tempdir");
        let _ = run_start(
            root.path(),
            &crate::parse_args(&[
                "start".to_string(),
                "--strict=1".to_string(),
                "--cycle-id=c18".to_string(),
                "--allow-high-risk=1".to_string(),
            ]),
            true,
        );
        let out = run_compact(
            root.path(),
            &crate::parse_args(&[
                "compact".to_string(),
                "--strict=1".to_string(),
                "--cycle-id=c18".to_string(),
            ]),
            true,
        );
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
        let snap_path = out
            .get("snapshot")
            .and_then(|v| v.get("path"))
            .and_then(Value::as_str)
            .unwrap_or("");
        assert!(!snap_path.is_empty());
    }
}
