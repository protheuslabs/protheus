// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::parse_plane (authoritative)

use crate::v8_kernel::{
    attach_conduit, build_plane_conduit_enforcement, canonical_json_string, canonicalize_json,
    conduit_bypass_requested, emit_plane_receipt, load_json_or, parse_bool, parse_u64,
    plane_status, print_json, read_json, scoped_state_root, sha256_hex_str, write_json,
};
use crate::{clean, parse_args};
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "PARSE_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "parse_plane";

const PARSE_CONTRACT_PATH: &str = "planes/contracts/parse/mapping_rule_parser_contract_v1.json";
const VISUALIZE_CONTRACT_PATH: &str =
    "planes/contracts/parse/parse_instruction_pipeline_contract_v1.json";
const TABLE_POSTPROCESS_CONTRACT_PATH: &str =
    "planes/contracts/parse/table_postprocessing_contract_v1.json";
const FLATTEN_TRANSFORM_CONTRACT_PATH: &str =
    "planes/contracts/parse/flatten_unnest_transform_contract_v1.json";
const TEMPLATE_GOVERNANCE_CONTRACT_PATH: &str =
    "planes/contracts/parse/parser_template_governance_contract_v1.json";
const TEMPLATE_MANIFEST_PATH: &str = "planes/contracts/parse/parser_template_pack_manifest_v1.json";
const DEFAULT_MAPPING_ROOT: &str = "planes/contracts/parse/mappings";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops parse-plane status");
    println!("  protheus-ops parse-plane parse-doc [--file=<path>|--source=<text>] [--mapping=<id>|--mapping-path=<path>] [--strict=1|0]");
    println!("  protheus-ops parse-plane visualize [--from-path=<path>] [--strict=1|0]");
    println!("  protheus-ops parse-plane postprocess-table [--table-json=<json>|--table-path=<path>|--from-path=<path>] [--max-rows=<n>] [--max-cols=<n>] [--strict=1|0]");
    println!("  protheus-ops parse-plane flatten [--json=<json>|--json-path=<path>|--from-path=<path>] [--max-depth=<n>] [--format=dot|slash] [--strict=1|0]");
    println!("  protheus-ops parse-plane export [--from-path=<path>] [--output-path=<path>] [--format=json|jsonl|md] [--strict=1|0]");
    println!("  protheus-ops parse-plane template-governance [--manifest=<path>] [--templates-root=<path>] [--strict=1|0]");
}

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn emit(root: &Path, payload: Value) -> i32 {
    emit_plane_receipt(root, STATE_ENV, STATE_SCOPE, "parse_plane_error", payload)
}

fn status(root: &Path) -> Value {
    plane_status(root, STATE_ENV, STATE_SCOPE, "parse_plane_status")
}

fn conduit_enforcement(
    root: &Path,
    parsed: &crate::ParsedArgs,
    strict: bool,
    action: &str,
) -> Value {
    let bypass_requested = conduit_bypass_requested(&parsed.flags);
    build_plane_conduit_enforcement(
        root,
        STATE_ENV,
        STATE_SCOPE,
        strict,
        action,
        "parse_conduit_enforcement",
        "core/layer0/ops/parse_plane",
        bypass_requested,
        "all_parse_apply_and_visualize_actions_route_through_conduit_with_bypass_rejection",
        &["V6-PARSE-001.6"],
    )
}

fn strip_tags(raw: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in raw.chars() {
        if ch == '<' {
            in_tag = true;
            continue;
        }
        if ch == '>' {
            in_tag = false;
            out.push(' ');
            continue;
        }
        if !in_tag {
            out.push(ch);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn parse_title(raw: &str) -> String {
    let lower = raw.to_ascii_lowercase();
    if let Some(start) = lower.find("<title>") {
        let body = &raw[start + 7..];
        if let Some(end) = body.to_ascii_lowercase().find("</title>") {
            return clean(&body[..end], 240);
        }
    }
    if let Some(first) = raw.lines().next() {
        return clean(first, 240);
    }
    "untitled".to_string()
}

fn extract_between(raw: &str, start: &str, end: &str) -> Option<String> {
    let from = raw.find(start)?;
    let rest = &raw[from + start.len()..];
    let until = rest.find(end)?;
    Some(clean(&rest[..until], 500))
}

fn extract_prefix_line(raw: &str, prefix: &str) -> Option<String> {
    for line in raw.lines() {
        let trimmed = line.trim();
        if let Some(stripped) = trimmed.strip_prefix(prefix) {
            return Some(clean(stripped.trim(), 500));
        }
    }
    None
}

fn load_source(root: &Path, parsed: &crate::ParsedArgs) -> Result<(String, String), String> {
    if let Some(inline) = parsed.flags.get("source") {
        let source = clean(inline, 200_000);
        if source.is_empty() {
            return Err("source_empty".to_string());
        }
        return Ok(("inline".to_string(), source));
    }
    if let Some(file_rel) = parsed
        .flags
        .get("file")
        .or_else(|| parsed.positional.get(1))
    {
        let path = if Path::new(file_rel).is_absolute() {
            PathBuf::from(file_rel)
        } else {
            root.join(file_rel)
        };
        let source = fs::read_to_string(&path)
            .map_err(|_| format!("source_file_not_found:{}", path.display()))?;
        if source.trim().is_empty() {
            return Err("source_empty".to_string());
        }
        return Ok((path.display().to_string(), source));
    }
    Err("missing_source".to_string())
}

fn load_mapping(root: &Path, parsed: &crate::ParsedArgs) -> Result<(String, Value), String> {
    if let Some(path_raw) = parsed.flags.get("mapping-path") {
        let path = if Path::new(path_raw).is_absolute() {
            PathBuf::from(path_raw)
        } else {
            root.join(path_raw)
        };
        let value =
            read_json(&path).ok_or_else(|| format!("mapping_not_found:{}", path.display()))?;
        return Ok((path.display().to_string(), value));
    }

    let mapping_id = clean(
        parsed
            .flags
            .get("mapping")
            .cloned()
            .unwrap_or_else(|| "default".to_string()),
        120,
    );
    let path = root
        .join(DEFAULT_MAPPING_ROOT)
        .join(format!("{mapping_id}.json"));
    let value = read_json(&path).ok_or_else(|| format!("mapping_not_found:{}", path.display()))?;
    Ok((path.display().to_string(), value))
}

fn apply_rule(rule: &Value, source_raw: &str, source_plain: &str) -> (String, Value, bool) {
    let field = rule
        .get("field")
        .and_then(Value::as_str)
        .map(|v| clean(v, 120))
        .unwrap_or_else(|| "field".to_string());
    let strategy = rule
        .get("strategy")
        .and_then(Value::as_str)
        .map(|v| clean(v, 80).to_ascii_lowercase())
        .unwrap_or_else(|| "contains".to_string());
    let required = rule
        .get("required")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let value = match strategy.as_str() {
        "title" => Value::String(parse_title(source_raw)),
        "between" => {
            let start = rule
                .get("start")
                .and_then(Value::as_str)
                .map(|v| clean(v, 120))
                .unwrap_or_default();
            let end = rule
                .get("end")
                .and_then(Value::as_str)
                .map(|v| clean(v, 120))
                .unwrap_or_default();
            if start.is_empty() || end.is_empty() {
                Value::Null
            } else {
                extract_between(source_raw, &start, &end)
                    .map(Value::String)
                    .unwrap_or(Value::Null)
            }
        }
        "prefix_line" => {
            let prefix = rule
                .get("prefix")
                .and_then(Value::as_str)
                .map(|v| clean(v, 120))
                .unwrap_or_default();
            if prefix.is_empty() {
                Value::Null
            } else {
                extract_prefix_line(source_raw, &prefix)
                    .map(Value::String)
                    .unwrap_or(Value::Null)
            }
        }
        "constant" => rule.get("value").cloned().unwrap_or(Value::Null),
        "contains" => {
            let token = rule
                .get("token")
                .and_then(Value::as_str)
                .map(|v| clean(v, 120))
                .unwrap_or_default();
            if token.is_empty() {
                Value::Null
            } else {
                Value::Bool(
                    source_plain
                        .to_ascii_lowercase()
                        .contains(&token.to_ascii_lowercase()),
                )
            }
        }
        _ => Value::Null,
    };

    let present = if value.is_null() {
        false
    } else if let Some(s) = value.as_str() {
        !s.is_empty()
    } else {
        true
    };
    let valid = if required { present } else { true };
    (field, value, valid)
}

fn value_to_table(value: &Value) -> Option<Vec<Vec<String>>> {
    if let Some(rows) = value.as_array() {
        if rows.is_empty() {
            return Some(Vec::new());
        }
        if rows.iter().all(|row| row.is_array()) {
            let mut out = Vec::<Vec<String>>::new();
            for row in rows {
                let mut rendered = Vec::<String>::new();
                for cell in row.as_array().cloned().unwrap_or_default() {
                    rendered.push(clean(cell.as_str().unwrap_or(&cell.to_string()), 800));
                }
                out.push(rendered);
            }
            return Some(out);
        }
        if rows.iter().all(|row| row.is_object()) {
            let mut keys = rows
                .iter()
                .filter_map(Value::as_object)
                .flat_map(|obj| obj.keys().cloned().collect::<Vec<_>>())
                .collect::<Vec<_>>();
            keys.sort();
            keys.dedup();
            let mut out = vec![keys.clone()];
            for row in rows {
                let mut rendered = Vec::<String>::new();
                if let Some(obj) = row.as_object() {
                    for key in &keys {
                        let v = obj.get(key).cloned().unwrap_or(Value::Null);
                        rendered.push(clean(v.as_str().unwrap_or(&v.to_string()), 800));
                    }
                }
                out.push(rendered);
            }
            return Some(out);
        }
    }
    if let Some(raw) = value.as_str() {
        let mut out = Vec::<Vec<String>>::new();
        for line in raw.lines() {
            if !line.contains('|') {
                continue;
            }
            let row = line
                .split('|')
                .map(|cell| clean(cell.trim(), 800))
                .filter(|cell| !cell.is_empty())
                .collect::<Vec<_>>();
            if !row.is_empty() {
                out.push(row);
            }
        }
        return Some(out);
    }
    None
}

fn is_separator_cell(cell: &str) -> bool {
    let trimmed = cell.trim();
    !trimmed.is_empty()
        && trimmed
            .chars()
            .all(|ch| matches!(ch, '-' | '=' | ':' | '|' | ' '))
}

fn is_fake_row(row: &[String]) -> bool {
    if row.is_empty() {
        return true;
    }
    row.iter()
        .all(|cell| cell.trim().is_empty() || is_separator_cell(cell))
}

fn strip_footnote(cell: &str) -> (String, Option<String>) {
    let trimmed = cell.trim();
    if !trimmed.ends_with(']') {
        return (clean(trimmed, 800), None);
    }
    let Some(open_idx) = trimmed.rfind('[') else {
        return (clean(trimmed, 800), None);
    };
    if open_idx == 0 {
        return (clean(trimmed, 800), None);
    }
    let marker = &trimmed[open_idx + 1..trimmed.len() - 1];
    if marker.is_empty() || !marker.chars().all(|ch| ch.is_ascii_digit()) {
        return (clean(trimmed, 800), None);
    }
    let base = clean(trimmed[..open_idx].trim_end(), 800);
    let note = clean(&trimmed[open_idx..], 64);
    (base, Some(note))
}

fn run_parse_doc(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let parse_contract = load_json_or(
        root,
        PARSE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "mapping_rule_parser_contract",
            "supported_strategies": ["title", "between", "prefix_line", "constant", "contains"]
        }),
    );

    let mut errors = Vec::<String>::new();
    if parse_contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("parse_contract_version_must_be_v1".to_string());
    }
    if parse_contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "mapping_rule_parser_contract"
    {
        errors.push("parse_contract_kind_invalid".to_string());
    }

    let (source_path, source_raw) = match load_source(root, parsed) {
        Ok(ok) => ok,
        Err(err) => {
            errors.push(err);
            ("".to_string(), "".to_string())
        }
    };
    let (mapping_path, mapping) = match load_mapping(root, parsed) {
        Ok(ok) => ok,
        Err(err) => {
            errors.push(err);
            ("".to_string(), Value::Null)
        }
    };

    if mapping.is_null() {
        errors.push("mapping_missing".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "parse_plane_parse_doc",
            "errors": errors
        });
    }

    let mapping_version = mapping
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let mapping_kind = mapping
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if mapping_version != "v1" {
        errors.push("mapping_version_must_be_v1".to_string());
    }
    if mapping_kind != "mapping_rule_set" {
        errors.push("mapping_kind_invalid".to_string());
    }

    let rules = mapping
        .get("rules")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if rules.is_empty() {
        errors.push("mapping_rules_required".to_string());
    }

    let source_plain = strip_tags(&source_raw);
    let mut instructions = Vec::<Value>::new();
    let mut structured = Map::<String, Value>::new();
    let mut validation = Vec::<Value>::new();

    for (idx, rule) in rules.iter().enumerate() {
        let strategy = rule
            .get("strategy")
            .and_then(Value::as_str)
            .map(|v| clean(v, 80))
            .unwrap_or_else(|| "contains".to_string());
        instructions.push(json!({
            "index": idx,
            "strategy": strategy,
            "field": clean(rule.get("field").and_then(Value::as_str).unwrap_or("field"), 120)
        }));
        let (field, value, valid) = apply_rule(rule, &source_raw, &source_plain);
        let required = rule
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        validation.push(json!({"field": field, "required": required, "valid": valid}));
        structured.insert(field, value);
    }

    if strict
        && validation.iter().any(|row| {
            row.get("required")
                .and_then(Value::as_bool)
                .unwrap_or(false)
                && !row.get("valid").and_then(Value::as_bool).unwrap_or(false)
        })
    {
        errors.push("required_mapping_rule_validation_failed".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "parse_plane_parse_doc",
            "errors": errors,
            "validation": validation
        });
    }

    let stage_receipts = vec![
        json!({
            "stage": "source",
            "source_path": source_path,
            "source_sha256": sha256_hex_str(&source_raw),
            "length": source_raw.len()
        }),
        json!({
            "stage": "instructions",
            "mapping_path": mapping_path,
            "mapping_sha256": sha256_hex_str(&mapping.to_string()),
            "instruction_count": instructions.len()
        }),
        json!({
            "stage": "structured_dict",
            "field_count": structured.len(),
            "structured_sha256": sha256_hex_str(&Value::Object(structured.clone()).to_string())
        }),
    ];

    let artifact = json!({
        "source_path": source_path,
        "mapping_path": mapping_path,
        "pipeline": {
            "source": {
                "raw_sha256": sha256_hex_str(&source_raw),
                "plain_preview": clean(&source_plain, 300)
            },
            "instructions": instructions,
            "structured": Value::Object(structured.clone())
        },
        "validation": validation,
        "stage_receipts": stage_receipts
    });
    let artifact_path = state_root(root).join("parse_doc").join("latest.json");
    let _ = write_json(&artifact_path, &artifact);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "parse_plane_parse_doc",
        "lane": "core/layer0/ops",
        "artifact": {
            "path": artifact_path.display().to_string(),
            "sha256": sha256_hex_str(&artifact.to_string())
        },
        "pipeline": artifact.get("pipeline").cloned().unwrap_or(Value::Null),
        "validation": validation,
        "stage_receipts": stage_receipts,
        "claim_evidence": [
            {
                "id": "V6-PARSE-001.1",
                "claim": "versioned_mapping_rule_parser_runs_with_policy_scoped_load_and_deterministic_receipts",
                "evidence": {
                    "mapping_path": mapping_path,
                    "rule_count": rules.len()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_visualize(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let vis_contract = load_json_or(
        root,
        VISUALIZE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "parse_instruction_pipeline_contract",
            "pipeline_order": ["source", "instructions", "structured_dict"]
        }),
    );
    let mut errors = Vec::<String>::new();
    if vis_contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("visualize_contract_version_must_be_v1".to_string());
    }
    if vis_contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "parse_instruction_pipeline_contract"
    {
        errors.push("visualize_contract_kind_invalid".to_string());
    }

    let from_path = parsed.flags.get("from-path").cloned().unwrap_or_else(|| {
        state_root(root)
            .join("parse_doc")
            .join("latest.json")
            .display()
            .to_string()
    });
    let from = if Path::new(&from_path).is_absolute() {
        PathBuf::from(&from_path)
    } else {
        root.join(&from_path)
    };
    let artifact = read_json(&from).unwrap_or(Value::Null);
    if artifact.is_null() {
        errors.push(format!("parse_artifact_missing:{}", from.display()));
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "parse_plane_visualize",
            "errors": errors
        });
    }

    let stage_order = vis_contract
        .get("pipeline_order")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_else(|| {
            vec![
                json!("source"),
                json!("instructions"),
                json!("structured_dict"),
            ]
        })
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 120))
        .collect::<Vec<_>>();

    let diagram = format!(
        "source -> instructions -> structured_dict\norder={}",
        stage_order.join(" -> ")
    );
    let stage_receipts = vec![
        json!({
            "stage": "source",
            "artifact_path": from.display().to_string(),
            "artifact_sha256": sha256_hex_str(&artifact.to_string())
        }),
        json!({
            "stage": "visualization",
            "diagram_sha256": sha256_hex_str(&diagram)
        }),
    ];

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "parse_plane_visualize",
        "lane": "core/layer0/ops",
        "visualization": {
            "diagram": diagram,
            "stage_order": stage_order
        },
        "source_artifact": from.display().to_string(),
        "source_pipeline": artifact.get("pipeline").cloned().unwrap_or(Value::Null),
        "stage_receipts": stage_receipts,
        "claim_evidence": [
            {
                "id": "V6-PARSE-001.2",
                "claim": "instruction_stage_pipeline_is_inspectable_and_visualizable_with_deterministic_receipts",
                "evidence": {
                    "from_path": from.display().to_string(),
                    "stage_count": 3
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn parse_table_input(
    root: &Path,
    parsed: &crate::ParsedArgs,
) -> Result<(String, Vec<Vec<String>>), String> {
    if let Some(raw) = parsed.flags.get("table-json") {
        let parsed_value: Value =
            serde_json::from_str(raw).map_err(|_| "table_json_invalid".to_string())?;
        if let Some(table) = value_to_table(&parsed_value) {
            return Ok(("table-json".to_string(), table));
        }
        return Err("table_json_invalid_shape".to_string());
    }
    if let Some(rel_or_abs) = parsed.flags.get("table-path") {
        let path = if Path::new(rel_or_abs).is_absolute() {
            PathBuf::from(rel_or_abs)
        } else {
            root.join(rel_or_abs)
        };
        let raw = fs::read_to_string(&path)
            .map_err(|_| format!("table_path_not_found:{}", path.display()))?;
        let parsed_value: Value =
            serde_json::from_str(&raw).map_err(|_| "table_path_json_invalid".to_string())?;
        if let Some(table) = value_to_table(&parsed_value) {
            return Ok((path.display().to_string(), table));
        }
        return Err("table_path_invalid_shape".to_string());
    }

    let from_path = parsed.flags.get("from-path").cloned().unwrap_or_else(|| {
        state_root(root)
            .join("parse_doc")
            .join("latest.json")
            .display()
            .to_string()
    });
    let path = if Path::new(&from_path).is_absolute() {
        PathBuf::from(&from_path)
    } else {
        root.join(&from_path)
    };
    let artifact =
        read_json(&path).ok_or_else(|| format!("from_path_not_found:{}", path.display()))?;
    let structured = artifact
        .get("pipeline")
        .and_then(|v| v.get("structured"))
        .cloned()
        .unwrap_or(Value::Null);
    let candidate = structured
        .get("table")
        .cloned()
        .or_else(|| {
            structured
                .get("tables")
                .and_then(Value::as_array)
                .and_then(|rows| rows.first())
                .cloned()
        })
        .or_else(|| structured.get("rows").cloned())
        .unwrap_or(structured);
    if let Some(table) = value_to_table(&candidate) {
        return Ok((path.display().to_string(), table));
    }
    Err("table_unavailable_in_artifact".to_string())
}

fn run_postprocess_table(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        TABLE_POSTPROCESS_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "table_postprocessing_pipeline_contract",
            "stages": ["detect_fake_table", "merge_simplify", "footnote_handle"],
            "default_max_rows": 5000,
            "default_max_cols": 64
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("table_postprocess_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "table_postprocessing_pipeline_contract"
    {
        errors.push("table_postprocess_contract_kind_invalid".to_string());
    }

    let (source_hint, table) = match parse_table_input(root, parsed) {
        Ok(ok) => ok,
        Err(err) => {
            errors.push(err);
            ("".to_string(), Vec::new())
        }
    };
    let max_rows = parse_u64(
        parsed.flags.get("max-rows"),
        contract
            .get("default_max_rows")
            .and_then(Value::as_u64)
            .unwrap_or(5000),
    )
    .clamp(1, 20_000) as usize;
    let max_cols = parse_u64(
        parsed.flags.get("max-cols"),
        contract
            .get("default_max_cols")
            .and_then(Value::as_u64)
            .unwrap_or(64),
    )
    .clamp(1, 512) as usize;

    if table.is_empty() {
        errors.push("table_required".to_string());
    }
    if strict && table.len() > max_rows {
        errors.push("table_rows_exceed_contract_limit".to_string());
    }
    if strict && table.iter().any(|row| row.len() > max_cols) {
        errors.push("table_cols_exceed_contract_limit".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "parse_plane_postprocess_table",
            "errors": errors
        });
    }

    let before = table.clone();
    let before_hash = sha256_hex_str(&canonical_json_string(&json!(before)));

    let mut fake_rows_removed = 0usize;
    let mut stage1 = Vec::<Vec<String>>::new();
    for row in &before {
        if is_fake_row(row) {
            fake_rows_removed += 1;
        } else {
            stage1.push(
                row.iter()
                    .map(|cell| clean(cell.trim(), 800))
                    .collect::<Vec<_>>(),
            );
        }
    }

    let mut merged_rows = 0usize;
    let mut stage2 = Vec::<Vec<String>>::new();
    for row in &stage1 {
        let first_empty = row
            .first()
            .map(|cell| cell.trim().is_empty())
            .unwrap_or(true);
        if first_empty && !stage2.is_empty() {
            let prev = stage2.last_mut().expect("prev");
            for (idx, cell) in row.iter().enumerate() {
                if cell.trim().is_empty() {
                    continue;
                }
                if idx >= prev.len() {
                    prev.push(clean(cell.trim(), 800));
                    continue;
                }
                if prev[idx].trim().is_empty() {
                    prev[idx] = clean(cell.trim(), 800);
                } else {
                    prev[idx] = clean(format!("{} {}", prev[idx], cell.trim()), 800);
                }
            }
            merged_rows += 1;
        } else {
            stage2.push(row.clone());
        }
    }

    let mut footnotes = Vec::<Value>::new();
    let mut stage3 = Vec::<Vec<String>>::new();
    for (row_idx, row) in stage2.iter().enumerate() {
        let mut rendered = Vec::<String>::new();
        for (col_idx, cell) in row.iter().enumerate() {
            let (cleaned, note) = strip_footnote(cell);
            if let Some(marker) = note {
                footnotes.push(json!({
                    "row": row_idx,
                    "col": col_idx,
                    "marker": marker
                }));
            }
            rendered.push(cleaned);
        }
        stage3.push(rendered);
    }

    let after_hash = sha256_hex_str(&canonical_json_string(&json!(stage3)));
    let stage_receipts = vec![
        json!({
            "stage": "detect_fake_table",
            "before_rows": before.len(),
            "after_rows": stage1.len(),
            "fake_rows_removed": fake_rows_removed
        }),
        json!({
            "stage": "merge_simplify",
            "before_rows": stage1.len(),
            "after_rows": stage2.len(),
            "rows_merged": merged_rows
        }),
        json!({
            "stage": "footnote_handle",
            "footnotes_extracted": footnotes.len()
        }),
    ];

    let artifact = json!({
        "source_hint": source_hint,
        "before": before,
        "after": stage3,
        "footnotes": footnotes,
        "limits": {"max_rows": max_rows, "max_cols": max_cols},
        "hashes": {"before_sha256": before_hash, "after_sha256": after_hash},
        "stage_receipts": stage_receipts
    });
    let artifact_path = state_root(root)
        .join("parse_postprocess")
        .join("latest.json");
    let _ = write_json(&artifact_path, &artifact);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "parse_plane_postprocess_table",
        "lane": "core/layer0/ops",
        "artifact": {
            "path": artifact_path.display().to_string(),
            "sha256": sha256_hex_str(&artifact.to_string())
        },
        "result": artifact,
        "claim_evidence": [
            {
                "id": "V6-PARSE-001.3",
                "claim": "advanced_table_postprocessing_pipeline_executes_fake_table_detection_merge_simplify_and_footnote_handling_with_before_after_evidence",
                "evidence": {
                    "fake_rows_removed": fake_rows_removed,
                    "rows_merged": merged_rows,
                    "footnotes_extracted": footnotes.len()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn flatten_key(prefix: &str, segment: &str, format: &str) -> String {
    if prefix.is_empty() {
        return clean(segment, 200);
    }
    if format == "slash" {
        clean(format!("{prefix}/{segment}"), 300)
    } else {
        clean(format!("{prefix}.{segment}"), 300)
    }
}

fn is_scalar(value: &Value) -> bool {
    matches!(
        value,
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_)
    )
}

fn flatten_value(
    prefix: &str,
    value: &Value,
    depth: usize,
    max_depth: usize,
    format: &str,
    out: &mut Map<String, Value>,
) {
    if depth > max_depth {
        out.insert(prefix.to_string(), Value::String("[max_depth]".to_string()));
        return;
    }
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                if let Some(next) = map.get(&key) {
                    let joined = flatten_key(prefix, &key, format);
                    flatten_value(&joined, next, depth + 1, max_depth, format, out);
                }
            }
        }
        Value::Array(rows) => {
            if rows.iter().all(is_scalar) {
                out.insert(prefix.to_string(), Value::Array(rows.clone()));
            } else {
                for (idx, next) in rows.iter().enumerate() {
                    let joined = flatten_key(prefix, &idx.to_string(), format);
                    flatten_value(&joined, next, depth + 1, max_depth, format, out);
                }
            }
        }
        _ => {
            out.insert(prefix.to_string(), value.clone());
        }
    }
}

fn collect_unnested_rows(
    prefix: &str,
    value: &Value,
    depth: usize,
    max_depth: usize,
    format: &str,
    out: &mut Vec<Value>,
) {
    if depth > max_depth {
        return;
    }
    match value {
        Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            for key in keys {
                if let Some(next) = map.get(&key) {
                    let joined = flatten_key(prefix, &key, format);
                    collect_unnested_rows(&joined, next, depth + 1, max_depth, format, out);
                }
            }
        }
        Value::Array(rows) => {
            for (idx, next) in rows.iter().enumerate() {
                if let Some(obj) = next.as_object() {
                    let mut row = Map::<String, Value>::new();
                    row.insert("__path".to_string(), Value::String(prefix.to_string()));
                    row.insert("__index".to_string(), json!(idx));
                    let mut keys = obj.keys().cloned().collect::<Vec<_>>();
                    keys.sort();
                    for key in keys {
                        let cell = obj.get(&key).cloned().unwrap_or(Value::Null);
                        if is_scalar(&cell) {
                            row.insert(key, cell);
                        } else {
                            row.insert(
                                key,
                                Value::String(clean(canonical_json_string(&cell), 400)),
                            );
                        }
                    }
                    out.push(Value::Object(row));
                }
                let joined = flatten_key(prefix, &idx.to_string(), format);
                collect_unnested_rows(&joined, next, depth + 1, max_depth, format, out);
            }
        }
        _ => {}
    }
}

fn parse_transform_input(
    root: &Path,
    parsed: &crate::ParsedArgs,
) -> Result<(String, Value), String> {
    if let Some(raw) = parsed.flags.get("json") {
        let value =
            serde_json::from_str::<Value>(raw).map_err(|_| "json_payload_invalid".to_string())?;
        return Ok(("json".to_string(), value));
    }
    if let Some(rel_or_abs) = parsed.flags.get("json-path") {
        let path = if Path::new(rel_or_abs).is_absolute() {
            PathBuf::from(rel_or_abs)
        } else {
            root.join(rel_or_abs)
        };
        let value =
            read_json(&path).ok_or_else(|| format!("json_path_not_found:{}", path.display()))?;
        return Ok((path.display().to_string(), value));
    }
    let from_path = parsed.flags.get("from-path").cloned().unwrap_or_else(|| {
        state_root(root)
            .join("parse_doc")
            .join("latest.json")
            .display()
            .to_string()
    });
    let path = if Path::new(&from_path).is_absolute() {
        PathBuf::from(&from_path)
    } else {
        root.join(&from_path)
    };
    let artifact =
        read_json(&path).ok_or_else(|| format!("from_path_not_found:{}", path.display()))?;
    let structured = artifact
        .get("pipeline")
        .and_then(|v| v.get("structured"))
        .cloned()
        .unwrap_or(Value::Null);
    if structured.is_null() {
        return Err("structured_payload_missing".to_string());
    }
    Ok((path.display().to_string(), structured))
}

fn run_flatten_transform(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        FLATTEN_TRANSFORM_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "flatten_unnest_transform_contract",
            "default_max_depth": 6,
            "default_format": "dot",
            "preserve_metadata": true
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("flatten_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "flatten_unnest_transform_contract"
    {
        errors.push("flatten_contract_kind_invalid".to_string());
    }
    let format = clean(
        parsed.flags.get("format").cloned().unwrap_or_else(|| {
            contract
                .get("default_format")
                .and_then(Value::as_str)
                .unwrap_or("dot")
                .to_string()
        }),
        20,
    )
    .to_ascii_lowercase();
    if !matches!(format.as_str(), "dot" | "slash") {
        errors.push("flatten_format_invalid".to_string());
    }
    let max_depth = parse_u64(
        parsed.flags.get("max-depth"),
        contract
            .get("default_max_depth")
            .and_then(Value::as_u64)
            .unwrap_or(6),
    )
    .clamp(1, 32) as usize;
    let preserve_metadata = contract
        .get("preserve_metadata")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let (input_hint, input) = match parse_transform_input(root, parsed) {
        Ok(ok) => ok,
        Err(err) => {
            errors.push(err);
            ("".to_string(), Value::Null)
        }
    };
    if input.is_null() {
        errors.push("transform_input_required".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "parse_plane_flatten_transform",
            "errors": errors
        });
    }

    let mut flattened = Map::<String, Value>::new();
    flatten_value("root", &input, 0, max_depth, &format, &mut flattened);
    let mut unnested_rows = Vec::<Value>::new();
    collect_unnested_rows("root", &input, 0, max_depth, &format, &mut unnested_rows);

    let result = json!({
        "input_hint": input_hint,
        "format": format,
        "max_depth": max_depth,
        "flattened": Value::Object(flattened.clone()),
        "unnested_rows": unnested_rows,
        "metadata": if preserve_metadata {
            json!({
                "input_sha256": sha256_hex_str(&canonical_json_string(&input)),
                "flattened_sha256": sha256_hex_str(&canonical_json_string(&Value::Object(flattened.clone()))),
                "preserve_metadata": true
            })
        } else {
            Value::Null
        }
    });
    let artifact_path = state_root(root).join("parse_flatten").join("latest.json");
    let _ = write_json(&artifact_path, &result);
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "parse_plane_flatten_transform",
        "lane": "core/layer0/ops",
        "artifact": {
            "path": artifact_path.display().to_string(),
            "sha256": sha256_hex_str(&result.to_string())
        },
        "result": result,
        "claim_evidence": [
            {
                "id": "V6-PARSE-001.4",
                "claim": "governed_flatten_and_unnest_transforms_execute_with_configurable_depth_format_and_provenance_receipts",
                "evidence": {
                    "format": format,
                    "max_depth": max_depth,
                    "flattened_keys": flattened.len()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_template_governance(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        TEMPLATE_GOVERNANCE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "parser_template_governance_contract",
            "manifest_path": TEMPLATE_MANIFEST_PATH,
            "templates_root": "planes/contracts/parse/templates",
            "required_contract_version": "v1",
            "max_review_cadence_days": 120
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("template_governance_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "parser_template_governance_contract"
    {
        errors.push("template_governance_contract_kind_invalid".to_string());
    }

    let manifest_rel = parsed
        .flags
        .get("manifest")
        .cloned()
        .or_else(|| {
            contract
                .get("manifest_path")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| TEMPLATE_MANIFEST_PATH.to_string());
    let templates_root_rel = parsed
        .flags
        .get("templates-root")
        .cloned()
        .or_else(|| {
            contract
                .get("templates_root")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "planes/contracts/parse/templates".to_string());
    let manifest_path = if Path::new(&manifest_rel).is_absolute() {
        PathBuf::from(&manifest_rel)
    } else {
        root.join(&manifest_rel)
    };
    let templates_root = if Path::new(&templates_root_rel).is_absolute() {
        PathBuf::from(&templates_root_rel)
    } else {
        root.join(&templates_root_rel)
    };

    let manifest = read_json(&manifest_path).unwrap_or(Value::Null);
    if manifest.is_null() {
        errors.push(format!(
            "template_manifest_not_found:{}",
            manifest_path.display()
        ));
    }

    let required_contract_version = clean(
        contract
            .get("required_contract_version")
            .and_then(Value::as_str)
            .unwrap_or("v1"),
        32,
    );
    let max_review_cadence_days = contract
        .get("max_review_cadence_days")
        .and_then(Value::as_u64)
        .unwrap_or(120);

    let mut validated = Vec::<Value>::new();
    if !manifest.is_null() {
        if manifest
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            != "v1"
        {
            errors.push("template_manifest_version_must_be_v1".to_string());
        }
        if manifest
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            != "parser_template_pack_manifest"
        {
            errors.push("template_manifest_kind_invalid".to_string());
        }
        let templates = manifest
            .get("templates")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if templates.is_empty() {
            errors.push("template_manifest_templates_required".to_string());
        }
        for entry in templates {
            let rel_path = entry
                .get("path")
                .and_then(Value::as_str)
                .map(|v| clean(v, 260))
                .unwrap_or_default();
            if rel_path.is_empty() {
                errors.push("template_entry_path_required".to_string());
                continue;
            }
            let tpl_path = if Path::new(&rel_path).is_absolute() {
                PathBuf::from(&rel_path)
            } else {
                templates_root.join(&rel_path)
            };
            let raw = fs::read_to_string(&tpl_path)
                .map_err(|_| format!("template_file_missing:{}", tpl_path.display()));
            let Ok(raw) = raw else {
                errors.push(raw.err().unwrap_or_default());
                continue;
            };
            let expected_sha = entry
                .get("sha256")
                .and_then(Value::as_str)
                .map(|v| clean(v, 128))
                .unwrap_or_default();
            let actual_sha = sha256_hex_str(&raw);
            if expected_sha.is_empty() || expected_sha != actual_sha {
                errors.push(format!("template_sha_mismatch:{}", rel_path));
            }
            let human_reviewed = entry
                .get("human_reviewed")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if strict && !human_reviewed {
                errors.push(format!("template_not_human_reviewed:{}", rel_path));
            }
            let review_cadence_days = entry
                .get("review_cadence_days")
                .and_then(Value::as_u64)
                .unwrap_or(max_review_cadence_days + 1);
            if strict && review_cadence_days > max_review_cadence_days {
                errors.push(format!("template_review_cadence_exceeded:{}", rel_path));
            }
            let compatibility = entry
                .get("compatibility")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let mapping_contract_version = compatibility
                .get("mapping_contract_version")
                .and_then(Value::as_str)
                .map(|v| clean(v, 32))
                .unwrap_or_default();
            if strict && mapping_contract_version != required_contract_version {
                errors.push(format!(
                    "template_contract_version_incompatible:{}",
                    rel_path
                ));
            }
            validated.push(json!({
                "path": tpl_path.display().to_string(),
                "sha256": actual_sha,
                "human_reviewed": human_reviewed,
                "review_cadence_days": review_cadence_days,
                "mapping_contract_version": mapping_contract_version
            }));
        }

        let signature = manifest
            .get("signature")
            .and_then(Value::as_str)
            .map(|v| clean(v, 240))
            .unwrap_or_default();
        let mut signature_basis = manifest.clone();
        if let Some(obj) = signature_basis.as_object_mut() {
            obj.remove("signature");
        }
        match std::env::var("PARSER_TEMPLATE_SIGNING_KEY")
            .ok()
            .map(|v| clean(v, 4096))
            .filter(|v| !v.is_empty())
        {
            Some(key) => {
                let expected = format!(
                    "sig:{}",
                    sha256_hex_str(&format!(
                        "{}:{}",
                        key,
                        canonical_json_string(&signature_basis)
                    ))
                );
                if signature != expected {
                    errors.push("template_manifest_signature_invalid".to_string());
                }
            }
            None => {
                if strict {
                    errors.push("parser_template_signing_key_missing".to_string());
                }
            }
        }
    }

    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "parse_plane_template_governance",
            "errors": errors
        });
    }

    let result = json!({
        "manifest_path": manifest_path.display().to_string(),
        "templates_root": templates_root.display().to_string(),
        "validated_templates": validated,
        "required_contract_version": required_contract_version
    });
    let artifact_path = state_root(root).join("parse_templates").join("latest.json");
    let _ = write_json(&artifact_path, &result);
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "parse_plane_template_governance",
        "lane": "core/layer0/ops",
        "artifact": {
            "path": artifact_path.display().to_string(),
            "sha256": sha256_hex_str(&result.to_string())
        },
        "result": result,
        "claim_evidence": [
            {
                "id": "V6-PARSE-001.5",
                "claim": "signed_parser_template_mapping_library_governance_validates_compatibility_and_review_metadata",
                "evidence": {
                    "manifest_path": manifest_path.display().to_string(),
                    "validated_templates": validated.len()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_export(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let format = parsed
        .flags
        .get("format")
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "json".to_string());
    let extension = match format.as_str() {
        "json" => "json",
        "jsonl" => "jsonl",
        "md" | "markdown" => "md",
        _ => {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "parse_plane_export_error",
                "errors": ["invalid_export_format"],
                "format": clean(&format, 24)
            });
        }
    };

    let source_path = parsed
        .flags
        .get("from-path")
        .map(PathBuf::from)
        .unwrap_or_else(|| latest_path(root));
    let source_value = match read_json(&source_path) {
        Some(v) => v,
        None => {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "parse_plane_export_error",
                "errors": ["export_source_missing_or_invalid_json"],
                "source_path": source_path.display().to_string()
            });
        }
    };

    let output_path = parsed
        .flags
        .get("output-path")
        .or_else(|| parsed.flags.get("out-path"))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            state_root(root)
                .join("exports")
                .join(format!("latest.{extension}"))
        });

    let canonical = canonicalize_json(&source_value);
    let body = match extension {
        "json" => {
            let mut out = serde_json::to_string_pretty(&canonical)
                .unwrap_or_else(|_| canonical_json_string(&canonical));
            out.push('\n');
            out
        }
        "jsonl" => {
            let mut out = canonical_json_string(&canonical);
            out.push('\n');
            out
        }
        "md" => {
            format!(
                "# Parse Export\n\n```json\n{}\n```\n",
                serde_json::to_string_pretty(&canonical)
                    .unwrap_or_else(|_| canonical_json_string(&canonical))
            )
        }
        _ => String::new(),
    };

    if let Some(parent) = output_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Err(err) = fs::write(&output_path, body.as_bytes()) {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "parse_plane_export_error",
            "errors": ["export_write_failed"],
            "path": output_path.display().to_string(),
            "error": clean(err.to_string(), 220)
        });
    }

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "parse_plane_export",
        "lane": "core/layer0/ops",
        "source_path": source_path.display().to_string(),
        "output_path": output_path.display().to_string(),
        "format": extension,
        "artifact": {
            "path": output_path.display().to_string(),
            "sha256": sha256_hex_str(&body)
        },
        "claim_evidence": [
            {
                "id": "V6-PARSE-001.6",
                "claim": "parse_export_actions_route_through_conduit_with_fail_closed_policy_checks_and_deterministic_receipts",
                "evidence": {
                    "source_path": source_path.display().to_string(),
                    "output_path": output_path.display().to_string(),
                    "format": extension
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
                "type": "parse_plane_conduit_gate",
                "errors": ["conduit_bypass_rejected"],
                "conduit_enforcement": conduit
            }),
        );
    }

    let payload = match command.as_str() {
        "status" => status(root),
        "parse-doc" | "parse_doc" | "doc" => run_parse_doc(root, &parsed, strict),
        "visualize" | "viz" => run_visualize(root, &parsed, strict),
        "postprocess-table" | "postprocess_table" | "postprocess" => {
            run_postprocess_table(root, &parsed, strict)
        }
        "flatten" | "unnest" => run_flatten_transform(root, &parsed, strict),
        "export" => run_export(root, &parsed, strict),
        "template-governance" | "template_governance" | "templates" => {
            run_template_governance(root, &parsed, strict)
        }
        _ => json!({
            "ok": false,
            "type": "parse_plane_error",
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
    fn parse_doc_requires_source() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = crate::parse_args(&["parse-doc".to_string(), "--mapping=default".to_string()]);
        let out = run_parse_doc(root.path(), &parsed, true);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
        assert!(out
            .get("errors")
            .and_then(Value::as_array)
            .map(|rows| rows
                .iter()
                .any(|row| row.as_str() == Some("missing_source")))
            .unwrap_or(false));
    }

    #[test]
    fn conduit_rejects_bypass_when_strict() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = crate::parse_args(&["parse-doc".to_string(), "--bypass=1".to_string()]);
        let gate = conduit_enforcement(root.path(), &parsed, true, "parse-doc");
        assert_eq!(gate.get("ok").and_then(Value::as_bool), Some(false));
    }
}
