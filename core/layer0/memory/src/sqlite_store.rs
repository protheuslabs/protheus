// SPDX-License-Identifier: Apache-2.0
use crate::ebbinghaus;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRow {
    pub id: String,
    pub content: String,
    pub tags: Vec<String>,
    pub updated_at: i64,
    pub repetitions: u32,
    pub retention_score: f64,
}

fn now_ts() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_secs() as i64)
        .unwrap_or(0)
}

#[allow(dead_code)]
pub fn default_db_path() -> std::path::PathBuf {
    if let Ok(v) = std::env::var("PROTHEUS_MEMORY_DB_PATH") {
        let s = v.trim();
        if !s.is_empty() {
            return std::path::PathBuf::from(s);
        }
    }
    if let Ok(core_root) = std::env::var("PROTHEUS_CORE_STATE_ROOT") {
        let s = core_root.trim();
        if !s.is_empty() {
            return std::path::PathBuf::from(s).join("memory/runtime_memory.sqlite");
        }
    }
    if let Ok(client_root) = std::env::var("PROTHEUS_CLIENT_STATE_ROOT") {
        let s = client_root.trim();
        if !s.is_empty() {
            return std::path::PathBuf::from(s).join("memory/runtime_memory.sqlite");
        }
    }
    std::path::PathBuf::from("core/local/state/memory/runtime_memory.sqlite")
}

#[cfg(not(target_arch = "wasm32"))]
mod native {
    use super::*;
    use rusqlite::{params, Connection};

    pub fn open(path: &std::path::Path) -> Result<Connection, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{e}"))?;
        }
        Connection::open(path).map_err(|e| format!("sqlite_open_failed:{e}"))
    }

    pub fn ensure_schema(conn: &Connection) -> Result<(), String> {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS memories (
              id TEXT PRIMARY KEY,
              content TEXT NOT NULL,
              tags_json TEXT NOT NULL DEFAULT '[]',
              updated_at INTEGER NOT NULL,
              repetitions INTEGER NOT NULL DEFAULT 1,
              retention_score REAL NOT NULL DEFAULT 1.0
            );
            CREATE TABLE IF NOT EXISTS memory_cache (
              key TEXT PRIMARY KEY,
              payload TEXT NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memories_retention ON memories(retention_score DESC);
            "#,
        )
        .map_err(|e| format!("sqlite_schema_failed:{e}"))
    }

    pub fn upsert_memory(mut row: MemoryRow) -> Result<(), String> {
        let db_path = default_db_path();
        let conn = open(&db_path)?;
        ensure_schema(&conn)?;
        row.updated_at = now_ts();
        let tags_json =
            serde_json::to_string(&row.tags).map_err(|e| format!("tags_encode_failed:{e}"))?;
        conn.execute(
            r#"
            INSERT INTO memories (id, content, tags_json, updated_at, repetitions, retention_score)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(id) DO UPDATE SET
              content=excluded.content,
              tags_json=excluded.tags_json,
              updated_at=excluded.updated_at,
              repetitions=excluded.repetitions,
              retention_score=excluded.retention_score
            "#,
            params![
                row.id,
                row.content,
                tags_json,
                row.updated_at,
                i64::from(row.repetitions as i32),
                row.retention_score
            ],
        )
        .map_err(|e| format!("sqlite_upsert_failed:{e}"))?;
        Ok(())
    }

    pub fn query_recall(query: &str, limit: u32) -> Result<Vec<MemoryRow>, String> {
        let db_path = default_db_path();
        let conn = open(&db_path)?;
        ensure_schema(&conn)?;
        let q = format!("%{}%", query.to_lowercase());
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, content, tags_json, updated_at, repetitions, retention_score
                FROM memories
                WHERE lower(content) LIKE ?1
                ORDER BY retention_score DESC, updated_at DESC
                LIMIT ?2
                "#,
            )
            .map_err(|e| format!("sqlite_prepare_failed:{e}"))?;
        let rows = stmt
            .query_map(params![q, i64::from(limit as i32)], |row| {
                let tags_json: String = row.get(2)?;
                let tags = serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default();
                Ok(MemoryRow {
                    id: row.get(0)?,
                    content: row.get(1)?,
                    tags,
                    updated_at: row.get(3)?,
                    repetitions: row.get::<_, i64>(4)? as u32,
                    retention_score: row.get(5)?,
                })
            })
            .map_err(|e| format!("sqlite_query_failed:{e}"))?;
        let mut out = Vec::new();
        for row in rows {
            out.push(row.map_err(|e| format!("sqlite_row_failed:{e}"))?);
        }
        Ok(out)
    }

    pub fn get_by_id(id: &str) -> Result<Option<MemoryRow>, String> {
        let db_path = default_db_path();
        let conn = open(&db_path)?;
        ensure_schema(&conn)?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, content, tags_json, updated_at, repetitions, retention_score
                FROM memories
                WHERE id = ?1
                LIMIT 1
                "#,
            )
            .map_err(|e| format!("sqlite_prepare_failed:{e}"))?;
        let mut rows = stmt
            .query(params![id])
            .map_err(|e| format!("sqlite_query_failed:{e}"))?;
        if let Some(row) = rows
            .next()
            .map_err(|e| format!("sqlite_row_next_failed:{e}"))?
        {
            let tags_json: String = row.get(2).map_err(|e| format!("sqlite_col_failed:{e}"))?;
            let tags = serde_json::from_str::<Vec<String>>(&tags_json).unwrap_or_default();
            return Ok(Some(MemoryRow {
                id: row.get(0).map_err(|e| format!("sqlite_col_failed:{e}"))?,
                content: row.get(1).map_err(|e| format!("sqlite_col_failed:{e}"))?,
                tags,
                updated_at: row.get(3).map_err(|e| format!("sqlite_col_failed:{e}"))?,
                repetitions: row
                    .get::<_, i64>(4)
                    .map_err(|e| format!("sqlite_col_failed:{e}"))?
                    as u32,
                retention_score: row.get(5).map_err(|e| format!("sqlite_col_failed:{e}"))?,
            }));
        }
        Ok(None)
    }

    pub fn clear_cache() -> Result<u64, String> {
        let db_path = default_db_path();
        let conn = open(&db_path)?;
        ensure_schema(&conn)?;
        let n = conn
            .execute("DELETE FROM memory_cache", [])
            .map_err(|e| format!("sqlite_clear_cache_failed:{e}"))?;
        Ok(n as u64)
    }

    pub fn set_hot_state(key: &str, payload_json: &str) -> Result<(), String> {
        let db_path = default_db_path();
        let conn = open(&db_path)?;
        ensure_schema(&conn)?;
        conn.execute(
            r#"
            INSERT INTO memory_cache (key, payload, updated_at)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(key) DO UPDATE SET
              payload=excluded.payload,
              updated_at=excluded.updated_at
            "#,
            params![key, payload_json, now_ts()],
        )
        .map_err(|e| format!("sqlite_hot_state_upsert_failed:{e}"))?;
        Ok(())
    }

    pub fn compress_store(aggressive: bool) -> Result<u64, String> {
        let db_path = default_db_path();
        let conn = open(&db_path)?;
        ensure_schema(&conn)?;
        let cutoff_days = if aggressive { 7.0 } else { 30.0 };
        let cutoff_ts = now_ts() - (cutoff_days as i64 * 24 * 60 * 60);
        let removed = conn
            .execute(
                "DELETE FROM memories WHERE updated_at < ?1 AND retention_score < ?2",
                params![cutoff_ts, if aggressive { 0.55 } else { 0.25 }],
            )
            .map_err(|e| format!("sqlite_compress_failed:{e}"))?;
        conn.execute_batch("VACUUM;")
            .map_err(|e| format!("sqlite_vacuum_failed:{e}"))?;
        Ok(removed as u64)
    }

    pub fn seed_if_empty() -> Result<(), String> {
        let db_path = default_db_path();
        let conn = open(&db_path)?;
        ensure_schema(&conn)?;
        let count: i64 = conn
            .query_row("SELECT COUNT(1) FROM memories", [], |row| row.get(0))
            .map_err(|e| format!("sqlite_count_failed:{e}"))?;
        if count > 0 {
            return Ok(());
        }
        let samples = vec![
            (
                "memory://northstar",
                "Northstar: build resilient compounding systems.",
                vec!["northstar".to_string(), "strategy".to_string()],
                5u32,
                1.0f64,
            ),
            (
                "memory://ops",
                "Ops reliability rises when rollout and rollback are both deterministic.",
                vec!["ops".to_string(), "reliability".to_string()],
                3u32,
                0.92f64,
            ),
            (
                "memory://rust",
                "Rust migration must move critical paths, not wrappers only.",
                vec!["rust".to_string(), "migration".to_string()],
                4u32,
                0.96f64,
            ),
        ];
        for (id, content, tags, repetitions, score) in samples {
            let row = MemoryRow {
                id: id.to_string(),
                content: content.to_string(),
                tags,
                updated_at: now_ts(),
                repetitions,
                retention_score: score,
            };
            upsert_memory(row)?;
        }
        Ok(())
    }
}

#[cfg(target_arch = "wasm32")]
mod native {
    use super::*;
    use std::sync::{Mutex, OnceLock};

    fn mem() -> &'static Mutex<Vec<MemoryRow>> {
        static STORE: OnceLock<Mutex<Vec<MemoryRow>>> = OnceLock::new();
        STORE.get_or_init(|| Mutex::new(Vec::new()))
    }

    pub fn upsert_memory(row: MemoryRow) -> Result<(), String> {
        let mut lock = mem().lock().map_err(|_| "store_lock_failed".to_string())?;
        if let Some(existing) = lock.iter_mut().find(|it| it.id == row.id) {
            *existing = row;
        } else {
            lock.push(row);
        }
        Ok(())
    }

    pub fn query_recall(query: &str, limit: u32) -> Result<Vec<MemoryRow>, String> {
        let lock = mem().lock().map_err(|_| "store_lock_failed".to_string())?;
        let mut out = lock
            .iter()
            .filter(|row| row.content.to_lowercase().contains(&query.to_lowercase()))
            .cloned()
            .collect::<Vec<_>>();
        out.sort_by(|a, b| {
            b.retention_score
                .partial_cmp(&a.retention_score)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
        });
        out.truncate(limit as usize);
        Ok(out)
    }

    pub fn get_by_id(id: &str) -> Result<Option<MemoryRow>, String> {
        let lock = mem().lock().map_err(|_| "store_lock_failed".to_string())?;
        Ok(lock.iter().find(|row| row.id == id).cloned())
    }

    pub fn clear_cache() -> Result<u64, String> {
        Ok(0)
    }

    pub fn set_hot_state(_key: &str, _payload_json: &str) -> Result<(), String> {
        Ok(())
    }

    pub fn compress_store(_aggressive: bool) -> Result<u64, String> {
        Ok(0)
    }

    pub fn seed_if_empty() -> Result<(), String> {
        let lock = mem().lock().map_err(|_| "store_lock_failed".to_string())?;
        if !lock.is_empty() {
            return Ok(());
        }
        drop(lock);
        upsert_memory(MemoryRow {
            id: "memory://wasm".to_string(),
            content: "WASM memory runtime active.".to_string(),
            tags: vec!["wasm".to_string()],
            updated_at: now_ts(),
            repetitions: 1,
            retention_score: 1.0,
        })
    }
}

pub fn ingest(
    id: &str,
    content: &str,
    tags: Vec<String>,
    repetitions: u32,
    lambda: f64,
) -> Result<MemoryRow, String> {
    let row = MemoryRow {
        id: id.to_string(),
        content: content.to_string(),
        tags,
        updated_at: now_ts(),
        repetitions,
        retention_score: ebbinghaus::retention_score(0.0, repetitions, lambda),
    };
    native::upsert_memory(row.clone())?;
    Ok(row)
}

pub fn recall(query: &str, limit: u32) -> Result<Vec<MemoryRow>, String> {
    native::seed_if_empty()?;
    native::query_recall(query, limit.max(1))
}

pub fn get(id: &str) -> Result<Option<MemoryRow>, String> {
    native::get_by_id(id)
}

pub fn clear_cache() -> Result<u64, String> {
    native::clear_cache()
}

pub fn compress(aggressive: bool) -> Result<u64, String> {
    native::compress_store(aggressive)
}

pub fn set_hot_state(key: &str, payload_json: &str) -> Result<(), String> {
    native::set_hot_state(key, payload_json)
}
