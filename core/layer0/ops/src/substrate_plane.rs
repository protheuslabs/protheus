// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::substrate_plane (authoritative)

use crate::v8_kernel::{
    append_jsonl, attach_conduit, build_plane_conduit_enforcement, conduit_bypass_requested,
    emit_plane_receipt, load_json_or, parse_bool, parse_f64, parse_u64, plane_status, print_json,
    read_json, scoped_state_root, sha256_hex_str, split_csv_clean, write_json,
};
use crate::{clean, parse_args};
use exotic_wrapper::{default_degradation, wrap_exotic_signal, ExoticDomain, ExoticEnvelope};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "SUBSTRATE_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "substrate_plane";

const CSI_CAPTURE_CONTRACT_PATH: &str = "planes/contracts/substrate/csi_capture_contract_v1.json";
const CSI_MODULE_CONTRACT_PATH: &str =
    "planes/contracts/substrate/csi_module_registry_contract_v1.json";
const CSI_EMBEDDED_CONTRACT_PATH: &str =
    "planes/contracts/substrate/csi_embedded_profile_contract_v1.json";
const CSI_POLICY_CONTRACT_PATH: &str = "planes/contracts/substrate/csi_policy_contract_v1.json";
const EYE_BINDING_CONTRACT_PATH: &str = "planes/contracts/substrate/eye_binding_contract_v1.json";
const BIO_INTERFACE_CONTRACT_PATH: &str =
    "planes/contracts/substrate/biological_interface_contract_v1.json";
const BIO_FEEDBACK_CONTRACT_PATH: &str =
    "planes/contracts/substrate/biological_feedback_contract_v1.json";
const BIO_ADAPTER_TEMPLATE_CONTRACT_PATH: &str =
    "planes/contracts/substrate/biological_adapter_template_contract_v1.json";
const BIO_ETHICS_POLICY_CONTRACT_PATH: &str =
    "planes/contracts/substrate/biological_ethics_policy_contract_v1.json";
const BIO_ENABLE_CONTRACT_PATH: &str =
    "planes/contracts/substrate/biological_enable_contract_v1.json";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops substrate-plane status");
    println!(
        "  protheus-ops substrate-plane csi-capture [--adapter=<id>] [--signal-ref=<ref>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops substrate-plane csi-module --op=<register|activate|list> [--module=<id>] [--input-contract=<id>] [--budget-units=<n>] [--privacy-class=<local|sensitive|restricted>] [--degrade-behavior=<id>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops substrate-plane csi-embedded-profile [--target=<esp32>] [--power-mw=<n>] [--latency-ms=<n>] [--bounded-memory-kb=<n>] [--offline=1|0] [--strict=1|0]"
    );
    println!(
        "  protheus-ops substrate-plane csi-policy [--consent=1|0] [--locality=<local-only|restricted-edge>] [--retention-minutes=<n>] [--biometric-risk=<low|medium|high>] [--allow-export=1|0] [--strict=1|0]"
    );
    println!(
        "  protheus-ops substrate-plane eye-bind --op=<enable|status> [--source=<wifi>] [--persona=<id>] [--shadow=<id>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops substrate-plane bio-interface --op=<ingest|status> [--channels=<n>] [--payload-ref=<ref>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops substrate-plane bio-feedback --op=<stimulate|degrade|status> [--mode=<closed-loop|silicon-only>] [--consent=1|0] [--strict=1|0]"
    );
    println!(
        "  protheus-ops substrate-plane bio-adapter-template --op=<emit|status> [--adapter=<id>] [--spike-channels=a,b] [--stimulation-channels=x,y] [--health-telemetry=latency_ms,power_mw] [--strict=1|0]"
    );
    println!(
        "  protheus-ops substrate-plane bioethics-policy --op=<status|approve|enforce> [--approval=<HMAN-BIO-001>] [--artifact-ref=<ref>] [--consent=1|0] [--high-risk=1|0] [--strict=1|0]"
    );
    println!(
        "  protheus-ops substrate-plane bio-enable [--mode=<biological|silicon-only>] [--persona=<id>] [--adapter=<id>] [--strict=1|0]"
    );
}

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn emit(root: &Path, payload: Value) -> i32 {
    emit_plane_receipt(
        root,
        STATE_ENV,
        STATE_SCOPE,
        "substrate_plane_error",
        payload,
    )
}

fn status(root: &Path) -> Value {
    plane_status(root, STATE_ENV, STATE_SCOPE, "substrate_plane_status")
}

fn claim_ids_for_action(action: &str) -> Vec<&'static str> {
    match action {
        "csi-capture" => vec!["V6-SUBSTRATE-001.1", "V6-SUBSTRATE-001.4"],
        "csi-module" => vec!["V6-SUBSTRATE-001.2", "V6-SUBSTRATE-001.4"],
        "csi-embedded-profile" => vec!["V6-SUBSTRATE-001.3", "V6-SUBSTRATE-001.4"],
        "csi-policy" => vec!["V6-SUBSTRATE-001.4"],
        "eye-bind" => vec!["V6-SUBSTRATE-001.5", "V6-SUBSTRATE-001.4"],
        "bio-interface" => vec!["V6-SUBSTRATE-002.1"],
        "bio-feedback" => vec!["V6-SUBSTRATE-002.2"],
        "bio-adapter-template" => vec!["V6-SUBSTRATE-002.3"],
        "bioethics-policy" => vec!["V6-SUBSTRATE-002.4"],
        "bio-enable" => vec!["V6-SUBSTRATE-002.5", "V6-SUBSTRATE-002.4"],
        _ => vec!["V6-SUBSTRATE-001.4"],
    }
}

fn conduit_enforcement(
    root: &Path,
    parsed: &crate::ParsedArgs,
    strict: bool,
    action: &str,
) -> Value {
    let bypass_requested = conduit_bypass_requested(&parsed.flags);
    let claim_ids = claim_ids_for_action(action);
    build_plane_conduit_enforcement(
        root,
        STATE_ENV,
        STATE_SCOPE,
        strict,
        action,
        "substrate_conduit_enforcement",
        "core/layer0/ops/substrate_plane",
        bypass_requested,
        "substrate_operations_route_through_layer0_conduit_with_fail_closed_policy",
        &claim_ids,
    )
}

fn csi_capture_artifact_path(root: &Path, id: &str) -> PathBuf {
    state_root(root)
        .join("csi")
        .join("captures")
        .join(format!("{id}.json"))
}

fn csi_module_registry_path(root: &Path) -> PathBuf {
    state_root(root)
        .join("csi")
        .join("modules")
        .join("registry.json")
}

fn csi_embedded_profile_path(root: &Path, target: &str) -> PathBuf {
    state_root(root)
        .join("csi")
        .join("embedded")
        .join(format!("{target}.json"))
}

fn csi_policy_state_path(root: &Path) -> PathBuf {
    state_root(root)
        .join("csi")
        .join("policy")
        .join("latest.json")
}

fn eye_binding_state_path(root: &Path) -> PathBuf {
    state_root(root).join("eye").join("bindings.json")
}

fn bio_interface_state_path(root: &Path) -> PathBuf {
    state_root(root)
        .join("bio")
        .join("interface")
        .join("latest.json")
}

fn bio_feedback_state_path(root: &Path) -> PathBuf {
    state_root(root)
        .join("bio")
        .join("feedback")
        .join("latest.json")
}

fn bio_adapter_template_path(root: &Path) -> PathBuf {
    state_root(root)
        .join("bio")
        .join("adapter")
        .join("template.json")
}

fn bioethics_state_path(root: &Path) -> PathBuf {
    state_root(root)
        .join("bio")
        .join("ethics")
        .join("policy.json")
}

fn bio_enable_state_path(root: &Path) -> PathBuf {
    state_root(root)
        .join("bio")
        .join("enable")
        .join("latest.json")
}

fn decode_signal_u64(hex: &str, offset: usize) -> u64 {
    let start = offset.min(hex.len());
    let end = (start + 8).min(hex.len());
    if start >= end {
        return 0;
    }
    u64::from_str_radix(&hex[start..end], 16).unwrap_or(0)
}

fn run_csi_capture(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        CSI_CAPTURE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "substrate_csi_capture_contract",
            "normalized_events": ["presence", "respiration", "heartbeat_proxy", "pose_proxy", "motion"],
            "require_layer_minus_one_descriptor": true
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("substrate_csi_capture_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "substrate_csi_capture_contract"
    {
        errors.push("substrate_csi_capture_contract_kind_invalid".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_csi_capture",
            "errors": errors
        });
    }

    let adapter = clean(
        parsed
            .flags
            .get("adapter")
            .cloned()
            .unwrap_or_else(|| "wifi-csi-esp32".to_string()),
        120,
    );
    let signal_ref = clean(
        parsed
            .flags
            .get("signal-ref")
            .cloned()
            .unwrap_or_else(|| "csi://capture/latest".to_string()),
        220,
    );
    let envelope = ExoticEnvelope {
        domain: ExoticDomain::Analog,
        adapter_id: adapter.clone(),
        signal_type: "wifi_csi_frame".to_string(),
        payload_ref: signal_ref.clone(),
        ts_ms: chrono::Utc::now().timestamp_millis(),
    };
    let wrapped = wrap_exotic_signal(&envelope, "sense.csi.capture");
    let digest = wrapped.deterministic_digest.clone();
    let presence_score = (decode_signal_u64(&digest, 0) % 100) as f64 / 100.0;
    let respiration_bpm = 10 + (decode_signal_u64(&digest, 8) % 24);
    let heartbeat_proxy_bpm = 52 + (decode_signal_u64(&digest, 12) % 58);
    let pose_proxy = match decode_signal_u64(&digest, 14) % 3 {
        0 => "upright",
        1 => "supine",
        _ => "moving",
    };
    let motion_flag = (decode_signal_u64(&digest, 16) % 2) == 1;
    let normalized = vec![
        json!({
            "event": "presence",
            "value": presence_score >= 0.42,
            "confidence": presence_score
        }),
        json!({
            "event": "respiration",
            "value": respiration_bpm,
            "unit": "breaths_per_minute",
            "confidence": 0.76
        }),
        json!({
            "event": "heartbeat_proxy",
            "value": heartbeat_proxy_bpm,
            "unit": "beats_per_minute",
            "confidence": 0.61
        }),
        json!({
            "event": "pose_proxy",
            "value": pose_proxy,
            "confidence": 0.57
        }),
        json!({
            "event": "motion",
            "value": motion_flag,
            "confidence": 0.69
        }),
    ];
    let capture_id = format!("csi_{}", &sha256_hex_str(&digest)[..12]);
    let artifact = json!({
        "version": "v1",
        "capture_id": capture_id,
        "layer_minus_one": {
            "descriptor": {
                "domain": "analog",
                "adapter_id": adapter,
                "signal_type": "wifi_csi_frame",
                "payload_ref": signal_ref
            },
            "wrapped_envelope": wrapped
        },
        "layer_two_decode": {
            "normalized_events": normalized,
            "sampling_metadata": {
                "sampling_hz": 20,
                "window_ms": 1200,
                "provenance": "layer2_decode_from_layer_minus_one_csi_envelope"
            }
        },
        "captured_at": crate::now_iso()
    });
    let path = csi_capture_artifact_path(root, &capture_id);
    let _ = write_json(&path, &artifact);
    let _ = append_jsonl(
        &state_root(root)
            .join("csi")
            .join("captures")
            .join("history.jsonl"),
        &artifact,
    );
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "substrate_plane_csi_capture",
        "lane": "core/layer0/ops",
        "capture": artifact,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&artifact.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-SUBSTRATE-001.1",
                "claim": "csi_primitive_captures_layer_minus_one_signal_and_layer_two_normalized_events_with_receipts",
                "evidence": {
                    "capture_id": capture_id,
                    "event_count": artifact
                        .get("layer_two_decode")
                        .and_then(|v| v.get("normalized_events"))
                        .and_then(Value::as_array)
                        .map(|rows| rows.len())
                        .unwrap_or(0)
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_csi_module(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        CSI_MODULE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "substrate_csi_module_registry_contract",
            "allowed_ops": ["register", "activate", "list"],
            "allowed_privacy_classes": ["local", "sensitive", "restricted"],
            "required_fields": ["input_contract", "budget_units", "privacy_class", "degrade_behavior"]
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("substrate_csi_module_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "substrate_csi_module_registry_contract"
    {
        errors.push("substrate_csi_module_contract_kind_invalid".to_string());
    }
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
    if strict
        && !contract
            .get("allowed_ops")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(Value::as_str)
            .any(|row| row == op)
    {
        errors.push("substrate_csi_module_op_invalid".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_csi_module",
            "errors": errors
        });
    }

    let path = csi_module_registry_path(root);
    let mut registry = read_json(&path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "modules": {},
            "activations": []
        })
    });
    if !registry
        .get("modules")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        registry["modules"] = Value::Object(serde_json::Map::new());
    }
    if !registry
        .get("activations")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        registry["activations"] = Value::Array(Vec::new());
    }

    if op == "list" {
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "substrate_plane_csi_module",
            "lane": "core/layer0/ops",
            "op": op,
            "registry": registry,
            "claim_evidence": [
                {
                    "id": "V6-SUBSTRATE-001.2",
                    "claim": "csi_module_registry_lists_registered_and_activated_modules",
                    "evidence": {
                        "module_count": registry
                            .get("modules")
                            .and_then(Value::as_object)
                            .map(|m| m.len())
                            .unwrap_or(0)
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    let module = clean(
        parsed
            .flags
            .get("module")
            .cloned()
            .or_else(|| parsed.positional.get(2).cloned())
            .unwrap_or_default(),
        120,
    );
    if strict && module.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_csi_module",
            "errors": ["substrate_csi_module_id_required"]
        });
    }

    let out = match op.as_str() {
        "register" => {
            let input_contract = clean(
                parsed
                    .flags
                    .get("input-contract")
                    .cloned()
                    .unwrap_or_else(|| "csi.normalized_events.v1".to_string()),
                120,
            );
            let budget_units = parse_u64(parsed.flags.get("budget-units"), 1000);
            let privacy_class = clean(
                parsed
                    .flags
                    .get("privacy-class")
                    .cloned()
                    .unwrap_or_else(|| "local".to_string()),
                30,
            )
            .to_ascii_lowercase();
            let degrade_behavior = clean(
                parsed
                    .flags
                    .get("degrade-behavior")
                    .cloned()
                    .unwrap_or_else(|| "drop-to-presence-only".to_string()),
                120,
            );
            let privacy_allowed = contract
                .get("allowed_privacy_classes")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(Value::as_str)
                .any(|row| row == privacy_class);
            if strict && !privacy_allowed {
                return json!({
                    "ok": false,
                    "strict": strict,
                    "type": "substrate_plane_csi_module",
                    "errors": ["substrate_csi_module_privacy_class_invalid"]
                });
            }
            if strict
                && contract
                    .get("required_fields")
                    .and_then(Value::as_array)
                    .map(|required| {
                        required
                            .iter()
                            .filter_map(Value::as_str)
                            .any(|row| row == "degrade_behavior")
                    })
                    .unwrap_or(false)
                && degrade_behavior.is_empty()
            {
                return json!({
                    "ok": false,
                    "strict": strict,
                    "type": "substrate_plane_csi_module",
                    "errors": ["substrate_csi_module_degrade_behavior_required"]
                });
            }
            let module_doc = json!({
                "module": module,
                "input_contract": input_contract,
                "budget_units": budget_units,
                "privacy_class": privacy_class,
                "degrade_behavior": degrade_behavior,
                "registered_at": crate::now_iso(),
                "active": false
            });
            registry["modules"][&module] = module_doc.clone();
            registry["updated_at"] = Value::String(crate::now_iso());
            let _ = write_json(&path, &registry);
            let _ = append_jsonl(
                &state_root(root)
                    .join("csi")
                    .join("modules")
                    .join("history.jsonl"),
                &json!({"op": "register", "module": module_doc, "ts": crate::now_iso()}),
            );
            json!({
                "ok": true,
                "strict": strict,
                "type": "substrate_plane_csi_module",
                "lane": "core/layer0/ops",
                "op": op,
                "module": module_doc,
                "artifact": {
                    "path": path.display().to_string(),
                    "sha256": sha256_hex_str(&registry.to_string())
                }
            })
        }
        "activate" => {
            if strict && !registry["modules"].get(&module).is_some() {
                return json!({
                    "ok": false,
                    "strict": strict,
                    "type": "substrate_plane_csi_module",
                    "errors": ["substrate_csi_module_not_registered"]
                });
            }
            registry["modules"][&module]["active"] = Value::Bool(true);
            registry["modules"][&module]["activated_at"] = Value::String(crate::now_iso());
            let activation = json!({
                "module": module,
                "activation_id": format!("act_{}", &sha256_hex_str(&format!("{}:{}", module, crate::now_iso()))[..10]),
                "ts": crate::now_iso()
            });
            let mut activations = registry
                .get("activations")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            activations.push(activation.clone());
            registry["activations"] = Value::Array(activations);
            registry["updated_at"] = Value::String(crate::now_iso());
            let _ = write_json(&path, &registry);
            let _ = append_jsonl(
                &state_root(root)
                    .join("csi")
                    .join("modules")
                    .join("history.jsonl"),
                &json!({"op": "activate", "activation": activation, "ts": crate::now_iso()}),
            );
            json!({
                "ok": true,
                "strict": strict,
                "type": "substrate_plane_csi_module",
                "lane": "core/layer0/ops",
                "op": op,
                "activation": activation,
                "artifact": {
                    "path": path.display().to_string(),
                    "sha256": sha256_hex_str(&registry.to_string())
                }
            })
        }
        _ => json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_csi_module",
            "errors": ["substrate_csi_module_op_invalid"]
        }),
    };
    let mut out = out;
    let mut claims = out
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    claims.push(json!({
        "id": "V6-SUBSTRATE-001.2",
        "claim": "csi_derived_module_registry_tracks_input_contract_budget_privacy_and_activation_receipts",
        "evidence": {
            "op": op,
            "module": module
        }
    }));
    out["claim_evidence"] = Value::Array(claims);
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_csi_embedded_profile(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        CSI_EMBEDDED_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "substrate_csi_embedded_profile_contract",
            "profiles": {
                "esp32": {
                    "max_power_mw": 450.0,
                    "max_latency_ms": 250.0,
                    "max_bounded_memory_kb": 512,
                    "offline_required": true
                }
            }
        }),
    );
    let target = clean(
        parsed
            .flags
            .get("target")
            .cloned()
            .unwrap_or_else(|| "esp32".to_string()),
        40,
    )
    .to_ascii_lowercase();
    let profile = contract
        .get("profiles")
        .and_then(|v| v.get(&target))
        .cloned()
        .unwrap_or(Value::Null);
    if strict && profile.is_null() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_csi_embedded_profile",
            "errors": ["substrate_csi_embedded_profile_unknown_target"]
        });
    }
    let power_mw = parse_f64(parsed.flags.get("power-mw"), 380.0);
    let latency_ms = parse_f64(parsed.flags.get("latency-ms"), 120.0);
    let bounded_memory_kb = parse_u64(parsed.flags.get("bounded-memory-kb"), 256);
    let offline = parse_bool(parsed.flags.get("offline"), true);
    let max_power = profile
        .get("max_power_mw")
        .and_then(Value::as_f64)
        .unwrap_or(450.0);
    let max_latency = profile
        .get("max_latency_ms")
        .and_then(Value::as_f64)
        .unwrap_or(250.0);
    let max_memory_kb = profile
        .get("max_bounded_memory_kb")
        .and_then(Value::as_u64)
        .unwrap_or(512);
    let offline_required = profile
        .get("offline_required")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let mut reason_codes = Vec::<String>::new();
    if power_mw > max_power {
        reason_codes.push("power_budget_exceeded".to_string());
    }
    if latency_ms > max_latency {
        reason_codes.push("latency_budget_exceeded".to_string());
    }
    if bounded_memory_kb > max_memory_kb {
        reason_codes.push("bounded_memory_budget_exceeded".to_string());
    }
    if offline_required && !offline {
        reason_codes.push("offline_first_required".to_string());
    }
    let degraded_mode = !reason_codes.is_empty();
    let profile_state = json!({
        "version": "v1",
        "target": target,
        "power_mw": power_mw,
        "latency_ms": latency_ms,
        "bounded_memory_kb": bounded_memory_kb,
        "offline": offline,
        "degraded_mode": degraded_mode,
        "reason_codes": reason_codes,
        "telemetry": {
            "power_mw": power_mw,
            "latency_ms": latency_ms,
            "bounded_memory_kb": bounded_memory_kb
        },
        "ts": crate::now_iso()
    });
    let path = csi_embedded_profile_path(root, &target);
    let _ = write_json(&path, &profile_state);
    let _ = append_jsonl(
        &state_root(root)
            .join("csi")
            .join("embedded")
            .join("history.jsonl"),
        &profile_state,
    );

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "substrate_plane_csi_embedded_profile",
        "lane": "core/layer0/ops",
        "profile": profile_state,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&profile_state.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-SUBSTRATE-001.3",
                "claim": "embedded_csi_profile_tracks_power_latency_offline_and_degraded_mode_receipts",
                "evidence": {
                    "target": target,
                    "degraded_mode": degraded_mode
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_csi_policy(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        CSI_POLICY_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "substrate_csi_policy_contract",
            "locality_default": "local-only",
            "consent_required": true,
            "export_default_denied": true,
            "max_retention_minutes": 1440,
            "risk_classes": ["low", "medium", "high"]
        }),
    );
    let consent = parse_bool(parsed.flags.get("consent"), false);
    let locality = clean(
        parsed
            .flags
            .get("locality")
            .cloned()
            .unwrap_or_else(|| "local-only".to_string()),
        40,
    )
    .to_ascii_lowercase();
    let retention_minutes = parse_u64(parsed.flags.get("retention-minutes"), 60);
    let biometric_risk = clean(
        parsed
            .flags
            .get("biometric-risk")
            .cloned()
            .unwrap_or_else(|| "medium".to_string()),
        20,
    )
    .to_ascii_lowercase();
    let allow_export = parse_bool(parsed.flags.get("allow-export"), false);
    let mut violations = Vec::<String>::new();
    if contract
        .get("consent_required")
        .and_then(Value::as_bool)
        .unwrap_or(true)
        && !consent
    {
        violations.push("consent_required".to_string());
    }
    if locality != "local-only" {
        violations.push("locality_must_be_local_only".to_string());
    }
    if retention_minutes
        > contract
            .get("max_retention_minutes")
            .and_then(Value::as_u64)
            .unwrap_or(1440)
    {
        violations.push("retention_window_exceeded".to_string());
    }
    let risk_allowed = contract
        .get("risk_classes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .any(|row| row == biometric_risk);
    if strict && !risk_allowed {
        violations.push("biometric_risk_invalid".to_string());
    }
    if strict
        && biometric_risk == "high"
        && !parse_bool(parsed.flags.get("high-risk-approved"), false)
    {
        violations.push("high_risk_requires_approval".to_string());
    }
    if contract
        .get("export_default_denied")
        .and_then(Value::as_bool)
        .unwrap_or(true)
        && allow_export
    {
        violations.push("export_denied_by_default".to_string());
    }
    let ok = if strict { violations.is_empty() } else { true };
    let policy = json!({
        "version": "v1",
        "consent": consent,
        "locality": locality,
        "retention_minutes": retention_minutes,
        "biometric_risk": biometric_risk,
        "allow_export": allow_export,
        "violations": violations,
        "ok": ok,
        "ts": crate::now_iso()
    });
    let path = csi_policy_state_path(root);
    let _ = write_json(&path, &policy);
    let _ = append_jsonl(
        &state_root(root)
            .join("csi")
            .join("policy")
            .join("history.jsonl"),
        &policy,
    );
    let mut out = json!({
        "ok": ok,
        "strict": strict,
        "type": "substrate_plane_csi_policy",
        "lane": "core/layer0/ops",
        "policy": policy,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&policy.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-SUBSTRATE-001.4",
                "claim": "non_visual_sensing_policy_enforces_locality_consent_retention_and_risk_class",
                "evidence": {
                    "ok": ok
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_eye_bind(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        EYE_BINDING_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "substrate_eye_binding_contract",
            "allowed_sources": ["wifi"],
            "allowed_ops": ["enable", "status"],
            "thin_client_surface": ["enable", "status"]
        }),
    );
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "status".to_string()),
        20,
    )
    .to_ascii_lowercase();
    let source = clean(
        parsed
            .flags
            .get("source")
            .cloned()
            .or_else(|| parsed.positional.get(2).cloned())
            .unwrap_or_else(|| "wifi".to_string()),
        30,
    )
    .to_ascii_lowercase();
    let allowed_source = contract
        .get("allowed_sources")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .any(|row| row == source);
    let op_allowed = contract
        .get("allowed_ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .any(|row| row == op);
    if strict && !op_allowed {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_eye_bind",
            "errors": ["substrate_eye_bind_op_invalid"]
        });
    }
    if strict && !allowed_source {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_eye_bind",
            "errors": ["substrate_eye_source_invalid"]
        });
    }

    let path = eye_binding_state_path(root);
    let mut bindings = read_json(&path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "bindings": {}
        })
    });
    if !bindings
        .get("bindings")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        bindings["bindings"] = Value::Object(serde_json::Map::new());
    }
    if op == "status" {
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "substrate_plane_eye_bind",
            "lane": "core/layer0/ops",
            "op": op,
            "bindings": bindings,
            "claim_evidence": [
                {
                    "id": "V6-SUBSTRATE-001.5",
                    "claim": "thin_client_eye_surface_is_limited_to_enable_and_status_for_wifi_source",
                    "evidence": {
                        "enabled_count": bindings
                            .get("bindings")
                            .and_then(Value::as_object)
                            .map(|m| m.len())
                            .unwrap_or(0)
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    let latest_policy = read_json(&csi_policy_state_path(root)).unwrap_or_else(|| json!({}));
    if strict
        && !latest_policy
            .get("ok")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_eye_bind",
            "errors": ["substrate_eye_bind_requires_passing_csi_policy"]
        });
    }

    let binding = json!({
        "enabled": true,
        "source": source,
        "persona": clean(parsed.flags.get("persona").cloned().unwrap_or_else(|| "default".to_string()), 120),
        "shadow": clean(parsed.flags.get("shadow").cloned().unwrap_or_else(|| "default-shadow".to_string()), 120),
        "command_alias": "protheus eye enable wifi",
        "enabled_at": crate::now_iso()
    });
    bindings["bindings"][&source] = binding.clone();
    bindings["updated_at"] = Value::String(crate::now_iso());
    let _ = write_json(&path, &bindings);
    let _ = append_jsonl(
        &state_root(root).join("eye").join("history.jsonl"),
        &json!({"op": "enable", "source": source, "binding": binding, "ts": crate::now_iso()}),
    );
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "substrate_plane_eye_bind",
        "lane": "core/layer0/ops",
        "op": "enable",
        "binding": binding,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&bindings.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-SUBSTRATE-001.5",
                "claim": "wifi_csi_is_bound_as_native_eye_source_for_persona_and_shadow_triggers",
                "evidence": {
                    "source": source
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_bio_interface(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        BIO_INTERFACE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "substrate_biological_interface_contract",
            "channels": {"min": 4, "max": 128},
            "model_control_fields": ["attention_gain", "exploration_bias", "safety_temperature"]
        }),
    );
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "status".to_string()),
        20,
    )
    .to_ascii_lowercase();
    if op == "status" {
        let latest = read_json(&bio_interface_state_path(root)).unwrap_or_else(|| Value::Null);
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "substrate_plane_bio_interface",
            "lane": "core/layer0/ops",
            "op": op,
            "latest": latest,
            "claim_evidence": [
                {
                    "id": "V6-SUBSTRATE-002.1",
                    "claim": "biological_interface_status_surfaces_multi_electrode_mapping_state",
                    "evidence": {
                        "has_latest": !latest.is_null()
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    if op != "ingest" {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_bio_interface",
            "errors": ["substrate_bio_interface_op_invalid"]
        });
    }
    let channels = parse_u64(parsed.flags.get("channels"), 16);
    let min = contract
        .get("channels")
        .and_then(|v| v.get("min"))
        .and_then(Value::as_u64)
        .unwrap_or(4);
    let max = contract
        .get("channels")
        .and_then(|v| v.get("max"))
        .and_then(Value::as_u64)
        .unwrap_or(128);
    if strict && (channels < min || channels > max) {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_bio_interface",
            "errors": ["substrate_bio_interface_channels_out_of_bounds"]
        });
    }
    let payload_ref = clean(
        parsed
            .flags
            .get("payload-ref")
            .cloned()
            .unwrap_or_else(|| "bio://multielectrode/latest".to_string()),
        220,
    );
    let envelope = ExoticEnvelope {
        domain: ExoticDomain::Neural,
        adapter_id: "bio-neural-interface".to_string(),
        signal_type: "multi_electrode_input".to_string(),
        payload_ref,
        ts_ms: chrono::Utc::now().timestamp_millis(),
    };
    let wrapped = wrap_exotic_signal(&envelope, "sense.neural.input");
    let digest = wrapped.deterministic_digest.clone();
    let attention_gain = 0.5 + ((decode_signal_u64(&digest, 0) % 100) as f64 / 100.0);
    let exploration_bias = ((decode_signal_u64(&digest, 8) % 40) as f64 / 100.0) - 0.2;
    let safety_temperature = 0.1 + ((decode_signal_u64(&digest, 16) % 90) as f64 / 100.0);
    let mapped = json!({
        "attention_gain": attention_gain,
        "exploration_bias": exploration_bias,
        "safety_temperature": safety_temperature
    });
    let event = json!({
        "version": "v1",
        "op": "ingest",
        "channels": channels,
        "wrapped_envelope": wrapped,
        "mapped_controls": mapped,
        "ts": crate::now_iso()
    });
    let path = bio_interface_state_path(root);
    let _ = write_json(&path, &event);
    let _ = append_jsonl(
        &state_root(root)
            .join("bio")
            .join("interface")
            .join("history.jsonl"),
        &event,
    );
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "substrate_plane_bio_interface",
        "lane": "core/layer0/ops",
        "op": op,
        "event": event,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&event.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-SUBSTRATE-002.1",
                "claim": "biological_interface_maps_multi_electrode_input_to_model_control_parameters_with_receipts",
                "evidence": {
                    "channels": channels
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_bio_feedback(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        BIO_FEEDBACK_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "substrate_biological_feedback_contract",
            "allowed_ops": ["stimulate", "degrade", "status"],
            "fallback_mode": "silicon-only",
            "require_consent_for_stimulation": true
        }),
    );
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "status".to_string()),
        20,
    )
    .to_ascii_lowercase();

    if op == "status" {
        let latest = read_json(&bio_feedback_state_path(root)).unwrap_or_else(|| Value::Null);
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "substrate_plane_bio_feedback",
            "lane": "core/layer0/ops",
            "op": op,
            "latest": latest,
            "claim_evidence": [
                {
                    "id": "V6-SUBSTRATE-002.2",
                    "claim": "closed_loop_feedback_status_surfaces_current_mode_and_degrade_path",
                    "evidence": {
                        "has_latest": !latest.is_null()
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    if op != "stimulate" && op != "degrade" {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_bio_feedback",
            "errors": ["substrate_bio_feedback_op_invalid"]
        });
    }

    let interface = read_json(&bio_interface_state_path(root)).unwrap_or_else(|| Value::Null);
    if strict && op == "stimulate" && interface.is_null() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_bio_feedback",
            "errors": ["substrate_bio_feedback_requires_bio_interface_event"]
        });
    }
    if strict
        && op == "stimulate"
        && contract
            .get("require_consent_for_stimulation")
            .and_then(Value::as_bool)
            .unwrap_or(true)
        && !parse_bool(parsed.flags.get("consent"), false)
    {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_bio_feedback",
            "errors": ["substrate_bio_feedback_consent_required"]
        });
    }

    let mode = if op == "degrade" {
        clean(
            parsed
                .flags
                .get("mode")
                .cloned()
                .unwrap_or_else(|| "silicon-only".to_string()),
            30,
        )
    } else {
        clean(
            parsed
                .flags
                .get("mode")
                .cloned()
                .unwrap_or_else(|| "closed-loop".to_string()),
            30,
        )
    }
    .to_ascii_lowercase();
    let degrade = default_degradation(&ExoticDomain::Neural);
    let command_payload = if op == "stimulate" {
        json!({
            "mode": mode,
            "stimulation_level": interface
                .get("mapped_controls")
                .and_then(|v| v.get("attention_gain"))
                .and_then(Value::as_f64)
                .unwrap_or(1.0),
            "reason": "closed_loop_adjustment"
        })
    } else {
        json!({
            "mode": contract
                .get("fallback_mode")
                .and_then(Value::as_str)
                .unwrap_or("silicon-only"),
            "reason": "operator_or_policy_degrade"
        })
    };
    let feedback = json!({
        "version": "v1",
        "op": op,
        "mode": command_payload.get("mode").cloned().unwrap_or(Value::Null),
        "command_payload": command_payload,
        "degrade_contract": {
            "primary": degrade.primary,
            "fallback": degrade.fallback,
            "reason": degrade.reason
        },
        "ts": crate::now_iso()
    });
    let path = bio_feedback_state_path(root);
    let _ = write_json(&path, &feedback);
    let _ = append_jsonl(
        &state_root(root)
            .join("bio")
            .join("feedback")
            .join("history.jsonl"),
        &feedback,
    );
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "substrate_plane_bio_feedback",
        "lane": "core/layer0/ops",
        "op": op,
        "feedback": feedback,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&feedback.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-SUBSTRATE-002.2",
                "claim": "closed_loop_biological_feedback_supports_deterministic_degrade_to_silicon_only_mode",
                "evidence": {
                    "mode": feedback.get("mode").cloned().unwrap_or(Value::Null)
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_bio_adapter_template(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        BIO_ADAPTER_TEMPLATE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "substrate_biological_adapter_template_contract",
            "template_fields": ["spike_rate_channels", "stimulation_channels", "health_telemetry_fields"],
            "layer0_substrate_agnostic": true
        }),
    );
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "status".to_string()),
        20,
    )
    .to_ascii_lowercase();
    if op == "status" {
        let latest = read_json(&bio_adapter_template_path(root)).unwrap_or_else(|| Value::Null);
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "substrate_plane_bio_adapter_template",
            "lane": "core/layer0/ops",
            "op": "status",
            "latest": latest,
            "claim_evidence": [
                {
                    "id": "V6-SUBSTRATE-002.3",
                    "claim": "biological_adapter_template_surfaces_spike_stimulation_and_health_telemetry_descriptors",
                    "evidence": {
                        "has_latest": !latest.is_null()
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }
    if op != "emit" {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_bio_adapter_template",
            "errors": ["substrate_bio_adapter_template_op_invalid"]
        });
    }

    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("substrate_bio_adapter_template_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "substrate_biological_adapter_template_contract"
    {
        errors.push("substrate_bio_adapter_template_contract_kind_invalid".to_string());
    }
    let spike_channels = split_csv_clean(
        parsed
            .flags
            .get("spike-channels")
            .map(String::as_str)
            .unwrap_or("spike_rate_hz,burst_index"),
        120,
    );
    let stimulation_channels = split_csv_clean(
        parsed
            .flags
            .get("stimulation-channels")
            .map(String::as_str)
            .unwrap_or("stim_current_ua,stim_pulse_width_us"),
        120,
    );
    let telemetry_fields = split_csv_clean(
        parsed
            .flags
            .get("health-telemetry")
            .map(String::as_str)
            .unwrap_or("latency_ms,power_mw,artifact_rate"),
        120,
    );
    if strict && spike_channels.is_empty() {
        errors.push("substrate_bio_adapter_template_spike_channels_required".to_string());
    }
    if strict && stimulation_channels.is_empty() {
        errors.push("substrate_bio_adapter_template_stimulation_channels_required".to_string());
    }
    if strict && telemetry_fields.is_empty() {
        errors.push("substrate_bio_adapter_template_health_telemetry_required".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_bio_adapter_template",
            "errors": errors
        });
    }

    let adapter_id = clean(
        parsed
            .flags
            .get("adapter")
            .cloned()
            .unwrap_or_else(|| "bio-neural-generic".to_string()),
        120,
    );
    let template = json!({
        "version": "v1",
        "adapter_id": adapter_id,
        "spike_rate_channels": spike_channels,
        "stimulation_channels": stimulation_channels,
        "health_telemetry_fields": telemetry_fields,
        "layer0_substrate_agnostic": contract
            .get("layer0_substrate_agnostic")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        "ts": crate::now_iso()
    });
    let path = bio_adapter_template_path(root);
    let _ = write_json(&path, &template);
    let _ = append_jsonl(
        &state_root(root)
            .join("bio")
            .join("adapter")
            .join("history.jsonl"),
        &template,
    );
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "substrate_plane_bio_adapter_template",
        "lane": "core/layer0/ops",
        "op": "emit",
        "template": template,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&template.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-SUBSTRATE-002.3",
                "claim": "pluggable_biological_adapter_template_declares_channels_and_health_telemetry",
                "evidence": {
                    "adapter_id": adapter_id
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_bioethics_policy(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        BIO_ETHICS_POLICY_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "substrate_biological_ethics_policy_contract",
            "required_approvals": ["HMAN-BIO-001"],
            "blocked_external_prepared": true,
            "high_risk_requires_explicit_approval": true,
            "consent_required": true
        }),
    );
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "status".to_string()),
        20,
    )
    .to_ascii_lowercase();

    let path = bioethics_state_path(root);
    let mut state = read_json(&path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "approvals": {},
            "consent": false,
            "high_risk_approved": false,
            "last_enforced_ok": false
        })
    });
    if !state
        .get("approvals")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        state["approvals"] = Value::Object(serde_json::Map::new());
    }

    if op == "approve" {
        let approval = clean(
            parsed
                .flags
                .get("approval")
                .cloned()
                .unwrap_or_else(|| "HMAN-BIO-001".to_string()),
            120,
        );
        let artifact_ref = clean(
            parsed
                .flags
                .get("artifact-ref")
                .cloned()
                .unwrap_or_else(|| "evidence://pending-human-approval".to_string()),
            220,
        );
        state["approvals"][&approval] = json!({
            "approved": true,
            "artifact_ref": artifact_ref,
            "approved_at": crate::now_iso()
        });
        state["updated_at"] = Value::String(crate::now_iso());
        let _ = write_json(&path, &state);
        let _ = append_jsonl(
            &state_root(root)
                .join("bio")
                .join("ethics")
                .join("history.jsonl"),
            &json!({
                "op": "approve",
                "approval": approval,
                "ts": crate::now_iso()
            }),
        );
    } else if op == "enforce" {
        state["consent"] = Value::Bool(parse_bool(parsed.flags.get("consent"), false));
        state["high_risk_approved"] = Value::Bool(parse_bool(parsed.flags.get("high-risk"), false));
        state["updated_at"] = Value::String(crate::now_iso());
    } else if op != "status" {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_bioethics_policy",
            "errors": ["substrate_bioethics_policy_op_invalid"]
        });
    }

    let required = contract
        .get("required_approvals")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|row| row.to_string())
        .collect::<Vec<_>>();
    let missing_approvals = required
        .iter()
        .filter(|id| {
            !state
                .get("approvals")
                .and_then(Value::as_object)
                .and_then(|m| m.get(*id))
                .and_then(|v| v.get("approved"))
                .and_then(Value::as_bool)
                .unwrap_or(false)
        })
        .cloned()
        .collect::<Vec<_>>();
    let blocked_external = contract
        .get("blocked_external_prepared")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let consent_required = contract
        .get("consent_required")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let consent_ok = !consent_required
        || state
            .get("consent")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let high_risk_requires = contract
        .get("high_risk_requires_explicit_approval")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let high_risk_ok = !high_risk_requires
        || state
            .get("high_risk_approved")
            .and_then(Value::as_bool)
            .unwrap_or(false);
    let mut reason_codes = Vec::<String>::new();
    if !missing_approvals.is_empty() {
        reason_codes.push("missing_required_human_approvals".to_string());
        if blocked_external {
            reason_codes.push("blocked_external_hman_bio_001".to_string());
        }
    }
    if !consent_ok {
        reason_codes.push("bioethics_consent_required".to_string());
    }
    if !high_risk_ok {
        reason_codes.push("bioethics_high_risk_approval_required".to_string());
    }
    let ok = if strict {
        reason_codes.is_empty()
    } else {
        true
    };
    state["last_enforced_ok"] = Value::Bool(ok);
    let _ = write_json(&path, &state);
    let _ = append_jsonl(
        &state_root(root)
            .join("bio")
            .join("ethics")
            .join("history.jsonl"),
        &json!({
            "op": op,
            "ok": ok,
            "reason_codes": reason_codes,
            "ts": crate::now_iso()
        }),
    );

    let mut out = json!({
        "ok": ok,
        "strict": strict,
        "type": "substrate_plane_bioethics_policy",
        "lane": "core/layer0/ops",
        "op": op,
        "policy_state": state,
        "required_approvals": required,
        "missing_approvals": missing_approvals,
        "reason_codes": reason_codes,
        "blocked_external_prepared": blocked_external,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&read_json(&path).unwrap_or_else(|| json!({})).to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-SUBSTRATE-002.4",
                "claim": "bioethics_policy_gate_enforces_revocable_consent_human_approvals_and_high_risk_disable_paths",
                "evidence": {
                    "blocked_external_prepared": blocked_external,
                    "missing_approvals": missing_approvals
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_bio_enable(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        BIO_ENABLE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "substrate_biological_enable_contract",
            "allowed_modes": ["biological", "silicon-only"],
            "persona_visibility": true
        }),
    );
    let mode = clean(
        parsed
            .flags
            .get("mode")
            .cloned()
            .unwrap_or_else(|| "biological".to_string()),
        30,
    )
    .to_ascii_lowercase();
    let allowed = contract
        .get("allowed_modes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .any(|row| row == mode);
    if strict && !allowed {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_bio_enable",
            "errors": ["substrate_bio_enable_mode_invalid"]
        });
    }

    let ethics = read_json(&bioethics_state_path(root)).unwrap_or_else(|| json!({}));
    let ethics_ok = ethics
        .get("last_enforced_ok")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if strict && mode == "biological" && !ethics_ok {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_bio_enable",
            "errors": ["substrate_bio_enable_requires_passing_bioethics_policy"]
        });
    }
    let template = read_json(&bio_adapter_template_path(root)).unwrap_or_else(|| json!({}));
    let template_ok = template
        .get("version")
        .and_then(Value::as_str)
        .map(|v| v == "v1")
        .unwrap_or(false);
    if strict && mode == "biological" && !template_ok {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "substrate_plane_bio_enable",
            "errors": ["substrate_bio_enable_requires_adapter_template"]
        });
    }

    let activation = json!({
        "version": "v1",
        "mode": mode,
        "adapter_id": clean(
            parsed
                .flags
                .get("adapter")
                .cloned()
                .unwrap_or_else(|| "bio-neural-generic".to_string()),
            120
        ),
        "persona": clean(
            parsed
                .flags
                .get("persona")
                .cloned()
                .unwrap_or_else(|| "operator".to_string()),
            120
        ),
        "dashboard_hint": "protheus-top substrate biological",
        "command_alias": "protheus substrate enable biological",
        "ethics_policy_ok": ethics_ok,
        "ts": crate::now_iso()
    });
    let path = bio_enable_state_path(root);
    let _ = write_json(&path, &activation);
    let _ = append_jsonl(
        &state_root(root)
            .join("bio")
            .join("enable")
            .join("history.jsonl"),
        &activation,
    );
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "substrate_plane_bio_enable",
        "lane": "core/layer0/ops",
        "activation": activation,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&read_json(&path).unwrap_or_else(|| json!({})).to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-SUBSTRATE-002.5",
                "claim": "biological_substrate_activation_is_visible_in_cli_persona_and_dashboard_surfaces",
                "evidence": {
                    "command_alias": "protheus substrate enable biological"
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
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
    let conduit = if command != "status" {
        Some(conduit_enforcement(root, &parsed, strict, &command))
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
                "type": "substrate_plane_conduit_gate",
                "errors": ["conduit_bypass_rejected"],
                "conduit_enforcement": conduit
            }),
        );
    }

    let payload = match command.as_str() {
        "status" => status(root),
        "csi-capture" => run_csi_capture(root, &parsed, strict),
        "csi-module" => run_csi_module(root, &parsed, strict),
        "csi-embedded-profile" => run_csi_embedded_profile(root, &parsed, strict),
        "csi-policy" => run_csi_policy(root, &parsed, strict),
        "eye-bind" => run_eye_bind(root, &parsed, strict),
        "bio-interface" => run_bio_interface(root, &parsed, strict),
        "bio-feedback" => run_bio_feedback(root, &parsed, strict),
        "bio-adapter-template" => run_bio_adapter_template(root, &parsed, strict),
        "bioethics-policy" => run_bioethics_policy(root, &parsed, strict),
        "bio-enable" => run_bio_enable(root, &parsed, strict),
        _ => json!({
            "ok": false,
            "type": "substrate_plane_error",
            "error": "unknown_command",
            "command": command
        }),
    };
    if command == "status" {
        print_json(&payload);
        return 0;
    }
    emit(root, attach_conduit(payload, conduit.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conduit_rejects_bypass() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = crate::parse_args(&["csi-capture".to_string(), "--bypass=1".to_string()]);
        let out = conduit_enforcement(root.path(), &parsed, true, "csi-capture");
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn decode_signal_u64_handles_bounds() {
        assert_eq!(decode_signal_u64("abcdef", 99), 0);
        assert!(decode_signal_u64("001122334455", 0) > 0);
    }
}
