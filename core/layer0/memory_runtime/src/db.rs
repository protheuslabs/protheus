use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use rand::RngCore;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug, Default)]
pub struct DbIndexEntry {
    pub node_id: String,
    pub uid: String,
    pub file_rel: String,
    pub summary: String,
    pub tags: Vec<String>,
}

pub struct MemoryDb {
    conn: Connection,
    db_path: PathBuf,
    cipher_key: [u8; 32],
}

#[derive(Clone, Debug, Default)]
pub struct HotStateEnvelopeStats {
    pub total_rows: usize,
    pub enveloped_rows: usize,
    pub legacy_cipher_rows: usize,
    pub plain_rows: usize,
}

const HOT_STATE_ENVELOPE_SCHEMA_ID: &str = "organ_state_envelope";
const HOT_STATE_ENVELOPE_SCHEMA_VERSION: &str = "1.0";

fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|dur| dur.as_secs())
        .unwrap_or(0);
    format!("{secs}")
}

fn default_db_path(root: &Path) -> PathBuf {
    root.join("state")
        .join("memory")
        .join("runtime_memory.sqlite")
}

fn resolve_db_path(root: &Path, raw: &str) -> PathBuf {
    let v = raw.trim();
    if v.is_empty() {
        return default_db_path(root);
    }
    let p = PathBuf::from(v);
    if p.is_absolute() {
        p
    } else {
        root.join(p)
    }
}

fn derive_key_material(root: &Path) -> String {
    if let Ok(v) = env::var("PROTHEUS_MEMORY_DB_KEY") {
        let trimmed = v.trim().to_string();
        if !trimmed.is_empty() {
            return trimmed;
        }
    }
    let keyring_path = root
        .join("state")
        .join("security")
        .join("organ_state_encryption")
        .join("keyring.json");
    if let Ok(raw) = fs::read_to_string(&keyring_path) {
        if !raw.trim().is_empty() {
            return raw;
        }
    }
    format!("fallback:{}:memory-runtime-db", root.to_string_lossy())
}

fn derive_cipher_key(root: &Path) -> [u8; 32] {
    let material = derive_key_material(root);
    let mut hasher = Sha256::new();
    hasher.update(material.as_bytes());
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest[..32]);
    out
}

fn legacy_keystream_block(cipher_key: &[u8; 32], nonce: u64, block_index: u64) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(cipher_key);
    hasher.update(nonce.to_le_bytes());
    hasher.update(block_index.to_le_bytes());
    let digest = hasher.finalize();
    let mut out = [0u8; 32];
    out.copy_from_slice(&digest[..32]);
    out
}

fn legacy_xor_stream(cipher_key: &[u8; 32], nonce: u64, input: &[u8]) -> Vec<u8> {
    let mut out = vec![0u8; input.len()];
    let mut offset = 0usize;
    let mut block_index = 0u64;
    while offset < input.len() {
        let block = legacy_keystream_block(cipher_key, nonce, block_index);
        let mut local = 0usize;
        while local < block.len() && (offset + local) < input.len() {
            out[offset + local] = input[offset + local] ^ block[local];
            local += 1;
        }
        offset += block.len();
        block_index += 1;
    }
    out
}

fn encrypt_value(cipher_key: &[u8; 32], plaintext: &str) -> Result<String, String> {
    let cipher =
        Aes256Gcm::new_from_slice(cipher_key).map_err(|err| format!("aead_init_failed:{err}"))?;
    let mut nonce_bytes = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|err| format!("aead_encrypt_failed:{err}"))?;
    Ok(format!(
        "aead-v1:{}:{}",
        hex::encode(nonce_bytes),
        hex::encode(ciphertext)
    ))
}

fn decrypt_legacy_value(cipher_key: &[u8; 32], payload: &str) -> Result<String, String> {
    let body = payload.trim();
    if !body.starts_with("enc-v1:") {
        return Ok(body.to_string());
    }
    let parts = body.splitn(3, ':').collect::<Vec<&str>>();
    if parts.len() != 3 {
        return Err("legacy_cipher_invalid_parts".to_string());
    }
    let nonce = u64::from_str_radix(parts[1], 16).unwrap_or(0);
    let Ok(cipher_bytes) = hex::decode(parts[2]) else {
        return Err("legacy_cipher_invalid_hex".to_string());
    };
    let plain = legacy_xor_stream(cipher_key, nonce, &cipher_bytes);
    String::from_utf8(plain).map_err(|_| "legacy_cipher_invalid_utf8".to_string())
}

fn decrypt_value(cipher_key: &[u8; 32], payload: &str) -> Result<String, String> {
    let body = payload.trim();
    if body.starts_with("enc-v1:") {
        return Err("legacy_cipher_retired".to_string());
    }
    if !body.starts_with("aead-v1:") {
        return Err("legacy_plaintext_retired".to_string());
    }
    let parts = body.splitn(3, ':').collect::<Vec<&str>>();
    if parts.len() != 3 {
        return Err("aead_invalid_parts".to_string());
    }
    let nonce_bytes = hex::decode(parts[1]).map_err(|_| "aead_invalid_nonce_hex".to_string())?;
    if nonce_bytes.len() != 12 {
        return Err("aead_invalid_nonce_len".to_string());
    }
    let cipher_bytes = hex::decode(parts[2]).map_err(|_| "aead_invalid_cipher_hex".to_string())?;
    let cipher =
        Aes256Gcm::new_from_slice(cipher_key).map_err(|err| format!("aead_init_failed:{err}"))?;
    let nonce = Nonce::from_slice(&nonce_bytes);
    let plaintext = cipher
        .decrypt(nonce, cipher_bytes.as_ref())
        .map_err(|_| "aead_decrypt_failed".to_string())?;
    String::from_utf8(plaintext).map_err(|_| "aead_invalid_utf8".to_string())
}

fn hot_state_key_ref(cipher_key: &[u8; 32]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(cipher_key);
    let digest = hasher.finalize();
    format!("organ_state_encryption:key_{}", hex::encode(&digest[..8]))
}

fn parse_hot_state_envelope_ciphertext(payload: &str) -> Option<String> {
    let parsed = serde_json::from_str::<Value>(payload).ok()?;
    let schema_id = parsed
        .get("schema_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    if schema_id != HOT_STATE_ENVELOPE_SCHEMA_ID {
        return None;
    }
    let lane = parsed.get("lane").and_then(Value::as_str).unwrap_or("");
    if lane != "hot_state" {
        return None;
    }
    parsed
        .get("ciphertext")
        .and_then(Value::as_str)
        .map(|s| s.to_string())
}

fn wrap_hot_state_envelope(cipher_key: &[u8; 32], plaintext: &str) -> Result<String, String> {
    let ciphertext = encrypt_value(cipher_key, plaintext)?;
    let envelope = json!({
        "schema_id": HOT_STATE_ENVELOPE_SCHEMA_ID,
        "schema_version": HOT_STATE_ENVELOPE_SCHEMA_VERSION,
        "organ": "memory",
        "lane": "hot_state",
        "algorithm": "aes256_gcm",
        "key_ref": hot_state_key_ref(cipher_key),
        "wrapped_at": now_iso(),
        "ciphertext": ciphertext
    });
    serde_json::to_string(&envelope)
        .map_err(|err| format!("hot_state_envelope_encode_failed:{err}"))
}

fn decode_hot_state_payload_for_migration(
    cipher_key: &[u8; 32],
    payload: &str,
) -> Result<Option<String>, String> {
    let body = payload.trim();
    if body.is_empty() {
        return Ok(Some(String::new()));
    }
    if parse_hot_state_envelope_ciphertext(body).is_some() {
        return Ok(None);
    }
    if body.starts_with("aead-v1:") {
        let plain = decrypt_value(cipher_key, body)?;
        return Ok(Some(plain));
    }
    if body.starts_with("enc-v1:") {
        let plain = decrypt_legacy_value(cipher_key, body)?;
        return Ok(Some(plain));
    }
    Ok(Some(body.to_string()))
}

fn decrypt_hot_state_envelope(cipher_key: &[u8; 32], payload: &str) -> Result<String, String> {
    let body = payload.trim();
    let Some(ciphertext) = parse_hot_state_envelope_ciphertext(body) else {
        return Err("hot_state_envelope_required".to_string());
    };
    decrypt_value(cipher_key, &ciphertext)
}

fn parse_tags_json(raw: &str) -> Vec<String> {
    let parsed = serde_json::from_str::<Vec<String>>(raw).unwrap_or_default();
    let mut out = parsed
        .into_iter()
        .filter(|tag| !tag.trim().is_empty())
        .collect::<Vec<String>>();
    out.sort();
    out.dedup();
    out
}

fn normalize_vector(values: &[f32]) -> Vec<f32> {
    if values.is_empty() {
        return vec![];
    }
    let mut out = values
        .iter()
        .map(|value| if value.is_finite() { *value } else { 0.0f32 })
        .collect::<Vec<f32>>();
    let norm = out
        .iter()
        .fold(0.0f32, |acc, value| acc + (*value * *value))
        .sqrt();
    if norm > 0.0 {
        for value in out.iter_mut() {
            *value /= norm;
        }
    }
    out
}

fn encode_vector_blob(values: &[f32]) -> Result<Vec<u8>, String> {
    let normalized = normalize_vector(values);
    serde_json::to_vec(&normalized).map_err(|err| format!("db_vector_encode_failed:{err}"))
}

fn decode_vector_blob(blob: &[u8]) -> Result<Vec<f32>, String> {
    let parsed = serde_json::from_slice::<Vec<f32>>(blob)
        .map_err(|err| format!("db_vector_decode_failed:{err}"))?;
    Ok(normalize_vector(&parsed))
}

impl MemoryDb {
    pub fn open(root: &Path, db_path_raw: &str) -> Result<Self, String> {
        let db_path = resolve_db_path(root, db_path_raw);
        if let Some(parent) = db_path.parent() {
            fs::create_dir_all(parent).map_err(|err| format!("db_parent_create_failed:{err}"))?;
        }
        let conn = Connection::open(&db_path).map_err(|err| format!("db_open_failed:{err}"))?;
        let db = Self {
            conn,
            db_path,
            cipher_key: derive_cipher_key(root),
        };
        db.init_schema()?;
        db.migrate_legacy_hot_state_cipher()?;
        Ok(db)
    }

    pub fn rel_db_path(&self, root: &Path) -> String {
        self.db_path
            .strip_prefix(root)
            .unwrap_or(&self.db_path)
            .to_string_lossy()
            .replace('\\', "/")
    }

    fn init_schema(&self) -> Result<(), String> {
        self.conn
            .execute_batch(
                r#"
PRAGMA journal_mode=WAL;
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=3000;

CREATE TABLE IF NOT EXISTS embeddings (
  embedding_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  vector_blob BLOB NOT NULL,
  metadata_json TEXT NOT NULL,
  created_ts TEXT NOT NULL,
  updated_ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS temporal_graph_nodes (
  node_id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  updated_ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS temporal_graph_edges (
  src_node_id TEXT NOT NULL,
  edge_type TEXT NOT NULL,
  dst_node_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_ts TEXT NOT NULL,
  PRIMARY KEY (src_node_id, edge_type, dst_node_id)
);

CREATE TABLE IF NOT EXISTS hot_state (
  state_key TEXT PRIMARY KEY,
  state_value_json TEXT NOT NULL,
  updated_ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_index (
  node_id TEXT NOT NULL,
  uid TEXT NOT NULL,
  file_rel TEXT NOT NULL,
  summary TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_ts TEXT NOT NULL,
  PRIMARY KEY (node_id, file_rel)
);

CREATE INDEX IF NOT EXISTS idx_memory_index_file ON memory_index(file_rel);
CREATE INDEX IF NOT EXISTS idx_memory_index_uid ON memory_index(uid);
CREATE INDEX IF NOT EXISTS idx_memory_index_node ON memory_index(node_id);
CREATE INDEX IF NOT EXISTS idx_memory_index_source ON memory_index(source);
CREATE INDEX IF NOT EXISTS idx_graph_edges_src ON temporal_graph_edges(src_node_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_dst ON temporal_graph_edges(dst_node_id);
"#,
            )
            .map_err(|err| format!("db_schema_failed:{err}"))?;

        // Optional sqlite-vec extension table; non-fatal when extension is unavailable.
        let _ = self.conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS embedding_vectors USING vec0(vector float[1536])",
            [],
        );
        Ok(())
    }

    fn migrate_legacy_hot_state_cipher(&self) -> Result<usize, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT state_key, state_value_json FROM hot_state")
            .map_err(|err| format!("db_hot_state_scan_prepare_failed:{err}"))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|err| format!("db_hot_state_scan_failed:{err}"))?;
        let mut pending: Vec<(String, String)> = vec![];
        for row in mapped {
            let (state_key, value_raw) =
                row.map_err(|err| format!("db_hot_state_scan_row_failed:{err}"))?;
            let maybe_plain = decode_hot_state_payload_for_migration(&self.cipher_key, &value_raw)
                .map_err(|err| format!("db_hot_state_legacy_migrate_decode_failed:{err}"))?;
            let Some(plain) = maybe_plain else {
                continue;
            };
            let envelope = wrap_hot_state_envelope(&self.cipher_key, &plain)
                .map_err(|err| format!("db_hot_state_envelope_wrap_failed:{err}"))?;
            pending.push((state_key, envelope));
        }
        if pending.is_empty() {
            return Ok(0);
        }
        let now = now_iso();
        for (state_key, encrypted) in pending.iter() {
            self.conn
            .execute(
                "UPDATE hot_state SET state_value_json = ?1, updated_ts = ?2 WHERE state_key = ?3",
                params![encrypted, now, state_key],
            )
            .map_err(|err| format!("db_hot_state_migrate_update_failed:{err}"))?;
        }
        Ok(pending.len())
    }

    pub fn count_index_rows(&self) -> Result<usize, String> {
        let count = self
            .conn
            .query_row("SELECT COUNT(1) FROM memory_index", [], |row| {
                row.get::<_, i64>(0)
            })
            .map_err(|err| format!("db_count_index_failed:{err}"))?;
        Ok(count.max(0) as usize)
    }

    pub fn load_index_entries(&self) -> Result<Vec<DbIndexEntry>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT node_id, uid, file_rel, summary, tags_json
                 FROM memory_index
                 ORDER BY file_rel ASC, node_id ASC",
            )
            .map_err(|err| format!("db_prepare_index_load_failed:{err}"))?;
        let mapped = stmt
            .query_map([], |row| {
                let tags_raw = row.get::<_, String>(4)?;
                Ok(DbIndexEntry {
                    node_id: row.get::<_, String>(0)?,
                    uid: row.get::<_, String>(1)?,
                    file_rel: row.get::<_, String>(2)?,
                    summary: row.get::<_, String>(3)?,
                    tags: parse_tags_json(&tags_raw),
                })
            })
            .map_err(|err| format!("db_query_index_failed:{err}"))?;
        let mut out: Vec<DbIndexEntry> = vec![];
        for row in mapped {
            match row {
                Ok(entry) => out.push(entry),
                Err(err) => return Err(format!("db_row_decode_failed:{err}")),
            }
        }
        Ok(out)
    }

    pub fn replace_index_entries(
        &mut self,
        entries: &[DbIndexEntry],
        source: &str,
    ) -> Result<usize, String> {
        let tx = self
            .conn
            .transaction()
            .map_err(|err| format!("db_tx_start_failed:{err}"))?;
        tx.execute("DELETE FROM memory_index", [])
            .map_err(|err| format!("db_index_clear_failed:{err}"))?;
        let now = now_iso();
        for entry in entries {
            let tags_json = serde_json::to_string(&entry.tags)
                .map_err(|err| format!("db_tags_encode_failed:{err}"))?;
            tx.execute(
                "INSERT INTO memory_index (node_id, uid, file_rel, summary, tags_json, source, updated_ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    entry.node_id,
                    entry.uid,
                    entry.file_rel,
                    entry.summary,
                    tags_json,
                    source,
                    now
                ],
            )
            .map_err(|err| format!("db_index_insert_failed:{err}"))?;
        }
        tx.commit()
            .map_err(|err| format!("db_tx_commit_failed:{err}"))?;
        Ok(entries.len())
    }

    pub fn replace_embeddings(
        &mut self,
        entries: &[(String, Vec<f32>, Value)],
        source: &str,
    ) -> Result<usize, String> {
        let tx = self
            .conn
            .transaction()
            .map_err(|err| format!("db_embedding_tx_start_failed:{err}"))?;
        tx.execute("DELETE FROM embeddings", [])
            .map_err(|err| format!("db_embedding_clear_failed:{err}"))?;
        let now = now_iso();
        for (node_id, vector, metadata) in entries {
            let embedding_id = format!("{}::{}", source, node_id);
            let vector_blob = encode_vector_blob(vector)?;
            let metadata_json = serde_json::to_string(metadata)
                .map_err(|err| format!("db_embedding_metadata_encode_failed:{err}"))?;
            tx.execute(
                "INSERT INTO embeddings (embedding_id, node_id, vector_blob, metadata_json, created_ts, updated_ts)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    embedding_id,
                    node_id,
                    vector_blob,
                    metadata_json,
                    now,
                    now
                ],
            )
            .map_err(|err| format!("db_embedding_insert_failed:{err}"))?;
        }
        tx.commit()
            .map_err(|err| format!("db_embedding_tx_commit_failed:{err}"))?;
        Ok(entries.len())
    }

    pub fn load_embedding_map(
        &self,
    ) -> Result<std::collections::HashMap<String, Vec<f32>>, String> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT node_id, vector_blob
                 FROM embeddings",
            )
            .map_err(|err| format!("db_prepare_embedding_load_failed:{err}"))?;
        let mapped = stmt
            .query_map([], |row| {
                let node_id = row.get::<_, String>(0)?;
                let blob = row.get::<_, Vec<u8>>(1)?;
                Ok((node_id, blob))
            })
            .map_err(|err| format!("db_query_embedding_failed:{err}"))?;
        let mut out = std::collections::HashMap::new();
        for row in mapped {
            match row {
                Ok((node_id, blob)) => {
                    let vector = decode_vector_blob(&blob)?;
                    if !vector.is_empty() {
                        out.insert(node_id, vector);
                    }
                }
                Err(err) => return Err(format!("db_embedding_row_decode_failed:{err}")),
            }
        }
        Ok(out)
    }

    pub fn get_hot_state_json(&self, key: &str) -> Result<Option<Value>, String> {
        let raw: Option<String> = self
            .conn
            .query_row(
                "SELECT state_value_json FROM hot_state WHERE state_key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|err| format!("db_hot_state_query_failed:{err}"))?;
        match raw {
            Some(cipher) => {
                let plain = decrypt_hot_state_envelope(&self.cipher_key, &cipher)
                    .map_err(|err| format!("db_hot_state_decrypt_failed:{err}"))?;
                let parsed = serde_json::from_str::<Value>(&plain)
                    .map_err(|err| format!("db_hot_state_decode_failed:{err}"))?;
                Ok(Some(parsed))
            }
            None => Ok(None),
        }
    }

    pub fn set_hot_state_json(&self, key: &str, value: &Value) -> Result<(), String> {
        let encoded = serde_json::to_string(value)
            .map_err(|err| format!("db_hot_state_encode_failed:{err}"))?;
        let envelope = wrap_hot_state_envelope(&self.cipher_key, &encoded)
            .map_err(|err| format!("db_hot_state_encrypt_failed:{err}"))?;
        self.conn
            .execute(
                "INSERT INTO hot_state (state_key, state_value_json, updated_ts)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(state_key) DO UPDATE SET
                   state_value_json = excluded.state_value_json,
                   updated_ts = excluded.updated_ts",
                params![key, envelope, now_iso()],
            )
            .map_err(|err| format!("db_hot_state_upsert_failed:{err}"))?;
        Ok(())
    }

    pub fn hot_state_envelope_stats(&self) -> Result<HotStateEnvelopeStats, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT state_value_json FROM hot_state")
            .map_err(|err| format!("db_hot_state_stats_prepare_failed:{err}"))?;
        let mapped = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|err| format!("db_hot_state_stats_query_failed:{err}"))?;
        let mut stats = HotStateEnvelopeStats::default();
        for row in mapped {
            let raw = row.map_err(|err| format!("db_hot_state_stats_row_failed:{err}"))?;
            stats.total_rows += 1;
            let body = raw.trim();
            if parse_hot_state_envelope_ciphertext(body).is_some() {
                stats.enveloped_rows += 1;
            } else if body.starts_with("aead-v1:") || body.starts_with("enc-v1:") {
                stats.legacy_cipher_rows += 1;
            } else {
                stats.plain_rows += 1;
            }
        }
        Ok(stats)
    }
}

#[cfg(test)]
mod tests {
    use super::{decrypt_hot_state_envelope, encrypt_value, wrap_hot_state_envelope};

    fn test_key() -> [u8; 32] {
        [7u8; 32]
    }

    #[test]
    fn aead_round_trip() {
        let key = test_key();
        let payload = r#"{"ok":true,"k":"v"}"#;
        let wrapped = wrap_hot_state_envelope(&key, payload).expect("envelope");
        assert!(wrapped.contains("\"schema_id\":\"organ_state_envelope\""));
        let decrypted = decrypt_hot_state_envelope(&key, &wrapped).expect("decrypt");
        assert_eq!(decrypted, payload);
    }

    #[test]
    fn aead_tamper_fails_closed() {
        let key = test_key();
        let payload = r#"{"ok":true}"#;
        let encrypted = encrypt_value(&key, payload).expect("encrypt");
        let mut chars = encrypted.chars().collect::<Vec<char>>();
        let idx = chars.len().saturating_sub(1);
        chars[idx] = if chars[idx] == 'a' { 'b' } else { 'a' };
        let tampered_cipher = chars.into_iter().collect::<String>();
        let wrapped = serde_json::json!({
            "schema_id": "organ_state_envelope",
            "schema_version": "1.0",
            "organ": "memory",
            "lane": "hot_state",
            "ciphertext": tampered_cipher
        })
        .to_string();
        let decrypted = decrypt_hot_state_envelope(&key, &wrapped);
        assert!(decrypted.is_err(), "tampered payload should fail decrypt");
    }

    #[test]
    fn legacy_cipher_is_rejected_after_retirement() {
        let key = test_key();
        let legacy = "enc-v1:0000000000000001:00";
        let decrypted = decrypt_hot_state_envelope(&key, legacy);
        assert!(decrypted.is_err(), "legacy payload should be rejected");
    }
}
