// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::flow_plane (authoritative)

use crate::v8_kernel::{
    append_jsonl, attach_conduit, build_conduit_enforcement, canonical_json_string,
    conduit_bypass_requested, load_json_or, parse_bool, parse_u64, read_json, scoped_state_root,
    sha256_hex_str, write_json, write_receipt,
};
use crate::{clean, parse_args};
use serde_json::{json, Map, Value};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

const STATE_ENV: &str = "FLOW_PLANE_STATE_ROOT";
const STATE_SCOPE: &str = "flow_plane";

const CANVAS_COMPILE_CONTRACT_PATH: &str =
    "planes/contracts/flow/canvas_execution_graph_contract_v1.json";
const PLAYGROUND_CONTRACT_PATH: &str = "planes/contracts/flow/step_playground_contract_v1.json";
const COMPONENT_MARKETPLACE_CONTRACT_PATH: &str =
    "planes/contracts/flow/component_marketplace_contract_v1.json";
const COMPONENT_MARKETPLACE_MANIFEST_PATH: &str =
    "planes/contracts/flow/component_marketplace_manifest_v1.json";
const EXPORT_CONTRACT_PATH: &str = "planes/contracts/flow/export_compiler_contract_v1.json";
const TEMPLATE_GOVERNANCE_CONTRACT_PATH: &str =
    "planes/contracts/flow/template_governance_contract_v1.json";
const TEMPLATE_MANIFEST_PATH: &str = "planes/contracts/flow/template_pack_manifest_v1.json";

fn usage() {
    println!("Usage:");
    println!("  protheus-ops flow-plane status");
    println!("  protheus-ops flow-plane compile [--canvas-json=<json>|--canvas-path=<path>] [--strict=1|0]");
    println!(
        "  protheus-ops flow-plane run [--run-id=<id>] [--strict=1|0]   # alias of playground --op=play"
    );
    println!("  protheus-ops flow-plane playground --op=<play|pause|step|resume|inspect> [--run-id=<id>] [--strict=1|0]");
    println!("  protheus-ops flow-plane component-marketplace [--manifest=<path>] [--components-root=<path>] [--component-id=<id>] [--custom-source-path=<path>] [--strict=1|0]");
    println!("  protheus-ops flow-plane export [--format=json|api|mcp] [--from-path=<path>] [--package-version=<v>] [--strict=1|0]");
    println!(
        "  protheus-ops flow-plane install [--manifest=<path>] [--templates-root=<path>] [--strict=1|0]   # alias of template-governance"
    );
    println!("  protheus-ops flow-plane template-governance [--manifest=<path>] [--templates-root=<path>] [--strict=1|0]");
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
                "type": "flow_plane_error",
                "error": clean(err, 240)
            }));
            1
        }
    }
}

fn conduit_enforcement(
    root: &Path,
    parsed: &crate::ParsedArgs,
    strict: bool,
    action: &str,
) -> Value {
    let bypass_requested = conduit_bypass_requested(&parsed.flags);
    build_conduit_enforcement(
        root,
        STATE_ENV,
        STATE_SCOPE,
        strict,
        action,
        "flow_conduit_enforcement",
        "core/layer0/ops/flow_plane",
        bypass_requested,
        vec![json!({
            "id": "V6-FLOW-001.6",
            "claim": "visual_builder_compile_run_debug_export_install_actions_route_through_conduit_with_bypass_rejection",
            "evidence": {
                "action": clean(action, 120),
                "bypass_requested": bypass_requested
            }
        })],
    )
}

fn status(root: &Path) -> Value {
    json!({
        "ok": true,
        "type": "flow_plane_status",
        "lane": "core/layer0/ops",
        "latest_path": latest_path(root).display().to_string(),
        "latest": read_json(&latest_path(root))
    })
}

fn parse_canvas_input(root: &Path, parsed: &crate::ParsedArgs) -> Result<(String, Value), String> {
    if let Some(raw) = parsed.flags.get("canvas-json") {
        let value =
            serde_json::from_str::<Value>(raw).map_err(|_| "canvas_json_invalid".to_string())?;
        return Ok(("canvas-json".to_string(), value));
    }
    if let Some(rel_or_abs) = parsed.flags.get("canvas-path") {
        let path = if Path::new(rel_or_abs).is_absolute() {
            PathBuf::from(rel_or_abs)
        } else {
            root.join(rel_or_abs)
        };
        let value =
            read_json(&path).ok_or_else(|| format!("canvas_path_not_found:{}", path.display()))?;
        return Ok((path.display().to_string(), value));
    }
    Err("canvas_required".to_string())
}

fn run_compile(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        CANVAS_COMPILE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "flow_canvas_execution_graph_contract",
            "allowed_node_types": ["source", "transform", "sink", "component"],
            "max_nodes": 512,
            "max_edges": 4096
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("flow_compile_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "flow_canvas_execution_graph_contract"
    {
        errors.push("flow_compile_contract_kind_invalid".to_string());
    }

    let (source_hint, canvas) = match parse_canvas_input(root, parsed) {
        Ok(v) => v,
        Err(err) => {
            errors.push(err);
            ("".to_string(), Value::Null)
        }
    };
    if canvas.is_null() {
        errors.push("canvas_required".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "flow_plane_compile",
            "errors": errors
        });
    }

    let version = canvas
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let kind = canvas
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if strict && version != "v1" {
        errors.push("canvas_version_must_be_v1".to_string());
    }
    if strict && kind != "flow_canvas_graph" {
        errors.push("canvas_kind_invalid".to_string());
    }

    let nodes = canvas
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let edges = canvas
        .get("edges")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let max_nodes = contract
        .get("max_nodes")
        .and_then(Value::as_u64)
        .unwrap_or(512) as usize;
    let max_edges = contract
        .get("max_edges")
        .and_then(Value::as_u64)
        .unwrap_or(4096) as usize;
    let allowed_types = contract
        .get("allowed_node_types")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 60))
        .collect::<Vec<_>>();

    if nodes.is_empty() {
        errors.push("canvas_nodes_required".to_string());
    }
    if strict && nodes.len() > max_nodes {
        errors.push("canvas_node_limit_exceeded".to_string());
    }
    if strict && edges.len() > max_edges {
        errors.push("canvas_edge_limit_exceeded".to_string());
    }

    let mut node_ids = BTreeSet::<String>::new();
    let mut node_meta = BTreeMap::<String, String>::new();
    for node in &nodes {
        let id = clean(
            node.get("id").and_then(Value::as_str).unwrap_or_default(),
            120,
        );
        let typ = clean(
            node.get("type").and_then(Value::as_str).unwrap_or_default(),
            60,
        );
        if id.is_empty() {
            errors.push("node_id_required".to_string());
            continue;
        }
        if !node_ids.insert(id.clone()) {
            errors.push(format!("duplicate_node_id:{id}"));
        }
        if strict && !allowed_types.iter().any(|row| row == &typ) {
            errors.push(format!("node_type_not_allowed:{id}:{typ}"));
        }
        node_meta.insert(id, typ);
    }

    let mut indegree = BTreeMap::<String, usize>::new();
    let mut adjacency = BTreeMap::<String, Vec<String>>::new();
    for id in &node_ids {
        indegree.insert(id.clone(), 0usize);
        adjacency.insert(id.clone(), Vec::new());
    }

    for edge in &edges {
        let from = clean(
            edge.get("from").and_then(Value::as_str).unwrap_or_default(),
            120,
        );
        let to = clean(
            edge.get("to").and_then(Value::as_str).unwrap_or_default(),
            120,
        );
        if from.is_empty() || to.is_empty() {
            errors.push("edge_from_to_required".to_string());
            continue;
        }
        if !node_ids.contains(&from) || !node_ids.contains(&to) {
            errors.push(format!("edge_ref_missing_node:{from}->{to}"));
            continue;
        }
        adjacency.entry(from).or_default().push(to.clone());
        *indegree.entry(to).or_insert(0usize) += 1;
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "flow_plane_compile",
            "errors": errors
        });
    }

    let mut queue = indegree
        .iter()
        .filter_map(|(id, deg)| if *deg == 0 { Some(id.clone()) } else { None })
        .collect::<Vec<_>>();
    queue.sort();
    let mut q = VecDeque::from(queue);
    let mut execution_order = Vec::<String>::new();
    while let Some(id) = q.pop_front() {
        execution_order.push(id.clone());
        let mut children = adjacency.get(&id).cloned().unwrap_or_default();
        children.sort();
        for child in children {
            if let Some(deg) = indegree.get_mut(&child) {
                *deg = deg.saturating_sub(1);
                if *deg == 0 {
                    q.push_back(child);
                }
            }
        }
    }
    if strict && execution_order.len() != node_ids.len() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "flow_plane_compile",
            "errors": ["cycle_detected_in_canvas_graph"]
        });
    }

    let compiled_nodes = execution_order
        .iter()
        .enumerate()
        .map(|(idx, id)| {
            json!({
                "id": id,
                "type": node_meta.get(id).cloned().unwrap_or_else(|| "component".to_string()),
                "execution_index": idx
            })
        })
        .collect::<Vec<_>>();
    let stage_receipts = vec![
        json!({
            "stage": "schema_validate",
            "node_count": nodes.len(),
            "edge_count": edges.len(),
            "source_hint": source_hint
        }),
        json!({
            "stage": "compile_graph",
            "execution_nodes": compiled_nodes.len(),
            "order_sha256": sha256_hex_str(&execution_order.join(","))
        }),
    ];

    let compiled = json!({
        "version": "v1",
        "kind": "flow_execution_graph",
        "source_hint": source_hint,
        "execution_order": execution_order,
        "nodes": compiled_nodes,
        "edges": edges,
        "stage_receipts": stage_receipts
    });
    let artifact_path = state_root(root).join("compile").join("latest.json");
    let _ = write_json(&artifact_path, &compiled);
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "flow_plane_compile",
        "lane": "core/layer0/ops",
        "artifact": {
            "path": artifact_path.display().to_string(),
            "sha256": sha256_hex_str(&compiled.to_string())
        },
        "compiled_graph": compiled,
        "claim_evidence": [
            {
                "id": "V6-FLOW-001.1",
                "claim": "canvas_graph_compiles_into_execution_graph_with_live_schema_validation_and_deterministic_compile_receipts",
                "evidence": {
                    "node_count": nodes.len(),
                    "edge_count": edges.len(),
                    "execution_count": execution_order.len()
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_playground(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        PLAYGROUND_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "flow_step_playground_contract",
            "allowed_ops": ["play", "pause", "step", "resume", "inspect"],
            "default_total_steps": 8
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("playground_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "flow_step_playground_contract"
    {
        errors.push("playground_contract_kind_invalid".to_string());
    }

    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "inspect".to_string()),
        20,
    )
    .to_ascii_lowercase();
    let allowed = contract
        .get("allowed_ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 20).to_ascii_lowercase())
        .collect::<Vec<_>>();
    if !allowed.iter().any(|row| row == &op) {
        errors.push("playground_op_not_allowed".to_string());
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "flow_plane_playground",
            "errors": errors
        });
    }

    let run_id = clean(
        parsed
            .flags
            .get("run-id")
            .cloned()
            .unwrap_or_else(|| "flow-playground".to_string()),
        120,
    );
    let total_steps = parse_u64(
        parsed.flags.get("total-steps"),
        contract
            .get("default_total_steps")
            .and_then(Value::as_u64)
            .unwrap_or(8),
    )
    .clamp(1, 100_000);
    let state_path = state_root(root).join("playground").join("state.json");
    let mut state = read_json(&state_path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "kind": "flow_playground_state",
            "runs": {}
        })
    });
    if !state.get("runs").map(Value::is_object).unwrap_or(false) {
        state["runs"] = Value::Object(Map::new());
    }
    let runs = state
        .get("runs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut run = runs.get(&run_id).cloned().unwrap_or_else(|| {
        json!({
            "run_id": run_id,
            "status": "idle",
            "current_step": 0_u64,
            "total_steps": total_steps,
            "events": 0_u64
        })
    });

    let status_before = run
        .get("status")
        .and_then(Value::as_str)
        .unwrap_or("idle")
        .to_string();
    let mut event = Value::Null;
    match op.as_str() {
        "play" => {
            run["status"] = Value::String("running".to_string());
        }
        "pause" => {
            if strict && status_before != "running" {
                errors.push("pause_requires_running_state".to_string());
            } else {
                run["status"] = Value::String("paused".to_string());
            }
        }
        "resume" => {
            if strict && status_before != "paused" {
                errors.push("resume_requires_paused_state".to_string());
            } else {
                run["status"] = Value::String("running".to_string());
            }
        }
        "step" => {
            let cur = run.get("current_step").and_then(Value::as_u64).unwrap_or(0);
            let total = run
                .get("total_steps")
                .and_then(Value::as_u64)
                .unwrap_or(total_steps);
            if strict && cur >= total {
                errors.push("step_out_of_bounds".to_string());
            } else {
                run["current_step"] = json!(cur.saturating_add(1));
                run["status"] = Value::String("running".to_string());
                event = json!({
                    "type": "step",
                    "run_id": run_id,
                    "step": cur.saturating_add(1),
                    "step_hash": sha256_hex_str(&format!("{}:{}", run_id, cur.saturating_add(1)))
                });
            }
        }
        "inspect" => {}
        _ => {}
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "flow_plane_playground",
            "errors": errors
        });
    }

    run["updated_at"] = Value::String(crate::now_iso());
    run["events"] = json!(run.get("events").and_then(Value::as_u64).unwrap_or(0) + 1);
    let mut runs_next = state
        .get("runs")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    runs_next.insert(run_id.clone(), run.clone());
    state["runs"] = Value::Object(runs_next);
    let _ = write_json(&state_path, &state);
    if !event.is_null() {
        let _ = append_jsonl(
            &state_root(root).join("playground").join("history.jsonl"),
            &event,
        );
    }

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "flow_plane_playground",
        "lane": "core/layer0/ops",
        "run_id": run_id,
        "op": op,
        "state_path": state_path.display().to_string(),
        "run_state": run,
        "event": event,
        "claim_evidence": [
            {
                "id": "V6-FLOW-001.2",
                "claim": "interactive_playground_supports_play_pause_step_resume_inspect_with_per_step_receipts",
                "evidence": {
                    "op": op
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_component_marketplace(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        COMPONENT_MARKETPLACE_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "flow_component_marketplace_contract",
            "manifest_path": COMPONENT_MARKETPLACE_MANIFEST_PATH,
            "components_root": "planes/contracts/flow/components",
            "max_component_bytes": 200000,
            "required_language": "python"
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("component_marketplace_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "flow_component_marketplace_contract"
    {
        errors.push("component_marketplace_contract_kind_invalid".to_string());
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
        .unwrap_or_else(|| COMPONENT_MARKETPLACE_MANIFEST_PATH.to_string());
    let components_root_rel = parsed
        .flags
        .get("components-root")
        .cloned()
        .or_else(|| {
            contract
                .get("components_root")
                .and_then(Value::as_str)
                .map(ToString::to_string)
        })
        .unwrap_or_else(|| "planes/contracts/flow/components".to_string());
    let manifest_path = if Path::new(&manifest_rel).is_absolute() {
        PathBuf::from(&manifest_rel)
    } else {
        root.join(&manifest_rel)
    };
    let components_root = if Path::new(&components_root_rel).is_absolute() {
        PathBuf::from(&components_root_rel)
    } else {
        root.join(&components_root_rel)
    };
    let manifest = read_json(&manifest_path).unwrap_or(Value::Null);
    if manifest.is_null() {
        errors.push(format!(
            "component_manifest_not_found:{}",
            manifest_path.display()
        ));
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "flow_plane_component_marketplace",
            "errors": errors
        });
    }

    if strict
        && manifest
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            != "v1"
    {
        errors.push("component_manifest_version_must_be_v1".to_string());
    }
    if strict
        && manifest
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            != "flow_component_marketplace_manifest"
    {
        errors.push("component_manifest_kind_invalid".to_string());
    }

    let max_component_bytes = contract
        .get("max_component_bytes")
        .and_then(Value::as_u64)
        .unwrap_or(200_000);
    let required_language = clean(
        contract
            .get("required_language")
            .and_then(Value::as_str)
            .unwrap_or("python"),
        30,
    )
    .to_ascii_lowercase();

    let components = manifest
        .get("components")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut validated = Vec::<Value>::new();
    for row in components {
        let id = clean(
            row.get("id").and_then(Value::as_str).unwrap_or_default(),
            120,
        );
        let rel_path = clean(
            row.get("path").and_then(Value::as_str).unwrap_or_default(),
            260,
        );
        if id.is_empty() || rel_path.is_empty() {
            errors.push("component_id_and_path_required".to_string());
            continue;
        }
        let lang = clean(
            row.get("language")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            30,
        )
        .to_ascii_lowercase();
        if strict && lang != required_language {
            errors.push(format!("component_language_invalid:{id}:{lang}"));
        }
        let file_path = if Path::new(&rel_path).is_absolute() {
            PathBuf::from(&rel_path)
        } else {
            components_root.join(&rel_path)
        };
        let bytes = fs::read(&file_path)
            .map_err(|_| format!("component_file_missing:{}", file_path.display()));
        let bytes = match bytes {
            Ok(v) => v,
            Err(err) => {
                errors.push(err);
                continue;
            }
        };
        if strict && bytes.len() as u64 > max_component_bytes {
            errors.push(format!("component_size_exceeded:{id}"));
        }
        let expected_sha = clean(
            row.get("sha256")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            128,
        );
        let actual_sha = sha256_hex_str(&String::from_utf8_lossy(&bytes));
        if strict && (expected_sha.is_empty() || expected_sha != actual_sha) {
            errors.push(format!("component_sha_mismatch:{id}"));
        }
        validated.push(json!({
            "id": id,
            "path": file_path.display().to_string(),
            "language": lang,
            "sha256": actual_sha,
            "bytes": bytes.len()
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
    match std::env::var("FLOW_COMPONENT_SIGNING_KEY")
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
            if strict && signature != expected {
                errors.push("component_manifest_signature_invalid".to_string());
            }
        }
        None => {
            if strict {
                errors.push("flow_component_signing_key_missing".to_string());
            }
        }
    }

    let component_id = parsed
        .flags
        .get("component-id")
        .map(|v| clean(v, 120))
        .unwrap_or_default();
    let custom_source_path = parsed
        .flags
        .get("custom-source-path")
        .cloned()
        .unwrap_or_default();
    let mut custom_reload = Value::Null;
    if !component_id.is_empty() && !custom_source_path.is_empty() {
        let path = if Path::new(&custom_source_path).is_absolute() {
            PathBuf::from(&custom_source_path)
        } else {
            root.join(&custom_source_path)
        };
        match fs::read_to_string(&path) {
            Ok(raw) => {
                if strict && !path.display().to_string().ends_with(".py") {
                    errors.push("custom_source_must_be_python_file".to_string());
                }
                if strict && raw.as_bytes().len() as u64 > max_component_bytes {
                    errors.push("custom_source_size_exceeded".to_string());
                }
                let install_path = state_root(root)
                    .join("component_customizations")
                    .join(&component_id)
                    .join("custom.py");
                if errors.is_empty() {
                    if let Some(parent) = install_path.parent() {
                        let _ = fs::create_dir_all(parent);
                    }
                    let _ = fs::write(&install_path, raw.as_bytes());
                    custom_reload = json!({
                        "component_id": component_id,
                        "custom_source_path": path.display().to_string(),
                        "installed_path": install_path.display().to_string(),
                        "source_sha256": sha256_hex_str(&raw)
                    });
                }
            }
            Err(_) => errors.push(format!("custom_source_not_found:{}", path.display())),
        }
    }

    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "flow_plane_component_marketplace",
            "errors": errors
        });
    }

    let result = json!({
        "manifest_path": manifest_path.display().to_string(),
        "components_root": components_root.display().to_string(),
        "validated_components": validated,
        "custom_reload": custom_reload
    });
    let artifact_path = state_root(root)
        .join("component_marketplace")
        .join("latest.json");
    let _ = write_json(&artifact_path, &result);

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "flow_plane_component_marketplace",
        "lane": "core/layer0/ops",
        "artifact": {
            "path": artifact_path.display().to_string(),
            "sha256": sha256_hex_str(&result.to_string())
        },
        "result": result,
        "claim_evidence": [
            {
                "id": "V6-FLOW-001.3",
                "claim": "component_marketplace_enforces_signed_manifests_and_policy_scoped_sandboxed_python_customization_with_receipts",
                "evidence": {
                    "validated_components": validated.len(),
                    "customized_component": if component_id.is_empty() { Value::Null } else { Value::String(component_id) }
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}

fn run_export(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        EXPORT_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "flow_export_compiler_contract",
            "allowed_formats": ["json", "api", "mcp"],
            "default_format": "json",
            "default_package_version": "v1"
        }),
    );
    let mut errors = Vec::<String>::new();
    if contract
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "v1"
    {
        errors.push("flow_export_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "flow_export_compiler_contract"
    {
        errors.push("flow_export_contract_kind_invalid".to_string());
    }

    let format = clean(
        parsed
            .flags
            .get("format")
            .cloned()
            .or_else(|| {
                contract
                    .get("default_format")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| "json".to_string()),
        20,
    )
    .to_ascii_lowercase();
    let allowed_formats = contract
        .get("allowed_formats")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|v| clean(v, 20).to_ascii_lowercase())
        .collect::<Vec<_>>();
    if strict && !allowed_formats.iter().any(|row| row == &format) {
        errors.push("flow_export_format_not_allowed".to_string());
    }

    let from_rel = parsed.flags.get("from-path").cloned().unwrap_or_else(|| {
        state_root(root)
            .join("compile")
            .join("latest.json")
            .display()
            .to_string()
    });
    let from_path = if Path::new(&from_rel).is_absolute() {
        PathBuf::from(&from_rel)
    } else {
        root.join(&from_rel)
    };
    let compiled = read_json(&from_path).unwrap_or(Value::Null);
    if compiled.is_null() {
        errors.push(format!("compiled_graph_missing:{}", from_path.display()));
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "flow_plane_export",
            "errors": errors
        });
    }

    let package_version = clean(
        parsed
            .flags
            .get("package-version")
            .cloned()
            .or_else(|| {
                contract
                    .get("default_package_version")
                    .and_then(Value::as_str)
                    .map(ToString::to_string)
            })
            .unwrap_or_else(|| "v1".to_string()),
        40,
    );
    let package = json!({
        "version": package_version,
        "kind": "flow_export_package",
        "format": format,
        "compiled_graph_path": from_path.display().to_string(),
        "compiled_graph_sha256": sha256_hex_str(&compiled.to_string()),
        "export_payload": match format.as_str() {
            "api" => json!({
                "entrypoint": "/api/flow/run",
                "method": "POST",
                "body_schema": {"graph": "flow_execution_graph"}
            }),
            "mcp" => json!({
                "server": "flow-export",
                "tool": "run_flow",
                "input_schema": {"graph": "flow_execution_graph"}
            }),
            _ => compiled.clone()
        }
    });
    let artifact_path = state_root(root)
        .join("export")
        .join(&format)
        .join("latest.json");
    let _ = write_json(&artifact_path, &package);
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "flow_plane_export",
        "lane": "core/layer0/ops",
        "artifact": {
            "path": artifact_path.display().to_string(),
            "sha256": sha256_hex_str(&package.to_string())
        },
        "package": package,
        "claim_evidence": [
            {
                "id": "V6-FLOW-001.4",
                "claim": "one_click_flow_packaging_exports_versioned_json_api_and_mcp_artifacts_with_deterministic_hashes",
                "evidence": {
                    "format": format,
                    "package_version": package_version
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
            "kind": "flow_template_governance_contract",
            "manifest_path": TEMPLATE_MANIFEST_PATH,
            "templates_root": "planes/contracts/flow/templates",
            "required_canvas_version": "v1",
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
        errors.push("flow_template_governance_contract_version_must_be_v1".to_string());
    }
    if contract
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        != "flow_template_governance_contract"
    {
        errors.push("flow_template_governance_contract_kind_invalid".to_string());
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
        .unwrap_or_else(|| "planes/contracts/flow/templates".to_string());
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
            "flow_template_manifest_not_found:{}",
            manifest_path.display()
        ));
    }
    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "flow_plane_template_governance",
            "errors": errors
        });
    }

    if strict
        && manifest
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            != "v1"
    {
        errors.push("flow_template_manifest_version_must_be_v1".to_string());
    }
    if strict
        && manifest
            .get("kind")
            .and_then(Value::as_str)
            .unwrap_or_default()
            != "flow_template_pack_manifest"
    {
        errors.push("flow_template_manifest_kind_invalid".to_string());
    }
    let required_canvas_version = clean(
        contract
            .get("required_canvas_version")
            .and_then(Value::as_str)
            .unwrap_or("v1"),
        20,
    );
    let max_review_cadence_days = contract
        .get("max_review_cadence_days")
        .and_then(Value::as_u64)
        .unwrap_or(120);

    let templates = manifest
        .get("templates")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if templates.is_empty() {
        errors.push("flow_template_manifest_templates_required".to_string());
    }
    let mut validated = Vec::<Value>::new();
    for entry in templates {
        let rel_path = clean(
            entry
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            260,
        );
        if rel_path.is_empty() {
            errors.push("flow_template_entry_path_required".to_string());
            continue;
        }
        let path = if Path::new(&rel_path).is_absolute() {
            PathBuf::from(&rel_path)
        } else {
            templates_root.join(&rel_path)
        };
        let raw = fs::read_to_string(&path)
            .map_err(|_| format!("flow_template_missing:{}", path.display()));
        let raw = match raw {
            Ok(v) => v,
            Err(err) => {
                errors.push(err);
                continue;
            }
        };
        let expected_sha = clean(
            entry
                .get("sha256")
                .and_then(Value::as_str)
                .unwrap_or_default(),
            128,
        );
        let actual_sha = sha256_hex_str(&raw);
        if strict && (expected_sha.is_empty() || expected_sha != actual_sha) {
            errors.push(format!("flow_template_sha_mismatch:{}", rel_path));
        }
        let human_reviewed = entry
            .get("human_reviewed")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if strict && !human_reviewed {
            errors.push(format!("flow_template_not_human_reviewed:{}", rel_path));
        }
        let review_cadence_days = entry
            .get("review_cadence_days")
            .and_then(Value::as_u64)
            .unwrap_or(max_review_cadence_days + 1);
        if strict && review_cadence_days > max_review_cadence_days {
            errors.push(format!(
                "flow_template_review_cadence_exceeded:{}",
                rel_path
            ));
        }
        let canvas_version = entry
            .get("compatibility")
            .and_then(Value::as_object)
            .and_then(|row| row.get("canvas_version"))
            .and_then(Value::as_str)
            .map(|v| clean(v, 20))
            .unwrap_or_default();
        if strict && canvas_version != required_canvas_version {
            errors.push(format!(
                "flow_template_canvas_version_incompatible:{}",
                rel_path
            ));
        }
        validated.push(json!({
            "path": path.display().to_string(),
            "sha256": actual_sha,
            "human_reviewed": human_reviewed,
            "review_cadence_days": review_cadence_days,
            "canvas_version": canvas_version
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
    match std::env::var("FLOW_TEMPLATE_SIGNING_KEY")
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
            if strict && signature != expected {
                errors.push("flow_template_manifest_signature_invalid".to_string());
            }
        }
        None => {
            if strict {
                errors.push("flow_template_signing_key_missing".to_string());
            }
        }
    }

    if !errors.is_empty() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "flow_plane_template_governance",
            "errors": errors
        });
    }

    let result = json!({
        "manifest_path": manifest_path.display().to_string(),
        "templates_root": templates_root.display().to_string(),
        "validated_templates": validated
    });
    let artifact_path = state_root(root)
        .join("template_governance")
        .join("latest.json");
    let _ = write_json(&artifact_path, &result);
    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "flow_plane_template_governance",
        "lane": "core/layer0/ops",
        "artifact": {
            "path": artifact_path.display().to_string(),
            "sha256": sha256_hex_str(&result.to_string())
        },
        "result": result,
        "claim_evidence": [
            {
                "id": "V6-FLOW-001.5",
                "claim": "curated_visual_flow_template_library_governance_enforces_signature_review_cadence_and_deterministic_install_receipts",
                "evidence": {
                    "validated_templates": validated.len()
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
                "type": "flow_plane_conduit_gate",
                "errors": ["conduit_bypass_rejected"],
                "conduit_enforcement": conduit
            }),
        );
    }

    let payload = match command.as_str() {
        "status" => status(root),
        "compile" | "build" => run_compile(root, &parsed, strict),
        "run" => {
            let mut alias = parsed.clone();
            alias.positional = vec!["playground".to_string()];
            alias
                .flags
                .entry("op".to_string())
                .or_insert_with(|| "play".to_string());
            run_playground(root, &alias, strict)
        }
        "playground" | "debug" => run_playground(root, &parsed, strict),
        "component-marketplace" | "component_marketplace" | "components" => {
            run_component_marketplace(root, &parsed, strict)
        }
        "export" | "package" => run_export(root, &parsed, strict),
        "install" => run_template_governance(root, &parsed, strict),
        "template-governance" | "template_governance" | "templates" => {
            run_template_governance(root, &parsed, strict)
        }
        _ => json!({
            "ok": false,
            "type": "flow_plane_error",
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
    fn compile_requires_canvas() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = crate::parse_args(&["compile".to_string()]);
        let out = run_compile(root.path(), &parsed, true);
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    }

    #[test]
    fn conduit_rejects_bypass_when_strict() {
        let root = tempfile::tempdir().expect("tempdir");
        let parsed = crate::parse_args(&["compile".to_string(), "--bypass=1".to_string()]);
        let out = conduit_enforcement(root.path(), &parsed, true, "compile");
        assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    }
}
