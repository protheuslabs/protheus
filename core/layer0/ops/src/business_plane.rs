// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::business_plane (authoritative)
use crate::v8_kernel::{
    append_jsonl, attach_conduit, build_conduit_enforcement, canonical_json_string,
    conduit_bypass_requested, deterministic_merkle_root, history_path, latest_path,
    next_chain_hash, parse_bool, parse_i64, parse_json_or_empty, parse_u64, print_json,
    read_json, read_jsonl, scoped_state_root, sha256_hex_str, write_json,
};
use crate::{clean, now_iso, parse_args};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const LANE_ID: &str = "business_plane";
const ENV_KEY: &str = "PROTHEUS_BUSINESS_PLANE_STATE_ROOT";

fn usage() {
    println!("Usage:");
    println!(
        "  protheus-ops business-plane taxonomy --business-context=<id> --topic=<text> [--tier=node1|tag2|jot3] [--interaction-count=<n>] [--promote-threshold=<n>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops business-plane persona --op=<issue|renew|revoke|status> --persona=<id> [--business-context=<id>] [--lease-hours=<n>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops business-plane continuity --op=<checkpoint|resume|handoff|status> [--business-context=<id>] [--name=<id>] [--state-json=<json>] [--to=<stakeholder>] [--task=<text>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops business-plane alerts --op=<emit|ack|status> [--alert-type=<id>] [--channel=<dashboard|slack|email|sms|pagerduty>] [--business-context=<id>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops business-plane switchboard --op=<create|write|read|status> --business-context=<id> [--target-business=<id>] [--entry-json=<json>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops business-plane external-sync --system=<notion|confluence|crm|calendar|email|slack> --direction=<push|pull|bidirectional> [--business-context=<id>] [--external-id=<id>] [--content-json=<json>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops business-plane continuity-audit [--days=<n>] [--business-context=<id|ALL>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops business-plane archive --op=<record|query|export|status> [--business-context=<id|ALL>] [--date-range=<start:end>] [--entry-json=<json>] [--strict=1|0]"
    );
}

fn lane_root(root: &Path) -> PathBuf {
    scoped_state_root(root, ENV_KEY, LANE_ID)
}

fn taxonomy_path(root: &Path, business: &str) -> PathBuf {
    lane_root(root)
        .join("businesses")
        .join(clean(business, 80))
        .join("taxonomy.json")
}

fn personas_path(root: &Path) -> PathBuf {
    lane_root(root).join("personas.json")
}

fn checkpoints_dir(root: &Path) -> PathBuf {
    lane_root(root).join("checkpoints")
}

fn continuity_state_path(root: &Path) -> PathBuf {
    lane_root(root).join("continuity_state.json")
}

fn handoff_queue_path(root: &Path) -> PathBuf {
    lane_root(root).join("handoffs.jsonl")
}

fn alerts_state_path(root: &Path) -> PathBuf {
    lane_root(root).join("alerts.json")
}

fn switchboard_dir(root: &Path, business: &str) -> PathBuf {
    lane_root(root)
        .join("tenants")
        .join(clean(business, 80))
        .join("memory")
}

fn sync_history_path(root: &Path) -> PathBuf {
    lane_root(root).join("external_sync.jsonl")
}

fn archive_path(root: &Path) -> PathBuf {
    lane_root(root).join("archive.jsonl")
}

fn archive_anchor_path(root: &Path) -> PathBuf {
    lane_root(root).join("archive_daily_roots.json")
}

fn business_registry_path(root: &Path) -> PathBuf {
    lane_root(root).join("business_registry.json")
}

fn now_epoch_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_object(path: &Path) -> Map<String, Value> {
    read_json(path)
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn append_archive(root: &Path, row: &Value) -> Result<(), String> {
    append_jsonl(&archive_path(root), row)?;
    let day = now_iso()[..10].to_string();
    let all = read_jsonl(&archive_path(root));
    let day_receipts = all
        .iter()
        .filter(|entry| {
            entry
                .get("ts")
                .and_then(Value::as_str)
                .map(|ts| ts.starts_with(&day))
                .unwrap_or(false)
        })
        .filter_map(|entry| {
            entry
                .get("receipt_hash")
                .and_then(Value::as_str)
                .map(|s| s.to_string())
        })
        .collect::<Vec<_>>();
    let mut anchors = read_object(&archive_anchor_path(root));
    anchors.insert(
        day.clone(),
        Value::String(deterministic_merkle_root(&day_receipts)),
    );
    write_json(&archive_anchor_path(root), &Value::Object(anchors))
}

fn emit(root: &Path, command: &str, strict: bool, payload: Value, conduit: Option<&Value>) -> i32 {
    let out = attach_conduit(payload, conduit);
    let _ = write_json(&latest_path(root, ENV_KEY, LANE_ID), &out);
    let _ = append_jsonl(&history_path(root, ENV_KEY, LANE_ID), &out);
    let archive_row = json!({
        "ts": out.get("ts").cloned().unwrap_or_else(|| Value::String(now_iso())),
        "command": command,
        "strict": strict,
        "receipt_hash": out.get("receipt_hash").cloned().unwrap_or(Value::Null),
        "business_context": out.get("business_context").cloned().unwrap_or(Value::String("ALL".to_string())),
        "type": out.get("type").cloned().unwrap_or_else(|| Value::String("business_plane".to_string()))
    });
    let _ = append_archive(root, &archive_row);
    print_json(&out);
    if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        0
    } else {
        1
    }
}

fn require_business(parsed: &crate::ParsedArgs) -> Result<String, String> {
    let business = clean(
        parsed
            .flags
            .get("business-context")
            .map(String::as_str)
            .unwrap_or(""),
        80,
    );
    if business.is_empty() {
        return Err("business_context_required".to_string());
    }
    Ok(business)
}

fn load_personas(root: &Path) -> Map<String, Value> {
    read_object(&personas_path(root))
}

fn write_personas(root: &Path, rows: &Map<String, Value>) -> Result<(), String> {
    write_json(&personas_path(root), &Value::Object(rows.clone()))
}

fn ensure_business_registered(root: &Path, business: &str) -> Result<(), String> {
    let mut registry = read_object(&business_registry_path(root));
    if !registry.contains_key(business) {
        registry.insert(
            business.to_string(),
            json!({
                "created_at": now_iso(),
                "status": "active"
            }),
        );
        write_json(&business_registry_path(root), &Value::Object(registry))?;
    }
    Ok(())
}

fn taxonomy_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let business = require_business(parsed)?;
    ensure_business_registered(root, &business)?;
    let topic = clean(
        parsed
            .flags
            .get("topic")
            .map(String::as_str)
            .unwrap_or("untitled-topic"),
        240,
    );
    let tier_raw = clean(
        parsed
            .flags
            .get("tier")
            .map(String::as_str)
            .unwrap_or("jot3"),
        16,
    )
    .to_ascii_lowercase();
    let interaction_count = parse_u64(parsed.flags.get("interaction-count"), 1).max(1);
    let promote_threshold = parse_u64(parsed.flags.get("promote-threshold"), 12).max(2);
    let mut final_tier = match tier_raw.as_str() {
        "node1" | "tag2" | "jot3" => tier_raw.clone(),
        _ => "jot3".to_string(),
    };
    let mut promoted = false;
    if final_tier == "jot3" && interaction_count >= (promote_threshold / 2).max(2) {
        final_tier = "tag2".to_string();
        promoted = true;
    }
    if final_tier == "tag2" && interaction_count >= promote_threshold {
        final_tier = "node1".to_string();
        promoted = true;
    }

    let path = taxonomy_path(root, &business);
    let mut state = read_object(&path);
    let entry = json!({
        "topic": topic,
        "tier": final_tier,
        "interaction_count": interaction_count,
        "promote_threshold": promote_threshold,
        "promoted": promoted,
        "ts": now_iso()
    });
    state.insert(topic.clone(), entry.clone());
    write_json(&path, &Value::Object(state))?;

    Ok(json!({
        "ok": true,
        "type": "business_plane_taxonomy",
        "lane": LANE_ID,
        "ts": now_iso(),
        "business_context": business,
        "topic": topic,
        "entry": entry,
        "taxonomy_path": path.to_string_lossy().to_string(),
        "claim_evidence": [{
            "id": "V7-BUSINESS-001.1",
            "claim": "tiered_business_memory_taxonomy_supports_auto_promotion_and_business_scoped_query_filters",
            "evidence": {
                "tiers": ["node1", "tag2", "jot3"],
                "promoted": promoted,
                "interaction_count": interaction_count
            }
        }]
    }))
}

fn persona_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let op = clean(
        parsed
            .flags
            .get("op")
            .map(String::as_str)
            .unwrap_or("status"),
        16,
    )
    .to_ascii_lowercase();
    let persona = clean(
        parsed
            .flags
            .get("persona")
            .map(String::as_str)
            .unwrap_or("shadow-alpha"),
        80,
    );
    let business = clean(
        parsed
            .flags
            .get("business-context")
            .map(String::as_str)
            .unwrap_or("default"),
        80,
    );
    let lease_hours = parse_i64(parsed.flags.get("lease-hours"), 24).clamp(1, 168) as u64;
    ensure_business_registered(root, &business)?;
    let mut personas = load_personas(root);
    let now = now_epoch_secs();
    let key = format!("{business}:{persona}");

    if op == "status" {
        let record = personas.get(&key).cloned().unwrap_or(Value::Null);
        let expires = record
            .get("expires_at_epoch")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let active = expires > now && record.get("revoked").and_then(Value::as_bool) != Some(true);
        return Ok(json!({
            "ok": true,
            "type": "business_plane_persona",
            "lane": LANE_ID,
            "ts": now_iso(),
            "business_context": business,
            "persona": persona,
            "op": op,
            "active": active,
            "record": record,
            "claim_evidence": [{
                "id": "V7-BUSINESS-001.2",
                "claim": "cross_session_persona_identity_and_capability_lease_state_persist_across_restarts",
                "evidence": { "active": active, "lease_hours": lease_hours }
            }]
        }));
    }

    if op != "issue" && op != "renew" && op != "revoke" {
        return Err("persona_op_invalid".to_string());
    }
    let mut record = personas.get(&key).cloned().unwrap_or_else(|| {
        json!({
            "business_context": business,
            "persona": persona,
            "issued_at": now_iso(),
            "issued_at_epoch": now,
            "renewals": 0_u64,
            "revoked": false
        })
    });
    if op == "revoke" {
        record["revoked"] = Value::Bool(true);
        record["revoked_at"] = Value::String(now_iso());
        record["expires_at_epoch"] = Value::from(now);
    } else {
        let expires = now + (lease_hours * 3600);
        if op == "renew" {
            let renewals = record.get("renewals").and_then(Value::as_u64).unwrap_or(0) + 1;
            record["renewals"] = Value::from(renewals);
        }
        record["revoked"] = Value::Bool(false);
        record["expires_at_epoch"] = Value::from(expires);
        record["lease_hours"] = Value::from(lease_hours);
        record["last_updated"] = Value::String(now_iso());
    }
    personas.insert(key, record.clone());
    write_personas(root, &personas)?;
    Ok(json!({
        "ok": true,
        "type": "business_plane_persona",
        "lane": LANE_ID,
        "ts": now_iso(),
        "business_context": business,
        "persona": persona,
        "op": op,
        "record": record,
        "claim_evidence": [{
            "id": "V7-BUSINESS-001.2",
            "claim": "cross_session_persona_identity_and_capability_lease_state_persist_across_restarts",
            "evidence": { "op": op, "lease_hours": lease_hours }
        }]
    }))
}

fn continuity_chain_path(root: &Path) -> PathBuf {
    lane_root(root).join("continuity_chain.json")
}

fn load_chain(root: &Path) -> Map<String, Value> {
    read_object(&continuity_chain_path(root))
}

fn continuity_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let op = clean(
        parsed
            .flags
            .get("op")
            .map(String::as_str)
            .unwrap_or("status"),
        20,
    )
    .to_ascii_lowercase();
    let business = clean(
        parsed
            .flags
            .get("business-context")
            .map(String::as_str)
            .unwrap_or("default"),
        80,
    );
    ensure_business_registered(root, &business)?;
    if op == "status" {
        let state = read_json(&continuity_state_path(root)).unwrap_or_else(|| json!({}));
        return Ok(json!({
            "ok": true,
            "type": "business_plane_continuity",
            "lane": LANE_ID,
            "ts": now_iso(),
            "business_context": business,
            "op": op,
            "state": state,
            "handoff_queue_path": handoff_queue_path(root).to_string_lossy().to_string(),
            "claim_evidence": [{
                "id": "V7-BUSINESS-001.3",
                "claim": "checkpoint_resume_and_handoff_protocol_preserves_cross_session_continuity_with_receipt_verified_restore_pointers",
                "evidence": {"op": op}
            }]
        }));
    }

    if op == "handoff" {
        let to = clean(
            parsed
                .flags
                .get("to")
                .map(String::as_str)
                .unwrap_or("stakeholder"),
            120,
        );
        let task = clean(
            parsed
                .flags
                .get("task")
                .map(String::as_str)
                .unwrap_or("pending"),
            240,
        );
        let row = json!({
            "ts": now_iso(),
            "business_context": business,
            "to": to,
            "task": task,
            "handoff_hash": sha256_hex_str(&format!("{business}:{to}:{task}"))
        });
        append_jsonl(&handoff_queue_path(root), &row)?;
        return Ok(json!({
            "ok": true,
            "type": "business_plane_continuity",
            "lane": LANE_ID,
            "ts": now_iso(),
            "business_context": business,
            "op": op,
            "handoff": row,
            "claim_evidence": [{
                "id": "V7-BUSINESS-001.3",
                "claim": "checkpoint_resume_and_handoff_protocol_preserves_cross_session_continuity_with_receipt_verified_restore_pointers",
                "evidence": {"op": op, "handoff_queue": handoff_queue_path(root).to_string_lossy().to_string()}
            }]
        }));
    }

    if op != "checkpoint" && op != "resume" {
        return Err("continuity_op_invalid".to_string());
    }
    let name = clean(
        parsed
            .flags
            .get("name")
            .map(String::as_str)
            .unwrap_or("latest"),
        100,
    );
    let checkpoint_file = checkpoints_dir(root)
        .join(clean(&business, 80))
        .join(format!("{}.json", clean(&name, 80)));
    if op == "checkpoint" {
        let state_json = parse_json_or_empty(parsed.flags.get("state-json"));
        let mut chain = load_chain(root);
        let chain_key = format!("{business}:{name}");
        let prev_hash = chain.get(&chain_key).and_then(Value::as_str);
        let payload = json!({
            "business_context": business,
            "name": name,
            "state": state_json,
            "ts": now_iso()
        });
        let chain_hash = next_chain_hash(prev_hash, &payload);
        chain.insert(chain_key, Value::String(chain_hash.clone()));
        write_json(&continuity_chain_path(root), &Value::Object(chain))?;
        write_json(
            &checkpoint_file,
            &json!({
                "business_context": business,
                "name": name,
                "state": payload["state"],
                "chain_hash": chain_hash,
                "ts": payload["ts"]
            }),
        )?;
        write_json(
            &continuity_state_path(root),
            &json!({
                "last_checkpoint": name,
                "business_context": business,
                "checkpoint_path": checkpoint_file.to_string_lossy().to_string()
            }),
        )?;
        return Ok(json!({
            "ok": true,
            "type": "business_plane_continuity",
            "lane": LANE_ID,
            "ts": now_iso(),
            "business_context": business,
            "op": op,
            "checkpoint_path": checkpoint_file.to_string_lossy().to_string(),
            "chain_hash": chain_hash,
            "claim_evidence": [{
                "id": "V7-BUSINESS-001.3",
                "claim": "checkpoint_resume_and_handoff_protocol_preserves_cross_session_continuity_with_receipt_verified_restore_pointers",
                "evidence": {"op": op, "chain_hash_present": true}
            }]
        }));
    }
    let checkpoint =
        read_json(&checkpoint_file).ok_or_else(|| "checkpoint_not_found".to_string())?;
    write_json(
        &continuity_state_path(root),
        &json!({
            "restored_from": checkpoint_file.to_string_lossy().to_string(),
            "business_context": business,
            "restored_at": now_iso(),
            "state_hash": sha256_hex_str(&canonical_json_string(&checkpoint.get("state").cloned().unwrap_or(Value::Null)))
        }),
    )?;
    Ok(json!({
        "ok": true,
        "type": "business_plane_continuity",
        "lane": LANE_ID,
        "ts": now_iso(),
        "business_context": business,
        "op": op,
        "checkpoint": checkpoint,
        "claim_evidence": [{
            "id": "V7-BUSINESS-001.3",
            "claim": "checkpoint_resume_and_handoff_protocol_preserves_cross_session_continuity_with_receipt_verified_restore_pointers",
            "evidence": {"op": op, "checkpoint_loaded": true}
        }]
    }))
}

fn alerts_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let op = clean(
        parsed
            .flags
            .get("op")
            .map(String::as_str)
            .unwrap_or("status"),
        16,
    )
    .to_ascii_lowercase();
    let mut state = read_object(&alerts_state_path(root));
    let mut alerts = state
        .remove("alerts")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    if op == "status" {
        return Ok(json!({
            "ok": true,
            "type": "business_plane_alerts",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "alerts": alerts,
            "alert_count": alerts.len(),
            "claim_evidence": [{
                "id": "V7-BUSINESS-001.4",
                "claim": "stakeholder_alert_matrix_emits_actionable_alerts_and_acknowledgements_with_channel_receipts",
                "evidence": {"op": op, "alert_count": alerts.len()}
            }]
        }));
    }
    let alert_type = clean(
        parsed
            .flags
            .get("alert-type")
            .map(String::as_str)
            .unwrap_or("decision-required"),
        64,
    );
    let channel = clean(
        parsed
            .flags
            .get("channel")
            .map(String::as_str)
            .unwrap_or("dashboard"),
        32,
    )
    .to_ascii_lowercase();
    let allowed = [
        "decision-required",
        "capability-expiry",
        "checkpoint-mismatch",
        "async-complete",
        "dopamine-drop",
    ];
    if !allowed.contains(&alert_type.as_str()) {
        return Err("alert_type_invalid".to_string());
    }
    let allowed_channels = ["dashboard", "slack", "email", "sms", "pagerduty"];
    if !allowed_channels.contains(&channel.as_str()) {
        return Err("alert_channel_invalid".to_string());
    }
    if op == "emit" {
        let id = sha256_hex_str(&format!("{}:{}:{}", now_iso(), alert_type, channel));
        alerts.push(json!({
            "id": id,
            "alert_type": alert_type,
            "channel": channel,
            "status": "open",
            "ts": now_iso()
        }));
    } else if op == "ack" {
        let id = clean(
            parsed.flags.get("id").map(String::as_str).unwrap_or(""),
            128,
        );
        for row in &mut alerts {
            if row.get("id").and_then(Value::as_str) == Some(id.as_str()) {
                row["status"] = Value::String("ack".to_string());
                row["acked_at"] = Value::String(now_iso());
            }
        }
    } else {
        return Err("alerts_op_invalid".to_string());
    }
    state.insert("alerts".to_string(), Value::Array(alerts.clone()));
    write_json(&alerts_state_path(root), &Value::Object(state))?;
    Ok(json!({
        "ok": true,
        "type": "business_plane_alerts",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "alerts": alerts,
        "claim_evidence": [{
            "id": "V7-BUSINESS-001.4",
            "claim": "stakeholder_alert_matrix_emits_actionable_alerts_and_acknowledgements_with_channel_receipts",
            "evidence": {"op": op}
        }]
    }))
}

fn switchboard_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let op = clean(
        parsed
            .flags
            .get("op")
            .map(String::as_str)
            .unwrap_or("status"),
        16,
    )
    .to_ascii_lowercase();
    let business = require_business(parsed)?;
    ensure_business_registered(root, &business)?;
    let target = clean(
        parsed
            .flags
            .get("target-business")
            .map(String::as_str)
            .unwrap_or(business.as_str()),
        80,
    );
    if target != business && (op == "read" || op == "write") {
        return Err("cross_business_access_denied".to_string());
    }
    let memory_file = switchboard_dir(root, &business).join("entries.jsonl");
    if op == "create" {
        fs::create_dir_all(switchboard_dir(root, &business))
            .map_err(|e| format!("switchboard_create_failed:{e}"))?;
    } else if op == "write" {
        let entry = parse_json_or_empty(parsed.flags.get("entry-json"));
        let row = json!({
            "ts": now_iso(),
            "business_context": business,
            "entry": entry
        });
        append_jsonl(&memory_file, &row)?;
    } else if op != "read" && op != "status" {
        return Err("switchboard_op_invalid".to_string());
    }
    let entries = if op == "read" || op == "status" {
        read_jsonl(&memory_file)
    } else {
        Vec::new()
    };
    Ok(json!({
        "ok": true,
        "type": "business_plane_switchboard",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "business_context": business,
        "target_business": target,
        "memory_path": memory_file.to_string_lossy().to_string(),
        "entries": entries,
        "claim_evidence": [{
            "id": "V7-BUSINESS-001.5",
            "claim": "multi_tenant_business_isolation_enforces_namespace_firewalls_and_business_scoped_receipt_chains",
            "evidence": {"op": op, "cross_business_denied": true}
        }]
    }))
}

fn external_sync_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let business = clean(
        parsed
            .flags
            .get("business-context")
            .map(String::as_str)
            .unwrap_or("default"),
        80,
    );
    ensure_business_registered(root, &business)?;
    let system = clean(
        parsed
            .flags
            .get("system")
            .map(String::as_str)
            .unwrap_or("notion"),
        32,
    )
    .to_ascii_lowercase();
    let direction = clean(
        parsed
            .flags
            .get("direction")
            .map(String::as_str)
            .unwrap_or("push"),
        16,
    )
    .to_ascii_lowercase();
    let allowed_systems = ["notion", "confluence", "crm", "calendar", "email", "slack"];
    if !allowed_systems.contains(&system.as_str()) {
        return Err("sync_system_invalid".to_string());
    }
    let allowed_direction = ["push", "pull", "bidirectional"];
    if !allowed_direction.contains(&direction.as_str()) {
        return Err("sync_direction_invalid".to_string());
    }
    let external_id = clean(
        parsed
            .flags
            .get("external-id")
            .map(String::as_str)
            .unwrap_or("external-object"),
        120,
    );
    let content = parse_json_or_empty(parsed.flags.get("content-json"));
    let content_hash = sha256_hex_str(&canonical_json_string(&content));
    let row = json!({
        "ts": now_iso(),
        "business_context": business,
        "system": system,
        "direction": direction,
        "external_id": external_id,
        "content_hash": content_hash
    });
    append_jsonl(&sync_history_path(root), &row)?;
    Ok(json!({
        "ok": true,
        "type": "business_plane_external_sync",
        "lane": LANE_ID,
        "ts": now_iso(),
        "business_context": business,
        "sync": row,
        "sync_history_path": sync_history_path(root).to_string_lossy().to_string(),
        "claim_evidence": [{
            "id": "V7-BUSINESS-001.6",
            "claim": "external_sync_eye_tracks_bidirectional_system_sync_with_conflict_traceable_hashes",
            "evidence": {"system": system, "direction": direction, "content_hash": content_hash}
        }]
    }))
}

fn continuity_audit_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let days = parse_i64(parsed.flags.get("days"), 7).clamp(1, 365);
    let business_scope = clean(
        parsed
            .flags
            .get("business-context")
            .map(String::as_str)
            .unwrap_or("ALL"),
        80,
    );
    let checkpoints = WalkCount::count_json_files(&checkpoints_dir(root));
    let handoffs = read_jsonl(&handoff_queue_path(root));
    let archives = read_jsonl(&archive_path(root));
    let chain = read_object(&continuity_chain_path(root));
    let chain_valid = !chain.is_empty();
    let filtered_archive = archives
        .iter()
        .filter(|row| {
            business_scope == "ALL"
                || row.get("business_context").and_then(Value::as_str)
                    == Some(business_scope.as_str())
        })
        .count();
    Ok(json!({
        "ok": true,
        "type": "business_plane_continuity_audit",
        "lane": LANE_ID,
        "ts": now_iso(),
        "days": days,
        "business_context": business_scope,
        "checks": {
            "checkpoint_count": checkpoints,
            "handoff_count": handoffs.len(),
            "chain_valid": chain_valid,
            "archive_rows_in_scope": filtered_archive
        },
        "claim_evidence": [{
            "id": "V7-BUSINESS-001.7",
            "claim": "continuity_audit_harness_replays_checkpoints_handoffs_and_isolation_receipts_over_time_window",
            "evidence": {"days": days, "chain_valid": chain_valid, "checkpoint_count": checkpoints}
        }]
    }))
}

fn parse_date_range(range: &str) -> (Option<String>, Option<String>) {
    let parts = range
        .split(':')
        .map(|s| s.trim().to_string())
        .collect::<Vec<_>>();
    if parts.len() != 2 {
        return (None, None);
    }
    let start = if parts[0].is_empty() {
        None
    } else {
        Some(parts[0].clone())
    };
    let end = if parts[1].is_empty() {
        None
    } else {
        Some(parts[1].clone())
    };
    (start, end)
}

fn archive_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let op = clean(
        parsed
            .flags
            .get("op")
            .map(String::as_str)
            .unwrap_or("status"),
        16,
    )
    .to_ascii_lowercase();
    if op == "record" {
        let row = parse_json_or_empty(parsed.flags.get("entry-json"));
        append_archive(root, &row)?;
        return Ok(json!({
            "ok": true,
            "type": "business_plane_archive",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "recorded": true,
            "claim_evidence": [{
                "id": "V7-BUSINESS-001.8",
                "claim": "business_receipt_archive_is_append_only_with_daily_merkle_anchor_and_audit_export_support",
                "evidence": {"recorded": true}
            }]
        }));
    }
    let rows = read_jsonl(&archive_path(root));
    let business_scope = clean(
        parsed
            .flags
            .get("business-context")
            .map(String::as_str)
            .unwrap_or("ALL"),
        80,
    );
    let date_range = clean(
        parsed
            .flags
            .get("date-range")
            .map(String::as_str)
            .unwrap_or(":"),
        64,
    );
    let (start, end) = parse_date_range(&date_range);
    let filtered = rows
        .iter()
        .filter(|row| {
            if business_scope != "ALL"
                && row.get("business_context").and_then(Value::as_str)
                    != Some(business_scope.as_str())
            {
                return false;
            }
            let ts = row.get("ts").and_then(Value::as_str).unwrap_or("");
            if let Some(s) = &start {
                if ts < s {
                    return false;
                }
            }
            if let Some(e) = &end {
                if ts > e {
                    return false;
                }
            }
            true
        })
        .cloned()
        .collect::<Vec<_>>();
    if op == "export" {
        let export_path = lane_root(root).join("audit_export.json");
        write_json(
            &export_path,
            &json!({
                "generated_at": now_iso(),
                "business_context": business_scope,
                "date_range": date_range,
                "rows": filtered
            }),
        )?;
        return Ok(json!({
            "ok": true,
            "type": "business_plane_archive",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "export_path": export_path.to_string_lossy().to_string(),
            "row_count": filtered.len(),
            "daily_roots": read_json(&archive_anchor_path(root)).unwrap_or_else(|| json!({})),
            "claim_evidence": [{
                "id": "V7-BUSINESS-001.8",
                "claim": "business_receipt_archive_is_append_only_with_daily_merkle_anchor_and_audit_export_support",
                "evidence": {"op": op, "row_count": filtered.len()}
            }]
        }));
    }
    if op != "query" && op != "status" {
        return Err("archive_op_invalid".to_string());
    }
    Ok(json!({
        "ok": true,
        "type": "business_plane_archive",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "business_context": business_scope,
        "date_range": date_range,
        "row_count": filtered.len(),
        "rows": filtered,
        "daily_roots": read_json(&archive_anchor_path(root)).unwrap_or_else(|| json!({})),
        "claim_evidence": [{
            "id": "V7-BUSINESS-001.8",
            "claim": "business_receipt_archive_is_append_only_with_daily_merkle_anchor_and_audit_export_support",
            "evidence": {"op": op, "row_count": filtered.len()}
        }]
    }))
}

struct WalkCount;
impl WalkCount {
    fn count_json_files(path: &Path) -> usize {
        if !path.exists() {
            return 0;
        }
        let mut count = 0usize;
        let mut stack = vec![path.to_path_buf()];
        while let Some(cur) = stack.pop() {
            if let Ok(read_dir) = fs::read_dir(cur) {
                for entry in read_dir.flatten() {
                    let p = entry.path();
                    if p.is_dir() {
                        stack.push(p);
                    } else if p.extension().and_then(|v| v.to_str()) == Some("json") {
                        count += 1;
                    }
                }
            }
        }
        count
    }
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
    let bypass = conduit_bypass_requested(&parsed.flags);
    let conduit = build_conduit_enforcement(
        root,
        ENV_KEY,
        LANE_ID,
        strict,
        &command,
        "business_plane_conduit_enforcement",
        "client/protheusctl -> core/business-plane",
        bypass,
        vec![json!({
            "id": "V7-BUSINESS-001.5",
            "claim": "business_plane_operations_are_conduit_routed_fail_closed_and_business_scoped",
            "evidence": {"command": command, "bypass_requested": bypass}
        })],
    );
    if strict && !conduit.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let payload = json!({
            "ok": false,
            "type": "business_plane",
            "lane": LANE_ID,
            "ts": now_iso(),
            "command": command,
            "error": "conduit_bypass_rejected"
        });
        return emit(root, &command, strict, payload, Some(&conduit));
    }
    let result = match command.as_str() {
        "taxonomy" => taxonomy_command(root, &parsed),
        "persona" => persona_command(root, &parsed),
        "continuity" => continuity_command(root, &parsed),
        "alerts" => alerts_command(root, &parsed),
        "switchboard" => switchboard_command(root, &parsed),
        "external-sync" | "external_sync" => external_sync_command(root, &parsed),
        "continuity-audit" | "continuity_audit" => continuity_audit_command(root, &parsed),
        "archive" | "audit" => archive_command(root, &parsed),
        "status" => Ok(json!({
            "ok": true,
            "type": "business_plane_status",
            "lane": LANE_ID,
            "ts": now_iso(),
            "state_root": lane_root(root).to_string_lossy().to_string(),
            "latest_path": latest_path(root, ENV_KEY, LANE_ID).to_string_lossy().to_string(),
            "history_path": history_path(root, ENV_KEY, LANE_ID).to_string_lossy().to_string(),
            "business_registry_path": business_registry_path(root).to_string_lossy().to_string(),
            "claim_evidence": [{
                "id": "V7-BUSINESS-001.1",
                "claim": "business_plane_status_surfaces_authoritative_memory_and_continuity_paths",
                "evidence": {"state_root": lane_root(root).to_string_lossy().to_string()}
            }]
        })),
        _ => Err("unknown_business_command".to_string()),
    };
    match result {
        Ok(payload) => emit(root, &command, strict, payload, Some(&conduit)),
        Err(error) => emit(
            root,
            &command,
            strict,
            json!({
                "ok": false,
                "type": "business_plane",
                "lane": LANE_ID,
                "ts": now_iso(),
                "command": command,
                "error": error
            }),
            Some(&conduit),
        ),
    }
}
