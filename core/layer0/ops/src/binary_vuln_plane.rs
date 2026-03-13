// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::binary_vuln_plane (authoritative)

use crate::v8_kernel::{
    append_jsonl, parse_bool, read_json, scoped_state_root, sha256_hex_str, write_json,
    write_receipt,
};
use crate::{clean, parse_args};
use serde_json::{json, Value};
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

fn load_json_or(root: &Path, rel: &str, fallback: Value) -> Value {
    read_json(&root.join(rel)).unwrap_or(fallback)
}

fn status(root: &Path) -> Value {
    json!({
        "ok": true,
        "type": "binary_vuln_plane_status",
        "lane": "core/layer0/ops",
        "latest_path": latest_path(root).display().to_string(),
        "latest": read_json(&latest_path(root))
    })
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
    let mut out = json!({
        "ok": if strict { ok } else { true },
        "type": "binary_vuln_conduit_enforcement",
        "action": clean(action, 120),
        "required_path": "core/layer0/ops/binary_vuln_plane",
        "bypass_requested": bypass_requested,
        "errors": if ok { Value::Array(Vec::new()) } else { json!(["conduit_bypass_rejected"]) },
        "claim_evidence": [
            {
                "id": "V6-BINVULN-001.2",
                "claim": "binary_analysis_mcp_surface_is_conduit_routed_with_receipts",
                "evidence": {
                    "action": clean(action, 120),
                    "bypass_requested": bypass_requested
                }
            },
            {
                "id": "V6-BINVULN-001.4",
                "claim": "binary_scan_execution_is_sandboxed_with_budget_privacy_and_degrade_guards_at_the_conduit_boundary",
                "evidence": {
                    "action": clean(action, 120),
                    "bypass_requested": bypass_requested
                }
            }
        ]
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

fn resolve_rel_or_abs(root: &Path, rel_or_abs: &str) -> PathBuf {
    if Path::new(rel_or_abs).is_absolute() {
        PathBuf::from(rel_or_abs)
    } else {
        root.join(rel_or_abs)
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

fn load_rulepack(root: &Path, parsed: &crate::ParsedArgs) -> (Value, Vec<Value>) {
    let rulepack_path = parsed
        .flags
        .get("rulepack")
        .cloned()
        .unwrap_or_else(|| RULEPACK_PATH.to_string());
    let path = resolve_rel_or_abs(root, &rulepack_path);
    let rulepack = read_json(&path).unwrap_or_else(|| {
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
    (rulepack, rules)
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
    let (rulepack, rules) = load_rulepack(root, parsed);
    let rulepack_sha256 = sha256_hex_str(&rulepack.to_string());

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
            "sha256": rulepack_sha256,
            "rules": rules.len()
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
