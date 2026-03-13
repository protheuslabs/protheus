// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops (authoritative)

use crate::directive_kernel;
use crate::network_protocol;
use crate::v8_kernel::{
    next_chain_hash, parse_bool, parse_f64, print_json, read_json, scoped_state_root,
    sha256_hex_str, write_json, write_receipt,
};
use crate::{clean, now_iso, parse_args, ParsedArgs};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

const STATE_ENV: &str = "INTELLIGENCE_NEXUS_STATE_ROOT";
const STATE_SCOPE: &str = "intelligence_nexus";
const VAULT_KEY_ENV: &str = "INTELLIGENCE_NEXUS_VAULT_KEY";
#[path = "intelligence_nexus_finance.rs"]
mod intelligence_nexus_finance;
#[path = "intelligence_nexus_keys.rs"]
mod intelligence_nexus_keys;

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
    obj.get_mut(key)
        .and_then(Value::as_object_mut)
        .expect("map")
}

fn array_mut<'a>(obj: &'a mut Map<String, Value>, key: &str) -> &'a mut Vec<Value> {
    if !obj.get(key).map(Value::is_array).unwrap_or(false) {
        obj.insert(key.to_string(), Value::Array(Vec::new()));
    }
    obj.get_mut(key)
        .and_then(Value::as_array_mut)
        .expect("array")
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
            .map(|c| if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            })
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
            .map(|c| if c.is_ascii_alphanumeric() {
                c.to_ascii_uppercase()
            } else {
                '_'
            })
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
        println!("  protheus-ops intelligence-nexus workspace-view");
        println!("  protheus-ops intelligence-nexus buy-credits [--provider=<id>] [--amount=<n>] [--spend-limit=<n>] [--rail=nexus|stripe|crypto] [--actor=<id>] [--apply=1|0]");
        println!("  protheus-ops intelligence-nexus autobuy-evaluate [--provider=<id>] [--threshold=<n>] [--refill=<n>] [--daily-cap=<n>] [--priority=low|normal|high] [--apply=1|0]");
        return 0;
    }

    match command.as_str() {
        "status" => intelligence_nexus_keys::command_status(root),
        "open" | "keys-open" => intelligence_nexus_keys::command_open(root),
        "add-key" | "add" => intelligence_nexus_keys::command_add_key(root, &parsed),
        "rotate-key" | "rotate" => intelligence_nexus_keys::command_rotate_key(root, &parsed),
        "revoke-key" | "revoke" | "remove-key" | "remove" => {
            intelligence_nexus_keys::command_revoke_key(root, &parsed)
        }
        "credits-status" | "credit-status" => {
            intelligence_nexus_finance::command_credits_status(root, &parsed)
        }
        "workspace-view" | "dashboard" => intelligence_nexus_finance::command_workspace_view(root),
        "buy-credits" => intelligence_nexus_finance::command_buy_credits(root, &parsed),
        "autobuy-evaluate" | "auto-buy" => {
            intelligence_nexus_finance::command_autobuy(root, &parsed)
        }
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
#[path = "intelligence_nexus_tests.rs"]
mod tests;
