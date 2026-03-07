// SPDX-License-Identifier: Apache-2.0
use crate::compression;
use crate::sqlite_store::{self, MemoryRow};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
pub struct RecallHit {
    pub id: String,
    pub content: String,
    pub tags: Vec<String>,
    pub retention_score: f64,
    pub compression_ratio: f64,
    pub updated_at: i64,
}

fn to_hit(row: MemoryRow) -> RecallHit {
    let report = compression::report_for(&row.content);
    RecallHit {
        id: row.id,
        content: row.content,
        tags: row.tags,
        retention_score: row.retention_score,
        compression_ratio: report.ratio,
        updated_at: row.updated_at,
    }
}

pub fn recall_json(query: &str, limit: u32) -> String {
    match sqlite_store::recall(query, limit) {
        Ok(rows) => {
            let hits = rows.into_iter().map(to_hit).collect::<Vec<_>>();
            serde_json::json!({
                "ok": true,
                "query": query,
                "limit": limit,
                "hit_count": hits.len(),
                "hits": hits
            })
            .to_string()
        }
        Err(err) => serde_json::json!({
            "ok": false,
            "error": err
        })
        .to_string(),
    }
}

pub fn get_json(id: &str) -> String {
    match sqlite_store::get(id) {
        Ok(Some(row)) => serde_json::json!({
            "ok": true,
            "row": to_hit(row)
        })
        .to_string(),
        Ok(None) => serde_json::json!({
            "ok": false,
            "error": "not_found",
            "id": id
        })
        .to_string(),
        Err(err) => serde_json::json!({
            "ok": false,
            "error": err
        })
        .to_string(),
    }
}
