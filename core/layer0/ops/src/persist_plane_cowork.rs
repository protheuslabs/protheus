// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::persist_plane::cowork

use super::*;

pub(super) fn run_cowork(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        COWORK_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "persist_cowork_background_contract",
            "allowed_ops": ["delegate", "tick", "status", "list"],
            "allowed_modes": ["co-work", "sub-agent"],
            "max_budget_ms": 3600000
        }),
    );
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "list".to_string()),
        20,
    )
    .to_ascii_lowercase();
    let allowed_ops = contract
        .get("allowed_ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if strict
        && !allowed_ops
            .iter()
            .filter_map(Value::as_str)
            .any(|row| row == op)
    {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "persist_plane_cowork",
            "errors": ["persist_cowork_op_invalid"]
        });
    }

    let path = cowork_path(root);
    let mut state = read_json(&path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "runs": []
        })
    });
    if !state.get("runs").map(Value::is_array).unwrap_or(false) {
        state["runs"] = Value::Array(Vec::new());
    }

    if op == "list" {
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "persist_plane_cowork",
            "lane": "core/layer0/ops",
            "op": "list",
            "state": state,
            "claim_evidence": [
                {
                    "id": "V6-PERSIST-001.5",
                    "claim": "cowork_registry_lists_parent_child_background_runs",
                    "evidence": {
                        "run_count": state.get("runs").and_then(Value::as_array).map(|rows| rows.len()).unwrap_or(0)
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    if op == "status" {
        let run_id = clean(parsed.flags.get("run-id").cloned().unwrap_or_default(), 120);
        let current = state
            .get("runs")
            .and_then(Value::as_array)
            .and_then(|rows| {
                if run_id.is_empty() {
                    rows.last().cloned()
                } else {
                    rows.iter()
                        .find(|row| {
                            row.get("run_id").and_then(Value::as_str) == Some(run_id.as_str())
                        })
                        .cloned()
                }
            });
        if strict && current.is_none() {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "persist_plane_cowork",
                "op": "status",
                "errors": ["persist_cowork_run_not_found"]
            });
        }
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "persist_plane_cowork",
            "lane": "core/layer0/ops",
            "op": "status",
            "run": current,
            "claim_evidence": [
                {
                    "id": "V6-PERSIST-001.5",
                    "claim": "cowork_status_surfaces_parent_child_chain_state_under_budget_contract",
                    "evidence": {
                        "requested_run_id": run_id
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    if op == "tick" {
        let run_id = clean(parsed.flags.get("run-id").cloned().unwrap_or_default(), 120);
        let mut updated = None::<Value>;
        if let Some(rows) = state.get_mut("runs").and_then(Value::as_array_mut) {
            for row in rows.iter_mut() {
                let matches = if run_id.is_empty() {
                    true
                } else {
                    row.get("run_id").and_then(Value::as_str) == Some(run_id.as_str())
                };
                if matches {
                    row["last_heartbeat_ts"] = Value::String(crate::now_iso());
                    row["status"] = Value::String("running".to_string());
                    updated = Some(row.clone());
                    break;
                }
            }
        }
        if strict && updated.is_none() {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "persist_plane_cowork",
                "op": "tick",
                "errors": ["persist_cowork_run_not_found"]
            });
        }
        state["updated_at"] = Value::String(crate::now_iso());
        let _ = write_json(&path, &state);
        let _ = append_jsonl(
            &state_root(root).join("cowork").join("history.jsonl"),
            &json!({"op":"tick","run_id":run_id,"ts":crate::now_iso()}),
        );
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "persist_plane_cowork",
            "lane": "core/layer0/ops",
            "op": "tick",
            "run": updated,
            "artifact": {
                "path": path.display().to_string(),
                "sha256": sha256_hex_str(&state.to_string())
            },
            "claim_evidence": [
                {
                    "id": "V6-PERSIST-001.5",
                    "claim": "cowork_tick_keeps_background_parent_child_execution_chain_alive",
                    "evidence": {
                        "run_id": run_id
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    let mode = clean(
        parsed
            .flags
            .get("mode")
            .cloned()
            .unwrap_or_else(|| "co-work".to_string()),
        40,
    );
    let allowed_modes = contract
        .get("allowed_modes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if strict
        && !allowed_modes
            .iter()
            .filter_map(Value::as_str)
            .any(|row| row.eq_ignore_ascii_case(mode.as_str()))
    {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "persist_plane_cowork",
            "op": "delegate",
            "errors": ["persist_cowork_mode_invalid"]
        });
    }
    let max_budget_ms = contract
        .get("max_budget_ms")
        .and_then(Value::as_u64)
        .unwrap_or(3_600_000);
    let budget_ms = parse_u64(parsed.flags.get("budget-ms"), 120_000).max(1);
    if strict && budget_ms > max_budget_ms {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "persist_plane_cowork",
            "op": "delegate",
            "errors": ["persist_cowork_budget_exceeded"]
        });
    }
    let task = clean(
        parsed
            .flags
            .get("task")
            .cloned()
            .unwrap_or_else(|| "background-task".to_string()),
        240,
    );
    let parent = clean_id(
        parsed
            .flags
            .get("parent")
            .map(String::as_str)
            .or(Some("parent-main")),
        "parent-main",
    );
    let child = clean_id(
        parsed
            .flags
            .get("child")
            .map(String::as_str)
            .or(Some("delegated-shadow")),
        "delegated-shadow",
    );
    let run_id = format!(
        "cowork_{}",
        &sha256_hex_str(&format!(
            "{}:{}:{}:{}:{}",
            parent,
            child,
            mode,
            task,
            crate::now_iso()
        ))[..10]
    );
    let parent_receipt = format!(
        "parent:{}",
        &sha256_hex_str(&format!("{parent}:{task}:{}", crate::now_iso()))[..16]
    );
    let child_receipt = format!(
        "child:{}",
        &sha256_hex_str(&format!("{child}:{mode}:{}", crate::now_iso()))[..16]
    );
    let chain_hash = sha256_hex_str(&format!("{parent_receipt}:{child_receipt}:{run_id}"));
    let run = json!({
        "run_id": run_id,
        "mode": mode,
        "task": task,
        "parent": parent,
        "child": child,
        "status": "running",
        "budget_ms": budget_ms,
        "started_at": crate::now_iso(),
        "parent_receipt": parent_receipt,
        "child_receipt": child_receipt,
        "receipt_chain_hash": chain_hash
    });
    let mut runs = state
        .get("runs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    runs.push(run.clone());
    state["runs"] = Value::Array(runs);
    state["updated_at"] = Value::String(crate::now_iso());
    let _ = write_json(&path, &state);
    let _ = append_jsonl(
        &state_root(root).join("cowork").join("history.jsonl"),
        &json!({"op":"delegate","run":run,"ts":crate::now_iso()}),
    );

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "persist_plane_cowork",
        "lane": "core/layer0/ops",
        "op": "delegate",
        "run": run,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&state.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-PERSIST-001.5",
                "claim": "sub_agent_cowork_background_execution_emits_parent_child_receipt_chain_under_budget_caps",
                "evidence": {
                    "run_id": run_id,
                    "receipt_chain_hash": chain_hash,
                    "budget_ms": budget_ms
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}
