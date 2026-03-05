use serde_json::{json, Value};

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

#[cfg(test)]
mod tests {
    use super::run_importer_generic_json_json;
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
}
