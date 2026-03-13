// SPDX-License-Identifier: Apache-2.0
use super::*;

fn federation_state_path(root: &Path) -> PathBuf {
    client_state_root(root)
        .join("memory")
        .join("federation")
        .join("state.json")
}

fn federation_history_path(root: &Path) -> PathBuf {
    client_state_root(root)
        .join("memory")
        .join("federation")
        .join("history.jsonl")
}

fn load_federation_state(root: &Path) -> Value {
    read_json(&federation_state_path(root)).unwrap_or_else(|| {
        json!({
            "version": 1,
            "entries": {},
            "updated_at": now_iso()
        })
    })
}

fn parse_entries(argv: &[String]) -> Result<Vec<Value>, String> {
    let raw = parse_flag(argv, "entries-json").ok_or_else(|| "entries_json_missing".to_string())?;
    let parsed = parse_json(Some(raw.as_str()))?;
    let rows = parsed
        .as_array()
        .cloned()
        .ok_or_else(|| "entries_json_not_array".to_string())?;
    Ok(rows)
}

pub(super) fn federation_sync_payload(
    root: &Path,
    policy: &MemoryPlanePolicy,
    argv: &[String],
) -> Result<Value, String> {
    let device_id = clean_id(parse_flag(argv, "device-id").as_deref(), "device");
    let apply = parse_bool(parse_flag(argv, "apply").as_deref(), true);
    let entries = parse_entries(argv)?;

    let mut state = load_federation_state(root);
    let mut map = state
        .get("entries")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if map.len() + entries.len() > policy.max_federation_entries {
        return Err("federation_capacity_exceeded".to_string());
    }

    let mut accepted = 0usize;
    let mut conflicted = 0usize;
    let mut replaced = 0usize;
    let ts = now_iso();

    for row in entries {
        let key = clean_id(row.get("key").and_then(Value::as_str), "");
        if key.is_empty() {
            continue;
        }
        let incoming_counter = row
            .get("counter")
            .and_then(Value::as_i64)
            .unwrap_or(1)
            .max(1);
        let incoming_value = row.get("value").cloned().unwrap_or(Value::Null);
        let incoming_ts = clean_text(row.get("ts").and_then(Value::as_str), 64);
        let existing = map.get(&key).cloned();
        match existing {
            None => {
                map.insert(
                    key,
                    json!({
                        "value": incoming_value,
                        "vector": { device_id.clone(): incoming_counter },
                        "updated_at": if incoming_ts.is_empty() { ts.clone() } else { incoming_ts },
                        "updated_by": device_id
                    }),
                );
                accepted += 1;
            }
            Some(old) => {
                let old_vector = old
                    .get("vector")
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default();
                let old_counter = old_vector
                    .get(&device_id)
                    .and_then(Value::as_i64)
                    .unwrap_or(0);
                if incoming_counter > old_counter {
                    let mut vector = old_vector;
                    vector.insert(device_id.clone(), Value::Number(incoming_counter.into()));
                    map.insert(
                        key,
                        json!({
                            "value": incoming_value,
                            "vector": vector,
                            "updated_at": if incoming_ts.is_empty() { ts.clone() } else { incoming_ts },
                            "updated_by": device_id
                        }),
                    );
                    accepted += 1;
                    replaced += 1;
                } else {
                    conflicted += 1;
                }
            }
        }
    }

    state["entries"] = Value::Object(map);
    state["updated_at"] = Value::String(ts.clone());
    if apply {
        write_json(&federation_state_path(root), &state)?;
        append_jsonl(
            &federation_history_path(root),
            &json!({
                "type": "memory_federation_sync",
                "device_id": device_id,
                "ts": ts,
                "accepted": accepted,
                "replaced": replaced,
                "conflicted": conflicted
            }),
        )?;
    }

    let mut out = json!({
        "ok": true,
        "type": "memory_federation_plane_sync",
        "lane": LANE_ID,
        "device_id": device_id,
        "apply": apply,
        "accepted": accepted,
        "replaced": replaced,
        "conflicted": conflicted,
        "entry_count": state.get("entries").and_then(Value::as_object).map(|m| m.len()).unwrap_or(0),
        "state_path": rel_path(root, &federation_state_path(root)),
        "claim_evidence": [{
            "id": "cross_device_conflict_resolution",
            "claim": "federation_sync_merges_entries_using_vector_counters",
            "evidence": {
                "device_id": device_id,
                "accepted": accepted,
                "conflicted": conflicted
            }
        }]
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    Ok(out)
}

pub(super) fn federation_pull_payload(root: &Path, argv: &[String]) -> Value {
    let limit = parse_flag(argv, "limit")
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|n| *n > 0)
        .unwrap_or(1000);
    let state = load_federation_state(root);
    let rows = state
        .get("entries")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut entries = Vec::new();
    for (key, value) in rows.into_iter().take(limit) {
        entries.push(json!({ "key": key, "entry": value }));
    }
    let mut out = json!({
        "ok": true,
        "type": "memory_federation_plane_pull",
        "lane": LANE_ID,
        "state_path": rel_path(root, &federation_state_path(root)),
        "entry_count": entries.len(),
        "entries": entries
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}

pub(super) fn federation_status_payload(root: &Path) -> Value {
    let state = load_federation_state(root);
    let mut out = json!({
        "ok": true,
        "type": "memory_federation_plane_status",
        "lane": LANE_ID,
        "state_path": rel_path(root, &federation_state_path(root)),
        "history_path": rel_path(root, &federation_history_path(root)),
        "entry_count": state.get("entries").and_then(Value::as_object).map(|m| m.len()).unwrap_or(0),
        "updated_at": state.get("updated_at").cloned().unwrap_or(Value::Null)
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}
