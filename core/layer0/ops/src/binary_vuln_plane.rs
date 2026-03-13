// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::binary_vuln_plane (authoritative)

use crate::v8_kernel::{
    attach_conduit, build_conduit_enforcement, canonical_json_string, conduit_bypass_requested,
    load_json_or, parse_bool, read_json, scoped_state_root, sha256_hex_str, write_json,
    write_receipt,
};
use crate::{clean, parse_args};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

const STATE_ENV: &str = "BINARY_VULN_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "binary_vuln_plane";

const ENGINE_CONTRACT_PATH: &str =
    "planes/contracts/binary_vuln/binary_analysis_engine_contract_v1.json";
const MCP_CONTRACT_PATH: &str = "planes/contracts/binary_vuln/mcp_analysis_server_contract_v1.json";
const OUTPUT_CONTRACT_PATH: &str =
    "planes/contracts/binary_vuln/structured_output_contract_v1.json";
const RULEPACK_PATH: &str = "planes/contracts/binary_vuln/rulepack_v1.json";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops binary-vuln-plane status");
    println!("  protheus-ops binary-vuln-plane scan --input=<path> [--rulepack=<path>] [--format=json|jsonl] [--strict=1|0]");
    println!("  protheus-ops binary-vuln-plane mcp-analyze --input=<path> [--transport=stdio|http-sse] [--rulepack=<path>] [--strict=1|0]");
    println!("  protheus-ops binary-vuln-plane rulepack-install --rulepack=<path> [--name=<id>] [--signature=<sig:...>] [--provenance=<uri>] [--strict=1|0]");
    println!("  protheus-ops binary-vuln-plane rulepack-enable --name=<id> [--strict=1|0]");
}

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn print_payload(payload: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(payload)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn normalize_rulepack_name(raw: &str) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars() {
        if out.len() >= 80 {
            break;
        }
        if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-') {
            out.push(ch.to_ascii_lowercase());
        } else if ch.is_ascii_whitespace() {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "default".to_string()
    } else {
        trimmed
    }
}

fn rulepack_root(root: &Path) -> PathBuf {
    state_root(root).join("rulepacks")
}

fn installed_rulepack_dir(root: &Path) -> PathBuf {
    rulepack_root(root).join("installed")
}

fn active_rulepack_path(root: &Path) -> PathBuf {
    rulepack_root(root).join("active.json")
}

fn strip_rulepack_signatures(mut rulepack: Value) -> Value {
    if let Some(obj) = rulepack.as_object_mut() {
        obj.remove("signature");
        if let Some(meta) = obj.get_mut("metadata").and_then(Value::as_object_mut) {
            meta.remove("signature");
        }
    }
    rulepack
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
                "type": "binary_vuln_plane_error",
                "error": clean(err, 240)
            }));
            1
        }
    }
}

fn status(root: &Path) -> Value {
    let installed_count = fs::read_dir(installed_rulepack_dir(root))
        .ok()
        .map(|entries| {
            entries
                .flatten()
                .filter(|entry| {
                    entry
                        .path()
                        .extension()
                        .and_then(|v| v.to_str())
                        .map(|ext| ext.eq_ignore_ascii_case("json"))
                        .unwrap_or(false)
                })
                .count()
        })
        .unwrap_or(0);
    json!({
        "ok": true,
        "type": "binary_vuln_plane_status",
        "lane": "core/layer0/ops",
        "latest_path": latest_path(root).display().to_string(),
        "latest": read_json(&latest_path(root)),
        "rulepack": {
            "active": read_json(&active_rulepack_path(root)),
            "installed_count": installed_count
        },
        "observability": {
            "surface": "protheus-top",
            "cockpit_lane": "core/layer0/ops/hermes_plane"
        }
    })
}

fn conduit_enforcement(
    root: &Path,
    parsed: &crate::ParsedArgs,
    strict: bool,
    action: &str,
) -> Value {
    let bypass_requested = conduit_bypass_requested(&parsed.flags);
    let mut claim_rows = vec![
        json!({
            "id": "V6-BINVULN-001.2",
            "claim": "binary_analysis_mcp_surface_is_conduit_routed_with_receipts",
            "evidence": {
                "action": clean(action, 120),
                "bypass_requested": bypass_requested
            }
        }),
        json!({
            "id": "V6-BINVULN-001.4",
            "claim": "binary_scan_execution_is_sandboxed_with_budget_privacy_and_degrade_guards_at_the_conduit_boundary",
            "evidence": {
                "action": clean(action, 120),
                "bypass_requested": bypass_requested
            }
        }),
    ];
    if action.starts_with("rulepack") {
        claim_rows.push(json!({
            "id": "V6-BINVULN-001.5",
            "claim": "rulepack_intake_and_enable_paths_are_conduit_gated_with_fail_closed_receipts",
            "evidence": {
                "action": clean(action, 120),
                "bypass_requested": bypass_requested
            }
        }));
    }
    if action == "scan" || action == "mcp-analyze" || action == "mcp_analyze" {
        claim_rows.push(json!({
            "id": "V6-BINVULN-001.6",
            "claim": "developer_cli_aliases_route_to_core_binary_scan_lanes_and_surface_observability_in_protheus_top",
            "evidence": {
                "action": clean(action, 120),
                "bypass_requested": bypass_requested
            }
        }));
    }
    build_conduit_enforcement(
        root,
        STATE_ENV,
        STATE_SCOPE,
        strict,
        action,
        "binary_vuln_conduit_enforcement",
        "core/layer0/ops/binary_vuln_plane",
        bypass_requested,
        claim_rows,
    )
}

fn resolve_rel_or_abs(root: &Path, rel_or_abs: &str) -> PathBuf {
    if Path::new(rel_or_abs).is_absolute() {
        PathBuf::from(rel_or_abs)
    } else {
        root.join(rel_or_abs)
    }
}

fn validate_rulepack(rulepack: &Value) -> Vec<String> {
    let mut errors = Vec::<String>::new();
    if rulepack
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("rulepack_version_must_be_v1".to_string());
    }
    if rulepack
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "binary_vuln_rulepack"
    {
        errors.push("rulepack_kind_invalid".to_string());
    }
    let rules = rulepack
        .get("rules")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rules.is_empty() {
        errors.push("rulepack_rules_required".to_string());
    }
    for (idx, rule) in rules.iter().enumerate() {
        let prefix = format!("rule[{idx}]");
        let id = clean(
            rule.get("id").and_then(Value::as_str).unwrap_or_default(),
            120,
        );
        let pattern = clean(
            rule.get("pattern")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            240,
        );
        let severity = clean(
            rule.get("severity")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            40,
        )
        .to_ascii_lowercase();
        if id.is_empty() {
            errors.push(format!("{prefix}_id_required"));
        }
        if pattern.is_empty() {
            errors.push(format!("{prefix}_pattern_required"));
        }
        if !matches!(severity.as_str(), "low" | "medium" | "high" | "critical") {
            errors.push(format!("{prefix}_severity_invalid"));
        }
    }
    errors
}

fn resolve_rulepack_path_from_active(root: &Path) -> Option<PathBuf> {
    let active = read_json(&active_rulepack_path(root))?;
    let path = active
        .get("installed_path")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if path.is_empty() {
        return None;
    }
    let resolved = resolve_rel_or_abs(root, path);
    if resolved.exists() {
        Some(resolved)
    } else {
        None
    }
}

fn read_input_file(root: &Path, parsed: &crate::ParsedArgs) -> Result<(PathBuf, Vec<u8>), String> {
    let raw = parsed
        .flags
        .get("input")
        .cloned()
        .or_else(|| parsed.positional.get(1).cloned())
        .unwrap_or_default();
    if raw.trim().is_empty() {
        return Err("input_required".to_string());
    }
    let path = resolve_rel_or_abs(root, &raw);
    let bytes = fs::read(&path).map_err(|_| format!("input_not_found:{}", path.display()))?;
    if bytes.is_empty() {
        return Err("input_empty".to_string());
    }
    Ok((path, bytes))
}

fn detect_input_kind(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|v| v.to_str())
        .map(|v| v.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "bin" => "binary".to_string(),
        "efi" | "uefi" | "rom" => "uefi".to_string(),
        "ba2" => "ba2".to_string(),
        "bndb" => "binary_ninja_db".to_string(),
        "fw" | "firmware" => "firmware".to_string(),
        _ => "binary".to_string(),
    }
}

fn shannon_entropy(bytes: &[u8]) -> f64 {
    if bytes.is_empty() {
        return 0.0;
    }
    let mut freq = [0u64; 256];
    for byte in bytes {
        freq[*byte as usize] += 1;
    }
    let total = bytes.len() as f64;
    freq.iter()
        .filter(|count| **count > 0)
        .map(|count| {
            let p = *count as f64 / total;
            -(p * p.log2())
        })
        .sum()
}

fn load_rulepack(root: &Path, parsed: &crate::ParsedArgs) -> (Value, Vec<Value>, String) {
    let mut path = parsed
        .flags
        .get("rulepack")
        .map(|v| resolve_rel_or_abs(root, v))
        .or_else(|| resolve_rulepack_path_from_active(root))
        .unwrap_or_else(|| resolve_rel_or_abs(root, RULEPACK_PATH));
    let rulepack = read_json(&path).unwrap_or_else(|| {
        path = resolve_rel_or_abs(root, RULEPACK_PATH);
        json!({
            "version": "v1",
            "kind": "binary_vuln_rulepack",
            "rules": []
        })
    });
    let rules = rulepack
        .get("rules")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    (rulepack, rules, path.display().to_string())
}

fn scan_with_rules(
    raw_utf8: &str,
    kind: &str,
    bytes: &[u8],
    rules: &[Value],
    input_sha256: &str,
) -> Vec<Value> {
    let corpus = raw_utf8.to_ascii_lowercase();
    let mut findings = Vec::<Value>::new();

    for rule in rules {
        let id = clean(
            rule.get("id").and_then(Value::as_str).unwrap_or("rule"),
            120,
        );
        let pattern = clean(
            rule.get("pattern")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            240,
        );
        if pattern.is_empty() {
            continue;
        }
        let pattern_lc = pattern.to_ascii_lowercase();
        let mut cursor = 0usize;
        while let Some(found) = corpus[cursor..].find(&pattern_lc) {
            let offset = cursor + found;
            findings.push(json!({
                "id": id,
                "title": clean(rule.get("title").and_then(Value::as_str).unwrap_or("rule_match"), 140),
                "severity": clean(rule.get("severity").and_then(Value::as_str).unwrap_or("medium"), 40),
                "kind": kind,
                "pattern": pattern,
                "offset": offset,
                "confidence": rule.get("confidence").and_then(Value::as_f64).unwrap_or(0.7),
                "policy_labels": rule.get("policy_labels").cloned().unwrap_or_else(|| json!(["security"])),
                "provenance_hash": sha256_hex_str(&format!("{}:{}:{}:{}", input_sha256, kind, id, offset))
            }));
            cursor = offset.saturating_add(pattern_lc.len());
            if cursor >= corpus.len() {
                break;
            }
        }
    }

    let entropy = shannon_entropy(bytes);
    if entropy > 7.3 {
        findings.push(json!({
            "id": "entropy_high",
            "title": "high entropy payload",
            "severity": "medium",
            "kind": kind,
            "pattern": "entropy",
            "offset": 0,
            "confidence": 0.55,
            "policy_labels": ["packed_binary", "requires_manual_review"],
            "provenance_hash": sha256_hex_str(&format!("{}:{}:entropy", input_sha256, kind)),
            "entropy": entropy
        }));
    }

    findings
}

fn normalize_findings(findings: Vec<Value>) -> Vec<Value> {
    findings
        .into_iter()
        .enumerate()
        .map(|(idx, mut finding)| {
            if finding.get("finding_id").is_none() {
                let id = clean(
                    finding
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("finding"),
                    120,
                );
                finding["finding_id"] = Value::String(format!("{}-{:04}", id, idx + 1));
            }
            if finding.get("policy_labels").is_none() {
                finding["policy_labels"] = json!(["security"]);
            }
            if finding.get("confidence").is_none() {
                finding["confidence"] = json!(0.5);
            }
            finding
        })
        .collect()
}

fn scan_payload(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Result<Value, Value> {
    let scan_started = Instant::now();
    let engine_contract = load_json_or(
        root,
        ENGINE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "binary_analysis_engine_contract",
            "allowed_kinds": ["binary", "firmware", "uefi", "ba2", "binary_ninja_db"],
            "max_input_bytes": 104857600,
            "sandbox": {
                "max_findings": 4000,
                "max_scan_millis": 30000,
                "privacy": {
                    "redact_input_path": true
                },
                "degrade": {
                    "enabled": true,
                    "mode": "truncate_findings"
                }
            }
        }),
    );
    let output_contract = load_json_or(
        root,
        OUTPUT_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "binary_vuln_structured_output_contract",
            "supported_formats": ["json", "jsonl"]
        }),
    );

    let mut errors = Vec::<String>::new();
    if engine_contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("binary_analysis_engine_contract_version_must_be_v1".to_string());
    }
    if engine_contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "binary_analysis_engine_contract"
    {
        errors.push("binary_analysis_engine_contract_kind_invalid".to_string());
    }
    if output_contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("structured_output_contract_version_must_be_v1".to_string());
    }
    if output_contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "binary_vuln_structured_output_contract"
    {
        errors.push("structured_output_contract_kind_invalid".to_string());
    }

    let (path, bytes) = match read_input_file(root, parsed) {
        Ok(v) => v,
        Err(err) => {
            errors.push(err);
            (PathBuf::new(), Vec::new())
        }
    };
    if !errors.is_empty() {
        return Err(json!({
            "ok": false,
            "strict": strict,
            "type": "binary_vuln_plane_scan",
            "errors": errors
        }));
    }

    let max_input = engine_contract
        .get("max_input_bytes")
        .and_then(Value::as_u64)
        .unwrap_or(104857600) as usize;
    let sandbox = engine_contract
        .get("sandbox")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let max_findings = sandbox
        .get("max_findings")
        .and_then(Value::as_u64)
        .unwrap_or(4000) as usize;
    let max_scan_millis = sandbox
        .get("max_scan_millis")
        .and_then(Value::as_u64)
        .unwrap_or(30000);
    let redact_input_path = sandbox
        .get("privacy")
        .and_then(Value::as_object)
        .and_then(|row| row.get("redact_input_path"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let degrade_enabled = sandbox
        .get("degrade")
        .and_then(Value::as_object)
        .and_then(|row| row.get("enabled"))
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let degrade_mode = clean(
        sandbox
            .get("degrade")
            .and_then(Value::as_object)
            .and_then(|row| row.get("mode"))
            .and_then(Value::as_str)
            .unwrap_or("truncate_findings"),
        80,
    );
    let allow_raw_path = parse_bool(parsed.flags.get("allow-raw-path"), false);
    if strict && bytes.len() > max_input {
        return Err(json!({
            "ok": false,
            "strict": strict,
            "type": "binary_vuln_plane_scan",
            "errors": ["input_exceeds_max_bytes"]
        }));
    }

    let kind = detect_input_kind(&path);
    let allowed_kinds = engine_contract
        .get("allowed_kinds")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 80).to_ascii_lowercase())
        .collect::<Vec<_>>();
    if strict && !allowed_kinds.iter().any(|v| v == &kind) {
        return Err(json!({
            "ok": false,
            "strict": strict,
            "type": "binary_vuln_plane_scan",
            "errors": ["input_kind_not_allowed"]
        }));
    }

    let input_sha256 = sha256_hex_str(&String::from_utf8_lossy(&bytes));
    let raw_utf8 = String::from_utf8_lossy(&bytes).to_string();
    let (rulepack, rules, rulepack_path) = load_rulepack(root, parsed);
    let rulepack_sha256 = sha256_hex_str(&rulepack.to_string());
    let dx_source = clean(
        parsed
            .flags
            .get("dx-source")
            .map(String::as_str)
            .unwrap_or("direct"),
        80,
    );

    let mut findings = normalize_findings(scan_with_rules(
        &raw_utf8,
        &kind,
        &bytes,
        &rules,
        &input_sha256,
    ));
    let mut degraded = false;
    let mut degrade_reason = String::new();
    if findings.len() > max_findings {
        if strict && !degrade_enabled {
            return Err(json!({
                "ok": false,
                "strict": strict,
                "type": "binary_vuln_plane_scan",
                "errors": ["sandbox_finding_budget_exceeded"]
            }));
        }
        findings.truncate(max_findings);
        degraded = true;
        degrade_reason = "finding_budget_exceeded".to_string();
    }
    let scan_millis = scan_started.elapsed().as_millis() as u64;
    if strict && scan_millis > max_scan_millis {
        return Err(json!({
            "ok": false,
            "strict": strict,
            "type": "binary_vuln_plane_scan",
            "errors": ["sandbox_scan_time_budget_exceeded"]
        }));
    }

    let format = clean(
        parsed
            .flags
            .get("format")
            .cloned()
            .unwrap_or_else(|| "json".to_string()),
        20,
    )
    .to_ascii_lowercase();
    let supported_formats = output_contract
        .get("supported_formats")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![json!("json"), json!("jsonl")])
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 20).to_ascii_lowercase())
        .collect::<Vec<_>>();
    if strict && !supported_formats.iter().any(|v| v == &format) {
        return Err(json!({
            "ok": false,
            "strict": strict,
            "type": "binary_vuln_plane_scan",
            "errors": ["structured_output_format_not_supported"]
        }));
    }

    let artifact_base = state_root(root)
        .join("scan")
        .join(format!("{}", &input_sha256[..16]));
    let artifact_path = if format == "jsonl" {
        artifact_base.with_extension("jsonl")
    } else {
        artifact_base.with_extension("json")
    };

    if format == "jsonl" {
        if let Some(parent) = artifact_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let mut lines = Vec::<String>::new();
        for finding in &findings {
            lines.push(serde_json::to_string(finding).unwrap_or_else(|_| "{}".to_string()));
        }
        let _ = fs::write(&artifact_path, format!("{}\n", lines.join("\n")));
    } else {
        let _ = write_json(
            &artifact_path,
            &json!({
                "version": "v1",
                "kind": "binary_vuln_scan_artifact",
                "findings": findings
            }),
        );
    }

    let output_path = if redact_input_path && !allow_raw_path {
        format!("<redacted:{}>", &input_sha256[..12])
    } else {
        path.display().to_string()
    };
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "binary_vuln_plane_scan",
        "lane": "core/layer0/ops",
        "input": {
            "path": output_path,
            "path_redacted": redact_input_path && !allow_raw_path,
            "kind": kind,
            "sha256": input_sha256,
            "bytes": bytes.len()
        },
        "rulepack": {
            "path": rulepack_path,
            "sha256": rulepack_sha256,
            "rules": rules.len(),
            "provenance": rulepack
                .get("metadata")
                .and_then(Value::as_object)
                .and_then(|m| m.get("provenance"))
                .cloned()
                .unwrap_or(Value::Null),
            "signature": rulepack
                .get("metadata")
                .and_then(Value::as_object)
                .and_then(|m| m.get("signature"))
                .cloned()
                .or_else(|| rulepack.get("signature").cloned())
                .unwrap_or(Value::Null)
        },
        "output": {
            "format": format,
            "artifact_path": artifact_path.display().to_string(),
            "finding_count": findings.len(),
            "sandbox": {
                "max_input_bytes": max_input,
                "max_findings": max_findings,
                "max_scan_millis": max_scan_millis,
                "scan_millis": scan_millis,
                "privacy_path_redaction": redact_input_path,
                "degrade_enabled": degrade_enabled,
                "degrade_mode": degrade_mode,
                "degraded": degraded,
                "degrade_reason": if degrade_reason.is_empty() { Value::Null } else { Value::String(degrade_reason.clone()) }
            }
        },
        "findings": findings,
        "claim_evidence": [
            {
                "id": "V6-BINVULN-001.1",
                "claim": "binary_and_firmware_analysis_lane_executes_rulepack_detection_with_provenance_receipts",
                "evidence": {
                    "kind": detect_input_kind(&path),
                    "finding_count": findings.len()
                }
            },
            {
                "id": "V6-BINVULN-001.3",
                "claim": "structured_json_and_jsonl_output_contains_confidence_policy_metadata_and_provenance_hashes",
                "evidence": {
                    "format": format,
                    "finding_count": findings.len()
                }
            },
            {
                "id": "V6-BINVULN-001.4",
                "claim": "binary_scan_execution_runs_in_a_safety_plane_sandbox_with_budget_privacy_and_degrade_checks",
                "evidence": {
                    "max_input_bytes": max_input,
                    "max_findings": max_findings,
                    "scan_millis": scan_millis,
                    "degraded": degraded,
                    "path_redacted": redact_input_path && !allow_raw_path
                }
            },
            {
                "id": "V6-BINVULN-001.6",
                "claim": "developer_cli_aliases_route_to_core_binary_scan_lanes_and_surface_observability_in_protheus_top",
                "evidence": {
                    "dx_source": dx_source,
                    "observability_surface": "protheus-top",
                    "lane": "core/layer0/ops/binary_vuln_plane"
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    Ok(out)
}

fn run_scan(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    match scan_payload(root, parsed, strict) {
        Ok(v) => v,
        Err(err) => err,
    }
}

fn run_mcp_analyze(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        MCP_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "binary_vuln_mcp_server_contract",
            "allowed_transports": ["stdio", "http-sse"],
            "server_name": "binary-vuln-mcp"
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("mcp_server_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "binary_vuln_mcp_server_contract"
    {
        errors.push("mcp_server_contract_kind_invalid".to_string());
    }

    let transport = clean(
        parsed
            .flags
            .get("transport")
            .cloned()
            .unwrap_or_else(|| "stdio".to_string()),
        20,
    )
    .to_ascii_lowercase();
    let dx_source = clean(
        parsed
            .flags
            .get("dx-source")
            .map(String::as_str)
            .unwrap_or("direct"),
        80,
    );
    let allowed_transports = contract
        .get("allowed_transports")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| vec![json!("stdio")])
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 20).to_ascii_lowercase())
        .collect::<Vec<_>>();
    if strict && !allowed_transports.iter().any(|v| v == &transport) {
        errors.push("mcp_transport_invalid".to_string());
    }

    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "binary_vuln_plane_mcp_analyze",
            "errors": errors
        });
    }

    let mut scan_args = vec![
        "scan".to_string(),
        format!("--strict={}", if strict { "1" } else { "0" }),
    ];
    for (key, value) in &parsed.flags {
        if key == "transport" {
            continue;
        }
        scan_args.push(format!("--{key}={value}"));
    }
    if parsed.flags.get("format").is_none() {
        scan_args.push("--format=json".to_string());
    }

    let scan_payload = run_scan(root, &parse_args(&scan_args), strict);
    if !scan_payload
        .get("ok")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "binary_vuln_plane_mcp_analyze",
            "errors": ["scan_failed"],
            "scan_payload": scan_payload
        });
    }

    let findings = scan_payload
        .get("findings")
        .cloned()
        .unwrap_or_else(|| Value::Array(Vec::new()));
    let tool_response = json!({
        "server": clean(contract.get("server_name").and_then(Value::as_str).unwrap_or("binary-vuln-mcp"), 80),
        "transport": transport,
        "tool": "binary_vuln.analyze",
        "result": {
            "findings": findings,
            "finding_count": scan_payload
                .get("output")
                .and_then(|v| v.get("finding_count"))
                .cloned()
                .unwrap_or(json!(0)),
            "input": scan_payload.get("input").cloned().unwrap_or(Value::Null)
        }
    });

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "binary_vuln_plane_mcp_analyze",
        "lane": "core/layer0/ops",
        "mcp": tool_response,
        "scan_payload": scan_payload,
        "claim_evidence": [
            {
                "id": "V6-BINVULN-001.2",
                "claim": "binary_vuln_analysis_surface_is_exposed_as_mcp_contract_for_ai_assisted_hunting",
                "evidence": {
                    "transport": transport
                }
            },
            {
                "id": "V6-BINVULN-001.3",
                "claim": "structured_json_and_jsonl_output_contains_confidence_policy_metadata_and_provenance_hashes",
                "evidence": {
                    "finding_count": tool_response
                        .get("result")
                        .and_then(|v| v.get("finding_count"))
                        .cloned()
                        .unwrap_or(json!(0))
                }
            },
            {
                "id": "V6-BINVULN-001.4",
                "claim": "binary_scan_execution_runs_in_a_safety_plane_sandbox_with_budget_privacy_and_degrade_checks",
                "evidence": {
                    "transport": transport
                }
            },
            {
                "id": "V6-BINVULN-001.6",
                "claim": "developer_cli_aliases_route_to_core_binary_scan_lanes_and_surface_observability_in_protheus_top",
                "evidence": {
                    "dx_source": dx_source,
                    "transport": transport,
                    "observability_surface": "protheus-top"
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_rulepack_install(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let source_raw = parsed
        .flags
        .get("rulepack")
        .cloned()
        .or_else(|| parsed.positional.get(1).cloned())
        .unwrap_or_default();
    if source_raw.trim().is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "binary_vuln_plane_rulepack_install",
            "errors": ["rulepack_path_required"]
        });
    }
    let source_path = resolve_rel_or_abs(root, &source_raw);
    let mut rulepack = match read_json(&source_path) {
        Some(value) => value,
        None => {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "binary_vuln_plane_rulepack_install",
                "errors": [format!("rulepack_not_found:{}", source_path.display())]
            });
        }
    };
    let mut errors = validate_rulepack(&rulepack);
    let metadata_obj = rulepack
        .get("metadata")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let provenance = clean(
        parsed
            .flags
            .get("provenance")
            .map(String::as_str)
            .or_else(|| metadata_obj.get("provenance").and_then(Value::as_str))
            .unwrap_or_default(),
        240,
    );
    let signature = clean(
        parsed
            .flags
            .get("signature")
            .map(String::as_str)
            .or_else(|| metadata_obj.get("signature").and_then(Value::as_str))
            .or_else(|| rulepack.get("signature").and_then(Value::as_str))
            .unwrap_or_default(),
        240,
    );
    if strict && provenance.is_empty() {
        errors.push("rulepack_provenance_required".to_string());
    }
    if strict && !signature.starts_with("sig:") {
        errors.push("rulepack_signature_required".to_string());
    }
    let unsigned_payload = strip_rulepack_signatures(rulepack.clone());
    let payload_digest = sha256_hex_str(&canonical_json_string(&unsigned_payload));
    let expected_signature = format!(
        "sig:{}",
        sha256_hex_str(&format!("{provenance}:{payload_digest}"))
    );
    if strict && !signature.is_empty() && signature != expected_signature {
        errors.push("rulepack_signature_invalid".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "binary_vuln_plane_rulepack_install",
            "errors": errors,
            "source_path": source_path.display().to_string()
        });
    }

    let inferred_name = source_path
        .file_stem()
        .and_then(|v| v.to_str())
        .unwrap_or("custom-rulepack");
    let pack_name = normalize_rulepack_name(
        parsed
            .flags
            .get("name")
            .map(String::as_str)
            .or_else(|| rulepack.get("name").and_then(Value::as_str))
            .unwrap_or(inferred_name),
    );
    if let Some(obj) = rulepack.as_object_mut() {
        let metadata = obj
            .entry("metadata".to_string())
            .or_insert_with(|| Value::Object(Map::new()));
        if let Some(meta_obj) = metadata.as_object_mut() {
            if !provenance.is_empty() {
                meta_obj.insert("provenance".to_string(), Value::String(provenance.clone()));
            }
            if !signature.is_empty() {
                meta_obj.insert("signature".to_string(), Value::String(signature.clone()));
            }
            meta_obj.insert(
                "payload_digest".to_string(),
                Value::String(payload_digest.clone()),
            );
        }
    }

    let installed_path = installed_rulepack_dir(root).join(format!("{pack_name}.json"));
    if let Some(parent) = installed_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(err) = write_json(&installed_path, &rulepack) {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "binary_vuln_plane_rulepack_install",
            "errors": [clean(err, 240)],
            "source_path": source_path.display().to_string()
        });
    }

    let enable_now = parse_bool(parsed.flags.get("enable"), true);
    let mut active_written = false;
    if enable_now {
        let active = json!({
            "version": "v1",
            "kind": "binary_vuln_active_rulepack",
            "name": pack_name,
            "installed_path": installed_path.display().to_string(),
            "sha256": sha256_hex_str(&rulepack.to_string()),
            "enabled_at": crate::now_iso(),
            "provenance": if provenance.is_empty() { Value::Null } else { Value::String(provenance.clone()) },
            "signature": if signature.is_empty() { Value::Null } else { Value::String(signature.clone()) }
        });
        if write_json(&active_rulepack_path(root), &active).is_ok() {
            active_written = true;
        }
    }

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "binary_vuln_plane_rulepack_install",
        "lane": "core/layer0/ops",
        "rulepack": {
            "name": pack_name,
            "source_path": source_path.display().to_string(),
            "installed_path": installed_path.display().to_string(),
            "payload_digest": payload_digest,
            "provenance": if provenance.is_empty() { Value::Null } else { Value::String(provenance.clone()) },
            "signature": if signature.is_empty() { Value::Null } else { Value::String(signature.clone()) },
            "rule_count": rulepack.get("rules").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
            "enabled_now": enable_now,
            "active_written": active_written
        },
        "claim_evidence": [
            {
                "id": "V6-BINVULN-001.5",
                "claim": "custom_and_community_rulepacks_install_with_schema_signature_and_provenance_validation_before_enable",
                "evidence": {
                    "name": pack_name,
                    "strict": strict,
                    "enabled_now": enable_now,
                    "payload_digest": payload_digest
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_rulepack_enable(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let name = normalize_rulepack_name(
        parsed
            .flags
            .get("name")
            .map(String::as_str)
            .or_else(|| parsed.positional.get(1).map(String::as_str))
            .unwrap_or("default"),
    );
    let installed_path = installed_rulepack_dir(root).join(format!("{name}.json"));
    let Some(rulepack) = read_json(&installed_path) else {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "binary_vuln_plane_rulepack_enable",
            "errors": [format!("rulepack_not_installed:{name}")]
        });
    };
    let mut errors = validate_rulepack(&rulepack);
    let provenance = clean(
        rulepack
            .get("metadata")
            .and_then(Value::as_object)
            .and_then(|m| m.get("provenance"))
            .and_then(Value::as_str)
            .unwrap_or_default(),
        240,
    );
    let signature = clean(
        rulepack
            .get("metadata")
            .and_then(Value::as_object)
            .and_then(|m| m.get("signature"))
            .and_then(Value::as_str)
            .or_else(|| rulepack.get("signature").and_then(Value::as_str))
            .unwrap_or_default(),
        240,
    );
    if strict && provenance.is_empty() {
        errors.push("rulepack_provenance_required".to_string());
    }
    if strict && !signature.starts_with("sig:") {
        errors.push("rulepack_signature_required".to_string());
    }
    let unsigned_payload = strip_rulepack_signatures(rulepack.clone());
    let payload_digest = sha256_hex_str(&canonical_json_string(&unsigned_payload));
    let expected_signature = format!(
        "sig:{}",
        sha256_hex_str(&format!("{provenance}:{payload_digest}"))
    );
    if strict && !signature.is_empty() && signature != expected_signature {
        errors.push("rulepack_signature_invalid".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "binary_vuln_plane_rulepack_enable",
            "errors": errors,
            "name": name
        });
    }

    let active = json!({
        "version": "v1",
        "kind": "binary_vuln_active_rulepack",
        "name": name,
        "installed_path": installed_path.display().to_string(),
        "sha256": sha256_hex_str(&rulepack.to_string()),
        "enabled_at": crate::now_iso(),
        "provenance": if provenance.is_empty() { Value::Null } else { Value::String(provenance.clone()) },
        "signature": if signature.is_empty() { Value::Null } else { Value::String(signature.clone()) }
    });
    if let Err(err) = write_json(&active_rulepack_path(root), &active) {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "binary_vuln_plane_rulepack_enable",
            "errors": [clean(err, 240)],
            "name": name
        });
    }

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "binary_vuln_plane_rulepack_enable",
        "lane": "core/layer0/ops",
        "active_rulepack": active,
        "claim_evidence": [
            {
                "id": "V6-BINVULN-001.5",
                "claim": "custom_and_community_rulepacks_install_with_schema_signature_and_provenance_validation_before_enable",
                "evidence": {
                    "name": name,
                    "installed_path": installed_path.display().to_string()
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
                "type": "binary_vuln_plane_conduit_gate",
                "errors": ["conduit_bypass_rejected"],
                "conduit_enforcement": conduit
            }),
        );
    }

    let payload = match command.as_str() {
        "status" => status(root),
        "scan" => run_scan(root, &parsed, strict),
        "mcp-analyze" | "mcp_analyze" | "mcp" => run_mcp_analyze(root, &parsed, strict),
        "rulepack-install" | "rulepack_install" => run_rulepack_install(root, &parsed, strict),
        "rulepack-enable" | "rulepack_enable" => run_rulepack_enable(root, &parsed, strict),
        _ => json!({
            "ok": false,
            "type": "binary_vuln_plane_error",
            "error": "unknown_command",
            "command": command
        }),
    };
    if command == "status" {
        print_payload(&payload);
        return 0;
    }
    emit(root, attach_conduit(payload, conduit.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entropy_is_zero_for_empty() {
        assert_eq!(shannon_entropy(&[]), 0.0);
    }

    #[test]
    fn detect_input_kind_defaults_binary() {
        let path = PathBuf::from("sample.unknown");
        assert_eq!(detect_input_kind(&path), "binary");
    }

    #[test]
    fn conduit_rejects_bypass() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = crate::parse_args(&["scan".to_string(), "--bypass=1".to_string()]);
        let out = conduit_enforcement(root.path(), &parsed, true, "scan");
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    }
}
