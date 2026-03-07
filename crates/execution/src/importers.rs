// SPDX-License-Identifier: Apache-2.0
use serde_json::{json, Map, Number, Value};

fn normalize_token(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut prev_underscore = false;
    for ch in input.trim().to_lowercase().chars() {
        let allowed = ch.is_ascii_lowercase()
            || ch.is_ascii_digit()
            || ch == '_'
            || ch == '.'
            || ch == ':'
            || ch == '-';
        let mapped = if allowed { ch } else { '_' };
        if mapped == '_' {
            if !prev_underscore {
                out.push('_');
                prev_underscore = true;
            }
        } else {
            out.push(mapped);
            prev_underscore = false;
        }
    }
    out.trim_matches('_').to_string()
}

pub fn run_importer_generic_json_json(payload: &str) -> Result<String, String> {
    let parsed: Value =
        serde_json::from_str(payload).map_err(|err| format!("payload_json_parse_failed:{err}"))?;
    let obj = parsed.as_object().cloned().unwrap_or_default();

    let mut records = Vec::<Value>::new();
    let mut source_item_count: usize = 0;

    for (bucket, value) in obj {
        if let Some(rows) = value.as_array() {
            source_item_count += rows.len();
            for (idx, row) in rows.iter().enumerate() {
                let base = normalize_token(&bucket);
                let prefix = if base.is_empty() { "record" } else { &base };
                records.push(json!({
                    "id": format!("{prefix}_{}", idx + 1),
                    "bucket": bucket.as_str(),
                    "source": row
                }));
            }
            continue;
        }

        source_item_count += 1;
        let id = {
            let base = normalize_token(&bucket);
            if base.is_empty() {
                format!("record_{}", records.len() + 1)
            } else {
                base
            }
        };
        records.push(json!({
            "id": id,
            "bucket": bucket.as_str(),
            "source": value
        }));
    }

    let result = json!({
        "ok": true,
        "payload": {
            "entities": {
                "agents": [],
                "tasks": [],
                "workflows": [],
                "tools": [],
                "records": records
            },
            "source_item_count": source_item_count,
            "mapped_item_count": records.len(),
            "warnings": []
        }
    });
    serde_json::to_string(&result).map_err(|err| format!("result_json_serialize_failed:{err}"))
}

fn parse_simple_yaml_value(raw: &str) -> Value {
    if raw == "true" {
        return Value::Bool(true);
    }
    if raw == "false" {
        return Value::Bool(false);
    }
    if let Ok(int_value) = raw.parse::<i64>() {
        return Value::Number(Number::from(int_value));
    }
    if let Ok(float_value) = raw.parse::<f64>() {
        if let Some(number) = Number::from_f64(float_value) {
            return Value::Number(number);
        }
    }
    if raw.len() >= 2 {
        let bytes = raw.as_bytes();
        let first = bytes[0];
        let last = bytes[raw.len() - 1];
        if (first == b'"' && last == b'"') || (first == b'\'' && last == b'\'') {
            return Value::String(raw[1..raw.len() - 1].to_string());
        }
    }
    Value::String(raw.to_string())
}

fn parse_simple_yaml_text(text: &str) -> Value {
    let mut out = Map::<String, Value>::new();
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let Some(idx) = trimmed.find(':') else {
            continue;
        };
        if idx == 0 {
            continue;
        }
        let key = trimmed[..idx].trim();
        if key.is_empty() {
            continue;
        }
        let raw = trimmed[idx + 1..].trim();
        out.insert(key.to_string(), parse_simple_yaml_value(raw));
    }
    Value::Object(out)
}

pub fn run_importer_generic_yaml_json(payload: &str) -> Result<String, String> {
    let parsed = serde_json::from_str::<Value>(payload)
        .unwrap_or_else(|_| Value::String(payload.to_string()));
    let normalized = if let Some(text) = parsed.as_str() {
        parse_simple_yaml_text(text)
    } else {
        parsed
    };
    let normalized_json = serde_json::to_string(&normalized)
        .map_err(|err| format!("yaml_normalize_serialize_failed:{err}"))?;
    run_importer_generic_json_json(&normalized_json)
}

fn coerce_row_name(row: &Value, kind: &str, idx: usize) -> String {
    let fallback = format!("{kind}_{}", idx + 1);
    if let Some(obj) = row.as_object() {
        if let Some(name) = obj.get("name").and_then(Value::as_str) {
            let trimmed = name.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        if let Some(id) = obj.get("id").and_then(Value::as_str) {
            let trimmed = id.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    fallback
}

fn map_openfang_rows(rows: &[Value], kind: &str) -> Vec<Value> {
    rows.iter()
        .enumerate()
        .map(|(idx, row)| {
            let name = coerce_row_name(row, kind, idx);
            let id = {
                let normalized = normalize_token(&name);
                if normalized.is_empty() {
                    format!("{kind}_{}", idx + 1)
                } else {
                    normalized
                }
            };
            json!({
                "id": id,
                "name": name,
                "source_kind": kind,
                "source": row
            })
        })
        .collect()
}

pub fn run_importer_openfang_json(payload: &str) -> Result<String, String> {
    let parsed: Value =
        serde_json::from_str(payload).map_err(|err| format!("payload_json_parse_failed:{err}"))?;
    let obj = parsed.as_object().cloned().unwrap_or_default();

    let source_agents = obj
        .get("agents")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let source_tasks = obj
        .get("tasks")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let source_workflows = obj
        .get("workflows")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let source_tools = obj
        .get("tools")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let agents = map_openfang_rows(&source_agents, "agent");
    let tasks = map_openfang_rows(&source_tasks, "task");
    let workflows = map_openfang_rows(&source_workflows, "workflow");
    let tools = map_openfang_rows(&source_tools, "tool");

    let source_item_count =
        source_agents.len() + source_tasks.len() + source_workflows.len() + source_tools.len();
    let mapped_item_count = agents.len() + tasks.len() + workflows.len() + tools.len();

    let result = json!({
        "ok": true,
        "payload": {
            "entities": {
                "agents": agents,
                "tasks": tasks,
                "workflows": workflows,
                "tools": tools,
                "records": []
            },
            "source_item_count": source_item_count,
            "mapped_item_count": mapped_item_count,
            "warnings": []
        }
    });
    serde_json::to_string(&result).map_err(|err| format!("result_json_serialize_failed:{err}"))
}

fn value_to_plain_string(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(v)) => v.clone(),
        Some(Value::Number(v)) => v.to_string(),
        Some(Value::Bool(v)) => v.to_string(),
        _ => String::new(),
    }
}

pub fn run_importer_workflow_graph_json(payload: &str) -> Result<String, String> {
    let parsed: Value =
        serde_json::from_str(payload).map_err(|err| format!("payload_json_parse_failed:{err}"))?;
    let obj = parsed.as_object().cloned().unwrap_or_default();

    let nodes = obj
        .get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let edges = obj
        .get("edges")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let workflows: Vec<Value> = nodes
        .iter()
        .enumerate()
        .map(|(idx, node)| {
            let node_obj = node.as_object().cloned().unwrap_or_default();
            let fallback = format!("node_{}", idx + 1);
            let node_key = {
                let id = value_to_plain_string(node_obj.get("id"));
                if !id.is_empty() {
                    id
                } else {
                    value_to_plain_string(node_obj.get("name"))
                }
            };
            let id_candidate = if node_key.is_empty() {
                fallback.clone()
            } else {
                node_key.clone()
            };
            let id = {
                let normalized = normalize_token(&id_candidate);
                if normalized.is_empty() {
                    fallback.clone()
                } else {
                    normalized
                }
            };
            let name = {
                let name = value_to_plain_string(node_obj.get("name"));
                if !name.is_empty() {
                    name
                } else if !node_key.is_empty() {
                    node_key.clone()
                } else {
                    fallback.clone()
                }
            };
            let edges_out = edges
                .iter()
                .filter(|edge| {
                    let edge_obj = edge.as_object().cloned().unwrap_or_default();
                    let from = value_to_plain_string(edge_obj.get("from"));
                    from == node_key
                })
                .count();
            json!({
                "id": id,
                "name": name,
                "edges_out": edges_out,
                "source": node
            })
        })
        .collect();

    let records: Vec<Value> = edges
        .iter()
        .enumerate()
        .map(|(idx, edge)| {
            json!({
                "id": format!("edge_{}", idx + 1),
                "bucket": "edge",
                "source": edge
            })
        })
        .collect();

    let source_item_count = nodes.len() + edges.len();
    let mapped_item_count = workflows.len() + records.len();

    let result = json!({
        "ok": true,
        "payload": {
            "entities": {
                "agents": [],
                "tasks": [],
                "workflows": workflows,
                "tools": [],
                "records": records
            },
            "source_item_count": source_item_count,
            "mapped_item_count": mapped_item_count,
            "warnings": []
        }
    });
    serde_json::to_string(&result).map_err(|err| format!("result_json_serialize_failed:{err}"))
}

#[cfg(test)]
mod tests {
    use super::{
        parse_simple_yaml_text, run_importer_generic_json_json, run_importer_generic_yaml_json,
        run_importer_openfang_json, run_importer_workflow_graph_json,
    };
    use serde_json::{json, Value};

    #[test]
    fn importer_generic_json_maps_arrays_and_objects() {
        let payload = json!({
            "prompts": [{"id": "p1"}, {"id": "p2"}],
            "settings": {"retries": 3}
        });
        let out = run_importer_generic_json_json(&payload.to_string())
            .expect("importer_generic_json_json should return output");
        let parsed: Value = serde_json::from_str(&out).expect("valid json output");
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["payload"]["source_item_count"], 3);
        assert_eq!(parsed["payload"]["mapped_item_count"], 3);

        let records = parsed["payload"]["entities"]["records"]
            .as_array()
            .expect("records array");
        assert_eq!(records.len(), 3);
        assert_eq!(records[0]["id"], "prompts_1");
        assert_eq!(records[1]["id"], "prompts_2");
        assert_eq!(records[2]["id"], "settings");
    }

    #[test]
    fn importer_generic_json_empty_key_falls_back_to_record_prefix() {
        let payload = json!({
            "": [{"id": "x"}]
        });
        let out = run_importer_generic_json_json(&payload.to_string())
            .expect("importer_generic_json_json should return output");
        let parsed: Value = serde_json::from_str(&out).expect("valid json output");
        let records = parsed["payload"]["entities"]["records"]
            .as_array()
            .expect("records array");
        assert_eq!(records[0]["id"], "record_1");
    }

    #[test]
    fn importer_generic_json_non_object_payload_is_empty() {
        let out = run_importer_generic_json_json("[]")
            .expect("importer_generic_json_json should return output");
        let parsed: Value = serde_json::from_str(&out).expect("valid json output");
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["payload"]["source_item_count"], 0);
        assert_eq!(parsed["payload"]["mapped_item_count"], 0);
    }

    #[test]
    fn parse_simple_yaml_text_maps_scalar_values() {
        let parsed = parse_simple_yaml_text(
            r#"
            # comment
            enabled: true
            retries: 3
            threshold: 2.5
            name: "alpha"
            "#,
        );
        assert_eq!(parsed["enabled"], true);
        assert_eq!(parsed["retries"], 3);
        assert_eq!(parsed["threshold"], 2.5);
        assert_eq!(parsed["name"], "alpha");
    }

    #[test]
    fn importer_generic_yaml_string_payload_routes_to_generic_json_mapping() {
        let payload = "enabled: true\nretries: 3\n";
        let out = run_importer_generic_yaml_json(
            &serde_json::to_string(payload).expect("serialize payload"),
        )
        .expect("importer_generic_yaml_json should return output");
        let parsed: Value = serde_json::from_str(&out).expect("valid json output");
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["payload"]["source_item_count"], 2);
        assert_eq!(parsed["payload"]["mapped_item_count"], 2);
    }

    #[test]
    fn importer_generic_yaml_object_payload_passthrough() {
        let payload = json!({
            "prompts": [{"id": "p1"}],
            "settings": {"mode": "safe"}
        });
        let out = run_importer_generic_yaml_json(&payload.to_string())
            .expect("importer_generic_yaml_json should return output");
        let parsed: Value = serde_json::from_str(&out).expect("valid json output");
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["payload"]["source_item_count"], 2);
        assert_eq!(parsed["payload"]["mapped_item_count"], 2);
    }

    #[test]
    fn importer_openfang_maps_named_rows() {
        let payload = json!({
            "agents": [{"name": "Planner"}],
            "tasks": [{"id": "task_alpha"}],
            "workflows": [{"name": "PrimaryFlow"}],
            "tools": [{"name": "Search"}]
        });
        let out = run_importer_openfang_json(&payload.to_string())
            .expect("importer_openfang_json should return output");
        let parsed: Value = serde_json::from_str(&out).expect("valid json output");
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["payload"]["source_item_count"], 4);
        assert_eq!(parsed["payload"]["mapped_item_count"], 4);
        assert_eq!(parsed["payload"]["entities"]["agents"][0]["id"], "planner");
        assert_eq!(
            parsed["payload"]["entities"]["tasks"][0]["id"],
            "task_alpha"
        );
        assert_eq!(
            parsed["payload"]["entities"]["workflows"][0]["id"],
            "primaryflow"
        );
        assert_eq!(parsed["payload"]["entities"]["tools"][0]["id"], "search");
    }

    #[test]
    fn importer_openfang_non_object_payload_is_empty() {
        let out =
            run_importer_openfang_json("[]").expect("importer_openfang_json should return output");
        let parsed: Value = serde_json::from_str(&out).expect("valid json output");
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["payload"]["source_item_count"], 0);
        assert_eq!(parsed["payload"]["mapped_item_count"], 0);
    }

    #[test]
    fn importer_workflow_graph_maps_nodes_and_edges() {
        let payload = json!({
            "nodes": [{"id": "a"}, {"id": "b"}],
            "edges": [{"from": "a", "to": "b"}]
        });
        let out = run_importer_workflow_graph_json(&payload.to_string())
            .expect("importer_workflow_graph_json should return output");
        let parsed: Value = serde_json::from_str(&out).expect("valid json output");
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["payload"]["source_item_count"], 3);
        assert_eq!(parsed["payload"]["mapped_item_count"], 3);
        assert_eq!(parsed["payload"]["entities"]["workflows"][0]["id"], "a");
        assert_eq!(
            parsed["payload"]["entities"]["workflows"][0]["edges_out"],
            1
        );
        assert_eq!(parsed["payload"]["entities"]["records"][0]["id"], "edge_1");
    }

    #[test]
    fn importer_workflow_graph_non_object_payload_is_empty() {
        let out = run_importer_workflow_graph_json("[]")
            .expect("importer_workflow_graph_json should return output");
        let parsed: Value = serde_json::from_str(&out).expect("valid json output");
        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["payload"]["source_item_count"], 0);
        assert_eq!(parsed["payload"]["mapped_item_count"], 0);
    }
}
