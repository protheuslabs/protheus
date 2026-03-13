// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::persist_plane::connector

use super::*;

pub(super) fn run_connector(root: &Path, parsed: &crate::ParsedArgs, strict: bool) -> Value {
    let contract = load_json_or(
        root,
        CONNECTOR_CONTRACT_PATH,
        json!({
            "version": "v1",
            "kind": "persist_connector_onboarding_contract",
            "allowed_ops": ["add", "list", "status", "remove"],
            "providers": {
                "slack": {"policy_template": "slack-default", "required_env": ["SLACK_BOT_TOKEN"]},
                "gmail": {"policy_template": "gmail-default", "required_env": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]},
                "drive": {"policy_template": "drive-default", "required_env": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]}
            }
        }),
    );
    let op = clean(
        parsed
            .flags
            .get("op")
            .cloned()
            .or_else(|| parsed.positional.get(1).cloned())
            .unwrap_or_else(|| "list".to_string()),
        20,
    )
    .to_ascii_lowercase();
    let allowed_ops = contract
        .get("allowed_ops")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if strict
        && !allowed_ops
            .iter()
            .filter_map(Value::as_str)
            .any(|row| row == op)
    {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "persist_plane_connector",
            "errors": ["persist_connector_op_invalid"]
        });
    }

    let path = connectors_path(root);
    let mut state = read_json(&path).unwrap_or_else(|| {
        json!({
            "version": "v1",
            "connectors": {}
        })
    });
    if !state
        .get("connectors")
        .map(Value::is_object)
        .unwrap_or(false)
    {
        state["connectors"] = Value::Object(serde_json::Map::new());
    }

    if op == "list" {
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "persist_plane_connector",
            "lane": "core/layer0/ops",
            "op": "list",
            "state": state,
            "claim_evidence": [
                {
                    "id": "V6-PERSIST-001.4",
                    "claim": "connector_registry_lists_policy_bound_provider_bindings",
                    "evidence": {
                        "provider_count": state.get("connectors").and_then(Value::as_object).map(|m| m.len()).unwrap_or(0)
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    let provider = clean_id(
        parsed
            .flags
            .get("provider")
            .map(String::as_str)
            .or_else(|| parsed.positional.get(2).map(String::as_str)),
        "unknown-provider",
    );
    if op == "status" {
        let connector = state
            .get("connectors")
            .and_then(|m| m.get(&provider))
            .cloned();
        if strict && connector.is_none() {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "persist_plane_connector",
                "op": "status",
                "errors": ["persist_connector_not_found"]
            });
        }
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "persist_plane_connector",
            "lane": "core/layer0/ops",
            "op": "status",
            "provider": provider,
            "connector": connector,
            "claim_evidence": [
                {
                    "id": "V6-PERSIST-001.4",
                    "claim": "connector_status_surfaces_policy_template_and_capability_checks",
                    "evidence": {
                        "provider": provider
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    if op == "remove" {
        let removed = state
            .get_mut("connectors")
            .and_then(Value::as_object_mut)
            .and_then(|m| m.remove(&provider));
        if strict && removed.is_none() {
            return json!({
                "ok": false,
                "strict": strict,
                "type": "persist_plane_connector",
                "op": "remove",
                "errors": ["persist_connector_not_found"]
            });
        }
        state["updated_at"] = Value::String(crate::now_iso());
        let _ = write_json(&path, &state);
        let _ = append_jsonl(
            &state_root(root).join("connectors").join("history.jsonl"),
            &json!({"op":"remove","provider":provider,"ts":crate::now_iso()}),
        );
        let mut out = json!({
            "ok": true,
            "strict": strict,
            "type": "persist_plane_connector",
            "lane": "core/layer0/ops",
            "op": "remove",
            "provider": provider,
            "artifact": {
                "path": path.display().to_string(),
                "sha256": sha256_hex_str(&state.to_string())
            },
            "claim_evidence": [
                {
                    "id": "V6-PERSIST-001.4",
                    "claim": "connector_registry_supports_receipted_provider_deprovisioning",
                    "evidence": {
                        "provider": provider
                    }
                }
            ]
        });
        out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
        return out;
    }

    let providers = contract
        .get("providers")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let provider_contract = providers.get(&provider).cloned();
    if strict && provider_contract.is_none() {
        return json!({
            "ok": false,
            "strict": strict,
            "type": "persist_plane_connector",
            "op": "add",
            "errors": ["persist_connector_provider_invalid"]
        });
    }
    let provider_contract = provider_contract.unwrap_or_else(|| json!({}));
    let policy_template = clean(
        parsed
            .flags
            .get("policy-template")
            .cloned()
            .or_else(|| {
                provider_contract
                    .get("policy_template")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .unwrap_or_else(|| format!("{provider}-default")),
        120,
    );
    let required_env = provider_contract
        .get("required_env")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|row| row.as_str().map(str::to_string))
        .collect::<Vec<_>>();
    let missing_env = required_env
        .iter()
        .filter(|key| {
            std::env::var(key.as_str())
                .unwrap_or_default()
                .trim()
                .is_empty()
        })
        .cloned()
        .collect::<Vec<_>>();
    let capability_ok = missing_env.is_empty();
    let connector = json!({
        "provider": provider,
        "policy_template": policy_template,
        "status": if capability_ok { "active" } else { "pending_auth" },
        "required_env": required_env,
        "missing_env": missing_env,
        "added_at": crate::now_iso(),
        "updated_at": crate::now_iso()
    });
    state["connectors"][&provider] = connector.clone();
    state["updated_at"] = Value::String(crate::now_iso());
    let _ = write_json(&path, &state);
    let _ = append_jsonl(
        &state_root(root).join("connectors").join("history.jsonl"),
        &json!({"op":"add","provider":provider,"policy_template":policy_template,"capability_ok":capability_ok,"ts":crate::now_iso()}),
    );

    let mut out = json!({
        "ok": true,
        "strict": strict,
        "type": "persist_plane_connector",
        "lane": "core/layer0/ops",
        "op": "add",
        "provider": provider,
        "connector": connector,
        "artifact": {
            "path": path.display().to_string(),
            "sha256": sha256_hex_str(&state.to_string())
        },
        "claim_evidence": [
            {
                "id": "V6-PERSIST-001.4",
                "claim": "connector_onboarding_binds_policy_templates_and_capability_checks_with_receipts",
                "evidence": {
                    "provider": provider,
                    "policy_template": policy_template,
                    "capability_ok": capability_ok
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
    out
}
