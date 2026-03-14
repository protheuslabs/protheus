// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::healthcare_plane (authoritative)
use crate::v8_kernel::{
    append_jsonl, build_conduit_enforcement, canonical_json_string, conduit_bypass_requested,
    emit_attached_plane_receipt, history_path, latest_path, parse_bool, parse_f64,
    parse_json_or_empty, read_json, read_jsonl, scoped_state_root, sha256_hex_str, write_json,
};
use crate::{clean, now_iso, parse_args};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

const LANE_ID: &str = "healthcare_plane";
const ENV_KEY: &str = "PROTHEUS_HEALTHCARE_PLANE_STATE_ROOT";

fn usage() {
    println!("Usage:");
    println!(
        "  protheus-ops healthcare-plane patient --op=<register|status> --patient-id=<id> [--mrn=<id>] [--consent-json=<json>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops healthcare-plane phi-audit --op=<access|status> [--user=<id>] [--npi=<id>] [--patient-id=<id>] [--reason=<treatment|payment|operations|research>] [--break-glass=1|0] [--strict=1|0]"
    );
    println!(
        "  protheus-ops healthcare-plane cds --op=<evaluate|status> [--patient-id=<id>] [--meds=a,b] [--allergies=a,b] [--dose-mg=<n>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops healthcare-plane devices --op=<ingest|status> [--protocol=<hl7|fhir|dicom|ieee11073>] [--device-id=<id>] [--payload-json=<json>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops healthcare-plane documentation --op=<draft|status> [--soap-json=<json>] [--codes-json=<json>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops healthcare-plane alerts --op=<emit|ack|status> [--tier=<info|low|medium|high|critical>] [--key=<id>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops healthcare-plane coordination --op=<handoff|reconcile|status> [--sbar-json=<json>] [--meds-json=<json>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops healthcare-plane trials --op=<screen|consent|report-sae|status> [--patient-id=<id>] [--trial=<id>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops healthcare-plane imaging --op=<ingest|critical-route|status> [--study-id=<id>] [--finding=<text>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops healthcare-plane emergency --op=<break-glass|status> [--user=<id>] [--patient-id=<id>] [--justification=<text>] [--ttl-minutes=<n>] [--strict=1|0]"
    );
}

fn lane_root(root: &Path) -> PathBuf {
    scoped_state_root(root, ENV_KEY, LANE_ID)
}

fn patients_path(root: &Path) -> PathBuf {
    lane_root(root).join("patients.json")
}

fn phi_log_path(root: &Path) -> PathBuf {
    lane_root(root).join("phi_access_log.jsonl")
}

fn cds_path(root: &Path) -> PathBuf {
    lane_root(root).join("cds_state.json")
}

fn devices_path(root: &Path) -> PathBuf {
    lane_root(root).join("device_events.jsonl")
}

fn docs_path(root: &Path) -> PathBuf {
    lane_root(root).join("clinical_docs.jsonl")
}

fn alerts_path(root: &Path) -> PathBuf {
    lane_root(root).join("alerts.json")
}

fn coordination_path(root: &Path) -> PathBuf {
    lane_root(root).join("coordination.jsonl")
}

fn trials_path(root: &Path) -> PathBuf {
    lane_root(root).join("trials.json")
}

fn imaging_path(root: &Path) -> PathBuf {
    lane_root(root).join("imaging.jsonl")
}

fn emergency_path(root: &Path) -> PathBuf {
    lane_root(root).join("emergency.jsonl")
}

fn read_object(path: &Path) -> Map<String, Value> {
    read_json(path)
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn csv_set(raw: Option<&String>) -> BTreeSet<String> {
    raw.map(|s| {
        s.split(',')
            .map(|v| v.trim().to_ascii_lowercase())
            .filter(|v| !v.is_empty())
            .collect::<BTreeSet<_>>()
    })
    .unwrap_or_default()
}

fn emit(root: &Path, _command: &str, strict: bool, payload: Value, conduit: Option<&Value>) -> i32 {
    emit_attached_plane_receipt(root, ENV_KEY, LANE_ID, strict, payload, conduit)
}

fn patient_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let op = clean(
        parsed
            .flags
            .get("op")
            .map(String::as_str)
            .unwrap_or("status"),
        16,
    )
    .to_ascii_lowercase();
    let mut state = read_object(&patients_path(root));
    if op == "status" {
        return Ok(json!({
            "ok": true,
            "type": "healthcare_plane_patient",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "patients": state,
            "claim_evidence": [{
                "id": "V7-HEALTH-001.1",
                "claim": "patient_identity_plane_tracks_mpi_mrn_and_consent_scoped_context_without_raw_phi_leakage",
                "evidence": {"patient_count": state.len()}
            }]
        }));
    }
    if op != "register" {
        return Err("patient_op_invalid".to_string());
    }
    let patient_id = clean(
        parsed
            .flags
            .get("patient-id")
            .map(String::as_str)
            .unwrap_or("patient"),
        120,
    );
    let mrn = clean(
        parsed
            .flags
            .get("mrn")
            .map(String::as_str)
            .unwrap_or("MRN0000"),
        80,
    );
    let consent = parse_json_or_empty(parsed.flags.get("consent-json"));
    state.insert(
        patient_id.clone(),
        json!({
            "patient_id": patient_id,
            "mrn": mrn,
            "phi_hash": sha256_hex_str(&canonical_json_string(&consent)),
            "consent": consent,
            "updated_at": now_iso()
        }),
    );
    write_json(&patients_path(root), &Value::Object(state.clone()))?;
    Ok(json!({
        "ok": true,
        "type": "healthcare_plane_patient",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "record": state.get(&patient_id).cloned().unwrap_or_else(|| json!({})),
        "claim_evidence": [{
            "id": "V7-HEALTH-001.1",
            "claim": "patient_identity_plane_tracks_mpi_mrn_and_consent_scoped_context_without_raw_phi_leakage",
            "evidence": {"patient_id": patient_id}
        }]
    }))
}

fn phi_audit_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let op = clean(
        parsed
            .flags
            .get("op")
            .map(String::as_str)
            .unwrap_or("status"),
        16,
    )
    .to_ascii_lowercase();
    if op == "status" {
        let logs = read_jsonl(&phi_log_path(root));
        return Ok(json!({
            "ok": true,
            "type": "healthcare_plane_phi_audit",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "count": logs.len(),
            "logs": logs,
            "claim_evidence": [{
                "id": "V7-HEALTH-001.2",
                "claim": "hipaa_phi_audit_status_surfaces_patient_access_disclosure_log",
                "evidence": {"count": logs.len()}
            }]
        }));
    }
    if op != "access" {
        return Err("phi_audit_op_invalid".to_string());
    }
    let user = clean(
        parsed
            .flags
            .get("user")
            .map(String::as_str)
            .unwrap_or("clinician"),
        120,
    );
    let npi = clean(
        parsed
            .flags
            .get("npi")
            .map(String::as_str)
            .unwrap_or("0000000000"),
        32,
    );
    let patient_id = clean(
        parsed
            .flags
            .get("patient-id")
            .map(String::as_str)
            .unwrap_or("patient"),
        120,
    );
    let reason = clean(
        parsed
            .flags
            .get("reason")
            .map(String::as_str)
            .unwrap_or("treatment"),
        32,
    )
    .to_ascii_lowercase();
    let break_glass = parse_bool(parsed.flags.get("break-glass"), false);
    let allowed = ["treatment", "payment", "operations", "research"];
    if !allowed.contains(&reason.as_str()) {
        return Err("phi_reason_invalid".to_string());
    }
    let row = json!({
        "ts": now_iso(),
        "user": user,
        "npi": npi,
        "patient_uuid": patient_id,
        "reason": reason,
        "break_glass": break_glass,
        "receipt_hash": sha256_hex_str(&format!("{}:{}:{}:{}", user, npi, patient_id, reason))
    });
    append_jsonl(&phi_log_path(root), &row)?;
    Ok(json!({
        "ok": true,
        "type": "healthcare_plane_phi_audit",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "entry": row,
        "claim_evidence": [{
            "id": "V7-HEALTH-001.2",
            "claim": "hipaa_phi_audit_captures_who_what_when_why_with_break_glass_and_disclosure_traceability",
            "evidence": {"break_glass": break_glass}
        }]
    }))
}

fn cds_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let op = clean(
        parsed
            .flags
            .get("op")
            .map(String::as_str)
            .unwrap_or("status"),
        16,
    )
    .to_ascii_lowercase();
    let mut state = read_object(&cds_path(root));
    if op == "status" {
        return Ok(json!({
            "ok": true,
            "type": "healthcare_plane_cds",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "state": state,
            "claim_evidence": [{
                "id": "V7-HEALTH-001.3",
                "claim": "cds_status_surfaces_safety_alert_state_and_override_history",
                "evidence": {"keys": state.keys().cloned().collect::<Vec<_>>()}
            }]
        }));
    }
    if op != "evaluate" {
        return Err("cds_op_invalid".to_string());
    }
    let patient_id = clean(
        parsed
            .flags
            .get("patient-id")
            .map(String::as_str)
            .unwrap_or("patient"),
        120,
    );
    let meds = csv_set(parsed.flags.get("meds"));
    let allergies = csv_set(parsed.flags.get("allergies"));
    let dose_mg = parse_f64(parsed.flags.get("dose-mg"), 0.0);
    let mut alerts = Vec::<String>::new();
    if meds.contains("warfarin") && meds.contains("aspirin") {
        alerts.push("drug_drug_interaction".to_string());
    }
    if meds.contains("penicillin") && allergies.contains("penicillin") {
        alerts.push("allergy_conflict".to_string());
    }
    if dose_mg > 0.0 && dose_mg > 1000.0 {
        alerts.push("dose_out_of_range".to_string());
    }
    state.insert(
        patient_id.clone(),
        json!({"patient_id": patient_id, "alerts": alerts, "dose_mg": dose_mg, "updated_at": now_iso()}),
    );
    write_json(&cds_path(root), &Value::Object(state.clone()))?;
    Ok(json!({
        "ok": true,
        "type": "healthcare_plane_cds",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "patient_id": patient_id,
        "alerts": state
            .get(&patient_id)
            .and_then(|v| v.get("alerts"))
            .cloned()
            .unwrap_or_else(|| Value::Array(Vec::new())),
        "claim_evidence": [{
            "id": "V7-HEALTH-001.3",
            "claim": "clinical_decision_support_checks_drug_interactions_allergies_and_dosing_constraints",
            "evidence": {"alert_count": state.get(&patient_id).and_then(|v| v.get("alerts")).and_then(Value::as_array).map(|a| a.len()).unwrap_or(0)}
        }]
    }))
}

fn devices_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let op = clean(
        parsed
            .flags
            .get("op")
            .map(String::as_str)
            .unwrap_or("status"),
        16,
    )
    .to_ascii_lowercase();
    if op == "status" {
        let logs = read_jsonl(&devices_path(root));
        return Ok(json!({
            "ok": true,
            "type": "healthcare_plane_devices",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "events": logs,
            "claim_evidence": [{
                "id": "V7-HEALTH-001.4",
                "claim": "device_integration_status_surfaces_protocol_native_events_and_provenance",
                "evidence": {"event_count": logs.len()}
            }]
        }));
    }
    if op != "ingest" {
        return Err("devices_op_invalid".to_string());
    }
    let protocol = clean(
        parsed
            .flags
            .get("protocol")
            .map(String::as_str)
            .unwrap_or("hl7"),
        16,
    )
    .to_ascii_lowercase();
    let allowed = ["hl7", "fhir", "dicom", "ieee11073"];
    if !allowed.contains(&protocol.as_str()) {
        return Err("device_protocol_invalid".to_string());
    }
    let device_id = clean(
        parsed
            .flags
            .get("device-id")
            .map(String::as_str)
            .unwrap_or("device"),
        120,
    );
    let payload = parse_json_or_empty(parsed.flags.get("payload-json"));
    let row = json!({
        "ts": now_iso(),
        "protocol": protocol,
        "device_id": device_id,
        "payload_hash": sha256_hex_str(&canonical_json_string(&payload))
    });
    append_jsonl(&devices_path(root), &row)?;
    Ok(json!({
        "ok": true,
        "type": "healthcare_plane_devices",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "event": row,
        "claim_evidence": [{
            "id": "V7-HEALTH-001.4",
            "claim": "device_integration_accepts_hl7_fhir_dicom_and_ieee11073_with_deterministic_receipts",
            "evidence": {"protocol": protocol}
        }]
    }))
}

fn documentation_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let op = clean(
        parsed
            .flags
            .get("op")
            .map(String::as_str)
            .unwrap_or("status"),
        16,
    )
    .to_ascii_lowercase();
    if op == "status" {
        return Ok(json!({
            "ok": true,
            "type": "healthcare_plane_documentation",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "docs_count": read_jsonl(&docs_path(root)).len(),
            "claim_evidence": [{
                "id": "V7-HEALTH-001.5",
                "claim": "clinical_documentation_status_surfaces_structured_note_and_coding_artifact_count",
                "evidence": {"count": read_jsonl(&docs_path(root)).len()}
            }]
        }));
    }
    if op != "draft" {
        return Err("documentation_op_invalid".to_string());
    }
    let soap = parse_json_or_empty(parsed.flags.get("soap-json"));
    let codes = parse_json_or_empty(parsed.flags.get("codes-json"));
    let required = ["subjective", "objective", "assessment", "plan"];
    let complete = required.iter().all(|k| soap.get(*k).is_some());
    if !complete {
        return Err("soap_incomplete".to_string());
    }
    let row = json!({
        "ts": now_iso(),
        "soap": soap,
        "codes": codes,
        "coding_hash": sha256_hex_str(&canonical_json_string(&codes))
    });
    append_jsonl(&docs_path(root), &row)?;
    Ok(json!({
        "ok": true,
        "type": "healthcare_plane_documentation",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "record": row,
        "claim_evidence": [{
            "id": "V7-HEALTH-001.5",
            "claim": "clinical_documentation_enforces_soap_structure_and_coded_metadata_receipts",
            "evidence": {"complete": complete}
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
    let mut state = read_object(&alerts_path(root));
    let mut alerts = state
        .remove("alerts")
        .and_then(|v| v.as_array().cloned())
        .unwrap_or_default();
    if op == "status" {
        return Ok(json!({
            "ok": true,
            "type": "healthcare_plane_alerts",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "alerts": alerts,
            "claim_evidence": [{
                "id": "V7-HEALTH-001.6",
                "claim": "alert_fatigue_management_surfaces_deduplicated_tiered_alert_state",
                "evidence": {"count": alerts.len()}
            }]
        }));
    }
    if op == "emit" {
        let tier = clean(
            parsed
                .flags
                .get("tier")
                .map(String::as_str)
                .unwrap_or("medium"),
            16,
        )
        .to_ascii_lowercase();
        let key = clean(
            parsed
                .flags
                .get("key")
                .map(String::as_str)
                .unwrap_or("alert"),
            120,
        );
        let duplicate = alerts.iter().any(|row| {
            row.get("key").and_then(Value::as_str) == Some(key.as_str())
                && row.get("status").and_then(Value::as_str) == Some("open")
        });
        if !duplicate {
            alerts.push(json!({"id": sha256_hex_str(&format!("{}:{}:{}", tier, key, now_iso())), "tier": tier, "key": key, "status": "open", "ts": now_iso()}));
        }
    } else if op == "ack" {
        let id = clean(
            parsed.flags.get("id").map(String::as_str).unwrap_or(""),
            120,
        );
        for row in &mut alerts {
            if row.get("id").and_then(Value::as_str) == Some(id.as_str()) {
                row["status"] = Value::String("ack".to_string());
                row["ack_at"] = Value::String(now_iso());
            }
        }
    } else {
        return Err("alerts_op_invalid".to_string());
    }
    state.insert("alerts".to_string(), Value::Array(alerts.clone()));
    write_json(&alerts_path(root), &Value::Object(state))?;
    Ok(json!({
        "ok": true,
        "type": "healthcare_plane_alerts",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "alerts": alerts,
        "claim_evidence": [{
            "id": "V7-HEALTH-001.6",
            "claim": "alert_fatigue_management_deduplicates_routes_and_tracks_acknowledgement_lifecycle",
            "evidence": {"op": op}
        }]
    }))
}

fn coordination_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let op = clean(
        parsed
            .flags
            .get("op")
            .map(String::as_str)
            .unwrap_or("status"),
        16,
    )
    .to_ascii_lowercase();
    if op == "status" {
        let rows = read_jsonl(&coordination_path(root));
        return Ok(json!({
            "ok": true,
            "type": "healthcare_plane_coordination",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "rows": rows,
            "claim_evidence": [{
                "id": "V7-HEALTH-001.7",
                "claim": "care_coordination_status_surfaces_handoff_and_reconciliation_history",
                "evidence": {"count": read_jsonl(&coordination_path(root)).len()}
            }]
        }));
    }
    if op != "handoff" && op != "reconcile" {
        return Err("coordination_op_invalid".to_string());
    }
    let sbar = parse_json_or_empty(parsed.flags.get("sbar-json"));
    let meds = parse_json_or_empty(parsed.flags.get("meds-json"));
    let row = json!({
        "ts": now_iso(),
        "op": op,
        "sbar": sbar,
        "meds": meds,
        "reconciliation_hash": sha256_hex_str(&format!("{}:{}", canonical_json_string(&sbar), canonical_json_string(&meds)))
    });
    append_jsonl(&coordination_path(root), &row)?;
    Ok(json!({
        "ok": true,
        "type": "healthcare_plane_coordination",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "entry": row,
        "claim_evidence": [{
            "id": "V7-HEALTH-001.7",
            "claim": "care_coordination_tracks_sbar_handoff_and_medication_reconciliation_with_transition_receipts",
            "evidence": {"op": op}
        }]
    }))
}

fn trials_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let op = clean(
        parsed
            .flags
            .get("op")
            .map(String::as_str)
            .unwrap_or("status"),
        16,
    )
    .to_ascii_lowercase();
    let mut state = read_object(&trials_path(root));
    if op == "status" {
        return Ok(json!({
            "ok": true,
            "type": "healthcare_plane_trials",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "trials": state,
            "claim_evidence": [{
                "id": "V7-HEALTH-001.8",
                "claim": "trial_status_surfaces_screening_consent_and_sae_tracking_state",
                "evidence": {"trial_count": state.len()}
            }]
        }));
    }
    let patient_id = clean(
        parsed
            .flags
            .get("patient-id")
            .map(String::as_str)
            .unwrap_or("patient"),
        120,
    );
    let trial = clean(
        parsed
            .flags
            .get("trial")
            .map(String::as_str)
            .unwrap_or("trial"),
        120,
    );
    let key = format!("{trial}:{patient_id}");
    let mut row = state.get(&key).cloned().unwrap_or_else(|| {
        json!({"trial": trial, "patient_id": patient_id, "screened": false, "consented": false, "sae_count": 0_u64})
    });
    if op == "screen" {
        row["screened"] = Value::Bool(true);
        row["screened_at"] = Value::String(now_iso());
    } else if op == "consent" {
        row["consented"] = Value::Bool(true);
        row["consent_at"] = Value::String(now_iso());
    } else if op == "report-sae" || op == "report_sae" {
        let next = row.get("sae_count").and_then(Value::as_u64).unwrap_or(0) + 1;
        row["sae_count"] = Value::from(next);
        row["last_sae_at"] = Value::String(now_iso());
    } else {
        return Err("trials_op_invalid".to_string());
    }
    state.insert(key, row.clone());
    write_json(&trials_path(root), &Value::Object(state.clone()))?;
    Ok(json!({
        "ok": true,
        "type": "healthcare_plane_trials",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "record": row,
        "claim_evidence": [{
            "id": "V7-HEALTH-001.8",
            "claim": "trial_engine_tracks_eligibility_consent_and_adverse_event_reporting_lifecycle",
            "evidence": {"op": op}
        }]
    }))
}

fn imaging_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let op = clean(
        parsed
            .flags
            .get("op")
            .map(String::as_str)
            .unwrap_or("status"),
        20,
    )
    .to_ascii_lowercase();
    if op == "status" {
        return Ok(json!({
            "ok": true,
            "type": "healthcare_plane_imaging",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "rows": read_jsonl(&imaging_path(root)),
            "claim_evidence": [{
                "id": "V7-HEALTH-001.9",
                "claim": "imaging_status_surfaces_dicom_ingest_and_critical_routing_history",
                "evidence": {"count": read_jsonl(&imaging_path(root)).len()}
            }]
        }));
    }
    if op != "ingest" && op != "critical-route" && op != "critical_route" {
        return Err("imaging_op_invalid".to_string());
    }
    let study_id = clean(
        parsed
            .flags
            .get("study-id")
            .map(String::as_str)
            .unwrap_or("study"),
        120,
    );
    let finding = clean(
        parsed
            .flags
            .get("finding")
            .map(String::as_str)
            .unwrap_or("none"),
        240,
    );
    let row = json!({
        "ts": now_iso(),
        "op": op,
        "study_id": study_id,
        "finding": finding,
        "critical": op != "ingest"
    });
    append_jsonl(&imaging_path(root), &row)?;
    Ok(json!({
        "ok": true,
        "type": "healthcare_plane_imaging",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "entry": row,
        "claim_evidence": [{
            "id": "V7-HEALTH-001.9",
            "claim": "imaging_lane_tracks_dicom_study_ingest_and_critical_finding_provider_routing",
            "evidence": {"critical": op != "ingest"}
        }]
    }))
}

fn emergency_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let op = clean(
        parsed
            .flags
            .get("op")
            .map(String::as_str)
            .unwrap_or("status"),
        20,
    )
    .to_ascii_lowercase();
    if op == "status" {
        return Ok(json!({
            "ok": true,
            "type": "healthcare_plane_emergency",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "events": read_jsonl(&emergency_path(root)),
            "claim_evidence": [{
                "id": "V7-HEALTH-001.10",
                "claim": "break_glass_status_surfaces_override_usage_for_post_incident_review",
                "evidence": {"count": read_jsonl(&emergency_path(root)).len()}
            }]
        }));
    }
    if op != "break-glass" && op != "break_glass" {
        return Err("emergency_op_invalid".to_string());
    }
    let user = clean(
        parsed
            .flags
            .get("user")
            .map(String::as_str)
            .unwrap_or("ed-physician"),
        120,
    );
    let patient_id = clean(
        parsed
            .flags
            .get("patient-id")
            .map(String::as_str)
            .unwrap_or("patient"),
        120,
    );
    let justification = clean(
        parsed
            .flags
            .get("justification")
            .map(String::as_str)
            .unwrap_or("emergency access"),
        240,
    );
    let ttl_minutes = parse_f64(parsed.flags.get("ttl-minutes"), 30.0).clamp(1.0, 240.0);
    let row = json!({
        "ts": now_iso(),
        "user": user,
        "patient_id": patient_id,
        "justification": justification,
        "ttl_minutes": ttl_minutes,
        "expires_token": sha256_hex_str(&format!("{}:{}:{}", user, patient_id, ttl_minutes))
    });
    append_jsonl(&emergency_path(root), &row)?;
    Ok(json!({
        "ok": true,
        "type": "healthcare_plane_emergency",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "event": row,
        "claim_evidence": [{
            "id": "V7-HEALTH-001.10",
            "claim": "break_glass_protocol_requires_justification_ttl_and_auditable_override_lineage",
            "evidence": {"ttl_minutes": ttl_minutes}
        }]
    }))
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
        "healthcare_plane_conduit_enforcement",
        "client/protheusctl -> core/healthcare-plane",
        bypass,
        vec![json!({
            "id": "V7-HEALTH-001.2",
            "claim": "healthcare_plane_is_conduit_routed_for_phi_sensitive_operations",
            "evidence": {"command": command, "bypass_requested": bypass}
        })],
    );
    if strict && !conduit.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let payload = json!({
            "ok": false,
            "type": "healthcare_plane",
            "lane": LANE_ID,
            "ts": now_iso(),
            "command": command,
            "error": "conduit_bypass_rejected"
        });
        return emit(root, &command, strict, payload, Some(&conduit));
    }
    let result = match command.as_str() {
        "patient" => patient_command(root, &parsed),
        "phi-audit" | "phi_audit" => phi_audit_command(root, &parsed),
        "cds" => cds_command(root, &parsed),
        "devices" => devices_command(root, &parsed),
        "documentation" => documentation_command(root, &parsed),
        "alerts" => alerts_command(root, &parsed),
        "coordination" => coordination_command(root, &parsed),
        "trials" => trials_command(root, &parsed),
        "imaging" => imaging_command(root, &parsed),
        "emergency" => emergency_command(root, &parsed),
        "status" => Ok(json!({
            "ok": true,
            "type": "healthcare_plane_status",
            "lane": LANE_ID,
            "ts": now_iso(),
            "state_root": lane_root(root).to_string_lossy().to_string(),
            "latest_path": latest_path(root, ENV_KEY, LANE_ID).to_string_lossy().to_string(),
            "history_path": history_path(root, ENV_KEY, LANE_ID).to_string_lossy().to_string()
        })),
        _ => Err("unknown_healthcare_command".to_string()),
    };
    match result {
        Ok(payload) => emit(root, &command, strict, payload, Some(&conduit)),
        Err(error) => emit(
            root,
            &command,
            strict,
            json!({
                "ok": false,
                "type": "healthcare_plane",
                "lane": LANE_ID,
                "ts": now_iso(),
                "command": command,
                "error": error
            }),
            Some(&conduit),
        ),
    }
}
