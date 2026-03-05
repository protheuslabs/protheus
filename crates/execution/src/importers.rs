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
    let parsed = serde_json::from_str::<Value>(payload).unwrap_or_else(|_| Value::String(payload.to_string()));
    let normalized = if let Some(text) = parsed.as_str() {
        parse_simple_yaml_text(text)
    } else {
        parsed
    };
    let normalized_json = serde_json::to_string(&normalized)
        .map_err(|err| format!("yaml_normalize_serialize_failed:{err}"))?;
    run_importer_generic_json_json(&normalized_json)
}

#[cfg(test)]
mod tests {
    use super::{parse_simple_yaml_text, run_importer_generic_json_json, run_importer_generic_yaml_json};
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
        let out = run_importer_generic_yaml_json(&serde_json::to_string(payload).expect("serialize payload"))
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
}
