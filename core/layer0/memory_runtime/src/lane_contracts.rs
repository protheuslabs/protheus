use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct ClaimEvidenceRow {
    pub claim: String,
    pub evidence: Vec<String>,
    pub persona_lenses: Vec<String>,
}

fn clean_line(raw: &str, max_len: usize) -> String {
    raw.split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
        .trim()
        .chars()
        .take(max_len)
        .collect::<String>()
}

fn normalize_lens(raw: &str) -> String {
    let cleaned = clean_line(raw, 80).to_lowercase();
    cleaned
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .collect::<String>()
}

fn normalize_claim(raw: &str) -> String {
    clean_line(raw, 240)
}

fn normalize_evidence(raw: &str) -> String {
    clean_line(raw, 320)
}

pub fn normalize_claim_evidence(rows: &[ClaimEvidenceRow]) -> Vec<ClaimEvidenceRow> {
    let mut out: Vec<ClaimEvidenceRow> = rows
        .iter()
        .map(|row| {
            let mut evidence = row
                .evidence
                .iter()
                .map(|v| normalize_evidence(v))
                .filter(|v| !v.is_empty())
                .collect::<BTreeSet<String>>()
                .into_iter()
                .collect::<Vec<String>>();
            let mut persona_lenses = row
                .persona_lenses
                .iter()
                .map(|v| normalize_lens(v))
                .filter(|v| !v.is_empty())
                .collect::<BTreeSet<String>>()
                .into_iter()
                .collect::<Vec<String>>();
            evidence.sort();
            persona_lenses.sort();
            ClaimEvidenceRow {
                claim: normalize_claim(&row.claim),
                evidence,
                persona_lenses,
            }
        })
        .filter(|row| !row.claim.is_empty())
        .collect();

    out.sort_by(|a, b| {
        let claim = a.claim.cmp(&b.claim);
        if claim != std::cmp::Ordering::Equal {
            return claim;
        }
        let lens_a = a.persona_lenses.join(",");
        let lens_b = b.persona_lenses.join(",");
        lens_a.cmp(&lens_b)
    });
    out
}

pub fn validate_claim_evidence(rows: &[ClaimEvidenceRow]) -> Result<(), String> {
    if rows.is_empty() {
        return Err("claim_evidence_required".to_string());
    }
    let normalized = normalize_claim_evidence(rows);
    if normalized.is_empty() {
        return Err("claim_evidence_required".to_string());
    }
    let mut claims: BTreeSet<String> = BTreeSet::new();
    for row in normalized {
        if row.claim.is_empty() {
            return Err("claim_empty".to_string());
        }
        if row.evidence.is_empty() {
            return Err(format!("claim_missing_evidence:{}", row.claim));
        }
        if row.persona_lenses.is_empty() {
            return Err(format!("claim_missing_persona_lenses:{}", row.claim));
        }
        if !claims.insert(row.claim.clone()) {
            return Err(format!("claim_duplicate:{}", row.claim));
        }
    }
    Ok(())
}

pub fn canonicalize_json(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut sorted: BTreeMap<String, Value> = BTreeMap::new();
            for (key, val) in map {
                sorted.insert(key.clone(), canonicalize_json(val));
            }
            let mut out = Map::new();
            for (key, val) in sorted {
                out.insert(key, val);
            }
            Value::Object(out)
        }
        Value::Array(rows) => Value::Array(rows.iter().map(canonicalize_json).collect()),
        _ => value.clone(),
    }
}

pub fn stable_hash_hex(value: &Value, len: usize) -> String {
    let canonical = canonicalize_json(value);
    let encoded = serde_json::to_string(&canonical).unwrap_or_default();
    let mut hasher = Sha256::new();
    hasher.update(encoded.as_bytes());
    let digest = hasher.finalize();
    let full = hex::encode(digest);
    let keep = len.min(full.len());
    full[..keep].to_string()
}

pub fn build_receipt_row(
    payload: &Value,
    schema_id: &str,
    schema_version: &str,
    artifact_type: &str,
    ts: &str,
    claim_rows: &[ClaimEvidenceRow],
) -> Result<Value, String> {
    validate_claim_evidence(claim_rows)?;
    let normalized_claims = normalize_claim_evidence(claim_rows);
    let mut row = if let Value::Object(obj) = payload {
        obj.clone()
    } else {
        let mut out = Map::new();
        out.insert("payload".to_string(), payload.clone());
        out
    };

    row.insert(
        "schema_id".to_string(),
        Value::String(clean_line(schema_id, 120)),
    );
    row.insert(
        "schema_version".to_string(),
        Value::String(clean_line(schema_version, 40)),
    );
    row.insert(
        "artifact_type".to_string(),
        Value::String(clean_line(artifact_type, 80)),
    );
    row.insert("ts".to_string(), Value::String(clean_line(ts, 64)));
    row.insert(
        "claim_evidence".to_string(),
        serde_json::to_value(&normalized_claims).unwrap_or_else(|_| Value::Array(vec![])),
    );
    let mut lenses = normalized_claims
        .iter()
        .flat_map(|row| row.persona_lenses.clone())
        .collect::<BTreeSet<String>>()
        .into_iter()
        .collect::<Vec<String>>();
    lenses.sort();
    row.insert(
        "persona_lenses".to_string(),
        serde_json::to_value(lenses).unwrap_or_else(|_| Value::Array(vec![])),
    );

    let mut for_hash = row.clone();
    for_hash.remove("receipt_hash");
    for_hash.remove("receipt_deterministic");
    let hash = stable_hash_hex(&Value::Object(for_hash), 24);
    row.insert("receipt_hash".to_string(), Value::String(hash));
    row.insert("receipt_deterministic".to_string(), Value::Bool(true));

    Ok(Value::Object(row))
}

#[cfg(test)]
mod tests {
    use super::{build_receipt_row, stable_hash_hex, validate_claim_evidence, ClaimEvidenceRow};
    use serde_json::json;

    fn sample_claim_rows() -> Vec<ClaimEvidenceRow> {
        vec![ClaimEvidenceRow {
            claim: "selector decision is deterministic".to_string(),
            evidence: vec![
                "state/client/memory/rust_transition/selector.json".to_string(),
                "backend:rust_shadow".to_string(),
            ],
            persona_lenses: vec!["Migration_Guard".to_string(), "operator_safety".to_string()],
        }]
    }

    #[test]
    fn stable_hash_is_independent_of_json_key_order() {
        let left = json!({
            "b": 2,
            "a": 1,
            "nested": { "z": 1, "x": 2 }
        });
        let right = json!({
            "nested": { "x": 2, "z": 1 },
            "a": 1,
            "b": 2
        });
        assert_eq!(stable_hash_hex(&left, 24), stable_hash_hex(&right, 24));
    }

    #[test]
    fn claim_evidence_requires_evidence_and_persona_lenses() {
        let missing_evidence = vec![ClaimEvidenceRow {
            claim: "x".to_string(),
            evidence: vec![],
            persona_lenses: vec!["memory_guard".to_string()],
        }];
        assert!(validate_claim_evidence(&missing_evidence).is_err());

        let missing_lens = vec![ClaimEvidenceRow {
            claim: "x".to_string(),
            evidence: vec!["e1".to_string()],
            persona_lenses: vec![],
        }];
        assert!(validate_claim_evidence(&missing_lens).is_err());
    }

    #[test]
    fn receipt_row_hash_is_deterministic() {
        let payload_a = json!({
            "type": "rust_memory_auto_selector",
            "backend": "rust_shadow",
            "stable_runs": 10,
            "avg_speedup": 1.4
        });
        let payload_b = json!({
            "avg_speedup": 1.4,
            "stable_runs": 10,
            "backend": "rust_shadow",
            "type": "rust_memory_auto_selector"
        });
        let claims = sample_claim_rows();

        let row_a = build_receipt_row(
            &payload_a,
            "rust_memory_transition_receipt",
            "1.0",
            "receipt",
            "2026-03-05T00:00:00Z",
            &claims,
        )
        .expect("receipt row a");
        let row_b = build_receipt_row(
            &payload_b,
            "rust_memory_transition_receipt",
            "1.0",
            "receipt",
            "2026-03-05T00:00:00Z",
            &claims,
        )
        .expect("receipt row b");

        let hash_a = row_a
            .get("receipt_hash")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let hash_b = row_b
            .get("receipt_hash")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        assert_eq!(hash_a, hash_b);
    }
}
