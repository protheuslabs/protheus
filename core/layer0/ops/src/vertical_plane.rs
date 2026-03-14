// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::vertical_plane (authoritative)
use crate::v8_kernel::{
    append_jsonl, attach_conduit, build_conduit_enforcement, conduit_bypass_requested,
    history_path, latest_path, parse_bool, print_json, read_json, scoped_state_root,
    sha256_hex_str, write_json,
};
use crate::{clean, now_iso, parse_args};
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const LANE_ID: &str = "vertical_plane";
const ENV_KEY: &str = "PROTHEUS_VERTICAL_PLANE_STATE_ROOT";

#[derive(Clone)]
struct DomainSpec {
    id: &'static str,
    protocols: &'static [&'static str],
    compliance: &'static [&'static str],
    safety_class: &'static str,
    realtime_slo: &'static str,
}

fn domain_specs() -> BTreeMap<&'static str, DomainSpec> {
    let mut map = BTreeMap::new();
    map.insert(
        "industrial",
        DomainSpec {
            id: "V7-VERTICAL-001.1",
            protocols: &["opc-ua", "modbus", "dnp3", "ethercat"],
            compliance: &["IEC62443", "ISO27001"],
            safety_class: "SIL3",
            realtime_slo: "100ms",
        },
    );
    map.insert(
        "grid",
        DomainSpec {
            id: "V7-VERTICAL-001.2",
            protocols: &["ieee2030.5", "openadr", "green-button"],
            compliance: &["NERC-CIP"],
            safety_class: "critical-infra",
            realtime_slo: "500ms",
        },
    );
    map.insert(
        "avionics",
        DomainSpec {
            id: "V7-VERTICAL-001.3",
            protocols: &["arinc-429", "arinc-664", "mil-std-1553"],
            compliance: &["DO-178C"],
            safety_class: "flight-critical",
            realtime_slo: "10ms",
        },
    );
    map.insert(
        "automotive",
        DomainSpec {
            id: "V7-VERTICAL-001.4",
            protocols: &["can", "lin", "flexray"],
            compliance: &["ISO26262", "ISO21434"],
            safety_class: "ASIL-D",
            realtime_slo: "20ms",
        },
    );
    map.insert(
        "telecom",
        DomainSpec {
            id: "V7-VERTICAL-001.5",
            protocols: &["diameter", "gtp", "sip"],
            compliance: &["3GPP", "NFV-MANO"],
            safety_class: "carrier-grade",
            realtime_slo: "50ms",
        },
    );
    map.insert(
        "retail",
        DomainSpec {
            id: "V7-VERTICAL-001.6",
            protocols: &["pos", "wms", "erp"],
            compliance: &["PCI-DSS"],
            safety_class: "payment-safe",
            realtime_slo: "200ms",
        },
    );
    map.insert(
        "education",
        DomainSpec {
            id: "V7-VERTICAL-001.7",
            protocols: &["lti", "xapi", "sis"],
            compliance: &["FERPA"],
            safety_class: "student-data",
            realtime_slo: "1s",
        },
    );
    map.insert(
        "legal",
        DomainSpec {
            id: "V7-VERTICAL-001.8",
            protocols: &["ediscovery", "docketing", "privilege-log"],
            compliance: &["legal-hold"],
            safety_class: "privileged",
            realtime_slo: "1s",
        },
    );
    map.insert(
        "gaming",
        DomainSpec {
            id: "V7-VERTICAL-001.9",
            protocols: &["realtime-netcode", "elo-mmr", "anti-cheat"],
            compliance: &["ugc-moderation"],
            safety_class: "fairplay",
            realtime_slo: "20ms",
        },
    );
    map.insert(
        "agriculture",
        DomainSpec {
            id: "V7-VERTICAL-001.10",
            protocols: &["ndvi", "weather-iot", "field-mapping"],
            compliance: &["traceability", "esg"],
            safety_class: "field-safe",
            realtime_slo: "5s",
        },
    );
    map.insert(
        "construction",
        DomainSpec {
            id: "V7-VERTICAL-001.11",
            protocols: &["bim", "rfi", "submittals"],
            compliance: &["osha"],
            safety_class: "site-safe",
            realtime_slo: "2s",
        },
    );
    map.insert(
        "logistics",
        DomainSpec {
            id: "V7-VERTICAL-001.12",
            protocols: &["tms", "eld", "pod"],
            compliance: &["customs"],
            safety_class: "cold-chain",
            realtime_slo: "1s",
        },
    );
    map.insert(
        "pharma",
        DomainSpec {
            id: "V7-VERTICAL-001.13",
            protocols: &["lims", "eln", "batch-qa"],
            compliance: &["GxP", "21CFRPart11"],
            safety_class: "qa-release",
            realtime_slo: "2s",
        },
    );
    map
}

fn usage() {
    println!("Usage:");
    println!(
        "  protheus-ops vertical-plane activate --domain=<industrial|grid|avionics|automotive|telecom|retail|education|legal|gaming|agriculture|construction|logistics|pharma> [--profile-json=<json>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops vertical-plane compile-profile --domain=<id> --profile-json=<json> [--strict=1|0]"
    );
    println!("  protheus-ops vertical-plane status [--strict=1|0]");
}

fn lane_root(root: &Path) -> PathBuf {
    scoped_state_root(root, ENV_KEY, LANE_ID)
}

fn profiles_path(root: &Path) -> PathBuf {
    lane_root(root).join("profiles.json")
}

fn parse_json_or_empty(raw: Option<&String>) -> Value {
    raw.and_then(|s| serde_json::from_str::<Value>(s).ok())
        .unwrap_or_else(|| json!({}))
}

fn read_profiles(root: &Path) -> Map<String, Value> {
    read_json(&profiles_path(root))
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

fn validate_profile_shape(profile: &Value) -> Vec<String> {
    let mut missing = Vec::new();
    if !profile
        .get("entity_model")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        missing.push("entity_model".to_string());
    }
    if !profile
        .get("compliance_mapping")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        missing.push("compliance_mapping".to_string());
    }
    if !profile
        .get("protocols")
        .map(Value::is_array)
        .unwrap_or(false)
    {
        missing.push("protocols".to_string());
    }
    if !profile
        .get("safety_class")
        .and_then(Value::as_str)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        missing.push("safety_class".to_string());
    }
    if !profile
        .get("realtime_slo")
        .and_then(Value::as_str)
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false)
    {
        missing.push("realtime_slo".to_string());
    }
    missing
}

fn default_profile(domain: &str, spec: &DomainSpec) -> Value {
    json!({
        "domain": domain,
        "entity_model": {
            "primary_entity": format!("{domain}_entity"),
            "version": "v1"
        },
        "compliance_mapping": spec.compliance,
        "protocols": spec.protocols,
        "safety_class": spec.safety_class,
        "realtime_slo": spec.realtime_slo
    })
}

fn activate_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let domain = clean(
        parsed.flags.get("domain").map(String::as_str).unwrap_or(""),
        40,
    )
    .to_ascii_lowercase();
    let specs = domain_specs();
    let spec = specs
        .get(domain.as_str())
        .ok_or_else(|| "domain_not_supported".to_string())?;
    let profile = parse_json_or_empty(parsed.flags.get("profile-json"));
    let resolved = if profile == json!({}) {
        default_profile(&domain, spec)
    } else {
        profile
    };
    let missing = validate_profile_shape(&resolved);
    if !missing.is_empty() {
        return Ok(json!({
            "ok": false,
            "type": "vertical_plane_activate",
            "lane": LANE_ID,
            "ts": now_iso(),
            "domain": domain,
            "error": "profile_incomplete",
            "missing_fields": missing
        }));
    }
    let mut profiles = read_profiles(root);
    profiles.insert(domain.clone(), resolved.clone());
    write_json(&profiles_path(root), &Value::Object(profiles.clone()))?;
    Ok(json!({
        "ok": true,
        "type": "vertical_plane_activate",
        "lane": LANE_ID,
        "ts": now_iso(),
        "domain": domain,
        "profile": resolved,
        "profile_hash": sha256_hex_str(&serde_json::to_string(&profiles.get(domain.as_str()).cloned().unwrap_or(Value::Null)).unwrap_or_default()),
        "claim_evidence": [{
            "id": spec.id,
            "claim": "domain_plane_activation_enforces_protocol_compliance_safety_and_realtime_contracts",
            "evidence": {"domain": domain, "safety_class": spec.safety_class, "realtime_slo": spec.realtime_slo}
        }]
    }))
}

fn compile_profile_command(parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let domain = clean(
        parsed.flags.get("domain").map(String::as_str).unwrap_or(""),
        40,
    )
    .to_ascii_lowercase();
    if domain.is_empty() {
        return Err("compile_domain_required".to_string());
    }
    let profile = parse_json_or_empty(parsed.flags.get("profile-json"));
    let missing = validate_profile_shape(&profile);
    let ok = missing.is_empty();
    let compiled = if ok {
        json!({
            "domain": domain,
            "entity_model": profile["entity_model"],
            "compliance": profile["compliance_mapping"],
            "protocols": profile["protocols"],
            "safety": profile["safety_class"],
            "realtime": profile["realtime_slo"],
            "compiled_at": now_iso()
        })
    } else {
        json!({})
    };
    Ok(json!({
        "ok": ok,
        "type": "vertical_plane_compile_profile",
        "lane": LANE_ID,
        "ts": now_iso(),
        "domain": domain,
        "missing_fields": missing,
        "compiled": compiled,
        "claim_evidence": [{
            "id": "V7-VERTICAL-001.14",
            "claim": "domain_profile_compiler_requires_entity_compliance_protocol_safety_and_realtime_declarations",
            "evidence": {"ok": ok}
        }]
    }))
}

fn status_command(root: &Path) -> Value {
    let profiles = read_profiles(root);
    json!({
        "ok": true,
        "type": "vertical_plane_status",
        "lane": LANE_ID,
        "ts": now_iso(),
        "domain_count": profiles.len(),
        "domains": profiles.keys().cloned().collect::<Vec<_>>(),
        "profiles_path": profiles_path(root).to_string_lossy().to_string()
    })
}

fn emit(root: &Path, _command: &str, strict: bool, payload: Value, conduit: Option<&Value>) -> i32 {
    let out = attach_conduit(payload, conduit);
    let _ = write_json(&latest_path(root, ENV_KEY, LANE_ID), &out);
    let _ = append_jsonl(&history_path(root, ENV_KEY, LANE_ID), &out);
    print_json(&out);
    if strict && !out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        1
    } else if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        0
    } else {
        1
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
        "vertical_plane_conduit_enforcement",
        "client/protheusctl -> core/vertical-plane",
        bypass,
        vec![json!({
            "id": "V7-VERTICAL-001.14",
            "claim": "vertical_plane_commands_require_conduit_only_fail_closed_execution",
            "evidence": {"command": command, "bypass_requested": bypass}
        })],
    );
    if strict && !conduit.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let payload = json!({
            "ok": false,
            "type": "vertical_plane",
            "lane": LANE_ID,
            "ts": now_iso(),
            "command": command,
            "error": "conduit_bypass_rejected"
        });
        return emit(root, &command, strict, payload, Some(&conduit));
    }
    let result = match command.as_str() {
        "activate" => activate_command(root, &parsed),
        "compile-profile" | "compile_profile" => compile_profile_command(&parsed),
        "status" => Ok(status_command(root)),
        _ => Err("unknown_vertical_command".to_string()),
    };
    match result {
        Ok(payload) => emit(root, &command, strict, payload, Some(&conduit)),
        Err(error) => emit(
            root,
            &command,
            strict,
            json!({
                "ok": false,
                "type": "vertical_plane",
                "lane": LANE_ID,
                "ts": now_iso(),
                "command": command,
                "error": error
            }),
            Some(&conduit),
        ),
    }
}
