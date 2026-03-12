mod db;
mod rag_runtime;
mod wave1;

use db::{DbIndexEntry, HotStateEnvelopeStats, MemoryDb};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Instant, UNIX_EPOCH};

#[derive(Clone, Debug, Default)]
struct IndexEntry {
    node_id: String,
    uid: String,
    file_rel: String,
    summary: String,
    tags: Vec<String>,
}

#[derive(Serialize)]
struct ProbeResult {
    ok: bool,
    parity_error_count: usize,
    estimated_ms: u64,
}

#[derive(Serialize)]
struct QueryHit {
    node_id: String,
    uid: String,
    file: String,
    summary: String,
    tags: Vec<String>,
    score: i64,
    reasons: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    section_excerpt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    section_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    section_source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expand_blocked: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expand_error: Option<String>,
}

#[derive(Serialize)]
struct QueryResult {
    ok: bool,
    backend: String,
    score_mode: String,
    vector_enabled: bool,
    entries_total: usize,
    candidates_total: usize,
    index_sources: Vec<String>,
    tag_sources: Vec<String>,
    hits: Vec<QueryHit>,
}

#[derive(Serialize)]
struct GetNodeResult {
    ok: bool,
    backend: String,
    node_id: String,
    uid: String,
    file: String,
    summary: String,
    tags: Vec<String>,
    section_hash: String,
    section: String,
}

#[derive(Serialize)]
struct BuildIndexResult {
    ok: bool,
    backend: String,
    node_count: usize,
    tag_count: usize,
    files_scanned: usize,
    wrote_files: bool,
    memory_index_path: String,
    tags_index_path: String,
    memory_index_sha256: String,
    tags_index_sha256: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sqlite_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sqlite_rows_written: Option<usize>,
}

#[derive(Serialize)]
struct VerifyEnvelopeResult {
    ok: bool,
    backend: String,
    db_path: String,
    total_rows: usize,
    enveloped_rows: usize,
    legacy_cipher_rows: usize,
    plain_rows: usize,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct CacheNode {
    mtime_ms: u64,
    section_hash: String,
    section_text: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct WorkingSetCache {
    schema_version: String,
    nodes: HashMap<String, CacheNode>,
}

#[derive(Deserialize)]
struct DaemonRequest {
    cmd: String,
    #[serde(default)]
    args: HashMap<String, String>,
}

fn strip_ticks(s: &str) -> String {
    s.replace('`', "").trim().to_string()
}

fn clean_cell(s: &str) -> String {
    strip_ticks(s.trim())
}

fn normalize_node_id(v: &str) -> String {
    let raw = strip_ticks(v);
    if raw.is_empty() {
        return String::new();
    }
    if raw
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        raw
    } else {
        String::new()
    }
}

fn normalize_uid(v: &str) -> String {
    let raw = strip_ticks(v);
    if raw.is_empty() {
        return String::new();
    }
    if raw.chars().all(|c| c.is_ascii_alphanumeric()) {
        raw
    } else {
        String::new()
    }
}

fn normalize_tag(v: &str) -> String {
    let mut raw = strip_ticks(v).to_lowercase();
    while raw.starts_with('#') {
        raw = raw[1..].to_string();
    }
    raw.chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_' || *c == '-')
        .collect::<String>()
}

fn normalize_header_cell(v: &str) -> String {
    let s = clean_cell(v).to_lowercase();
    let mut norm = String::new();
    let mut prev_underscore = false;
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            norm.push(ch);
            prev_underscore = false;
        } else if !prev_underscore {
            norm.push('_');
            prev_underscore = true;
        }
    }
    let norm = norm.trim_matches('_').to_string();
    if norm.contains("node_id") {
        return "node_id".to_string();
    }
    if norm == "uid" || norm.ends_with("_uid") {
        return "uid".to_string();
    }
    if norm.starts_with("file") {
        return "file".to_string();
    }
    if norm.starts_with("summary") || norm.starts_with("title") {
        return "summary".to_string();
    }
    if norm.starts_with("tags") {
        return "tags".to_string();
    }
    norm
}

fn is_date_memory_file(v: &str) -> bool {
    let bytes = v.as_bytes();
    if bytes.len() != 13 {
        return false;
    }
    for (idx, b) in bytes.iter().enumerate() {
        let is_digit = b.is_ascii_digit();
        match idx {
            4 | 7 => {
                if *b != b'-' {
                    return false;
                }
            }
            10 => {
                if *b != b'.' {
                    return false;
                }
            }
            11 => {
                if *b != b'm' {
                    return false;
                }
            }
            12 => {
                if *b != b'd' {
                    return false;
                }
            }
            _ => {
                if !is_digit {
                    return false;
                }
            }
        }
    }
    true
}

fn normalize_file_ref(v: &str) -> String {
    let mut raw = clean_cell(v)
        .trim_matches('"')
        .trim_matches('\'')
        .to_string();
    if raw.is_empty() {
        return String::new();
    }
    raw = raw.replace('\\', "/");
    while raw.starts_with("./") {
        raw = raw[2..].to_string();
    }
    if raw.starts_with("client/memory/") {
        return raw;
    }
    if is_date_memory_file(&raw) {
        return format!("client/memory/{raw}");
    }
    if raw.starts_with("_archive/") {
        return format!("client/memory/{raw}");
    }
    if raw.ends_with(".md") {
        return raw;
    }
    String::new()
}

fn parse_tag_cell(v: &str) -> Vec<String> {
    let mut set: BTreeSet<String> = BTreeSet::new();
    for token in v.replace(',', " ").split_whitespace() {
        let tag = normalize_tag(token);
        if !tag.is_empty() {
            set.insert(tag);
        }
    }
    set.into_iter().collect::<Vec<String>>()
}

fn parse_table_cells(trimmed: &str) -> Vec<String> {
    let inner = trimmed.trim_matches('|');
    if inner.is_empty() {
        return vec![];
    }
    inner.split('|').map(clean_cell).collect::<Vec<String>>()
}

fn parse_index_file(file_path: &Path) -> Vec<IndexEntry> {
    let Ok(text) = fs::read_to_string(file_path) else {
        return vec![];
    };
    let mut rows: Vec<IndexEntry> = vec![];
    let mut headers: Option<Vec<String>> = None;

    for line in text.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('|') {
            continue;
        }
        let cells = parse_table_cells(trimmed);
        if cells.is_empty() {
            continue;
        }
        if cells
            .iter()
            .all(|c| c.chars().all(|ch| ch == '-' || ch == ':' || ch == ' '))
        {
            continue;
        }

        let normalized = cells
            .iter()
            .map(|c| normalize_header_cell(c))
            .collect::<Vec<String>>();
        if normalized.iter().any(|h| h == "node_id") && normalized.iter().any(|h| h == "file") {
            headers = Some(normalized);
            continue;
        }
        let Some(hdr) = headers.as_ref() else {
            continue;
        };

        let mut row: HashMap<String, String> = HashMap::new();
        for (idx, key) in hdr.iter().enumerate() {
            row.insert(
                key.clone(),
                clean_cell(cells.get(idx).unwrap_or(&String::new())),
            );
        }

        let node_id = normalize_node_id(row.get("node_id").map_or("", String::as_str));
        let file_rel = normalize_file_ref(row.get("file").map_or("", String::as_str));
        if node_id.is_empty() || file_rel.is_empty() {
            continue;
        }
        let uid = normalize_uid(row.get("uid").map_or("", String::as_str));
        let summary = clean_cell(row.get("summary").map_or("", String::as_str));
        let tags = parse_tag_cell(row.get("tags").map_or("", String::as_str));
        rows.push(IndexEntry {
            node_id,
            uid,
            file_rel,
            summary,
            tags,
        });
    }
    rows
}

fn rel_path(root: &Path, p: &Path) -> String {
    p.strip_prefix(root)
        .unwrap_or(p)
        .to_string_lossy()
        .replace('\\', "/")
}

fn dedupe_sorted(mut values: Vec<String>) -> Vec<String> {
    values.sort();
    values.dedup();
    values
}

fn merge_tags(dst: &mut Vec<String>, src: &[String]) {
    let mut set: BTreeSet<String> = dst.iter().cloned().collect::<BTreeSet<String>>();
    for tag in src {
        if !tag.is_empty() {
            set.insert(tag.clone());
        }
    }
    *dst = set.into_iter().collect::<Vec<String>>();
}

fn load_memory_index(root: &Path) -> (Vec<String>, Vec<IndexEntry>) {
    let paths = vec![
        root.join("docs/workspace/MEMORY_INDEX.md"),
        root.join("client/memory/MEMORY_INDEX.md"),
        root.join("memory").join("MEMORY_INDEX.md"),
    ];
    let mut source = vec![];
    let mut merged: HashMap<String, IndexEntry> = HashMap::new();
    for p in paths {
        if !p.exists() {
            continue;
        }
        source.push(rel_path(root, &p));
        for row in parse_index_file(&p) {
            let key = format!("{}@{}", row.node_id, row.file_rel);
            if !merged.contains_key(&key) {
                merged.insert(key.clone(), row);
                continue;
            }
            if let Some(cur) = merged.get_mut(&key) {
                if cur.uid.is_empty() && !row.uid.is_empty() {
                    cur.uid = row.uid.clone();
                }
                if cur.summary.is_empty() && !row.summary.is_empty() {
                    cur.summary = row.summary.clone();
                }
                merge_tags(&mut cur.tags, &row.tags);
            }
        }
    }
    let mut entries = merged.into_values().collect::<Vec<IndexEntry>>();
    entries.sort_by(|a, b| {
        if a.file_rel != b.file_rel {
            return a.file_rel.cmp(&b.file_rel);
        }
        a.node_id.cmp(&b.node_id)
    });
    (source, entries)
}

fn parse_tags_file(file_path: &Path) -> HashMap<String, HashSet<String>> {
    let Ok(text) = fs::read_to_string(file_path) else {
        return HashMap::new();
    };
    let mut out: HashMap<String, HashSet<String>> = HashMap::new();
    let mut current_tag = String::new();
    for line in text.lines() {
        let trimmed = line.trim();

        if let Some(rest) = trimmed.strip_prefix("## ") {
            let mut raw = rest.trim().to_string();
            if raw.starts_with('`') && raw.ends_with('`') && raw.len() >= 2 {
                raw = raw[1..raw.len() - 1].to_string();
            }
            let tag = normalize_tag(&raw);
            current_tag = tag.clone();
            if !tag.is_empty() {
                out.entry(tag).or_default();
            }
            continue;
        }

        if !current_tag.is_empty() {
            if let Some(rest) = trimmed.strip_prefix("- ") {
                let mut raw = rest.trim().to_string();
                if raw.starts_with('`') && raw.ends_with('`') && raw.len() >= 2 {
                    raw = raw[1..raw.len() - 1].to_string();
                }
                let node_id = normalize_node_id(&raw);
                if !node_id.is_empty() {
                    out.entry(current_tag.clone()).or_default().insert(node_id);
                }
                continue;
            }
        }

        if trimmed.starts_with('#') {
            let sep = if trimmed.contains("->") {
                "->"
            } else if trimmed.contains("=>") {
                "=>"
            } else {
                ""
            };
            if !sep.is_empty() {
                let parts = trimmed.splitn(2, sep).collect::<Vec<&str>>();
                if parts.len() == 2 {
                    let tag = normalize_tag(parts[0]);
                    if !tag.is_empty() {
                        let entry = out.entry(tag).or_default();
                        for candidate in parts[1].split(',') {
                            let node_id = normalize_node_id(candidate);
                            if !node_id.is_empty() {
                                entry.insert(node_id);
                            }
                        }
                    }
                }
            }
        }
    }
    out
}

fn load_tags_index(root: &Path) -> (Vec<String>, HashMap<String, HashSet<String>>) {
    let paths = vec![
        root.join("docs/workspace/TAGS_INDEX.md"),
        root.join("client/memory/TAGS_INDEX.md"),
        root.join("memory").join("TAGS_INDEX.md"),
    ];
    let mut source = vec![];
    let mut out: HashMap<String, HashSet<String>> = HashMap::new();
    for p in paths {
        if !p.exists() {
            continue;
        }
        source.push(rel_path(root, &p));
        let parsed = parse_tags_file(&p);
        for (tag, ids) in parsed {
            let entry = out.entry(tag).or_default();
            for id in ids {
                entry.insert(id);
            }
        }
    }
    (source, out)
}

fn tokenize(v: &str) -> Vec<String> {
    let mut normalized = String::with_capacity(v.len());
    for ch in v.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch.is_ascii_whitespace() {
            normalized.push(ch);
        } else {
            normalized.push(' ');
        }
    }
    let mut out = normalized
        .split_whitespace()
        .filter(|token| token.len() >= 2)
        .map(|token| token.to_string())
        .collect::<Vec<String>>();
    out = dedupe_sorted(out);
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

fn hash_token_slot(token: &str, salt: u64, dims: usize) -> usize {
    let mut hasher = DefaultHasher::new();
    token.hash(&mut hasher);
    salt.hash(&mut hasher);
    (hasher.finish() as usize) % dims.max(1)
}

fn vectorize_text(text: &str, dims: usize) -> Vec<f32> {
    if dims == 0 {
        return vec![];
    }
    let mut vec = vec![0.0f32; dims];
    let tokens = tokenize(text);
    if tokens.is_empty() {
        return vec;
    }
    for token in tokens {
        let idx = hash_token_slot(&token, 0, dims);
        let sign_idx = hash_token_slot(&token, 1, dims);
        let sign = if sign_idx.is_multiple_of(2) {
            1.0f32
        } else {
            -1.0f32
        };
        let weight = 1.0f32 + ((token.len().min(24) as f32) / 24.0f32);
        vec[idx] += sign * weight;
    }
    normalize_vector(&vec)
}

fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let len = a.len().min(b.len());
    if len == 0 {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for i in 0..len {
        dot += a[i] * b[i];
        norm_a += a[i] * a[i];
        norm_b += b[i] * b[i];
    }
    if norm_a <= 0.0 || norm_b <= 0.0 {
        return 0.0;
    }
    dot / (norm_a.sqrt() * norm_b.sqrt())
}

fn embedding_text_for_entry(entry: &IndexEntry) -> String {
    format!(
        "{} {} {} {}",
        entry.node_id,
        entry.uid,
        entry.summary,
        entry.tags.join(" ")
    )
}

fn build_entry_embedding(entry: &IndexEntry, dims: usize) -> Vec<f32> {
    vectorize_text(&embedding_text_for_entry(entry), dims)
}

fn parse_tag_filters(raw: &str) -> Vec<String> {
    let mut out = vec![];
    for token in raw.split(',') {
        let tag = normalize_tag(token);
        if !tag.is_empty() {
            out.push(tag);
        }
    }
    dedupe_sorted(out)
}

fn score_entry(
    entry: &IndexEntry,
    query_tokens: &[String],
    tag_filters: &[String],
    tag_node_ids: &HashSet<String>,
) -> (i64, Vec<String>) {
    let mut score: i64 = 0;
    let mut reasons: BTreeSet<String> = BTreeSet::new();

    if !tag_filters.is_empty() {
        let overlap = entry
            .tags
            .iter()
            .filter(|t| tag_filters.contains(t))
            .count() as i64;
        if overlap > 0 {
            score += overlap * 6;
            reasons.insert("tag_match".to_string());
        }
        if tag_node_ids.contains(&entry.node_id) {
            score += 4;
            reasons.insert("tag_index_match".to_string());
        }
    }

    let node_lower = entry.node_id.to_lowercase();
    let summary_lower = entry.summary.to_lowercase();
    let tags_lower = entry.tags.join(" ").to_lowercase();
    let file_lower = entry.file_rel.to_lowercase();
    for tok in query_tokens {
        if node_lower == *tok {
            score += 8;
        } else if node_lower.contains(tok) {
            score += 4;
        }
        if summary_lower.contains(tok) {
            score += 3;
        }
        if tags_lower.contains(tok) {
            score += 2;
        }
        if file_lower.contains(tok) {
            score += 1;
        }
    }
    if !query_tokens.is_empty() && score > 0 {
        reasons.insert("query_match".to_string());
    }
    (score, reasons.into_iter().collect::<Vec<String>>())
}

fn parse_top(raw: &str) -> usize {
    let parsed = raw.parse::<usize>().unwrap_or(5);
    parsed.clamp(1, 50)
}

fn parse_clamped_usize(raw: &str, min: usize, max: usize, fallback: usize) -> usize {
    let parsed = raw.parse::<usize>().unwrap_or(fallback);
    parsed.clamp(min, max)
}

fn excerpt_lines(text: &str, lines: usize) -> String {
    if lines == 0 {
        return String::new();
    }
    text.lines().take(lines).collect::<Vec<&str>>().join("\n")
}

fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    hex::encode(hasher.finalize())
}

#[derive(Default)]
struct RuntimeIndexBundle {
    index_sources: Vec<String>,
    tag_sources: Vec<String>,
    entries: Vec<IndexEntry>,
    tag_map: HashMap<String, HashSet<String>>,
    embeddings: HashMap<String, Vec<f32>>,
    sqlite_path: Option<String>,
    sqlite_sync_rows: usize,
    sqlite_sync_applied: bool,
}

fn dedupe_tags(tags: &[String]) -> Vec<String> {
    let mut out = tags
        .iter()
        .map(|tag| normalize_tag(tag))
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<String>>();
    out.sort();
    out.dedup();
    out
}

fn to_db_index_entry(entry: &IndexEntry) -> DbIndexEntry {
    DbIndexEntry {
        node_id: entry.node_id.clone(),
        uid: entry.uid.clone(),
        file_rel: entry.file_rel.clone(),
        summary: entry.summary.clone(),
        tags: dedupe_tags(&entry.tags),
    }
}

fn from_db_index_entry(entry: &DbIndexEntry) -> IndexEntry {
    IndexEntry {
        node_id: entry.node_id.clone(),
        uid: entry.uid.clone(),
        file_rel: entry.file_rel.clone(),
        summary: entry.summary.clone(),
        tags: dedupe_tags(&entry.tags),
    }
}

fn build_tag_map_from_entries(entries: &[IndexEntry]) -> HashMap<String, HashSet<String>> {
    let mut out: HashMap<String, HashSet<String>> = HashMap::new();
    for entry in entries {
        for raw_tag in &entry.tags {
            let tag = normalize_tag(raw_tag);
            if tag.is_empty() {
                continue;
            }
            out.entry(tag).or_default().insert(entry.node_id.clone());
        }
    }
    out
}

fn build_embedding_map_from_entries(
    entries: &[IndexEntry],
    dims: usize,
) -> HashMap<String, Vec<f32>> {
    let mut out = HashMap::new();
    for entry in entries {
        let vector = build_entry_embedding(entry, dims);
        if vector.is_empty() {
            continue;
        }
        out.insert(entry.node_id.clone(), vector);
    }
    out
}

fn daily_scan_signature(root: &Path) -> String {
    let memory_dir = root.join("memory");
    let Ok(entries) = fs::read_dir(&memory_dir) else {
        return String::new();
    };
    let mut rows: Vec<String> = vec![];
    for item in entries.flatten() {
        let name = item.file_name().to_string_lossy().to_string();
        if !is_date_memory_file(&name) {
            continue;
        }
        let file_path = memory_dir.join(&name);
        if let Ok(meta) = fs::metadata(&file_path) {
            let modified = meta
                .modified()
                .ok()
                .and_then(|v| v.duration_since(UNIX_EPOCH).ok())
                .map(|dur| dur.as_millis())
                .unwrap_or(0);
            rows.push(format!("{name}:{}:{modified}", meta.len()));
        }
    }
    if rows.is_empty() {
        return String::new();
    }
    rows.sort();
    sha256_hex(&rows.join("|"))
}

fn sanitize_event_token(raw: &str) -> String {
    let mut out = raw
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' || ch == '.' {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    while out.contains("__") {
        out = out.replace("__", "_");
    }
    out.trim_matches('_').to_string()
}

fn publish_memory_event(root: &Path, event: &str, payload: serde_json::Value) {
    let event_id = sanitize_event_token(event);
    if event_id.is_empty() {
        return;
    }
    let script = root
        .join("systems")
        .join("ops")
        .join("event_sourced_control_plane.js");
    if !script.exists() {
        return;
    }
    let payload_arg = format!("--payload_json={payload}");
    let _ = Command::new("node")
        .arg(script)
        .arg("append")
        .arg("--stream=memory")
        .arg(format!("--event={event_id}"))
        .arg(payload_arg)
        .current_dir(root)
        .output();
}

type RuntimeIndexSyncResult = (Vec<String>, Vec<String>, usize, bool, String);

fn sync_sqlite_runtime_index(
    root: &Path,
    db: &mut MemoryDb,
) -> Result<RuntimeIndexSyncResult, String> {
    let signature = daily_scan_signature(root);
    let previous = db
        .get_hot_state_json("daily_scan_signature")?
        .and_then(|value| value.as_str().map(|v| v.to_string()))
        .unwrap_or_default();
    let existing_rows = db.count_index_rows()?;
    if existing_rows > 0 && !signature.is_empty() && signature == previous {
        return Ok((
            vec!["daily_scan:unchanged".to_string()],
            vec!["daily_scan:unchanged".to_string()],
            existing_rows,
            false,
            signature,
        ));
    }

    let (entries, files_scanned) = scan_daily_entries(root);
    let index_sources = vec![format!("daily_scan:{files_scanned}_files")];
    let tag_sources = vec!["daily_scan:frontmatter_tags".to_string()];
    let db_entries = entries
        .iter()
        .map(to_db_index_entry)
        .collect::<Vec<DbIndexEntry>>();
    let inserted = db.replace_index_entries(&db_entries, "daily_scan_authority")?;
    let embedding_rows = entries
        .iter()
        .map(|entry| {
            (
                entry.node_id.clone(),
                build_entry_embedding(entry, 64),
                json!({
                    "node_id": entry.node_id,
                    "source": "daily_scan_authority",
                    "tags": entry.tags
                }),
            )
        })
        .collect::<Vec<(String, Vec<f32>, serde_json::Value)>>();
    let embedding_written = db.replace_embeddings(&embedding_rows, "daily_scan_authority")?;
    let _ = db.set_hot_state_json("daily_scan_signature", &json!(signature));
    let _ = db.set_hot_state_json("index_row_count", &json!(inserted));
    let _ = db.set_hot_state_json("embedding_row_count", &json!(embedding_written));
    let _ = db.set_hot_state_json("index_sync_source", &json!("daily_scan_authority"));
    let _ = db.set_hot_state_json("index_files_scanned", &json!(files_scanned));
    Ok((index_sources, tag_sources, inserted, true, signature))
}

fn load_runtime_index(root: &Path, args: &HashMap<String, String>) -> RuntimeIndexBundle {
    let mut out = RuntimeIndexBundle::default();
    let db_path = arg_any(args, &["db-path", "db_path"]);
    if let Ok(mut db) = MemoryDb::open(root, &db_path) {
        out.sqlite_path = Some(db.rel_db_path(root));
        match sync_sqlite_runtime_index(root, &mut db) {
            Ok((idx_sources, tag_sources, row_count, wrote, signature)) => {
                out.sqlite_sync_rows = row_count;
                out.sqlite_sync_applied = wrote;
                if wrote {
                    publish_memory_event(
                        root,
                        "rust_memory_index_sync",
                        json!({
                            "ok": true,
                            "row_count": row_count,
                            "signature": signature,
                            "sqlite_path": out.sqlite_path.clone().unwrap_or_default(),
                            "index_sources": idx_sources,
                            "tag_sources": tag_sources
                        }),
                    );
                }
            }
            Err(sync_error) => {
                publish_memory_event(
                    root,
                    "rust_memory_index_sync_error",
                    json!({
                        "ok": false,
                        "error": sync_error
                    }),
                );
            }
        }
        if let Ok(db_rows) = db.load_index_entries() {
            if !db_rows.is_empty() {
                out.entries = db_rows
                    .iter()
                    .map(from_db_index_entry)
                    .collect::<Vec<IndexEntry>>();
                let sqlite_path = out
                    .sqlite_path
                    .clone()
                    .unwrap_or_else(|| "sqlite".to_string());
                out.index_sources = vec![format!("sqlite:{sqlite_path}")];
                out.tag_map = build_tag_map_from_entries(&out.entries);
                out.tag_sources = vec![format!("sqlite:{sqlite_path}")];
                out.embeddings = db
                    .load_embedding_map()
                    .unwrap_or_else(|_| build_embedding_map_from_entries(&out.entries, 64));
                return out;
            }
        }
    }

    let (entries, files_scanned) = scan_daily_entries(root);
    if !entries.is_empty() {
        out.index_sources = vec![format!("daily_scan_fallback:{files_scanned}_files")];
        out.tag_map = build_tag_map_from_entries(&entries);
        out.tag_sources = vec!["daily_scan_fallback:frontmatter_tags".to_string()];
        out.entries = entries;
        out.embeddings = build_embedding_map_from_entries(&out.entries, 64);
        return out;
    }

    let (index_sources, entries) = load_memory_index(root);
    let (tag_sources, tag_map) = load_tags_index(root);
    out.index_sources = index_sources;
    out.tag_sources = tag_sources;
    out.entries = entries;
    out.tag_map = tag_map;
    out.embeddings = build_embedding_map_from_entries(&out.entries, 64);
    out
}

fn file_mtime_ms(file_path: &Path) -> Option<u64> {
    let metadata = fs::metadata(file_path).ok()?;
    let modified = metadata.modified().ok()?;
    let dur = modified.duration_since(UNIX_EPOCH).ok()?;
    Some(dur.as_millis() as u64)
}

fn parse_cache_max_bytes(raw: &str) -> usize {
    parse_clamped_usize(raw, 65536, 16 * 1024 * 1024, 1024 * 1024)
}

fn load_working_set_cache(cache_path: &str) -> WorkingSetCache {
    if cache_path.is_empty() {
        return WorkingSetCache {
            schema_version: "1.0".to_string(),
            nodes: HashMap::new(),
        };
    }
    let p = PathBuf::from(cache_path);
    let Ok(text) = fs::read_to_string(&p) else {
        return WorkingSetCache {
            schema_version: "1.0".to_string(),
            nodes: HashMap::new(),
        };
    };
    let parsed = serde_json::from_str::<WorkingSetCache>(&text).ok();
    let mut out = parsed.unwrap_or(WorkingSetCache {
        schema_version: "1.0".to_string(),
        nodes: HashMap::new(),
    });
    if out.schema_version.is_empty() {
        out.schema_version = "1.0".to_string();
    }
    out
}

fn cache_size_bytes(cache: &WorkingSetCache) -> usize {
    serde_json::to_vec(cache)
        .map(|bytes| bytes.len())
        .unwrap_or(0)
}

fn prune_working_set_cache(cache: &mut WorkingSetCache, max_bytes: usize) {
    if cache_size_bytes(cache) <= max_bytes {
        return;
    }
    let mut keys = cache.nodes.keys().cloned().collect::<Vec<String>>();
    keys.sort();
    for key in keys {
        if cache_size_bytes(cache) <= max_bytes {
            break;
        }
        cache.nodes.remove(&key);
    }
}

fn save_working_set_cache(cache_path: &str, cache: &mut WorkingSetCache, max_bytes: usize) {
    if cache_path.is_empty() {
        return;
    }
    prune_working_set_cache(cache, max_bytes);
    let p = PathBuf::from(cache_path);
    if let Some(parent) = p.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(body) = serde_json::to_string_pretty(cache) {
        let _ = fs::write(p, format!("{body}\n"));
    }
}

fn cache_key(node_id: &str, file_rel: &str) -> String {
    format!("{node_id}@{file_rel}")
}

fn load_section_cached(
    root: &Path,
    file_rel: &str,
    node_id: &str,
    mut cache: Option<&mut WorkingSetCache>,
) -> Result<(String, String), String> {
    let file_abs = root.join(file_rel);
    let mtime = file_mtime_ms(&file_abs).ok_or_else(|| "file_read_failed".to_string())?;
    let key = cache_key(node_id, file_rel);

    if let Some(cache_ref) = cache.as_mut() {
        if let Some(entry) = cache_ref.nodes.get(&key) {
            if entry.mtime_ms == mtime && !entry.section_text.is_empty() {
                return Ok((entry.section_text.clone(), entry.section_hash.clone()));
            }
        }
    }

    let content = fs::read_to_string(&file_abs).map_err(|_| "file_read_failed".to_string())?;
    let section = extract_node_section(&content, node_id);
    if section.is_empty() {
        return Err("node_not_found".to_string());
    }
    let section_hash = sha256_hex(&section);

    if let Some(cache_ref) = cache.as_mut() {
        cache_ref.nodes.insert(
            key,
            CacheNode {
                mtime_ms: mtime,
                section_hash: section_hash.clone(),
                section_text: section.clone(),
            },
        );
    }

    Ok((section, section_hash))
}

fn parse_kv_args(args: &[String]) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let mut idx = 0usize;
    while idx < args.len() {
        let token = args[idx].to_string();
        if !token.starts_with("--") {
            idx += 1;
            continue;
        }
        let raw = token.trim_start_matches("--").to_string();
        if let Some(eq_idx) = raw.find('=') {
            let key = raw[..eq_idx].to_string();
            let value = raw[eq_idx + 1..].to_string();
            out.insert(key, value);
            idx += 1;
            continue;
        }
        let key = raw;
        if idx + 1 < args.len() && !args[idx + 1].starts_with("--") {
            out.insert(key, args[idx + 1].to_string());
            idx += 2;
            continue;
        }
        out.insert(key, "true".to_string());
        idx += 1;
    }
    out
}

fn arg_or_default(args: &HashMap<String, String>, key: &str, fallback: &str) -> String {
    args.get(key)
        .cloned()
        .unwrap_or_else(|| fallback.to_string())
}

fn arg_any(args: &HashMap<String, String>, keys: &[&str]) -> String {
    for key in keys {
        if let Some(v) = args.get(*key) {
            return v.clone();
        }
    }
    String::new()
}

fn extract_date_from_path(path_value: &str) -> String {
    let chars = path_value.chars().collect::<Vec<char>>();
    if chars.len() < 10 {
        return String::new();
    }
    for idx in 0..=(chars.len() - 10) {
        let mut ok = true;
        for off in 0..10 {
            let ch = chars[idx + off];
            let expected_dash = off == 4 || off == 7;
            if expected_dash {
                if ch != '-' {
                    ok = false;
                    break;
                }
            } else if !ch.is_ascii_digit() {
                ok = false;
                break;
            }
        }
        if ok {
            return chars[idx..idx + 10].iter().collect::<String>();
        }
    }
    String::new()
}

fn node_id_from_chunk(chunk: &str) -> String {
    for line in chunk.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("node_id:") {
            let normalized = normalize_node_id(rest);
            if !normalized.is_empty() {
                return normalized;
            }
        }
    }
    String::new()
}

fn extract_node_section(file_content: &str, node_id: &str) -> String {
    for chunk in file_content.split("<!-- NODE -->") {
        let detected = node_id_from_chunk(chunk);
        if !detected.is_empty() && detected == node_id {
            return chunk.trim().to_string();
        }
    }
    String::new()
}

fn parse_bool_flag(raw: &str) -> bool {
    matches!(
        raw.trim().to_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn sanitize_table_cell(v: &str) -> String {
    v.replace(['\n', '\r'], " ")
        .replace('|', "/")
        .trim()
        .to_string()
}

fn extract_uid_from_chunk(chunk: &str) -> String {
    for line in chunk.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("uid:") {
            let uid = normalize_uid(rest);
            if !uid.is_empty() {
                return uid;
            }
        }
    }
    String::new()
}

fn parse_tags_line(raw: &str) -> Vec<String> {
    let mut body = raw.trim().to_string();
    if body.starts_with('[') && body.ends_with(']') && body.len() >= 2 {
        body = body[1..body.len() - 1].to_string();
    }
    body = body.replace(['[', ']', '"', '\''], " ");
    let mut set: BTreeSet<String> = BTreeSet::new();
    for token in body.replace(',', " ").split_whitespace() {
        let tag = normalize_tag(token);
        if !tag.is_empty() {
            set.insert(tag);
        }
    }
    set.into_iter().collect::<Vec<String>>()
}

fn extract_tags_from_chunk(chunk: &str) -> Vec<String> {
    for line in chunk.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("tags:") {
            return parse_tags_line(rest);
        }
    }
    vec![]
}

fn extract_summary_from_chunk(chunk: &str, node_id: &str) -> String {
    for line in chunk.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("# ") {
            let summary = sanitize_table_cell(rest);
            if !summary.is_empty() {
                return summary;
            }
        }
    }
    sanitize_table_cell(node_id)
}

fn scan_daily_entries(root: &Path) -> (Vec<IndexEntry>, usize) {
    let memory_dir = root.join("memory");
    let Ok(entries) = fs::read_dir(&memory_dir) else {
        return (vec![], 0);
    };

    let mut files: Vec<String> = vec![];
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().to_string();
        if !is_date_memory_file(&file_name) {
            continue;
        }
        files.push(file_name);
    }
    files.sort();

    let mut out: Vec<IndexEntry> = vec![];
    let mut seen: HashSet<String> = HashSet::new();
    let mut files_scanned = 0usize;
    for file_name in files {
        files_scanned += 1;
        let file_abs = memory_dir.join(&file_name);
        let Ok(content) = fs::read_to_string(&file_abs) else {
            continue;
        };
        let file_rel = format!("client/memory/{file_name}");
        for chunk in content.split("<!-- NODE -->") {
            let node_id = node_id_from_chunk(chunk);
            if node_id.is_empty() {
                continue;
            }
            let key = format!("{node_id}@{file_rel}");
            if seen.contains(&key) {
                continue;
            }
            seen.insert(key);
            out.push(IndexEntry {
                node_id: node_id.clone(),
                uid: extract_uid_from_chunk(chunk),
                file_rel: file_rel.clone(),
                summary: extract_summary_from_chunk(chunk, &node_id),
                tags: extract_tags_from_chunk(chunk),
            });
        }
    }

    out.sort_by(|a, b| {
        if a.file_rel != b.file_rel {
            return a.file_rel.cmp(&b.file_rel);
        }
        a.node_id.cmp(&b.node_id)
    });
    (out, files_scanned)
}

fn build_memory_index_doc(entries: &[IndexEntry]) -> String {
    let mut lines: Vec<String> = vec![
        "# MEMORY_INDEX.md".to_string(),
        "# Generated by protheus-memory-core build-index".to_string(),
        "".to_string(),
        "| node_id | uid | tags | file | summary |".to_string(),
        "|---|---|---|---|---|".to_string(),
    ];

    if entries.is_empty() {
        lines.push("| | | | | |".to_string());
        return lines.join("\n");
    }

    for entry in entries {
        let tags = entry
            .tags
            .iter()
            .map(|tag| format!("#{tag}"))
            .collect::<Vec<String>>()
            .join(" ");
        lines.push(format!(
            "| `{}` | `{}` | {} | `{}` | {} |",
            sanitize_table_cell(&entry.node_id),
            sanitize_table_cell(&entry.uid),
            sanitize_table_cell(&tags),
            sanitize_table_cell(&entry.file_rel),
            sanitize_table_cell(&entry.summary)
        ));
    }
    lines.join("\n")
}

fn build_tags_index_doc(entries: &[IndexEntry]) -> (String, usize) {
    let mut tags: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for entry in entries {
        for tag in &entry.tags {
            if tag.is_empty() {
                continue;
            }
            tags.entry(tag.clone())
                .or_default()
                .insert(entry.node_id.clone());
        }
    }

    let mut lines: Vec<String> = vec![
        "# TAGS_INDEX.md".to_string(),
        "# Generated by protheus-memory-core build-index".to_string(),
        "".to_string(),
    ];
    for (tag, node_ids) in &tags {
        lines.push(format!("## `{}`", sanitize_table_cell(tag)));
        for node_id in node_ids {
            lines.push(format!("- `{}`", sanitize_table_cell(node_id)));
        }
        lines.push(String::new());
    }
    (lines.join("\n"), tags.len())
}

fn sort_entries_for_get(entries: &mut [IndexEntry]) {
    entries.sort_by(|a, b| {
        let da = extract_date_from_path(&a.file_rel);
        let db = extract_date_from_path(&b.file_rel);
        if db != da {
            return db.cmp(&da);
        }
        let aa = if a.file_rel.contains("/_archive/") {
            1
        } else {
            0
        };
        let bb = if b.file_rel.contains("/_archive/") {
            1
        } else {
            0
        };
        if aa != bb {
            return aa.cmp(&bb);
        }
        let node_cmp = a.node_id.cmp(&b.node_id);
        if node_cmp != Ordering::Equal {
            return node_cmp;
        }
        a.file_rel.cmp(&b.file_rel)
    });
}

fn detect_default_root() -> PathBuf {
    let cwd = env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    cwd.join("../../..")
        .canonicalize()
        .unwrap_or_else(|_| cwd.clone())
}

fn run_probe(args: &HashMap<String, String>) {
    let root = PathBuf::from(arg_or_default(
        args,
        "root",
        detect_default_root().to_string_lossy().as_ref(),
    ));
    let started = Instant::now();
    let (_source, entries) = load_memory_index(&root);
    let elapsed_ms = started.elapsed().as_millis() as u64;
    let result = ProbeResult {
        ok: true,
        parity_error_count: 0,
        estimated_ms: elapsed_ms.max(1),
    };
    let _ = entries;
    let out = serde_json::to_string(&result).expect("serialize probe result");
    println!("{}", out);
}

fn query_index_payload(args: &HashMap<String, String>) -> QueryResult {
    let root = PathBuf::from(arg_or_default(args, "root", "."));
    let q = arg_or_default(args, "q", "");
    let top = parse_top(arg_or_default(args, "top", "5").as_str());
    let tag_filters = parse_tag_filters(&arg_or_default(args, "tags", ""));
    let cache_path = arg_or_default(args, "cache-path", "");
    let cache_max_bytes = parse_cache_max_bytes(&arg_or_default(args, "cache-max-bytes", ""));
    let mut cache = if cache_path.is_empty() {
        None
    } else {
        Some(load_working_set_cache(&cache_path))
    };
    let expand_lines = parse_clamped_usize(
        &arg_any(args, &["expand-lines", "excerpt-lines"]),
        0,
        300,
        0,
    );
    let max_files = parse_clamped_usize(&arg_any(args, &["max-files", "max_files"]), 1, 20, 1);

    let runtime_index = load_runtime_index(&root, args);
    let index_sources = runtime_index.index_sources;
    let tag_sources = runtime_index.tag_sources;
    let entries = runtime_index.entries;
    let tag_map = runtime_index.tag_map;
    let embeddings = runtime_index.embeddings;
    let score_mode_raw = arg_any(args, &["score-mode", "score_mode"]).to_lowercase();
    let score_mode = score_mode_raw
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || *ch == '_' || *ch == '-')
        .collect::<String>();
    let vector_enabled = score_mode != "lexical";
    let query_vector = if vector_enabled {
        vectorize_text(&format!("{} {}", q, tag_filters.join(" ")), 64)
    } else {
        vec![]
    };

    let mut tag_node_ids: HashSet<String> = HashSet::new();
    for tag in &tag_filters {
        if let Some(ids) = tag_map.get(tag) {
            for id in ids {
                tag_node_ids.insert(id.clone());
            }
        }
    }

    let mut candidates = entries.clone();
    if !tag_filters.is_empty() && !tag_node_ids.is_empty() {
        candidates = candidates
            .into_iter()
            .filter(|entry| tag_node_ids.contains(&entry.node_id))
            .collect::<Vec<IndexEntry>>();
    }

    let query_tokens = tokenize(&q);
    let mut scored = candidates
        .iter()
        .map(|entry| {
            let (lexical_score, mut reasons) =
                score_entry(entry, &query_tokens, &tag_filters, &tag_node_ids);
            let vector_score = if vector_enabled {
                if let Some(entry_vector) = embeddings.get(&entry.node_id) {
                    let similarity = cosine_similarity(&query_vector, entry_vector);
                    if similarity > 0.0 {
                        if !reasons.iter().any(|reason| reason == "vector_similarity") {
                            reasons.push("vector_similarity".to_string());
                        }
                        (similarity * 1000.0).round() as i64
                    } else {
                        0
                    }
                } else {
                    0
                }
            } else {
                0
            };
            let fused_score = if vector_enabled {
                lexical_score
                    .saturating_mul(1000)
                    .saturating_add(vector_score)
            } else {
                lexical_score
            };
            (entry, fused_score, reasons)
        })
        .collect::<Vec<(&IndexEntry, i64, Vec<String>)>>();

    scored.sort_by(|a, b| {
        if b.1 != a.1 {
            return b.1.cmp(&a.1);
        }
        if a.0.file_rel != b.0.file_rel {
            return a.0.file_rel.cmp(&b.0.file_rel);
        }
        a.0.node_id.cmp(&b.0.node_id)
    });

    let mut hits = scored
        .into_iter()
        .take(top)
        .map(|(entry, score, reasons)| QueryHit {
            node_id: entry.node_id.clone(),
            uid: entry.uid.clone(),
            file: entry.file_rel.clone(),
            summary: entry.summary.clone(),
            tags: dedupe_sorted(entry.tags.clone()),
            score,
            reasons,
            section_excerpt: None,
            section_hash: None,
            section_source: None,
            expand_blocked: None,
            expand_error: None,
        })
        .collect::<Vec<QueryHit>>();

    if expand_lines > 0 {
        let mut file_order = hits
            .iter()
            .map(|hit| hit.file.clone())
            .collect::<Vec<String>>();
        file_order = dedupe_sorted(file_order);
        let allowed_files = file_order
            .into_iter()
            .take(max_files)
            .collect::<HashSet<String>>();
        let mut file_cache: HashMap<String, String> = HashMap::new();

        for hit in hits.iter_mut() {
            if !allowed_files.contains(&hit.file) {
                hit.expand_blocked = Some("file_budget".to_string());
                continue;
            }
            let section_pair = if cache.is_some() {
                load_section_cached(&root, &hit.file, &hit.node_id, cache.as_mut())
            } else {
                let content = if let Some(cached) = file_cache.get(&hit.file) {
                    cached.clone()
                } else {
                    let file_abs = root.join(&hit.file);
                    match fs::read_to_string(&file_abs) {
                        Ok(text) => {
                            file_cache.insert(hit.file.clone(), text.clone());
                            text
                        }
                        Err(_) => {
                            hit.expand_error = Some("file_read_failed".to_string());
                            continue;
                        }
                    }
                };
                let section = extract_node_section(&content, &hit.node_id);
                if section.is_empty() {
                    Err("node_not_found".to_string())
                } else {
                    Ok((section.clone(), sha256_hex(&section)))
                }
            };
            match section_pair {
                Ok((section, section_hash)) => {
                    hit.section_source = Some("rust".to_string());
                    hit.section_hash = Some(section_hash);
                    hit.section_excerpt = Some(excerpt_lines(&section, expand_lines));
                }
                Err(reason) => {
                    hit.expand_error = Some(reason);
                }
            }
        }
    }

    if let Some(ref mut cache_ref) = cache {
        save_working_set_cache(&cache_path, cache_ref, cache_max_bytes);
    }

    QueryResult {
        ok: true,
        backend: "protheus_memory_core".to_string(),
        score_mode: if vector_enabled {
            "hybrid".to_string()
        } else {
            "lexical".to_string()
        },
        vector_enabled,
        entries_total: entries.len(),
        candidates_total: candidates.len(),
        index_sources,
        tag_sources,
        hits,
    }
}

fn run_query_index(args: &HashMap<String, String>) {
    let out = query_index_payload(args);
    println!(
        "{}",
        serde_json::to_string(&out).expect("serialize query result")
    );
}

fn get_node_payload(args: &HashMap<String, String>) -> (serde_json::Value, i32) {
    let root = PathBuf::from(arg_or_default(args, "root", "."));
    let node_id = normalize_node_id(&arg_any(args, &["node-id", "node_id"]));
    let uid = normalize_uid(&arg_or_default(args, "uid", ""));
    let file_filter = normalize_file_ref(&arg_or_default(args, "file", ""));
    let cache_path = arg_or_default(args, "cache-path", "");
    let cache_max_bytes = parse_cache_max_bytes(&arg_or_default(args, "cache-max-bytes", ""));
    let mut cache = if cache_path.is_empty() {
        None
    } else {
        Some(load_working_set_cache(&cache_path))
    };

    if node_id.is_empty() && uid.is_empty() {
        return (
            json!({
                "ok": false,
                "error": "missing --node-id=<id> or --uid=<alnum_uid>"
            }),
            2,
        );
    }

    let runtime_index = load_runtime_index(&root, args);
    let mut matches = runtime_index
        .entries
        .into_iter()
        .filter(|entry| {
            if !uid.is_empty() && entry.uid != uid {
                return false;
            }
            if !node_id.is_empty() && entry.node_id != node_id {
                return false;
            }
            if !file_filter.is_empty() && entry.file_rel != file_filter {
                return false;
            }
            true
        })
        .collect::<Vec<IndexEntry>>();

    sort_entries_for_get(&mut matches);
    let Some(entry) = matches.first() else {
        return (
            json!({
                "ok": false,
                "error": "node_not_found",
                "node_id": if node_id.is_empty() { serde_json::Value::Null } else { json!(node_id) },
                "uid": if uid.is_empty() { serde_json::Value::Null } else { json!(uid) },
                "file": if file_filter.is_empty() { serde_json::Value::Null } else { json!(file_filter) }
            }),
            1,
        );
    };

    let section_pair = load_section_cached(&root, &entry.file_rel, &entry.node_id, cache.as_mut());
    let (section, section_hash) = match section_pair {
        Ok(pair) => pair,
        Err(reason) => {
            let mapped = if reason == "file_read_failed" {
                json!({
                    "ok": false,
                    "error": "file_read_failed",
                    "file": entry.file_rel
                })
            } else {
                json!({
                    "ok": false,
                    "error": "node_not_found",
                    "node_id": entry.node_id,
                    "file": entry.file_rel
                })
            };
            return (mapped, 1);
        }
    };

    if let Some(ref mut cache_ref) = cache {
        save_working_set_cache(&cache_path, cache_ref, cache_max_bytes);
    }

    if section.is_empty() {
        return (
            json!({
                "ok": false,
                "error": "node_not_found",
                "node_id": entry.node_id,
                "file": entry.file_rel
            }),
            1,
        );
    }

    let out = GetNodeResult {
        ok: true,
        backend: "protheus_memory_core".to_string(),
        node_id: entry.node_id.clone(),
        uid: entry.uid.clone(),
        file: entry.file_rel.clone(),
        summary: entry.summary.clone(),
        tags: dedupe_sorted(entry.tags.clone()),
        section_hash,
        section,
    };
    (
        serde_json::to_value(&out).expect("serialize get-node value"),
        0,
    )
}

fn run_get_node(args: &HashMap<String, String>) {
    let (payload, status_code) = get_node_payload(args);
    println!(
        "{}",
        serde_json::to_string(&payload).expect("serialize get-node payload")
    );
    if status_code != 0 {
        std::process::exit(status_code);
    }
}

fn build_index_payload(args: &HashMap<String, String>) -> BuildIndexResult {
    let root = PathBuf::from(arg_or_default(args, "root", "."));
    let write = parse_bool_flag(&arg_any(args, &["write", "save", "apply"]));
    let memory_index_path_raw = arg_any(args, &["memory-index-path", "memory_index_path"]);
    let tags_index_path_raw = arg_any(args, &["tags-index-path", "tags_index_path"]);

    let memory_index_abs = if memory_index_path_raw.is_empty() {
        root.join("client/memory/MEMORY_INDEX.md")
    } else {
        let p = PathBuf::from(memory_index_path_raw.clone());
        if p.is_absolute() {
            p
        } else {
            root.join(p)
        }
    };
    let tags_index_abs = if tags_index_path_raw.is_empty() {
        root.join("client/memory/TAGS_INDEX.md")
    } else {
        let p = PathBuf::from(tags_index_path_raw.clone());
        if p.is_absolute() {
            p
        } else {
            root.join(p)
        }
    };

    let (entries, files_scanned) = scan_daily_entries(&root);
    let memory_index_md = build_memory_index_doc(&entries);
    let (tags_index_md, tag_count) = build_tags_index_doc(&entries);
    let mut sqlite_rows_written: Option<usize> = None;
    let mut sqlite_path: Option<String> = None;

    let db_path = arg_any(args, &["db-path", "db_path"]);
    if let Ok(mut db) = MemoryDb::open(&root, &db_path) {
        let rel_path = db.rel_db_path(&root);
        let db_entries = entries
            .iter()
            .map(to_db_index_entry)
            .collect::<Vec<DbIndexEntry>>();
        match db.replace_index_entries(&db_entries, "daily_scan_build_index") {
            Ok(rows) => {
                sqlite_rows_written = Some(rows);
                sqlite_path = Some(rel_path.clone());
                let embedding_rows = entries
                    .iter()
                    .map(|entry| {
                        (
                            entry.node_id.clone(),
                            build_entry_embedding(entry, 64),
                            json!({
                                "node_id": entry.node_id,
                                "source": "daily_scan_build_index",
                                "tags": entry.tags
                            }),
                        )
                    })
                    .collect::<Vec<(String, Vec<f32>, serde_json::Value)>>();
                let embedding_written = db
                    .replace_embeddings(&embedding_rows, "daily_scan_build_index")
                    .unwrap_or(0);
                let _ = db.set_hot_state_json(
                    "build_index_memory_sha256",
                    &json!(sha256_hex(&memory_index_md)),
                );
                let _ = db.set_hot_state_json(
                    "build_index_tags_sha256",
                    &json!(sha256_hex(&tags_index_md)),
                );
                let _ = db.set_hot_state_json("build_index_node_count", &json!(entries.len()));
                let _ = db.set_hot_state_json("build_index_tag_count", &json!(tag_count));
                let _ =
                    db.set_hot_state_json("build_index_embedding_count", &json!(embedding_written));
                publish_memory_event(
                    &root,
                    "rust_memory_build_index",
                    json!({
                        "ok": true,
                        "node_count": entries.len(),
                        "tag_count": tag_count,
                        "embedding_count": embedding_written,
                        "files_scanned": files_scanned,
                        "sqlite_rows_written": rows,
                        "sqlite_path": rel_path
                    }),
                );
            }
            Err(err) => {
                publish_memory_event(
                    &root,
                    "rust_memory_build_index_error",
                    json!({
                        "ok": false,
                        "error": err
                    }),
                );
            }
        }
    }

    if write {
        if let Some(parent) = memory_index_abs.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Some(parent) = tags_index_abs.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&memory_index_abs, format!("{}\n", memory_index_md));
        let _ = fs::write(&tags_index_abs, format!("{}\n", tags_index_md));
    }

    BuildIndexResult {
        ok: true,
        backend: "protheus_memory_core".to_string(),
        node_count: entries.len(),
        tag_count,
        files_scanned,
        wrote_files: write,
        memory_index_path: rel_path(&root, &memory_index_abs),
        tags_index_path: rel_path(&root, &tags_index_abs),
        memory_index_sha256: sha256_hex(&memory_index_md),
        tags_index_sha256: sha256_hex(&tags_index_md),
        sqlite_path,
        sqlite_rows_written,
    }
}

fn run_build_index(args: &HashMap<String, String>) {
    let out = build_index_payload(args);
    println!(
        "{}",
        serde_json::to_string(&out).expect("serialize build-index result")
    );
}

fn verify_envelope_payload(args: &HashMap<String, String>) -> VerifyEnvelopeResult {
    let root = PathBuf::from(arg_or_default(args, "root", "."));
    let db_path_raw = arg_or_default(args, "db-path", "");
    let db = MemoryDb::open(&root, &db_path_raw).expect("open sqlite runtime");
    let stats = db
        .hot_state_envelope_stats()
        .unwrap_or_else(|_| HotStateEnvelopeStats::default());
    VerifyEnvelopeResult {
        ok: stats.total_rows == stats.enveloped_rows,
        backend: "rust_memory_box".to_string(),
        db_path: db.rel_db_path(&root),
        total_rows: stats.total_rows,
        enveloped_rows: stats.enveloped_rows,
        legacy_cipher_rows: stats.legacy_cipher_rows,
        plain_rows: stats.plain_rows,
    }
}

fn run_verify_envelope(args: &HashMap<String, String>) {
    let out = verify_envelope_payload(args);
    println!(
        "{}",
        serde_json::to_string(&out).expect("serialize verify-envelope result")
    );
}

fn run_value_payload(payload: Value) {
    let ok = payload.get("ok").and_then(Value::as_bool).unwrap_or(false);
    println!(
        "{}",
        serde_json::to_string(&payload).expect("serialize value payload")
    );
    if !ok {
        std::process::exit(1);
    }
}

fn set_hot_state_payload(args: &HashMap<String, String>) -> serde_json::Value {
    let root = PathBuf::from(arg_or_default(args, "root", "."));
    let db_path_raw = arg_or_default(args, "db-path", "");
    let key = arg_or_default(args, "key", "");
    if key.trim().is_empty() {
        return json!({
            "ok": false,
            "error": "key_required"
        });
    }
    let value_raw = arg_any(args, &["value_json", "value"]);
    if value_raw.trim().is_empty() {
        return json!({
            "ok": false,
            "error": "value_json_required"
        });
    }
    let value = match serde_json::from_str::<serde_json::Value>(&value_raw) {
        Ok(v) => v,
        Err(_) => {
            return json!({
                "ok": false,
                "error": "value_json_invalid"
            })
        }
    };
    let db = match MemoryDb::open(&root, &db_path_raw) {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "error": "db_open_failed",
                "reason": err
            })
        }
    };
    match db.set_hot_state_json(&key, &value) {
        Ok(_) => {
            publish_memory_event(
                &root,
                "rust_memory_hot_state_set",
                json!({
                    "ok": true,
                    "key": key
                }),
            );
            json!({
                "ok": true,
                "backend": "protheus_memory_core",
                "key": key,
                "db_path": db.rel_db_path(&root)
            })
        }
        Err(err) => json!({
            "ok": false,
            "error": "db_hot_state_set_failed",
            "reason": err
        }),
    }
}

fn run_set_hot_state(args: &HashMap<String, String>) {
    let out = set_hot_state_payload(args);
    println!(
        "{}",
        serde_json::to_string(&out).expect("serialize set-hot-state result")
    );
    if !out.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        std::process::exit(1);
    }
}

fn get_hot_state_payload(args: &HashMap<String, String>) -> serde_json::Value {
    let root = PathBuf::from(arg_or_default(args, "root", "."));
    let db_path_raw = arg_or_default(args, "db-path", "");
    let key = arg_or_default(args, "key", "");
    if key.trim().is_empty() {
        return json!({
            "ok": false,
            "error": "key_required"
        });
    }
    let db = match MemoryDb::open(&root, &db_path_raw) {
        Ok(v) => v,
        Err(err) => {
            return json!({
                "ok": false,
                "error": "db_open_failed",
                "reason": err
            })
        }
    };
    match db.get_hot_state_json(&key) {
        Ok(value) => json!({
            "ok": true,
            "backend": "protheus_memory_core",
            "key": key,
            "db_path": db.rel_db_path(&root),
            "value": value
        }),
        Err(err) => json!({
            "ok": false,
            "error": "db_hot_state_get_failed",
            "reason": err
        }),
    }
}

fn run_get_hot_state(args: &HashMap<String, String>) {
    let out = get_hot_state_payload(args);
    println!(
        "{}",
        serde_json::to_string(&out).expect("serialize get-hot-state result")
    );
    if !out.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
        std::process::exit(1);
    }
}

fn run_daemon(args: &HashMap<String, String>) {
    let host = arg_or_default(args, "host", "127.0.0.1");
    let port_raw = arg_or_default(args, "port", "34127");
    let port = port_raw.parse::<u16>().unwrap_or(34127);
    let bind_addr = format!("{host}:{port}");
    let listener = TcpListener::bind(&bind_addr).unwrap_or_else(|_| {
        eprintln!("memory-daemon bind failed at {bind_addr}");
        std::process::exit(1);
    });
    eprintln!("memory-daemon listening on {bind_addr}");

    for stream in listener.incoming() {
        let Ok(mut stream) = stream else {
            continue;
        };

        let mut line = String::new();
        {
            let mut reader = BufReader::new(&mut stream);
            if reader.read_line(&mut line).is_err() {
                let _ = stream.write_all(b"{\"ok\":false,\"error\":\"invalid_request\"}\n");
                continue;
            }
        }

        let parsed = serde_json::from_str::<DaemonRequest>(line.trim());
        let req = match parsed {
            Ok(v) => v,
            Err(_) => {
                let _ = stream.write_all(b"{\"ok\":false,\"error\":\"invalid_json\"}\n");
                continue;
            }
        };

        let cmd = req.cmd.trim().to_lowercase();
        let req_args = req.args;

        let (response, should_shutdown) = match cmd.as_str() {
            "ping" => (
                json!({
                    "ok": true,
                    "type": "memory_daemon_pong",
                    "backend": "protheus_memory_core"
                }),
                false,
            ),
            "probe" => {
                let root = PathBuf::from(arg_or_default(
                    &req_args,
                    "root",
                    detect_default_root().to_string_lossy().as_ref(),
                ));
                let started = Instant::now();
                let (_source, _entries) = load_memory_index(&root);
                let elapsed_ms = started.elapsed().as_millis() as u64;
                (
                    json!({
                        "ok": true,
                        "parity_error_count": 0,
                        "estimated_ms": elapsed_ms.max(1)
                    }),
                    false,
                )
            }
            "query-index" => (
                serde_json::to_value(query_index_payload(&req_args))
                    .unwrap_or_else(|_| json!({"ok": false, "error": "query_serialize_failed"})),
                false,
            ),
            "get-node" => {
                let (payload, _code) = get_node_payload(&req_args);
                (payload, false)
            }
            "build-index" => (
                serde_json::to_value(build_index_payload(&req_args))
                    .unwrap_or_else(|_| json!({"ok": false, "error": "build_serialize_failed"})),
                false,
            ),
            "verify-envelope" => (
                serde_json::to_value(verify_envelope_payload(&req_args)).unwrap_or_else(
                    |_| json!({"ok": false, "error": "verify_envelope_serialize_failed"}),
                ),
                false,
            ),
            "set-hot-state" => (set_hot_state_payload(&req_args), false),
            "get-hot-state" => (get_hot_state_payload(&req_args), false),
            "memory-matrix" => (wave1::memory_matrix_payload(&req_args), false),
            "memory-auto-recall" => (wave1::memory_auto_recall_payload(&req_args), false),
            "dream-sequencer" => (wave1::dream_sequencer_payload(&req_args), false),
            "rag-ingest" => (rag_runtime::ingest_payload(&req_args), false),
            "rag-search" => (rag_runtime::search_payload(&req_args), false),
            "rag-chat" => (rag_runtime::chat_payload(&req_args), false),
            "nano-chat" => (rag_runtime::nano_chat_payload(&req_args), false),
            "nano-train" => (rag_runtime::nano_train_payload(&req_args), false),
            "nano-fork" => (rag_runtime::nano_fork_payload(&req_args), false),
            "rag-status" => (rag_runtime::status_payload(&req_args), false),
            "rag-merge-vault" => (rag_runtime::merge_vault_payload(&req_args), false),
            "memory-upgrade-byterover" => {
                (rag_runtime::byterover_upgrade_payload(&req_args), false)
            }
            "memory-taxonomy" => (rag_runtime::memory_taxonomy_payload(&req_args), false),
            "memory-enable-metacognitive" => {
                (rag_runtime::memory_metacognitive_enable_payload(&req_args), false)
            }
            "memory-enable-causality" => {
                (rag_runtime::memory_causality_enable_payload(&req_args), false)
            }
            "memory-benchmark-ama" => {
                (rag_runtime::memory_benchmark_ama_payload(&req_args), false)
            }
            "memory-share" => (rag_runtime::memory_share_payload(&req_args), false),
            "memory-evolve" => (rag_runtime::memory_evolve_payload(&req_args), false),
            "memory-causal-retrieve" => {
                (rag_runtime::memory_causal_retrieve_payload(&req_args), false)
            }
            "memory-fuse" => (rag_runtime::memory_fuse_payload(&req_args), false),
            "stable-status" => (rag_runtime::stable_status_payload(), false),
            "stable-search" => match rag_runtime::ensure_supported_version(&req_args) {
                Ok(version) => {
                    let mut payload = serde_json::to_value(query_index_payload(&req_args))
                        .unwrap_or_else(
                            |_| json!({"ok": false, "error": "query_serialize_failed"}),
                        );
                    payload["api_version"] = json!(version);
                    (payload, false)
                }
                Err(err) => (err, false),
            },
            "stable-get-node" => match rag_runtime::ensure_supported_version(&req_args) {
                Ok(version) => {
                    let (mut payload, _code) = get_node_payload(&req_args);
                    payload["api_version"] = json!(version);
                    (payload, false)
                }
                Err(err) => (err, false),
            },
            "stable-build-index" => match rag_runtime::ensure_supported_version(&req_args) {
                Ok(version) => {
                    let mut payload = serde_json::to_value(build_index_payload(&req_args))
                        .unwrap_or_else(
                            |_| json!({"ok": false, "error": "build_serialize_failed"}),
                        );
                    payload["api_version"] = json!(version);
                    (payload, false)
                }
                Err(err) => (err, false),
            },
            "stable-rag-ingest" => match rag_runtime::ensure_supported_version(&req_args) {
                Ok(version) => {
                    let mut payload = rag_runtime::ingest_payload(&req_args);
                    payload["api_version"] = json!(version);
                    (payload, false)
                }
                Err(err) => (err, false),
            },
            "stable-rag-search" => match rag_runtime::ensure_supported_version(&req_args) {
                Ok(version) => {
                    let mut payload = rag_runtime::search_payload(&req_args);
                    payload["api_version"] = json!(version);
                    (payload, false)
                }
                Err(err) => (err, false),
            },
            "stable-rag-chat" => match rag_runtime::ensure_supported_version(&req_args) {
                Ok(version) => {
                    let mut payload = rag_runtime::chat_payload(&req_args);
                    payload["api_version"] = json!(version);
                    (payload, false)
                }
                Err(err) => (err, false),
            },
            "stable-nano-chat" => match rag_runtime::ensure_supported_version(&req_args) {
                Ok(version) => {
                    let mut payload = rag_runtime::nano_chat_payload(&req_args);
                    payload["api_version"] = json!(version);
                    (payload, false)
                }
                Err(err) => (err, false),
            },
            "stable-nano-train" => match rag_runtime::ensure_supported_version(&req_args) {
                Ok(version) => {
                    let mut payload = rag_runtime::nano_train_payload(&req_args);
                    payload["api_version"] = json!(version);
                    (payload, false)
                }
                Err(err) => (err, false),
            },
            "stable-nano-fork" => match rag_runtime::ensure_supported_version(&req_args) {
                Ok(version) => {
                    let mut payload = rag_runtime::nano_fork_payload(&req_args);
                    payload["api_version"] = json!(version);
                    (payload, false)
                }
                Err(err) => (err, false),
            },
            "stable-memory-upgrade-byterover" => {
                match rag_runtime::ensure_supported_version(&req_args) {
                    Ok(version) => {
                        let mut payload = rag_runtime::byterover_upgrade_payload(&req_args);
                        payload["api_version"] = json!(version);
                        (payload, false)
                    }
                    Err(err) => (err, false),
                }
            }
            "stable-memory-taxonomy" => match rag_runtime::ensure_supported_version(&req_args) {
                Ok(version) => {
                    let mut payload = rag_runtime::memory_taxonomy_payload(&req_args);
                    payload["api_version"] = json!(version);
                    (payload, false)
                }
                Err(err) => (err, false),
            },
            "stable-memory-enable-metacognitive" => {
                match rag_runtime::ensure_supported_version(&req_args) {
                    Ok(version) => {
                        let mut payload = rag_runtime::memory_metacognitive_enable_payload(&req_args);
                        payload["api_version"] = json!(version);
                        (payload, false)
                    }
                    Err(err) => (err, false),
                }
            }
            "stable-memory-enable-causality" => {
                match rag_runtime::ensure_supported_version(&req_args) {
                    Ok(version) => {
                        let mut payload = rag_runtime::memory_causality_enable_payload(&req_args);
                        payload["api_version"] = json!(version);
                        (payload, false)
                    }
                    Err(err) => (err, false),
                }
            }
            "stable-memory-benchmark-ama" => {
                match rag_runtime::ensure_supported_version(&req_args) {
                    Ok(version) => {
                        let mut payload = rag_runtime::memory_benchmark_ama_payload(&req_args);
                        payload["api_version"] = json!(version);
                        (payload, false)
                    }
                    Err(err) => (err, false),
                }
            }
            "stable-memory-share" => match rag_runtime::ensure_supported_version(&req_args) {
                Ok(version) => {
                    let mut payload = rag_runtime::memory_share_payload(&req_args);
                    payload["api_version"] = json!(version);
                    (payload, false)
                }
                Err(err) => (err, false),
            },
            "stable-memory-evolve" => match rag_runtime::ensure_supported_version(&req_args) {
                Ok(version) => {
                    let mut payload = rag_runtime::memory_evolve_payload(&req_args);
                    payload["api_version"] = json!(version);
                    (payload, false)
                }
                Err(err) => (err, false),
            },
            "stable-memory-causal-retrieve" => {
                match rag_runtime::ensure_supported_version(&req_args) {
                    Ok(version) => {
                        let mut payload = rag_runtime::memory_causal_retrieve_payload(&req_args);
                        payload["api_version"] = json!(version);
                        (payload, false)
                    }
                    Err(err) => (err, false),
                }
            }
            "stable-memory-fuse" => match rag_runtime::ensure_supported_version(&req_args) {
                Ok(version) => {
                    let mut payload = rag_runtime::memory_fuse_payload(&req_args);
                    payload["api_version"] = json!(version);
                    (payload, false)
                }
                Err(err) => (err, false),
            },
            "shutdown" => (
                json!({
                    "ok": true,
                    "type": "memory_daemon_shutdown"
                }),
                true,
            ),
            _ => (
                json!({
                    "ok": false,
                    "error": "unsupported_command",
                    "cmd": cmd
                }),
                false,
            ),
        };

        let body = serde_json::to_string(&response)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"serialize_failed\"}".to_string());
        let _ = stream.write_all(format!("{body}\n").as_bytes());
        let _ = stream.flush();
        if should_shutdown {
            break;
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("probe");
    let kv = parse_kv_args(&args[2..]);

    match cmd {
        "probe" => run_probe(&kv),
        "query-index" => run_query_index(&kv),
        "get-node" => run_get_node(&kv),
        "build-index" => run_build_index(&kv),
        "verify-envelope" => run_verify_envelope(&kv),
        "set-hot-state" => run_set_hot_state(&kv),
        "get-hot-state" => run_get_hot_state(&kv),
        "memory-matrix" => std::process::exit(wave1::print_payload_and_exit_code(
            wave1::memory_matrix_payload(&kv),
        )),
        "memory-auto-recall" => std::process::exit(wave1::print_payload_and_exit_code(
            wave1::memory_auto_recall_payload(&kv),
        )),
        "dream-sequencer" => std::process::exit(wave1::print_payload_and_exit_code(
            wave1::dream_sequencer_payload(&kv),
        )),
        "rag-ingest" => run_value_payload(rag_runtime::ingest_payload(&kv)),
        "rag-search" => run_value_payload(rag_runtime::search_payload(&kv)),
        "rag-chat" => run_value_payload(rag_runtime::chat_payload(&kv)),
        "nano-chat" => run_value_payload(rag_runtime::nano_chat_payload(&kv)),
        "nano-train" => run_value_payload(rag_runtime::nano_train_payload(&kv)),
        "nano-fork" => run_value_payload(rag_runtime::nano_fork_payload(&kv)),
        "rag-status" => run_value_payload(rag_runtime::status_payload(&kv)),
        "rag-merge-vault" => run_value_payload(rag_runtime::merge_vault_payload(&kv)),
        "memory-upgrade-byterover" => {
            run_value_payload(rag_runtime::byterover_upgrade_payload(&kv))
        }
        "memory-taxonomy" => run_value_payload(rag_runtime::memory_taxonomy_payload(&kv)),
        "memory-enable-metacognitive" => {
            run_value_payload(rag_runtime::memory_metacognitive_enable_payload(&kv))
        }
        "memory-enable-causality" => {
            run_value_payload(rag_runtime::memory_causality_enable_payload(&kv))
        }
        "memory-benchmark-ama" => run_value_payload(rag_runtime::memory_benchmark_ama_payload(&kv)),
        "memory-share" => run_value_payload(rag_runtime::memory_share_payload(&kv)),
        "memory-evolve" => run_value_payload(rag_runtime::memory_evolve_payload(&kv)),
        "memory-causal-retrieve" => {
            run_value_payload(rag_runtime::memory_causal_retrieve_payload(&kv))
        }
        "memory-fuse" => run_value_payload(rag_runtime::memory_fuse_payload(&kv)),
        "stable-status" => run_value_payload(rag_runtime::stable_status_payload()),
        "stable-search" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = serde_json::to_value(query_index_payload(&kv))
                    .unwrap_or_else(|_| json!({"ok": false, "error": "query_serialize_failed"}));
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-get-node" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let (mut out, _code) = get_node_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-build-index" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = serde_json::to_value(build_index_payload(&kv))
                    .unwrap_or_else(|_| json!({"ok": false, "error": "build_serialize_failed"}));
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-rag-ingest" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = rag_runtime::ingest_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-rag-search" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = rag_runtime::search_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-rag-chat" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = rag_runtime::chat_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-nano-chat" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = rag_runtime::nano_chat_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-nano-train" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = rag_runtime::nano_train_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-nano-fork" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = rag_runtime::nano_fork_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-memory-upgrade-byterover" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = rag_runtime::byterover_upgrade_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-memory-taxonomy" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = rag_runtime::memory_taxonomy_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-memory-enable-metacognitive" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = rag_runtime::memory_metacognitive_enable_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-memory-enable-causality" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = rag_runtime::memory_causality_enable_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-memory-benchmark-ama" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = rag_runtime::memory_benchmark_ama_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-memory-share" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = rag_runtime::memory_share_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-memory-evolve" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = rag_runtime::memory_evolve_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-memory-causal-retrieve" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = rag_runtime::memory_causal_retrieve_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "stable-memory-fuse" => match rag_runtime::ensure_supported_version(&kv) {
            Ok(version) => {
                let mut out = rag_runtime::memory_fuse_payload(&kv);
                out["api_version"] = json!(version);
                run_value_payload(out);
            }
            Err(err) => run_value_payload(err),
        },
        "daemon" => run_daemon(&kv),
        _ => {
            eprintln!("unsupported command: {}", cmd);
            std::process::exit(1);
        }
    }
}
