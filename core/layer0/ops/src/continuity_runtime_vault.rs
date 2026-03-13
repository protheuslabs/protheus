// SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::core_state_root;
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use base64::engine::general_purpose::STANDARD as BASE64_STD;
use base64::Engine;
use rand::RngCore;

fn vault_dir(root: &Path) -> PathBuf {
    core_state_root(root).join("continuity").join("vault")
}

fn vault_history_path(root: &Path) -> PathBuf {
    core_state_root(root)
        .join("continuity")
        .join("vault_history.jsonl")
}

fn derive_vault_key(secret: &str) -> [u8; 32] {
    let digest = Sha256::digest(secret.as_bytes());
    let mut key = [0u8; 32];
    key.copy_from_slice(&digest[..32]);
    key
}

fn encrypt_state(secret: &str, state: &[u8], aad: &[u8]) -> Result<(String, String), String> {
    let key_bytes = derive_vault_key(secret);
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let nonce_ref = Nonce::from_slice(&nonce);

    let encrypted = cipher
        .encrypt(nonce_ref, aes_gcm::aead::Payload { msg: state, aad })
        .map_err(|err| format!("encrypt_failed:{err}"))?;

    Ok((BASE64_STD.encode(nonce), BASE64_STD.encode(encrypted)))
}

fn decrypt_state(
    secret: &str,
    nonce_b64: &str,
    cipher_b64: &str,
    aad: &[u8],
) -> Result<Vec<u8>, String> {
    let key_bytes = derive_vault_key(secret);
    let key = Key::<Aes256Gcm>::from_slice(&key_bytes);
    let cipher = Aes256Gcm::new(key);

    let nonce_bytes = BASE64_STD
        .decode(nonce_b64.as_bytes())
        .map_err(|err| format!("nonce_decode_failed:{err}"))?;
    if nonce_bytes.len() != 12 {
        return Err("nonce_len_invalid".to_string());
    }
    let cipher_bytes = BASE64_STD
        .decode(cipher_b64.as_bytes())
        .map_err(|err| format!("cipher_decode_failed:{err}"))?;
    let nonce_ref = Nonce::from_slice(&nonce_bytes);
    cipher
        .decrypt(
            nonce_ref,
            aes_gcm::aead::Payload {
                msg: &cipher_bytes,
                aad,
            },
        )
        .map_err(|err| format!("decrypt_failed:{err}"))
}

pub(super) fn vault_put_payload(
    root: &Path,
    policy: &ContinuityPolicy,
    argv: &[String],
) -> Result<Value, String> {
    let session_id = clean_id(parse_flag(argv, "session-id").as_deref(), "session-default");
    let state = parse_json(parse_flag(argv, "state-json").as_deref())?;
    let encoded = serde_json::to_vec(&state).map_err(|err| format!("state_encode_failed:{err}"))?;
    if encoded.len() > policy.max_state_bytes {
        return Err(format!(
            "state_too_large:{}>{}",
            encoded.len(),
            policy.max_state_bytes
        ));
    }

    let key_env = parse_flag(argv, "vault-key-env").unwrap_or_else(|| policy.vault_key_env.clone());
    let vault_key = std::env::var(&key_env).unwrap_or_default();
    if policy.require_vault_encryption && vault_key.trim().is_empty() {
        return Err(format!("vault_key_missing_env:{key_env}"));
    }

    let aad = format!("{LANE_ID}:{session_id}");
    let (nonce_b64, cipher_b64) = if vault_key.trim().is_empty() {
        (String::new(), BASE64_STD.encode(encoded.as_slice()))
    } else {
        encrypt_state(vault_key.trim(), &encoded, aad.as_bytes())?
    };

    let apply = parse_bool(parse_flag(argv, "apply").as_deref(), true);
    let vault_path = vault_dir(root).join(format!("{}.json", session_id));
    let ciphertext_sha = hex::encode(Sha256::digest(cipher_b64.as_bytes()));

    if apply {
        write_json(
            &vault_path,
            &json!({
                "session_id": session_id,
                "updated_at": now_iso(),
                "lane": LANE_ID,
                "encryption": {
                    "algo": if vault_key.trim().is_empty() { "base64-plain" } else { "aes-256-gcm" },
                    "key_env": key_env,
                    "aad": aad,
                    "nonce_b64": nonce_b64
                },
                "ciphertext_b64": cipher_b64,
                "ciphertext_sha256": ciphertext_sha
            }),
        )?;
        append_jsonl(
            &vault_history_path(root),
            &json!({
                "type": "session_continuity_vault_put",
                "session_id": session_id,
                "ts": now_iso(),
                "vault_path": rel_path(root, &vault_path),
                "ciphertext_sha256": ciphertext_sha
            }),
        )?;
    }

    let mut out = json!({
        "ok": true,
        "type": "session_continuity_vault_put",
        "lane": LANE_ID,
        "session_id": session_id,
        "apply": apply,
        "vault_path": rel_path(root, &vault_path),
        "ciphertext_sha256": ciphertext_sha,
        "encrypted": !vault_key.trim().is_empty(),
        "claim_evidence": [
            {
                "id": "vault_encrypted_at_rest",
                "claim": "session_state_is_stored_with_cryptographic_envelope",
                "evidence": {
                    "encrypted": !vault_key.trim().is_empty(),
                    "vault_path": rel_path(root, &vault_path),
                    "key_env": key_env
                }
            }
        ]
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    Ok(out)
}

pub(super) fn vault_get_payload(
    root: &Path,
    policy: &ContinuityPolicy,
    argv: &[String],
) -> Result<Value, String> {
    let session_id = clean_id(parse_flag(argv, "session-id").as_deref(), "session-default");
    let emit_state = parse_bool(parse_flag(argv, "emit-state").as_deref(), false);
    let vault_path = vault_dir(root).join(format!("{}.json", session_id));
    let record = read_json(&vault_path).ok_or_else(|| "vault_record_missing".to_string())?;

    let encryption = record
        .get("encryption")
        .cloned()
        .unwrap_or_else(|| json!({}));
    let algo = encryption
        .get("algo")
        .and_then(Value::as_str)
        .unwrap_or("aes-256-gcm")
        .to_string();
    let key_env = encryption
        .get("key_env")
        .and_then(Value::as_str)
        .unwrap_or(policy.vault_key_env.as_str())
        .to_string();
    let aad = encryption
        .get("aad")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let nonce_b64 = encryption
        .get("nonce_b64")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let cipher_b64 = record
        .get("ciphertext_b64")
        .and_then(Value::as_str)
        .ok_or_else(|| "vault_ciphertext_missing".to_string())?
        .to_string();

    let decoded = if algo == "base64-plain" {
        BASE64_STD
            .decode(cipher_b64.as_bytes())
            .map_err(|err| format!("cipher_decode_failed:{err}"))?
    } else {
        let vault_key = std::env::var(&key_env).unwrap_or_default();
        if vault_key.trim().is_empty() {
            return Err(format!("vault_key_missing_env:{key_env}"));
        }
        decrypt_state(vault_key.trim(), &nonce_b64, &cipher_b64, aad.as_bytes())?
    };

    let state: Value =
        serde_json::from_slice(&decoded).map_err(|err| format!("state_decode_failed:{err}"))?;

    let mut out = json!({
        "ok": true,
        "type": "session_continuity_vault_get",
        "lane": LANE_ID,
        "session_id": session_id,
        "vault_path": rel_path(root, &vault_path),
        "encrypted": algo != "base64-plain",
        "state_sha256": hex::encode(Sha256::digest(&decoded)),
        "state_summary": {
            "attention_items": state.get("attention_queue").and_then(Value::as_array).map(|r| r.len()).unwrap_or(0),
            "memory_nodes": state.get("memory_graph").and_then(Value::as_object).map(|r| r.len()).unwrap_or(0),
            "active_personas": state.get("active_personas").and_then(Value::as_array).map(|r| r.len()).unwrap_or(0),
        }
    });
    if emit_state {
        out["state"] = state;
    }
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    Ok(out)
}

pub(super) fn vault_status_payload(root: &Path, policy: &ContinuityPolicy) -> Value {
    let dir = vault_dir(root);
    let mut records = 0usize;
    if let Ok(read) = fs::read_dir(&dir) {
        for entry in read.flatten() {
            if entry.path().extension().and_then(|s| s.to_str()) == Some("json") {
                records += 1;
            }
        }
    }
    let mut out = json!({
        "ok": true,
        "type": "session_continuity_vault_status",
        "lane": LANE_ID,
        "vault_dir": rel_path(root, &dir),
        "record_count": records,
        "history_path": rel_path(root, &vault_history_path(root)),
        "policy": {
            "require_vault_encryption": policy.require_vault_encryption,
            "vault_key_env": policy.vault_key_env
        }
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    out
}
