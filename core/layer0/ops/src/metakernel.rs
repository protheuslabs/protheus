// Layer ownership: core/layer0/ops (authoritative)
// SPDX-License-Identifier: Apache-2.0
use crate::{clean, deterministic_receipt_hash, now_iso, parse_args};
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

const REGISTRY_PATH: &str = "planes/contracts/metakernel_primitives_v1.json";
const CELLBUNDLE_SCHEMA_PATH: &str = "planes/contracts/cellbundle.schema.json";
const CELLBUNDLE_EXAMPLE_PATH: &str = "planes/contracts/examples/cellbundle.minimal.json";
const CONDUIT_SCHEMA_PATH: &str = "planes/contracts/conduit_envelope.schema.json";
const TLA_BOUNDARY_PATH: &str = "planes/spec/tla/three_plane_boundary.tla";
const DEP_BOUNDARY_MANIFEST: &str = "client/runtime/config/dependency_boundary_manifest.json";
const RUST_SOURCE_OF_TRUTH_POLICY: &str = "client/runtime/config/rust_source_of_truth_policy.json";

const EXPECTED_PRIMITIVES: &[&str] = &[
    "node",
    "cell",
    "task",
    "capability",
    "object",
    "stream",
    "journal",
    "budget",
    "policy",
    "model",
    "supervisor",
    "attestation",
];

fn state_root(root: &Path) -> PathBuf {
    if let Ok(v) = std::env::var("METAKERNEL_STATE_ROOT") {
        let s = v.trim();
        if !s.is_empty() {
            return PathBuf::from(s);
        }
    }
    root.join("core")
        .join("local")
        .join("state")
        .join("ops")
        .join("metakernel")
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn history_path(root: &Path) -> PathBuf {
    state_root(root).join("history.jsonl")
}

fn read_json(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn write_json(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut body) = serde_json::to_string_pretty(value) {
        body.push('\n');
        let _ = fs::write(path, body);
    }
}

fn append_jsonl(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(line) = serde_json::to_string(value) {
        let _ = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut file| {
                std::io::Write::write_all(&mut file, format!("{line}\n").as_bytes())
            });
    }
}

fn parse_bool(raw: Option<&String>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

fn print_receipt(value: &Value) {
    println!(
        "{}",
        serde_json::to_string_pretty(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn gather_primitives_from_registry(registry: &Value) -> Result<Vec<String>, String> {
    let version = registry
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if version != "v1" {
        return Err("registry_version_must_be_v1".to_string());
    }
    let Some(primitives) = registry.get("primitives").and_then(Value::as_array) else {
        return Err("registry_missing_primitives_array".to_string());
    };
    let mut out = Vec::new();
    for item in primitives {
        let id = item
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase();
        if id.is_empty() {
            return Err("registry_primitive_id_missing".to_string());
        }
        out.push(id);
    }
    Ok(out)
}

fn validate_registry_payload(registry: &Value) -> (bool, Value) {
    let mut errors: Vec<String> = Vec::new();
    let primitives = match gather_primitives_from_registry(registry) {
        Ok(items) => items,
        Err(err) => {
            errors.push(err);
            Vec::new()
        }
    };

    let mut dedup = BTreeSet::new();
    let mut duplicates = Vec::new();
    for p in &primitives {
        if !dedup.insert(p.clone()) {
            duplicates.push(p.clone());
        }
    }
    if !duplicates.is_empty() {
        errors.push("registry_duplicate_primitives".to_string());
    }

    let have = dedup;
    let expected: BTreeSet<String> = EXPECTED_PRIMITIVES.iter().map(|v| v.to_string()).collect();
    let missing: Vec<String> = expected.difference(&have).cloned().collect();
    let unknown: Vec<String> = have.difference(&expected).cloned().collect();
    if !missing.is_empty() {
        errors.push("registry_missing_expected_primitives".to_string());
    }

    (
        errors.is_empty(),
        json!({
            "missing_expected": missing,
            "unknown_primitives": unknown,
            "duplicates": duplicates,
            "errors": errors
        }),
    )
}

fn collect_unknown_primitive_usage(root: &Path, valid: &HashSet<String>) -> Vec<Value> {
    fn walk_json(path: &Path, value: &Value, valid: &HashSet<String>, out: &mut Vec<Value>) {
        match value {
            Value::Object(map) => {
                for (k, v) in map {
                    if matches!(k.as_str(), "primitive" | "primitive_id" | "primitiveId")
                        && v.is_string()
                    {
                        let raw = v.as_str().unwrap_or_default().trim().to_ascii_lowercase();
                        if !raw.is_empty()
                            && raw
                                .chars()
                                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
                            && !valid.contains(&raw)
                        {
                            out.push(json!({
                                "path": path.display().to_string(),
                                "key": k,
                                "value": raw
                            }));
                        }
                    }
                    walk_json(path, v, valid, out);
                }
            }
            Value::Array(arr) => {
                for v in arr {
                    walk_json(path, v, valid, out);
                }
            }
            _ => {}
        }
    }

    let mut out = Vec::new();
    let root_dir = root.join("client/runtime/config");
    for entry in WalkDir::new(&root_dir)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_file())
    {
        if entry.path().extension().and_then(|s| s.to_str()) != Some("json") {
            continue;
        }
        let Some(raw) = fs::read_to_string(entry.path()).ok() else {
            continue;
        };
        let Some(val) = serde_json::from_str::<Value>(&raw).ok() else {
            continue;
        };
        walk_json(entry.path(), &val, valid, &mut out);
    }
    out
}

fn validate_manifest_payload(
    manifest: &Value,
    valid_primitives: &HashSet<String>,
    strict: bool,
) -> (bool, Value) {
    let mut errors = Vec::new();

    let bundle_id = manifest
        .get("bundle_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if bundle_id.is_empty() {
        errors.push("bundle_id_required");
    }

    let version = manifest
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if version.is_empty() {
        errors.push("version_required");
    }

    let world = manifest
        .get("world")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if world.is_empty() {
        errors.push("world_required");
    }

    let caps = manifest
        .get("capabilities")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if caps.is_empty() {
        errors.push("capabilities_required");
    }
    let mut unknown_caps = Vec::new();
    for cap in caps {
        let id = cap.as_str().unwrap_or_default().trim().to_ascii_lowercase();
        if id.is_empty() {
            errors.push("capability_id_empty");
            continue;
        }
        if !valid_primitives.contains(&id) {
            unknown_caps.push(id);
        }
    }
    if !unknown_caps.is_empty() {
        errors.push("capabilities_include_unknown_primitive");
    }

    let budgets = manifest
        .get("budgets")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let budget_fields = [
        "cpu_ms",
        "ram_mb",
        "storage_mb",
        "network_kb",
        "tokens",
        "power_mw",
        "privacy_points",
        "cognitive_load",
    ];
    let mut budget_missing = Vec::new();
    for field in budget_fields {
        let ok = budgets
            .get(field)
            .and_then(Value::as_i64)
            .map(|v| v >= 0)
            .unwrap_or(false);
        if !ok {
            budget_missing.push(field.to_string());
        }
    }
    if !budget_missing.is_empty() {
        errors.push("budgets_missing_or_invalid_fields");
    }

    let provenance = manifest
        .get("provenance")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let provenance_source = provenance
        .get("source")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    let provenance_digest = provenance
        .get("digest")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    if provenance_source.is_empty() || provenance_digest.is_empty() {
        errors.push("provenance_source_and_digest_required");
    }

    let ok = if strict {
        errors.is_empty()
    } else {
        true
    };
    (
        ok,
        json!({
            "bundle_id": bundle_id,
            "version": version,
            "world": world,
            "unknown_capabilities": unknown_caps,
            "missing_budget_fields": budget_missing,
            "errors": errors
        }),
    )
}

fn run_registry(root: &Path, strict: bool) -> Value {
    let registry_path = root.join(REGISTRY_PATH);
    let registry = read_json(&registry_path).unwrap_or(Value::Null);
    let (registry_ok, registry_report) = validate_registry_payload(&registry);
    let primitives = gather_primitives_from_registry(&registry).unwrap_or_default();
    let valid: HashSet<String> = primitives.into_iter().collect();
    let unknown_usage = collect_unknown_primitive_usage(root, &valid);
    let unknown_usage_ok = unknown_usage.is_empty();
    let ok = registry_ok && unknown_usage_ok;

    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "registry_path": REGISTRY_PATH,
        "registry_ok": registry_ok,
        "registry_report": registry_report,
        "unknown_primitive_usage_count": unknown_usage.len(),
        "unknown_primitive_usage": unknown_usage
    })
}

fn run_manifest(root: &Path, strict: bool, manifest_rel: &str) -> Value {
    let registry = read_json(&root.join(REGISTRY_PATH)).unwrap_or(Value::Null);
    let primitives = gather_primitives_from_registry(&registry).unwrap_or_default();
    let valid: HashSet<String> = primitives.into_iter().collect();

    let schema_path = root.join(CELLBUNDLE_SCHEMA_PATH);
    let schema = read_json(&schema_path).unwrap_or(Value::Null);
    let schema_ok = schema
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .contains("CellBundle");

    let manifest_path = root.join(manifest_rel);
    let manifest = read_json(&manifest_path).unwrap_or(Value::Null);
    let (manifest_ok, manifest_report) = validate_manifest_payload(&manifest, &valid, strict);

    let ok = schema_ok && manifest_ok;
    json!({
        "ok": if strict { ok } else { true },
        "strict": strict,
        "schema_path": CELLBUNDLE_SCHEMA_PATH,
        "schema_ok": schema_ok,
        "manifest_path": manifest_rel,
        "manifest_ok": manifest_ok,
        "manifest_report": manifest_report
    })
}

fn run_invariants(root: &Path, strict: bool) -> Value {
    let registry = run_registry(root, true);
    let manifest = run_manifest(root, true, CELLBUNDLE_EXAMPLE_PATH);
    let checks = vec![
        json!({
            "id": "MK_INV_001_registry_contract_exists",
            "ok": root.join(REGISTRY_PATH).exists()
        }),
        json!({
            "id": "MK_INV_002_registry_contract_valid",
            "ok": registry.get("registry_ok").and_then(Value::as_bool).unwrap_or(false)
        }),
        json!({
            "id": "MK_INV_003_no_unknown_primitive_usage",
            "ok": registry.get("unknown_primitive_usage_count").and_then(Value::as_u64).unwrap_or(1) == 0
        }),
        json!({
            "id": "MK_INV_004_cellbundle_schema_exists",
            "ok": root.join(CELLBUNDLE_SCHEMA_PATH).exists()
        }),
        json!({
            "id": "MK_INV_005_cellbundle_example_validates",
            "ok": manifest.get("manifest_ok").and_then(Value::as_bool).unwrap_or(false)
        }),
        json!({
            "id": "MK_INV_006_conduit_schema_present",
            "ok": root.join(CONDUIT_SCHEMA_PATH).exists()
        }),
        json!({
            "id": "MK_INV_007_three_plane_tla_present",
            "ok": root.join(TLA_BOUNDARY_PATH).exists()
        }),
        json!({
            "id": "MK_INV_008_core_policy_manifests_present",
            "ok": root.join(DEP_BOUNDARY_MANIFEST).exists() && root.join(RUST_SOURCE_OF_TRUTH_POLICY).exists()
        }),
    ];
    let pass = checks
        .iter()
        .all(|v| v.get("ok").and_then(Value::as_bool).unwrap_or(false));
    json!({
        "ok": if strict { pass } else { true },
        "strict": strict,
        "checks": checks,
        "registry": registry,
        "manifest": manifest
    })
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let command = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());
    let strict = parse_bool(parsed.flags.get("strict"), true);
    let manifest_path = clean(
        parsed
            .flags
            .get("manifest")
            .cloned()
            .unwrap_or_else(|| CELLBUNDLE_EXAMPLE_PATH.to_string()),
        512,
    );

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        println!("Usage:");
        println!("  protheus-ops metakernel status");
        println!("  protheus-ops metakernel registry [--strict=1|0]");
        println!(
            "  protheus-ops metakernel manifest [--manifest=<path>] [--strict=1|0]"
        );
        println!("  protheus-ops metakernel invariants [--strict=1|0]");
        return 0;
    }

    let latest = latest_path(root);
    let history = history_path(root);
    if command == "status" {
        let mut out = json!({
            "ok": true,
            "type": "metakernel_status",
            "lane": "core/layer0/ops",
            "ts": now_iso(),
            "latest": read_json(&latest)
        });
        out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
        print_receipt(&out);
        return 0;
    }

    let payload = match command.as_str() {
        "registry" => run_registry(root, strict),
        "manifest" => run_manifest(root, strict, &manifest_path),
        "invariants" => run_invariants(root, strict),
        _ => {
            let mut out = json!({
                "ok": false,
                "type": "metakernel_error",
                "lane": "core/layer0/ops",
                "ts": now_iso(),
                "error": "unknown_command",
                "command": command
            });
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            print_receipt(&out);
            return 1;
        }
    };

    let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(false);
    let mut out = json!({
        "ok": ok,
        "type": "metakernel_run",
        "lane": "core/layer0/ops",
        "ts": now_iso(),
        "command": command,
        "payload": payload
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    write_json(&latest, &out);
    append_jsonl(&history, &out);
    print_receipt(&out);
    if ok { 0 } else { 1 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_validation_accepts_expected_shape() {
        let registry = json!({
            "version": "v1",
            "primitives": EXPECTED_PRIMITIVES.iter().map(|id| json!({"id": id})).collect::<Vec<_>>()
        });
        let (ok, report) = validate_registry_payload(&registry);
        assert!(ok);
        assert_eq!(
            report
                .get("missing_expected")
                .and_then(Value::as_array)
                .map(|v| v.len()),
            Some(0)
        );
    }

    #[test]
    fn manifest_validation_rejects_unknown_capability() {
        let valid = HashSet::from_iter(EXPECTED_PRIMITIVES.iter().map(|v| v.to_string()));
        let manifest = json!({
            "bundle_id": "bundle.test",
            "version": "1.0.0",
            "world": "infring.metakernel.v1",
            "capabilities": ["node", "unknown_capability"],
            "budgets": {
                "cpu_ms": 10,
                "ram_mb": 64,
                "storage_mb": 32,
                "network_kb": 8,
                "tokens": 100,
                "power_mw": 250,
                "privacy_points": 5,
                "cognitive_load": 1
            },
            "provenance": {
                "source": "unit-test",
                "digest": "sha256:abc"
            }
        });
        let (ok, report) = validate_manifest_payload(&manifest, &valid, true);
        assert!(!ok);
        assert!(report
            .get("errors")
            .and_then(Value::as_array)
            .map(|rows| rows
                .iter()
                .any(|v| v.as_str() == Some("capabilities_include_unknown_primitive")))
            .unwrap_or(false));
    }
}

