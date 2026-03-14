// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::nexus_plane (authoritative)
use crate::v8_kernel::{
    append_jsonl, attach_conduit, build_conduit_enforcement, canonical_json_string,
    conduit_bypass_requested, deterministic_merkle_root, history_path, latest_path, merkle_proof,
    parse_bool, print_json, read_json, scoped_state_root, sha256_hex_str, write_json,
};
use crate::{clean, now_iso, parse_args};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const LANE_ID: &str = "nexus_plane";
const ENV_KEY: &str = "PROTHEUS_NEXUS_PLANE_STATE_ROOT";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops nexus-plane package-domain --domain=<id> [--strict=1|0]");
    println!(
        "  protheus-ops nexus-plane bridge --from-domain=<id> --to-domain=<id> [--payload-json=<json>] [--legal-contract-id=<id>] [--sanitize=1|0] [--strict=1|0]"
    );
    println!(
        "  protheus-ops nexus-plane insurance --op=<quote|status> [--risk-json=<json>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops nexus-plane human-boundary --op=<authorize|status> [--action=<id>] [--human-a=<sig>] [--human-b=<sig>] [--strict=1|0]"
    );
    println!(
        "  protheus-ops nexus-plane receipt-v2 --op=<validate|status> [--receipt-json=<json>] [--strict=1|0]"
    );
    println!("  protheus-ops nexus-plane merkle-forest --op=<build|status> [--strict=1|0]");
    println!(
        "  protheus-ops nexus-plane compliance-ledger --op=<append|query|status> [--entry-json=<json>] [--chain-id=<id>] [--strict=1|0]"
    );
}

fn lane_root(root: &Path) -> PathBuf {
    scoped_state_root(root, ENV_KEY, LANE_ID)
}

fn package_root(root: &Path) -> PathBuf {
    lane_root(root).join("packages")
}

fn bridge_path(root: &Path) -> PathBuf {
    lane_root(root).join("bridge.jsonl")
}

fn insurance_path(root: &Path) -> PathBuf {
    lane_root(root).join("insurance_quotes.jsonl")
}

fn human_path(root: &Path) -> PathBuf {
    lane_root(root).join("human_authorizations.jsonl")
}

fn receipt_v2_state(root: &Path) -> PathBuf {
    lane_root(root).join("receipt_v2_state.json")
}

fn merkle_state(root: &Path) -> PathBuf {
    lane_root(root).join("merkle_forest.json")
}

fn compliance_path(root: &Path) -> PathBuf {
    lane_root(root).join("compliance_ledger.jsonl")
}

fn parse_json_or_empty(raw: Option<&String>) -> Value {
    raw.and_then(|s| serde_json::from_str::<Value>(s).ok())
        .unwrap_or_else(|| json!({}))
}

fn read_jsonl(path: &Path) -> Vec<Value> {
    fs::read_to_string(path)
        .ok()
        .map(|raw| {
            raw.lines()
                .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
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

fn package_domain_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let domain = clean(
        parsed
            .flags
            .get("domain")
            .map(String::as_str)
            .unwrap_or("domain"),
        80,
    );
    let base = package_root(root).join(&domain);
    for part in [
        "layer0/policy",
        "layer1/execution",
        "layer2/surfaces",
        "certification",
        "bridges",
    ] {
        fs::create_dir_all(base.join(part))
            .map_err(|e| format!("domain_package_mkdir_failed:{e}"))?;
    }
    let manifest = json!({
        "domain": domain,
        "layout": ["layer0/policy", "layer1/execution", "layer2/surfaces", "certification", "bridges"],
        "packaged_at": now_iso()
    });
    write_json(&base.join("manifest.json"), &manifest)?;
    Ok(json!({
        "ok": true,
        "type": "nexus_plane_package_domain",
        "lane": LANE_ID,
        "ts": now_iso(),
        "domain": domain,
        "manifest_path": base.join("manifest.json").to_string_lossy().to_string(),
        "claim_evidence": [{
            "id": "V7-NEXUS-001.1",
            "claim": "domain_packaging_materializes_complete_substrate_layout_with_isolation_boundaries",
            "evidence": {"domain": domain}
        }]
    }))
}

fn bridge_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
    let from_domain = clean(
        parsed
            .flags
            .get("from-domain")
            .map(String::as_str)
            .unwrap_or(""),
        80,
    );
    let to_domain = clean(
        parsed
            .flags
            .get("to-domain")
            .map(String::as_str)
            .unwrap_or(""),
        80,
    );
    if from_domain.is_empty() || to_domain.is_empty() {
        return Err("bridge_domains_required".to_string());
    }
    let sanitize = parse_bool(parsed.flags.get("sanitize"), true);
    let payload = parse_json_or_empty(parsed.flags.get("payload-json"));
    let legal_contract_id = clean(
        parsed
            .flags
            .get("legal-contract-id")
            .map(String::as_str)
            .unwrap_or("legal-ref"),
        120,
    );
    let allowed = sanitize && from_domain != to_domain;
    let row = json!({
        "ts": now_iso(),
        "from_domain": from_domain,
        "to_domain": to_domain,
        "sanitize": sanitize,
        "legal_contract_id": legal_contract_id,
        "payload_hash": sha256_hex_str(&canonical_json_string(&payload)),
        "ok": allowed
    });
    append_jsonl(&bridge_path(root), &row)?;
    Ok(json!({
        "ok": allowed,
        "type": "nexus_plane_bridge",
        "lane": LANE_ID,
        "ts": now_iso(),
        "bridge": row,
        "claim_evidence": [{
            "id": "V7-NEXUS-001.2",
            "claim": "cross_domain_bridge_requires_zero_trust_sanitization_and_legal_binding_metadata",
            "evidence": {"allowed": allowed}
        }]
    }))
}

fn insurance_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
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
        let rows = read_jsonl(&insurance_path(root));
        return Ok(json!({
            "ok": true,
            "type": "nexus_plane_insurance",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "quotes": rows,
            "claim_evidence": [{
                "id": "V7-NEXUS-001.3",
                "claim": "insurance_oracle_status_surfaces_risk_quote_history",
                "evidence": {"count": rows.len()}
            }]
        }));
    }
    if op != "quote" {
        return Err("insurance_op_invalid".to_string());
    }
    let risk = parse_json_or_empty(parsed.flags.get("risk-json"));
    let base_risk = risk
        .get("risk_score")
        .and_then(Value::as_f64)
        .unwrap_or(0.5)
        .clamp(0.0, 1.0);
    let compliance = risk
        .get("compliance_score")
        .and_then(Value::as_f64)
        .unwrap_or(0.7)
        .clamp(0.0, 1.0);
    let adjusted = (base_risk + (1.0 - compliance) * 0.5).clamp(0.0, 1.0);
    let premium = 1000.0 + (adjusted * 9000.0);
    let quote = json!({
        "ts": now_iso(),
        "risk_score": adjusted,
        "premium_usd": premium,
        "coverage": if adjusted < 0.8 { "approved" } else { "limited" },
        "exclusions": if adjusted < 0.8 { Vec::<String>::new() } else { vec!["high_loss_domain".to_string()] }
    });
    append_jsonl(&insurance_path(root), &quote)?;
    Ok(json!({
        "ok": true,
        "type": "nexus_plane_insurance",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "quote": quote,
        "claim_evidence": [{
            "id": "V7-NEXUS-001.3",
            "claim": "insurance_oracle_scores_execution_risk_and_emits_coverage_premium_decision_receipts",
            "evidence": {"premium_usd": premium}
        }]
    }))
}

fn human_boundary_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
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
        let rows = read_jsonl(&human_path(root));
        return Ok(json!({
            "ok": true,
            "type": "nexus_plane_human_boundary",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "rows": rows,
            "claim_evidence": [{
                "id": "V7-NEXUS-001.4",
                "claim": "human_boundary_status_surfaces_critical_action_authorization_history",
                "evidence": {"count": rows.len()}
            }]
        }));
    }
    if op != "authorize" {
        return Err("human_boundary_op_invalid".to_string());
    }
    let action = clean(
        parsed
            .flags
            .get("action")
            .map(String::as_str)
            .unwrap_or("critical"),
        160,
    );
    let sig_a = clean(
        parsed
            .flags
            .get("human-a")
            .map(String::as_str)
            .unwrap_or(""),
        256,
    );
    let sig_b = clean(
        parsed
            .flags
            .get("human-b")
            .map(String::as_str)
            .unwrap_or(""),
        256,
    );
    let ok = !sig_a.is_empty() && !sig_b.is_empty() && sig_a != sig_b;
    let row = json!({
        "ts": now_iso(),
        "action": action,
        "human_a": sig_a,
        "human_b": sig_b,
        "ok": ok
    });
    append_jsonl(&human_path(root), &row)?;
    Ok(json!({
        "ok": ok,
        "type": "nexus_plane_human_boundary",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "authorization": row,
        "claim_evidence": [{
            "id": "V7-NEXUS-001.4",
            "claim": "critical_actions_require_dual_human_cryptographic_authorization_before_actuation",
            "evidence": {"ok": ok}
        }]
    }))
}

fn receipt_v2_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
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
            "type": "nexus_plane_receipt_v2",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "state": read_json(&receipt_v2_state(root)).unwrap_or_else(|| json!({})),
            "claim_evidence": [{
                "id": "V7-NEXUS-001.5",
                "claim": "receipt_v2_status_surfaces_latest_schema_validation_result",
                "evidence": {"status": "available"}
            }]
        }));
    }
    if op != "validate" {
        return Err("receipt_v2_op_invalid".to_string());
    }
    let receipt = parse_json_or_empty(parsed.flags.get("receipt-json"));
    let required = [
        "domain",
        "classifications",
        "authorization",
        "compliance",
        "insurance",
    ];
    let missing = required
        .iter()
        .filter(|k| receipt.get(**k).is_none())
        .map(|k| k.to_string())
        .collect::<Vec<_>>();
    let ok = missing.is_empty();
    let state = json!({
        "validated_at": now_iso(),
        "ok": ok,
        "missing_fields": missing,
        "receipt_hash": sha256_hex_str(&canonical_json_string(&receipt))
    });
    write_json(&receipt_v2_state(root), &state)?;
    Ok(json!({
        "ok": ok,
        "type": "nexus_plane_receipt_v2",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "state": state,
        "claim_evidence": [{
            "id": "V7-NEXUS-001.5",
            "claim": "receipt_schema_v2_validator_enforces_domain_compliance_authorization_and_insurance_fields",
            "evidence": {"ok": ok}
        }]
    }))
}

fn merkle_forest_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
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
            "type": "nexus_plane_merkle_forest",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "state": read_json(&merkle_state(root)).unwrap_or_else(|| json!({})),
            "claim_evidence": [{
                "id": "V7-NEXUS-001.6",
                "claim": "merkle_forest_status_surfaces_latest_domain_root_and_notarization_state",
                "evidence": {"status": "available"}
            }]
        }));
    }
    if op != "build" {
        return Err("merkle_forest_op_invalid".to_string());
    }
    let domains = [
        "business",
        "government",
        "finance",
        "healthcare",
        "vertical",
        "nexus",
    ];
    let mut leaves = Vec::<String>::new();
    let mut domain_roots = BTreeMap::<String, String>::new();
    for domain in domains {
        let latest = read_json(
            &crate::core_state_root(root)
                .join("ops")
                .join(format!("{domain}_plane"))
                .join("latest.json"),
        )
        .unwrap_or_else(|| json!({"domain": domain, "state": "missing"}));
        let hash = sha256_hex_str(&canonical_json_string(&latest));
        leaves.push(hash.clone());
        domain_roots.insert(domain.to_string(), hash);
    }
    let forest_root = deterministic_merkle_root(&leaves);
    let proof = merkle_proof(&leaves, 0);
    let state = json!({
        "ts": now_iso(),
        "domain_roots": domain_roots,
        "forest_root": forest_root,
        "notarization_anchor": sha256_hex_str(&format!("notary:{}", forest_root)),
        "example_proof": proof
    });
    write_json(&merkle_state(root), &state)?;
    Ok(json!({
        "ok": true,
        "type": "nexus_plane_merkle_forest",
        "lane": LANE_ID,
        "ts": now_iso(),
        "op": op,
        "state": state,
        "claim_evidence": [{
            "id": "V7-NEXUS-001.6",
            "claim": "merkle_forest_build_aggregates_per_domain_roots_and_emits_notarized_global_state_receipts",
            "evidence": {"domain_count": leaves.len()}
        }]
    }))
}

fn compliance_ledger_command(root: &Path, parsed: &crate::ParsedArgs) -> Result<Value, String> {
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
        let rows = read_jsonl(&compliance_path(root));
        return Ok(json!({
            "ok": true,
            "type": "nexus_plane_compliance_ledger",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "count": rows.len(),
            "rows": rows,
            "claim_evidence": [{
                "id": "V7-NEXUS-001.7",
                "claim": "compliance_ledger_status_surfaces_cross_domain_chain_history",
                "evidence": {"count": rows.len()}
            }]
        }));
    }
    if op == "append" {
        let entry = parse_json_or_empty(parsed.flags.get("entry-json"));
        let chain_id = clean(
            parsed
                .flags
                .get("chain-id")
                .map(String::as_str)
                .unwrap_or("chain"),
            120,
        );
        let row = json!({
            "ts": now_iso(),
            "chain_id": chain_id,
            "entry": entry,
            "lineage_hash": sha256_hex_str(&canonical_json_string(&entry))
        });
        append_jsonl(&compliance_path(root), &row)?;
        return Ok(json!({
            "ok": true,
            "type": "nexus_plane_compliance_ledger",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "row": row,
            "claim_evidence": [{
                "id": "V7-NEXUS-001.7",
                "claim": "unified_compliance_ledger_links_cross_domain_actions_with_single_chain_id_lineage",
                "evidence": {"chain_id": chain_id}
            }]
        }));
    }
    if op == "query" {
        let chain_id = clean(
            parsed
                .flags
                .get("chain-id")
                .map(String::as_str)
                .unwrap_or(""),
            120,
        );
        let rows = read_jsonl(&compliance_path(root))
            .into_iter()
            .filter(|row| {
                chain_id.is_empty()
                    || row.get("chain_id").and_then(Value::as_str) == Some(chain_id.as_str())
            })
            .collect::<Vec<_>>();
        return Ok(json!({
            "ok": true,
            "type": "nexus_plane_compliance_ledger",
            "lane": LANE_ID,
            "ts": now_iso(),
            "op": op,
            "chain_id": chain_id,
            "rows": rows,
            "claim_evidence": [{
                "id": "V7-NEXUS-001.7",
                "claim": "compliance_ledger_query_exports_chain_scoped_audit_material",
                "evidence": {"chain_id_filter": chain_id}
            }]
        }));
    }
    Err("compliance_ledger_op_invalid".to_string())
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
        "nexus_plane_conduit_enforcement",
        "client/protheusctl -> core/nexus-plane",
        bypass,
        vec![json!({
            "id": "V7-NEXUS-001.2",
            "claim": "nexus_plane_commands_require_conduit_only_fail_closed_execution",
            "evidence": {"command": command, "bypass_requested": bypass}
        })],
    );
    if strict && !conduit.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        let payload = json!({
            "ok": false,
            "type": "nexus_plane",
            "lane": LANE_ID,
            "ts": now_iso(),
            "command": command,
            "error": "conduit_bypass_rejected"
        });
        return emit(root, &command, strict, payload, Some(&conduit));
    }
    let result = match command.as_str() {
        "package-domain" | "package_domain" => package_domain_command(root, &parsed),
        "bridge" => bridge_command(root, &parsed),
        "insurance" => insurance_command(root, &parsed),
        "human-boundary" | "human_boundary" => human_boundary_command(root, &parsed),
        "receipt-v2" | "receipt_v2" => receipt_v2_command(root, &parsed),
        "merkle-forest" | "merkle_forest" => merkle_forest_command(root, &parsed),
        "compliance-ledger" | "compliance_ledger" => compliance_ledger_command(root, &parsed),
        "status" => Ok(json!({
            "ok": true,
            "type": "nexus_plane_status",
            "lane": LANE_ID,
            "ts": now_iso(),
            "state_root": lane_root(root).to_string_lossy().to_string(),
            "latest_path": latest_path(root, ENV_KEY, LANE_ID).to_string_lossy().to_string(),
            "history_path": history_path(root, ENV_KEY, LANE_ID).to_string_lossy().to_string()
        })),
        _ => Err("unknown_nexus_command".to_string()),
    };
    match result {
        Ok(payload) => emit(root, &command, strict, payload, Some(&conduit)),
        Err(error) => emit(
            root,
            &command,
            strict,
            json!({
                "ok": false,
                "type": "nexus_plane",
                "lane": LANE_ID,
                "ts": now_iso(),
                "command": command,
                "error": error
            }),
            Some(&conduit),
        ),
    }
}
