// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use crate::directive_kernel;
use crate::network_protocol;
use crate::v8_kernel::{
    next_chain_hash, parse_bool, parse_f64, print_json, read_json, scoped_state_root,
    sha256_hex_str, write_json, write_receipt,
};
use crate::{clean, now_iso, parse_args, ParsedArgs};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

const STATE_ENV: &str = "INTELLIGENCE_NEXUS_STATE_ROOT";
const STATE_SCOPE: &str = "intelligence_nexus";
const VAULT_KEY_ENV: &str = "INTELLIGENCE_NEXUS_VAULT_KEY";

fn state_root(root: &Path) -> PathBuf {
    scoped_state_root(root, STATE_ENV, STATE_SCOPE)
}

fn latest_path(root: &Path) -> PathBuf {
    state_root(root).join("latest.json")
}

fn ledger_path(root: &Path) -> PathBuf {
    state_root(root).join("ledger.json")
}

fn default_ledger() -> Value {
    json!({
        "version": "1.0",
        "providers": {},
        "credit_balances": {},
        "credit_usage": {},
        "spend_limits": {},
        "purchase_history": [],
        "key_events": [],
        "last_autobuy": null,
        "event_head": "genesis",
        "created_at": now_iso()
    })
}

fn load_ledger(root: &Path) -> Value {
    read_json(&ledger_path(root)).unwrap_or_else(default_ledger)
}

fn store_ledger(root: &Path, ledger: &Value) -> Result<(), String> {
    write_json(&ledger_path(root), ledger)
}

fn ledger_obj_mut(ledger: &mut Value) -> &mut Map<String, Value> {
    if !ledger.is_object() {
        *ledger = default_ledger();
    }
    ledger.as_object_mut().expect("ledger_object")
}

fn map_mut<'a>(obj: &'a mut Map<String, Value>, key: &str) -> &'a mut Map<String, Value> {
    if !obj.get(key).map(Value::is_object).unwrap_or(false) {
        obj.insert(key.to_string(), Value::Object(Map::new()));
    }
    obj.get_mut(key).and_then(Value::as_object_mut).expect("map")
}

fn array_mut<'a>(obj: &'a mut Map<String, Value>, key: &str) -> &'a mut Vec<Value> {
    if !obj.get(key).map(Value::is_array).unwrap_or(false) {
        obj.insert(key.to_string(), Value::Array(Vec::new()));
    }
    obj.get_mut(key).and_then(Value::as_array_mut).expect("array")
}

fn f64_in_map(map: &Map<String, Value>, key: &str) -> f64 {
    map.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn emit(root: &Path, payload: Value) -> i32 {
    match write_receipt(root, STATE_ENV, STATE_SCOPE, payload) {
        Ok(out) => {
            print_json(&out);
            if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                0
            } else {
                2
            }
        }
        Err(err) => {
            let mut out = json!({
                "ok": false,
                "type": "intelligence_nexus_error",
                "lane": "core/layer0/ops",
                "error": clean(err, 240),
                "exit_code": 2
            });
            out["receipt_hash"] = Value::String(crate::deterministic_receipt_hash(&out));
            print_json(&out);
            2
        }
    }
}

fn provider_name(raw: Option<&String>) -> String {
    clean(raw.cloned().unwrap_or_else(|| "openai".to_string()), 40)
        .to_ascii_lowercase()
        .replace(' ', "-")
}

fn key_masked(raw: &str) -> String {
    let chars = raw.chars().collect::<Vec<_>>();
    if chars.len() < 10 {
        return "****".to_string();
    }
    let first = chars.iter().take(4).collect::<String>();
    let last = chars
        .iter()
        .rev()
        .take(4)
        .cloned()
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<String>();
    format!("{first}...{last}")
}

fn key_fingerprint(raw: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw.as_bytes());
    hex::encode(hasher.finalize())
}

fn vault_secret() -> Option<String> {
    env::var(VAULT_KEY_ENV)
        .ok()
        .map(|v| clean(v, 512))
        .filter(|v| !v.is_empty())
}

fn xor_crypt(bytes: &[u8], mask: &[u8]) -> Vec<u8> {
    if mask.is_empty() {
        return bytes.to_vec();
    }
    bytes
        .iter()
        .enumerate()
        .map(|(i, b)| b ^ mask[i % mask.len()])
        .collect::<Vec<_>>()
}

fn derive_mask(secret: &str, context: &str) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    hasher.update(b":");
    hasher.update(context.as_bytes());
    hasher.finalize().to_vec()
}

fn seal_key(raw: &str, provider: &str, fingerprint: &str) -> Option<String> {
    let secret = vault_secret()?;
    let context = format!("{provider}:{fingerprint}");
    let mask = derive_mask(&secret, &context);
    Some(BASE64_STANDARD.encode(xor_crypt(raw.as_bytes(), &mask)))
}

fn unseal_key(sealed: &str, provider: &str, fingerprint: &str) -> Option<String> {
    let secret = vault_secret()?;
    let context = format!("{provider}:{fingerprint}");
    let mask = derive_mask(&secret, &context);
    let bytes = BASE64_STANDARD.decode(sealed).ok()?;
    let plain = xor_crypt(&bytes, &mask);
    String::from_utf8(plain).ok()
}

fn validate_key(provider: &str, key: &str) -> Value {
    let ok = match provider {
        "openai" => key.starts_with("sk-") && key.len() >= 20,
        "anthropic" => key.starts_with("sk-ant-") && key.len() >= 24,
        "grok" | "xai" => key.starts_with("xai-") && key.len() >= 16,
        "bedrock" => key.len() >= 16,
        "minimax" => key.len() >= 16,
        _ => key.len() >= 16,
    };
    json!({
        "ok": ok,
        "method": "format_heuristic",
        "reason": if ok { "accepted" } else { "invalid_format" }
    })
}

fn key_from_flags(parsed: &ParsedArgs) -> Option<(String, String)> {
    if let Some(raw) = parsed.flags.get("key").map(|v| clean(v, 1024)) {
        if !raw.is_empty() {
            return Some((raw, "inline".to_string()));
        }
    }
    let env_key = parsed
        .flags
        .get("key-env")
        .cloned()
        .unwrap_or_else(|| "MODEL_API_KEY".to_string());
    let raw = env::var(&env_key).ok().map(|v| clean(v, 1024))?;
    if raw.is_empty() {
        return None;
    }
    Some((raw, clean(env_key, 128)))
}

fn key_for_provider(parsed: &ParsedArgs, provider: &str, ledger: &Value) -> Option<String> {
    if let Some((raw, _)) = key_from_flags(parsed) {
        return Some(raw);
    }
    let provider_record = ledger
        .get("providers")
        .and_then(Value::as_object)
        .and_then(|m| m.get(provider))
        .cloned()?;
    let sealed = provider_record
        .get("sealed_key")
        .and_then(Value::as_str)
        .unwrap_or("");
    let fingerprint = provider_record
        .get("fingerprint")
        .and_then(Value::as_str)
        .unwrap_or("");
    if sealed.is_empty() || fingerprint.is_empty() {
        return None;
    }
    unseal_key(sealed, provider, fingerprint)
}

fn parse_probe_output(raw: &str) -> Option<Value> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return Some(v);
    }
    for line in text.lines().rev() {
        if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
            return Some(v);
        }
    }
    None
}

fn provider_probe_env_key(provider: &str) -> String {
    format!(
        "INTELLIGENCE_NEXUS_PROVIDER_PROBE_{}",
        provider
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
            .collect::<String>()
    )
}

fn run_provider_probe(
    root: &Path,
    parsed: &ParsedArgs,
    provider: &str,
    key: Option<&str>,
) -> Result<Value, String> {
    if parsed.flags.contains_key("credits") {
        let credits = parse_f64(parsed.flags.get("credits"), 0.0).max(0.0);
        let burn_rate = parse_f64(parsed.flags.get("burn-rate-per-day"), 0.0).max(0.0);
        return Ok(json!({
            "credits_remaining": credits,
            "burn_rate_per_day": burn_rate,
            "source": "manual_flag"
        }));
    }

    let cmd = parsed
        .flags
        .get("probe-cmd")
        .cloned()
        .or_else(|| env::var(provider_probe_env_key(provider)).ok())
        .map(|v| clean(v, 1024))
        .unwrap_or_default();
    if !cmd.is_empty() {
        let mut command = Command::new("sh");
        command
            .arg("-lc")
            .arg(&cmd)
            .current_dir(root)
            .env("NEXUS_PROVIDER", provider);
        if let Some(key_raw) = key {
            command.env("NEXUS_API_KEY", key_raw);
        }
        let output = command
            .output()
            .map_err(|err| format!("provider_probe_spawn_failed:{err}"))?;
        if !output.status.success() {
            return Err(format!(
                "provider_probe_failed:{}",
                clean(String::from_utf8_lossy(&output.stderr), 200)
            ));
        }
        let parsed_out = parse_probe_output(&String::from_utf8_lossy(&output.stdout))
            .ok_or_else(|| "provider_probe_invalid_json".to_string())?;
        let credits = parsed_out
            .get("credits_remaining")
            .or_else(|| parsed_out.get("credits"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .max(0.0);
        let burn_rate = parsed_out
            .get("burn_rate_per_day")
            .or_else(|| parsed_out.get("burn_rate"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0)
            .max(0.0);
        return Ok(json!({
            "credits_remaining": credits,
            "burn_rate_per_day": burn_rate,
            "source": "provider_adapter",
            "adapter_payload": parsed_out
        }));
    }

    let env_credits_key = format!(
        "NEXUS_CREDITS_{}",
        provider
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_uppercase() } else { '_' })
            .collect::<String>()
    );
    if let Ok(raw) = env::var(&env_credits_key) {
        if let Ok(credits) = raw.trim().parse::<f64>() {
            let burn_rate = env::var(format!("NEXUS_BURN_RATE_{}", provider.to_ascii_uppercase()))
                .ok()
                .and_then(|v| v.trim().parse::<f64>().ok())
                .unwrap_or(0.0)
                .max(0.0);
            return Ok(json!({
                "credits_remaining": credits.max(0.0),
                "burn_rate_per_day": burn_rate,
                "source": "provider_env"
            }));
        }
    }

    Err("credit_probe_unavailable".to_string())
}

fn days_left(credits: f64, burn_rate: f64) -> f64 {
    if burn_rate <= 0.0 {
        3650.0
    } else {
        (credits / burn_rate).max(0.0)
    }
}

fn append_purchase_event(
    ledger: &mut Value,
    provider: &str,
    actor: &str,
    amount: f64,
    rail: &str,
    reason: &str,
) -> Value {
    let obj = ledger_obj_mut(ledger);
    let prev_hash = obj
        .get("event_head")
        .and_then(Value::as_str)
        .unwrap_or("genesis")
        .to_string();
    let event_base = json!({
        "id": format!("buy_{}", &sha256_hex_str(&format!("{}:{}:{}:{}", now_iso(), provider, amount, actor))[..16]),
        "provider": provider,
        "actor": actor,
        "amount": amount,
        "rail": rail,
        "reason": reason,
        "ts": now_iso()
    });
    let event_hash = next_chain_hash(Some(&prev_hash), &event_base);
    let event = json!({
        "event_hash": event_hash,
        "prev_event_hash": prev_hash,
        "event": event_base
    });
    array_mut(obj, "purchase_history").push(event.clone());
    obj.insert(
        "event_head".to_string(),
        event
            .get("event_hash")
            .cloned()
            .unwrap_or(Value::String("genesis".to_string())),
    );
    event
}

fn append_key_event(ledger: &mut Value, provider: &str, action: &str, detail: Value) -> Value {
    let obj = ledger_obj_mut(ledger);
    let prev_hash = obj
        .get("event_head")
        .and_then(Value::as_str)
        .unwrap_or("genesis")
        .to_string();
    let event_base = json!({
        "id": format!("key_{}", &sha256_hex_str(&format!("{}:{}:{}:{}", now_iso(), provider, action, prev_hash))[..16]),
        "provider": provider,
        "action": action,
        "detail": detail,
        "ts": now_iso()
    });
    let event_hash = next_chain_hash(Some(&prev_hash), &event_base);
    let event = json!({
        "event_hash": event_hash,
        "prev_event_hash": prev_hash,
        "event": event_base
    });
    array_mut(obj, "key_events").push(event.clone());
    obj.insert(
        "event_head".to_string(),
        event
            .get("event_hash")
            .cloned()
            .unwrap_or(Value::String("genesis".to_string())),
    );
    event
}

fn today_key() -> String {
    now_iso().chars().take(10).collect::<String>()
}

fn spent_today(ledger: &Value, actor: &str, provider: &str) -> f64 {
    let today = today_key();
    ledger
        .get("purchase_history")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|row| {
            row.get("event")
                .and_then(|v| v.get("ts"))
                .and_then(Value::as_str)
                .map(|ts| ts.starts_with(&today))
                .unwrap_or(false)
                && row
                    .get("event")
                    .and_then(|v| v.get("actor"))
                    .and_then(Value::as_str)
                    .map(|v| v == actor)
                    .unwrap_or(false)
                && row
                    .get("event")
                    .and_then(|v| v.get("provider"))
                    .and_then(Value::as_str)
                    .map(|v| v == provider)
                    .unwrap_or(false)
        })
        .map(|row| {
            row.get("event")
                .and_then(|v| v.get("amount"))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        })
        .sum::<f64>()
}

fn command_status(root: &Path) -> i32 {
    let ledger = load_ledger(root);
    let provider_count = ledger
        .get("providers")
        .and_then(Value::as_object)
        .map(|m| m.len())
        .unwrap_or(0);
    emit(
        root,
        json!({
            "ok": true,
            "type": "intelligence_nexus_status",
            "lane": "core/layer0/ops",
            "provider_count": provider_count,
            "ledger": ledger,
            "latest": read_json(&latest_path(root))
        }),
    )
}

fn command_open(root: &Path) -> i32 {
    emit(
        root,
        json!({
            "ok": true,
            "type": "intelligence_nexus_open",
            "lane": "core/layer0/ops",
            "workspace_route": "/workspace/keys",
            "dashboard_vital": "credit_health",
            "commands": ["protheus keys open", "protheus model buy credits"],
            "gates": {
                "conduit_required": true,
                "prime_directive_gate": true,
                "sovereign_identity_required": true
            }
        }),
    )
}

fn command_add_key(root: &Path, parsed: &ParsedArgs) -> i32 {
    let provider = provider_name(parsed.flags.get("provider"));
    let gate_action = format!("keys:add:{provider}");
    if !directive_kernel::action_allowed(root, &gate_action) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_add_key",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": "directive_gate_denied",
                "action": gate_action
            }),
        );
    }

    let Some((raw_key, key_source)) = key_from_flags(parsed) else {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_add_key",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": "missing_key_material"
            }),
        );
    };

    let validation = validate_key(&provider, &raw_key);
    let valid = validation.get("ok").and_then(Value::as_bool).unwrap_or(false);
    if !valid {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_add_key",
                "lane": "core/layer0/ops",
                "provider": provider,
                "validation": validation,
                "error": "key_validation_failed"
            }),
        );
    }

    let fingerprint = key_fingerprint(&raw_key);
    let masked = key_masked(&raw_key);
    let sealed = seal_key(&raw_key, &provider, &fingerprint);
    let mut ledger = load_ledger(root);
    let key_event = append_key_event(
        &mut ledger,
        &provider,
        "add",
        json!({
            "fingerprint": fingerprint,
            "masked_key": masked,
            "key_source": clean(key_source.clone(), 64)
        }),
    );
    {
        let obj = ledger_obj_mut(&mut ledger);
        map_mut(obj, "providers").insert(
            provider.clone(),
            json!({
                "provider": provider,
                "fingerprint": fingerprint,
                "masked_key": masked,
                "sealed_key": sealed,
                "seal_algorithm": if vault_secret().is_some() { "xor_sha256_v1" } else { "none_descriptor_only" },
                "key_source": clean(key_source, 64),
                "validation": validation,
                "updated_at": now_iso()
            }),
        );
    }
    if let Err(err) = store_ledger(root, &ledger) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_add_key",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": clean(err, 200)
            }),
        );
    }

    emit(
        root,
        json!({
            "ok": true,
            "type": "intelligence_nexus_add_key",
            "lane": "core/layer0/ops",
            "provider": provider,
            "descriptor_only_client_persistence": true,
            "vault_encryption_enabled": vault_secret().is_some(),
            "raw_key_persisted": false,
            "key_event": key_event
        }),
    )
}

fn command_rotate_key(root: &Path, parsed: &ParsedArgs) -> i32 {
    let provider = provider_name(parsed.flags.get("provider"));
    let gate_action = format!("keys:rotate:{provider}");
    if !directive_kernel::action_allowed(root, &gate_action) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_rotate_key",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": "directive_gate_denied",
                "action": gate_action
            }),
        );
    }

    let Some((raw_key, key_source)) = key_from_flags(parsed) else {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_rotate_key",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": "missing_key_material"
            }),
        );
    };

    let validation = validate_key(&provider, &raw_key);
    if !validation.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_rotate_key",
                "lane": "core/layer0/ops",
                "provider": provider,
                "validation": validation,
                "error": "key_validation_failed"
            }),
        );
    }

    let apply = parse_bool(parsed.flags.get("apply"), true);
    let allow_same = parse_bool(parsed.flags.get("allow-same"), false);
    let mut ledger = load_ledger(root);
    let existing = ledger
        .get("providers")
        .and_then(Value::as_object)
        .and_then(|m| m.get(&provider))
        .cloned();
    let Some(previous_record) = existing else {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_rotate_key",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": "provider_not_found"
            }),
        );
    };

    let old_fingerprint = previous_record
        .get("fingerprint")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let old_masked = previous_record
        .get("masked_key")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let new_fingerprint = key_fingerprint(&raw_key);
    if !allow_same && !old_fingerprint.is_empty() && old_fingerprint == new_fingerprint {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_rotate_key",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": "same_key_material",
                "allow_same": allow_same
            }),
        );
    }

    let masked = key_masked(&raw_key);
    let sealed = seal_key(&raw_key, &provider, &new_fingerprint);
    let key_event = if apply {
        let event = append_key_event(
            &mut ledger,
            &provider,
            "rotate",
            json!({
                "from_fingerprint": old_fingerprint,
                "to_fingerprint": new_fingerprint,
                "from_masked_key": old_masked,
                "to_masked_key": masked,
                "key_source": clean(key_source.clone(), 64)
            }),
        );
        {
            let obj = ledger_obj_mut(&mut ledger);
            map_mut(obj, "providers").insert(
                provider.clone(),
                json!({
                    "provider": provider,
                    "fingerprint": new_fingerprint,
                    "masked_key": masked,
                    "sealed_key": sealed,
                    "seal_algorithm": if vault_secret().is_some() { "xor_sha256_v1" } else { "none_descriptor_only" },
                    "key_source": clean(key_source, 64),
                    "validation": validation,
                    "updated_at": now_iso(),
                    "rotated_from": old_fingerprint,
                    "rotated_at": now_iso()
                }),
            );
        }
        event
    } else {
        Value::Null
    };

    if let Err(err) = store_ledger(root, &ledger) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_rotate_key",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": clean(err, 200)
            }),
        );
    }

    emit(
        root,
        json!({
            "ok": true,
            "type": "intelligence_nexus_rotate_key",
            "lane": "core/layer0/ops",
            "provider": provider,
            "apply": apply,
            "raw_key_persisted": false,
            "descriptor_only_client_persistence": true,
            "key_event": key_event
        }),
    )
}

fn command_revoke_key(root: &Path, parsed: &ParsedArgs) -> i32 {
    let provider = provider_name(parsed.flags.get("provider"));
    let gate_action = format!("keys:revoke:{provider}");
    if !directive_kernel::action_allowed(root, &gate_action) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_revoke_key",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": "directive_gate_denied",
                "action": gate_action
            }),
        );
    }
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let reason = clean(
        parsed
            .flags
            .get("reason")
            .cloned()
            .unwrap_or_else(|| "operator_revoke".to_string()),
        220,
    );

    let mut ledger = load_ledger(root);
    let existing = ledger
        .get("providers")
        .and_then(Value::as_object)
        .and_then(|m| m.get(&provider))
        .cloned();
    let Some(existing_record) = existing else {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_revoke_key",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": "provider_not_found"
            }),
        );
    };

    let removed_fingerprint = existing_record
        .get("fingerprint")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let removed_masked_key = existing_record
        .get("masked_key")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let key_event = if apply {
        let event = append_key_event(
            &mut ledger,
            &provider,
            "revoke",
            json!({
                "reason": reason,
                "removed_fingerprint": removed_fingerprint,
                "removed_masked_key": removed_masked_key
            }),
        );
        {
            let obj = ledger_obj_mut(&mut ledger);
            map_mut(obj, "providers").remove(&provider);
            map_mut(obj, "credit_balances").remove(&provider);
            map_mut(obj, "credit_usage").remove(&provider);
            map_mut(obj, "spend_limits").remove(&provider);
        }
        event
    } else {
        Value::Null
    };

    if let Err(err) = store_ledger(root, &ledger) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_revoke_key",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": clean(err, 200)
            }),
        );
    }

    emit(
        root,
        json!({
            "ok": true,
            "type": "intelligence_nexus_revoke_key",
            "lane": "core/layer0/ops",
            "provider": provider,
            "apply": apply,
            "key_event": key_event
        }),
    )
}

fn command_credits_status(root: &Path, parsed: &ParsedArgs) -> i32 {
    let provider = provider_name(parsed.flags.get("provider"));
    let gate_action = format!("credits:status:{provider}");
    if !directive_kernel::action_allowed(root, &gate_action) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_credits_status",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": "directive_gate_denied"
            }),
        );
    }

    let mut ledger = load_ledger(root);
    let key = key_for_provider(parsed, &provider, &ledger);
    let probe = match run_provider_probe(root, parsed, &provider, key.as_deref()) {
        Ok(v) => v,
        Err(err) => {
            return emit(
                root,
                json!({
                    "ok": false,
                    "type": "intelligence_nexus_credits_status",
                    "lane": "core/layer0/ops",
                    "provider": provider,
                    "error": clean(err, 220)
                }),
            )
        }
    };

    let credits = probe
        .get("credits_remaining")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0);
    let burn_rate = probe
        .get("burn_rate_per_day")
        .and_then(Value::as_f64)
        .unwrap_or(0.0)
        .max(0.0);
    let runway_days = days_left(credits, burn_rate);

    {
        let obj = ledger_obj_mut(&mut ledger);
        map_mut(obj, "credit_balances").insert(provider.clone(), Value::from(credits));
        map_mut(obj, "credit_usage").insert(
            provider.clone(),
            json!({
                "burn_rate_per_day": burn_rate,
                "runway_days": runway_days,
                "source": probe.get("source").cloned().unwrap_or(Value::Null),
                "refreshed_at": now_iso()
            }),
        );
    }
    if let Err(err) = store_ledger(root, &ledger) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_credits_status",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": clean(err, 220)
            }),
        );
    }

    emit(
        root,
        json!({
            "ok": true,
            "type": "intelligence_nexus_credits_status",
            "lane": "core/layer0/ops",
            "provider": provider,
            "credits_remaining": credits,
            "burn_rate_per_day": burn_rate,
            "runway_days_estimate": runway_days,
            "refresh_minutes": parse_f64(parsed.flags.get("refresh-minutes"), 5.0).clamp(1.0, 60.0),
            "probe_source": probe.get("source").cloned().unwrap_or(Value::Null)
        }),
    )
}

fn execute_purchase(
    root: &Path,
    ledger: &mut Value,
    provider: &str,
    amount: f64,
    rail: &str,
    actor: &str,
    reason: &str,
    spend_limit: f64,
    apply: bool,
    allow_unverified_rail: bool,
    payment_proof: &str,
) -> Value {
    let gate_action = format!("credits:buy:{provider}:{rail}");
    let gate_ok = directive_kernel::action_allowed(root, &gate_action);
    let payment_verified = rail == "nexus" || allow_unverified_rail || !payment_proof.is_empty();
    let allowed = gate_ok && amount > 0.0 && amount <= spend_limit && payment_verified;
    let mut network_debit = Value::Null;
    let mut error: Option<String> = None;
    let mut balance_after = 0.0;
    let mut event = Value::Null;

    if allowed && apply {
        if rail == "nexus" {
            match network_protocol::deduct_nexus_balance(
                root,
                actor,
                amount,
                &format!("model_credits:{provider}"),
            ) {
                Ok(v) => network_debit = v,
                Err(err) => {
                    error = Some(clean(err, 220));
                }
            }
        }

        if error.is_none() {
            let obj = ledger_obj_mut(ledger);
            let balances = map_mut(obj, "credit_balances");
            let current = f64_in_map(balances, provider);
            balance_after = current + amount;
            balances.insert(provider.to_string(), Value::from(balance_after));
            map_mut(obj, "spend_limits").insert(provider.to_string(), Value::from(spend_limit));
            event = append_purchase_event(ledger, provider, actor, amount, rail, reason);
        }
    } else {
        let balances = ledger
            .get("credit_balances")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        balance_after = f64_in_map(&balances, provider);
    }

    json!({
        "allowed": allowed && error.is_none(),
        "gate_ok": gate_ok,
        "payment_verified": payment_verified,
        "provider": provider,
        "amount": amount,
        "rail": rail,
        "actor": actor,
        "reason": reason,
        "spend_limit": spend_limit,
        "apply": apply,
        "network_debit": network_debit,
        "balance_after": balance_after,
        "purchase_event": event,
        "error": error
    })
}

fn command_buy_credits(root: &Path, parsed: &ParsedArgs) -> i32 {
    let provider = provider_name(parsed.flags.get("provider"));
    let amount = parse_f64(parsed.flags.get("amount"), 100.0).max(0.0);
    let rail = clean(
        parsed
            .flags
            .get("rail")
            .cloned()
            .unwrap_or_else(|| "nexus".to_string()),
        24,
    )
    .to_ascii_lowercase();
    let actor = clean(
        parsed
            .flags
            .get("actor")
            .cloned()
            .unwrap_or_else(|| "organism:global".to_string()),
        120,
    );
    let reason = clean(
        parsed
            .flags
            .get("reason")
            .cloned()
            .unwrap_or_else(|| "manual_top_up".to_string()),
        220,
    );
    let apply = parse_bool(parsed.flags.get("apply"), true);
    let allow_unverified_rail = parse_bool(parsed.flags.get("allow-unverified-rail"), false);
    let payment_proof = clean(
        parsed
            .flags
            .get("payment-proof")
            .cloned()
            .unwrap_or_default(),
        256,
    );

    let mut ledger = load_ledger(root);
    let stored_limit = ledger
        .get("spend_limits")
        .and_then(Value::as_object)
        .and_then(|m| m.get(&provider))
        .and_then(Value::as_f64)
        .unwrap_or(amount);
    let spend_limit = parse_f64(parsed.flags.get("spend-limit"), stored_limit).max(0.0);

    let result = execute_purchase(
        root,
        &mut ledger,
        &provider,
        amount,
        &rail,
        &actor,
        &reason,
        spend_limit,
        apply,
        allow_unverified_rail,
        &payment_proof,
    );

    if let Err(err) = store_ledger(root, &ledger) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_buy_credits",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": clean(err, 220)
            }),
        );
    }

    emit(
        root,
        json!({
            "ok": result.get("allowed").and_then(Value::as_bool).unwrap_or(false),
            "type": "intelligence_nexus_buy_credits",
            "lane": "core/layer0/ops",
            "result": result
        }),
    )
}

fn command_autobuy(root: &Path, parsed: &ParsedArgs) -> i32 {
    let provider = provider_name(parsed.flags.get("provider"));
    let actor = clean(
        parsed
            .flags
            .get("actor")
            .cloned()
            .unwrap_or_else(|| "organism:global".to_string()),
        120,
    );
    let priority = clean(
        parsed
            .flags
            .get("priority")
            .cloned()
            .unwrap_or_else(|| "normal".to_string()),
        32,
    )
    .to_ascii_lowercase();
    let threshold = parse_f64(parsed.flags.get("threshold"), 100.0).max(0.0);
    let refill = parse_f64(parsed.flags.get("refill"), 250.0).max(0.0);
    let daily_cap = parse_f64(parsed.flags.get("daily-cap"), 500.0).max(0.0);
    let apply = parse_bool(parsed.flags.get("apply"), false);
    let rail = clean(
        parsed
            .flags
            .get("rail")
            .cloned()
            .unwrap_or_else(|| "nexus".to_string()),
        24,
    )
    .to_ascii_lowercase();

    let mut ledger = load_ledger(root);
    let current = parsed
        .flags
        .get("current")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or_else(|| {
            ledger
                .get("credit_balances")
                .and_then(Value::as_object)
                .and_then(|m| m.get(&provider))
                .and_then(Value::as_f64)
                .unwrap_or(0.0)
        })
        .max(0.0);
    let spent = spent_today(&ledger, &actor, &provider);
    let under_threshold = current <= threshold;
    let within_cap = spent + refill <= daily_cap;
    let priority_allows = priority != "low";
    let decision = if under_threshold && within_cap && priority_allows {
        "buy_now"
    } else {
        "hold"
    };

    let purchase_result = if apply && decision == "buy_now" {
        Some(execute_purchase(
            root,
            &mut ledger,
            &provider,
            refill,
            &rail,
            &actor,
            "autobuy_refill",
            refill,
            true,
            false,
            "",
        ))
    } else {
        None
    };

    {
        let obj = ledger_obj_mut(&mut ledger);
        obj.insert(
            "last_autobuy".to_string(),
            json!({
                "provider": provider,
                "actor": actor,
                "decision": decision,
                "priority": priority,
                "current_credits": current,
                "threshold": threshold,
                "refill_amount": refill,
                "daily_cap": daily_cap,
                "spent_today": spent,
                "apply": apply,
                "ts": now_iso()
            }),
        );
    }

    if let Err(err) = store_ledger(root, &ledger) {
        return emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_autobuy_evaluate",
                "lane": "core/layer0/ops",
                "provider": provider,
                "error": clean(err, 220)
            }),
        );
    }

    emit(
        root,
        json!({
            "ok": true,
            "type": "intelligence_nexus_autobuy_evaluate",
            "lane": "core/layer0/ops",
            "provider": provider,
            "decision": decision,
            "current_credits": current,
            "threshold": threshold,
            "refill_amount": refill,
            "spent_today": spent,
            "daily_cap": daily_cap,
            "priority": priority,
            "purchase_result": purchase_result
        }),
    )
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let command = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(command.as_str(), "help" | "--help" | "-h") {
        println!("Usage:");
        println!("  protheus-ops intelligence-nexus status");
        println!("  protheus-ops intelligence-nexus open");
        println!("  protheus-ops intelligence-nexus add-key [--provider=<id>] [--key=<value>|--key-env=<ENV>]");
        println!("  protheus-ops intelligence-nexus rotate-key [--provider=<id>] [--key=<value>|--key-env=<ENV>] [--allow-same=1|0] [--apply=1|0]");
        println!("  protheus-ops intelligence-nexus revoke-key [--provider=<id>] [--reason=<text>] [--apply=1|0]");
        println!("  protheus-ops intelligence-nexus credits-status [--provider=<id>] [--credits=<n>] [--burn-rate-per-day=<n>] [--probe-cmd=<shell>]");
        println!("  protheus-ops intelligence-nexus buy-credits [--provider=<id>] [--amount=<n>] [--spend-limit=<n>] [--rail=nexus|stripe|crypto] [--actor=<id>] [--apply=1|0]");
        println!("  protheus-ops intelligence-nexus autobuy-evaluate [--provider=<id>] [--threshold=<n>] [--refill=<n>] [--daily-cap=<n>] [--priority=low|normal|high] [--apply=1|0]");
        return 0;
    }

    match command.as_str() {
        "status" => command_status(root),
        "open" | "keys-open" => command_open(root),
        "add-key" | "add" => command_add_key(root, &parsed),
        "rotate-key" | "rotate" => command_rotate_key(root, &parsed),
        "revoke-key" | "revoke" | "remove-key" | "remove" => command_revoke_key(root, &parsed),
        "credits-status" | "credit-status" => command_credits_status(root, &parsed),
        "buy-credits" => command_buy_credits(root, &parsed),
        "autobuy-evaluate" | "auto-buy" => command_autobuy(root, &parsed),
        _ => emit(
            root,
            json!({
                "ok": false,
                "type": "intelligence_nexus_error",
                "lane": "core/layer0/ops",
                "error": "unknown_command",
                "command": command,
                "exit_code": 2
            }),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("protheus_intelligence_nexus_{name}_{nonce}"));
        fs::create_dir_all(&root).expect("mkdir");
        root
    }

    fn allow(root: &Path, directive: &str) {
        std::env::set_var("DIRECTIVE_KERNEL_SIGNING_KEY", "test-sign-key");
        let exit = crate::directive_kernel::run(
            root,
            &[
                "prime-sign".to_string(),
                format!("--directive={directive}"),
                "--signer=tester".to_string(),
            ],
        );
        assert_eq!(exit, 0);
    }

    #[test]
    fn add_key_does_not_persist_raw_secret() {
        let root = temp_root("add_key");
        allow(&root, "allow:keys:add");
        std::env::set_var(VAULT_KEY_ENV, "vault-secret");
        std::env::set_var("TEST_NEXUS_KEY", "sk-test-super-secret-key");
        let exit = run(
            &root,
            &[
                "add-key".to_string(),
                "--provider=openai".to_string(),
                "--key-env=TEST_NEXUS_KEY".to_string(),
            ],
        );
        assert_eq!(exit, 0);
        let ledger_raw = fs::read_to_string(ledger_path(&root)).expect("ledger");
        assert!(!ledger_raw.contains("sk-test-super-secret-key"));
        assert!(ledger_raw.contains("masked_key"));
        std::env::remove_var("TEST_NEXUS_KEY");
        std::env::remove_var(VAULT_KEY_ENV);
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rotate_and_revoke_key_lifecycle_is_receipted() {
        let root = temp_root("rotate_revoke");
        allow(&root, "allow:keys:add");
        allow(&root, "allow:keys:rotate");
        allow(&root, "allow:keys:revoke");
        std::env::set_var(VAULT_KEY_ENV, "vault-secret");
        std::env::set_var("TEST_KEY_OLD", "sk-old-abcdef0123456789");
        std::env::set_var("TEST_KEY_NEW", "sk-new-abcdef0123456790");

        assert_eq!(
            run(
                &root,
                &[
                    "add-key".to_string(),
                    "--provider=openai".to_string(),
                    "--key-env=TEST_KEY_OLD".to_string(),
                ],
            ),
            0
        );

        let before = read_json(&ledger_path(&root)).expect("ledger");
        let old_fingerprint = before
            .get("providers")
            .and_then(Value::as_object)
            .and_then(|m| m.get("openai"))
            .and_then(|v| v.get("fingerprint"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        assert!(!old_fingerprint.is_empty());

        assert_eq!(
            run(
                &root,
                &[
                    "rotate-key".to_string(),
                    "--provider=openai".to_string(),
                    "--key-env=TEST_KEY_NEW".to_string(),
                    "--apply=1".to_string(),
                ],
            ),
            0
        );

        let after_rotate = read_json(&ledger_path(&root)).expect("ledger");
        let new_fingerprint = after_rotate
            .get("providers")
            .and_then(Value::as_object)
            .and_then(|m| m.get("openai"))
            .and_then(|v| v.get("fingerprint"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        assert_ne!(new_fingerprint, old_fingerprint);
        assert_eq!(
            after_rotate
                .get("providers")
                .and_then(Value::as_object)
                .and_then(|m| m.get("openai"))
                .and_then(|v| v.get("rotated_from"))
                .and_then(Value::as_str),
            Some(old_fingerprint.as_str())
        );

        assert_eq!(
            run(
                &root,
                &[
                    "revoke-key".to_string(),
                    "--provider=openai".to_string(),
                    "--reason=rotation_complete".to_string(),
                    "--apply=1".to_string(),
                ],
            ),
            0
        );

        let after_revoke = read_json(&ledger_path(&root)).expect("ledger");
        assert!(
            after_revoke
                .get("providers")
                .and_then(Value::as_object)
                .and_then(|m| m.get("openai"))
                .is_none()
        );
        let ledger_raw = fs::read_to_string(ledger_path(&root)).expect("ledger raw");
        assert!(!ledger_raw.contains("sk-old-abcdef0123456789"));
        assert!(!ledger_raw.contains("sk-new-abcdef0123456790"));
        let key_events = after_revoke
            .get("key_events")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(key_events.len() >= 3);

        std::env::remove_var("TEST_KEY_OLD");
        std::env::remove_var("TEST_KEY_NEW");
        std::env::remove_var(VAULT_KEY_ENV);
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn buy_credits_nexus_debits_network_balance() {
        let root = temp_root("buy_nexus");
        allow(&root, "allow:tokenomics");
        allow(&root, "allow:credits:buy");
        assert_eq!(
            crate::network_protocol::run(
                &root,
                &[
                    "reward".to_string(),
                    "--agent=shadow:alpha".to_string(),
                    "--amount=500".to_string(),
                    "--reason=tokenomics".to_string(),
                ]
            ),
            0
        );
        assert_eq!(
            run(
                &root,
                &[
                    "buy-credits".to_string(),
                    "--provider=openai".to_string(),
                    "--amount=120".to_string(),
                    "--rail=nexus".to_string(),
                    "--actor=shadow:alpha".to_string(),
                    "--spend-limit=200".to_string(),
                    "--apply=1".to_string(),
                ]
            ),
            0
        );
        let net_ledger_path = crate::core_state_root(&root)
            .join("ops")
            .join("network_protocol")
            .join("ledger.json");
        let net = read_json(&net_ledger_path).expect("net");
        let bal = net
            .get("balances")
            .and_then(Value::as_object)
            .and_then(|m| m.get("shadow:alpha"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        assert!((bal - 380.0).abs() < f64::EPSILON);
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn autobuy_apply_executes_purchase_when_below_threshold() {
        let root = temp_root("autobuy");
        allow(&root, "allow:tokenomics");
        allow(&root, "allow:credits:buy");
        assert_eq!(
            crate::network_protocol::run(
                &root,
                &[
                    "reward".to_string(),
                    "--agent=organism:global".to_string(),
                    "--amount=600".to_string(),
                    "--reason=tokenomics".to_string(),
                ]
            ),
            0
        );
        assert_eq!(
            run(
                &root,
                &[
                    "autobuy-evaluate".to_string(),
                    "--provider=anthropic".to_string(),
                    "--current=40".to_string(),
                    "--threshold=100".to_string(),
                    "--refill=150".to_string(),
                    "--daily-cap=300".to_string(),
                    "--apply=1".to_string(),
                ]
            ),
            0
        );
        let ledger = read_json(&ledger_path(&root)).expect("ledger");
        let history = ledger
            .get("purchase_history")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        assert!(!history.is_empty());
        let last = ledger.get("last_autobuy").cloned().unwrap_or(Value::Null);
        assert_eq!(
            last.get("decision").and_then(Value::as_str),
            Some("buy_now")
        );
        std::env::remove_var("DIRECTIVE_KERNEL_SIGNING_KEY");
        let _ = fs::remove_dir_all(root);
    }
}
