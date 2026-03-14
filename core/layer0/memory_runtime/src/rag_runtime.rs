// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RagChunk {
    chunk_id: String,
    source_path: String,
    mime: String,
    offset_start: usize,
    offset_end: usize,
    text: String,
    sha256: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RagSource {
    path: String,
    mime: String,
    sha256: String,
    chunk_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct RagIndex {
    schema_version: String,
    generated_at: String,
    source_count: usize,
    chunk_count: usize,
    sources: Vec<RagSource>,
    chunks: Vec<RagChunk>,
    tombstones: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct TaxonomyRow {
    chunk_id: String,
    source: String,
    when_value: String,
    what_value: String,
    how_value: String,
    which_value: String,
    confidence: f64,
    keywords: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct TaxonomySnapshot {
    schema_version: String,
    generated_at: String,
    row_count: usize,
    rows: Vec<TaxonomyRow>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CausalNode {
    id: String,
    ts: String,
    event_type: String,
    summary: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CausalEdge {
    from: String,
    to: String,
    relation: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct CausalityGraph {
    schema_version: String,
    generated_at: String,
    node_count: usize,
    edge_count: usize,
    nodes: Vec<CausalNode>,
    edges: Vec<CausalEdge>,
}

fn now_iso() -> String {
    time::OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".to_string())
}

fn clean_text(raw: &str, max_len: usize) -> String {
    raw.split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ")
        .chars()
        .take(max_len)
        .collect::<String>()
        .trim()
        .to_string()
}

fn parse_usize(value: Option<&String>, min: usize, max: usize, default: usize) -> usize {
    value
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(default)
        .clamp(min, max)
}

fn parse_bool(value: Option<&String>, default: bool) -> bool {
    value
        .map(|v| {
            matches!(
                v.trim().to_ascii_lowercase().as_str(),
                "1" | "true" | "yes" | "on"
            )
        })
        .unwrap_or(default)
}

fn root_from_args(args: &HashMap<String, String>) -> PathBuf {
    let raw = clean_text(args.get("root").map_or(".", String::as_str), 600);
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn state_root(root: &Path, args: &HashMap<String, String>) -> PathBuf {
    let raw = clean_text(args.get("state-root").map_or("", String::as_str), 600);
    if raw.is_empty() {
        root.join("local").join("state").join("ops").join("local_rag")
    } else {
        let p = PathBuf::from(raw);
        if p.is_absolute() {
            p
        } else {
            root.join(p)
        }
    }
}

fn index_path(root: &Path, args: &HashMap<String, String>) -> PathBuf {
    let raw = clean_text(args.get("index-path").map_or("", String::as_str), 600);
    if raw.is_empty() {
        state_root(root, args).join("index.json")
    } else {
        let p = PathBuf::from(raw);
        if p.is_absolute() {
            p
        } else {
            root.join(p)
        }
    }
}

fn history_path(root: &Path, args: &HashMap<String, String>) -> PathBuf {
    state_root(root, args).join("history.jsonl")
}

fn taxonomy_path(root: &Path, args: &HashMap<String, String>) -> PathBuf {
    state_root(root, args).join("taxonomy_4w.json")
}

fn metacognitive_config_path(root: &Path, args: &HashMap<String, String>) -> PathBuf {
    state_root(root, args).join("metacognitive_config.json")
}

fn metacognitive_journal_path(root: &Path, args: &HashMap<String, String>) -> PathBuf {
    state_root(root, args).join("metacognitive_journal.jsonl")
}

fn causality_path(root: &Path, args: &HashMap<String, String>) -> PathBuf {
    state_root(root, args).join("causality_graph.json")
}

fn ama_benchmark_path(root: &Path, args: &HashMap<String, String>) -> PathBuf {
    state_root(root, args).join("ama_benchmark_latest.json")
}

fn sharing_ledger_path(root: &Path, args: &HashMap<String, String>) -> PathBuf {
    state_root(root, args).join("sharing_ledger.jsonl")
}

fn evolution_state_path(root: &Path, args: &HashMap<String, String>) -> PathBuf {
    state_root(root, args).join("evolution_state.json")
}

fn fusion_state_path(root: &Path, args: &HashMap<String, String>) -> PathBuf {
    state_root(root, args).join("fusion_snapshot.json")
}

fn nanochat_state_dir(root: &Path, args: &HashMap<String, String>) -> PathBuf {
    state_root(root, args).join("nanochat")
}

fn nanochat_latest_path(root: &Path, args: &HashMap<String, String>) -> PathBuf {
    nanochat_state_dir(root, args).join("latest.json")
}

fn byterover_root(root: &Path, args: &HashMap<String, String>) -> PathBuf {
    let raw = clean_text(
        args.get("byterover-root").map_or(".brv", String::as_str),
        400,
    );
    let p = PathBuf::from(raw);
    if p.is_absolute() {
        p
    } else {
        root.join(p)
    }
}

fn sha256_hex(input: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input);
    hex::encode(hasher.finalize())
}

fn normalize_rel_path(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn looks_binary(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let mut binary = 0usize;
    for b in bytes.iter().take(4096) {
        if *b == 0 {
            binary += 1;
            continue;
        }
        if *b < 0x09 || (*b > 0x0d && *b < 0x20) {
            binary += 1;
        }
    }
    binary > 24
}

fn extract_pdf_text(bytes: &[u8]) -> String {
    let mut out = String::new();
    let mut run = String::new();
    for b in bytes {
        let ch = *b as char;
        if ch.is_ascii_alphanumeric() || ch.is_ascii_punctuation() || ch.is_ascii_whitespace() {
            run.push(ch);
            continue;
        }
        if run.len() >= 6 {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(&run);
        }
        run.clear();
    }
    if run.len() >= 6 {
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&run);
    }
    clean_text(&out, 200_000)
}

fn detect_mime(path: &Path) -> String {
    let ext = path
        .extension()
        .map(|v| v.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "md" | "markdown" => "text/markdown".to_string(),
        "txt" | "log" | "rst" => "text/plain".to_string(),
        "json" => "application/json".to_string(),
        "yaml" | "yml" => "application/yaml".to_string(),
        "csv" => "text/csv".to_string(),
        "pdf" => "application/pdf".to_string(),
        "html" | "htm" => "text/html".to_string(),
        "rs" | "ts" | "js" | "py" | "go" | "java" | "c" | "cpp" => "text/source".to_string(),
        _ => "application/octet-stream".to_string(),
    }
}

fn read_text_payload(path: &Path, mime: &str) -> Option<String> {
    let bytes = fs::read(path).ok()?;
    if mime == "application/pdf" {
        let out = extract_pdf_text(&bytes);
        if out.is_empty() {
            return None;
        }
        return Some(out);
    }
    if looks_binary(&bytes) {
        return None;
    }
    let text = String::from_utf8_lossy(&bytes).to_string();
    let out = clean_text(&text, 500_000);
    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

fn gather_supported_files(path: &Path, out: &mut Vec<PathBuf>) {
    if path.is_file() {
        out.push(path.to_path_buf());
        return;
    }
    let Ok(read_dir) = fs::read_dir(path) else {
        return;
    };
    for row in read_dir.flatten() {
        let p = row.path();
        if p.is_dir() {
            gather_supported_files(&p, out);
            continue;
        }
        let mime = detect_mime(&p);
        if mime == "application/octet-stream" {
            continue;
        }
        out.push(p);
    }
}

fn chunk_text(text: &str, chunk_size: usize, overlap: usize) -> Vec<(usize, usize, String)> {
    if text.is_empty() {
        return vec![];
    }
    let chars = text.chars().collect::<Vec<char>>();
    let mut out = Vec::new();
    let mut start = 0usize;
    let safe_overlap = overlap.min(chunk_size.saturating_sub(1));
    while start < chars.len() {
        let end = (start + chunk_size).min(chars.len());
        let chunk = chars[start..end].iter().collect::<String>();
        let clean = clean_text(&chunk, chunk_size + 64);
        if !clean.is_empty() {
            out.push((start, end, clean));
        }
        if end == chars.len() {
            break;
        }
        start = end.saturating_sub(safe_overlap);
    }
    out
}

fn tokenize(text: &str) -> Vec<String> {
    let mut out = BTreeSet::new();
    for token in text.split(|ch: char| !ch.is_ascii_alphanumeric()) {
        let t = token.trim().to_ascii_lowercase();
        if t.len() >= 2 {
            out.insert(t);
        }
    }
    out.into_iter().collect::<Vec<String>>()
}

fn parse_yyyy_mm_dd(value: &str) -> String {
    let bytes = value.as_bytes();
    if bytes.len() < 10 {
        return String::new();
    }
    for i in 0..=(bytes.len() - 10) {
        let mut ok = true;
        for off in 0..10 {
            let b = bytes[i + off];
            if off == 4 || off == 7 {
                if b != b'-' {
                    ok = false;
                    break;
                }
            } else if !b.is_ascii_digit() {
                ok = false;
                break;
            }
        }
        if ok {
            return value[i..i + 10].to_string();
        }
    }
    String::new()
}

fn classify_what(source: &str, mime: &str, text: &str) -> String {
    let lower_source = source.to_ascii_lowercase();
    let lower = text.to_ascii_lowercase();
    if mime == "text/source"
        || lower_source.ends_with(".rs")
        || lower_source.ends_with(".ts")
        || lower_source.ends_with(".js")
        || lower_source.ends_with(".py")
    {
        return "code".to_string();
    }
    if lower_source.contains("receipt") || lower.contains("receipt_hash") {
        return "receipt".to_string();
    }
    if lower_source.contains("policy") || lower.contains("policy") || lower.contains("rule") {
        return "policy".to_string();
    }
    if lower_source.contains("memory") || lower.contains("epistemic") {
        return "memory".to_string();
    }
    if lower_source.contains("log") || lower.contains("error") || lower.contains("warn") {
        return "log".to_string();
    }
    "document".to_string()
}

fn classify_how(source: &str, mime: &str) -> String {
    let lower = source.to_ascii_lowercase();
    if lower.contains(".brv/") || lower.contains("context-tree") {
        return "context_tree".to_string();
    }
    if lower.contains("memory/") {
        return "memory_ingest".to_string();
    }
    if mime == "text/source" {
        return "code_index".to_string();
    }
    "document_ingest".to_string()
}

fn effective_which(args: &HashMap<String, String>) -> String {
    clean_text(
        args.get("which")
            .or_else(|| args.get("persona"))
            .map_or("default", String::as_str),
        100,
    )
}

fn metacognitive_enabled(root: &Path, args: &HashMap<String, String>) -> bool {
    let path = metacognitive_config_path(root, args);
    let Some(raw) = fs::read_to_string(path).ok() else {
        return false;
    };
    let Ok(v) = serde_json::from_str::<Value>(&raw) else {
        return false;
    };
    v.get("enabled").and_then(Value::as_bool).unwrap_or(false)
}

fn append_metacognitive_note(root: &Path, args: &HashMap<String, String>, note: Value) {
    let path = metacognitive_journal_path(root, args);
    append_history(&path, &note);
}

fn load_history_rows(path: &Path) -> Vec<Value> {
    let raw = fs::read_to_string(path).unwrap_or_default();
    raw.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<Value>>()
}

fn read_json_file(path: &Path) -> Option<Value> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn load_index(path: &Path) -> Option<RagIndex> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<RagIndex>(&raw).ok()
}

fn write_index(path: &Path, index: &RagIndex) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(raw) = serde_json::to_string_pretty(index) {
        let _ = fs::write(path, format!("{raw}\n"));
    }
}

fn append_history(path: &Path, row: &Value) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(line) = serde_json::to_string(row) {
        let _ = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .and_then(|mut f| f.write_all(format!("{line}\n").as_bytes()));
    }
}

fn receipt(mut payload: Value) -> Value {
    let digest = sha256_hex(
        serde_json::to_string(&payload)
            .unwrap_or_default()
            .as_bytes(),
    );
    payload["receipt_hash"] = Value::String(digest);
    payload["receipt_deterministic"] = Value::Bool(true);
    payload
}

pub fn ingest_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let target_raw = clean_text(args.get("path").map_or("docs", String::as_str), 600);
    let target = {
        let p = PathBuf::from(target_raw.clone());
        if p.is_absolute() {
            p
        } else {
            root.join(p)
        }
    };
    let chunk_size = parse_usize(args.get("chunk-size"), 256, 4096, 900);
    let chunk_overlap = parse_usize(args.get("chunk-overlap"), 0, 1024, 120);
    let max_files = parse_usize(args.get("max-files"), 1, 10_000, 1000);
    let incremental = parse_bool(args.get("incremental"), true);
    let idx_path = index_path(&root, args);
    let hist_path = history_path(&root, args);

    let mut files = Vec::new();
    gather_supported_files(&target, &mut files);
    files.sort();
    files.truncate(max_files);

    let previous = load_index(&idx_path);
    let mut prev_by_source: HashMap<String, (String, Vec<RagChunk>)> = HashMap::new();
    if let Some(prev) = previous.clone() {
        let mut chunks_by_source: HashMap<String, Vec<RagChunk>> = HashMap::new();
        for chunk in prev.chunks {
            chunks_by_source
                .entry(chunk.source_path.clone())
                .or_default()
                .push(chunk);
        }
        for source in prev.sources {
            let chunks = chunks_by_source.remove(&source.path).unwrap_or_default();
            prev_by_source.insert(source.path.clone(), (source.sha256.clone(), chunks));
        }
    }

    let mut sources = Vec::new();
    let mut chunks = Vec::new();
    let mut reused_chunks = 0usize;
    let mut generated_chunks = 0usize;
    let mut active_sources = BTreeSet::new();
    let mut parse_errors = Vec::new();

    for file in files {
        let rel = normalize_rel_path(&root, &file);
        let mime = detect_mime(&file);
        let bytes = match fs::read(&file) {
            Ok(v) => v,
            Err(_) => {
                parse_errors.push(json!({"path": rel, "reason": "read_failed"}));
                continue;
            }
        };
        let source_sha = sha256_hex(&bytes);
        active_sources.insert(rel.clone());
        if incremental {
            if let Some((prev_sha, prev_chunks)) = prev_by_source.get(&rel) {
                if prev_sha == &source_sha && !prev_chunks.is_empty() {
                    reused_chunks += prev_chunks.len();
                    chunks.extend(prev_chunks.iter().cloned());
                    sources.push(RagSource {
                        path: rel.clone(),
                        mime: mime.clone(),
                        sha256: source_sha.clone(),
                        chunk_ids: prev_chunks
                            .iter()
                            .map(|c| c.chunk_id.clone())
                            .collect::<Vec<String>>(),
                    });
                    continue;
                }
            }
        }

        let text = match read_text_payload(&file, &mime) {
            Some(v) => v,
            None => {
                parse_errors.push(json!({"path": rel, "reason": "unsupported_or_empty"}));
                continue;
            }
        };
        let mut source_chunk_ids = Vec::new();
        for (start, end, chunk_text) in chunk_text(&text, chunk_size, chunk_overlap) {
            let seed = format!("{rel}|{start}|{end}|{}", sha256_hex(chunk_text.as_bytes()));
            let chunk_id = format!("chunk_{}", &sha256_hex(seed.as_bytes())[..20]);
            source_chunk_ids.push(chunk_id.clone());
            chunks.push(RagChunk {
                chunk_id,
                source_path: rel.clone(),
                mime: mime.clone(),
                offset_start: start,
                offset_end: end,
                text: chunk_text.clone(),
                sha256: sha256_hex(chunk_text.as_bytes()),
            });
            generated_chunks += 1;
        }
        sources.push(RagSource {
            path: rel,
            mime,
            sha256: source_sha,
            chunk_ids: source_chunk_ids,
        });
    }

    sources.sort_by(|a, b| a.path.cmp(&b.path));
    chunks.sort_by(|a, b| {
        let by_source = a.source_path.cmp(&b.source_path);
        if by_source != std::cmp::Ordering::Equal {
            return by_source;
        }
        a.offset_start.cmp(&b.offset_start)
    });

    let previous_sources = previous
        .map(|idx| {
            idx.sources
                .into_iter()
                .map(|s| s.path)
                .collect::<BTreeSet<String>>()
        })
        .unwrap_or_default();
    let tombstones = previous_sources
        .difference(&active_sources)
        .cloned()
        .collect::<Vec<String>>();

    let index = RagIndex {
        schema_version: "1.0".to_string(),
        generated_at: now_iso(),
        source_count: sources.len(),
        chunk_count: chunks.len(),
        sources,
        chunks,
        tombstones: tombstones.clone(),
    };
    write_index(&idx_path, &index);
    let index_hash = sha256_hex(
        serde_json::to_string(&index)
            .unwrap_or_else(|_| "{}".to_string())
            .as_bytes(),
    );

    let out = receipt(json!({
        "ok": true,
        "type": "local_rag_ingest",
        "backend": "protheus_memory_core",
        "schema_version": "1.0",
        "root": root.to_string_lossy().to_string(),
        "target": target_raw,
        "index_path": normalize_rel_path(&root, &idx_path),
        "source_count": index.source_count,
        "chunk_count": index.chunk_count,
        "generated_chunks": generated_chunks,
        "reused_chunks": reused_chunks,
        "tombstoned_sources": tombstones.len(),
        "parse_error_count": parse_errors.len(),
        "parse_errors": parse_errors,
        "index_sha256": index_hash
    }));
    append_history(&hist_path, &out);
    out
}

pub fn status_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let idx_path = index_path(&root, args);
    let hist_path = history_path(&root, args);
    let index = load_index(&idx_path);
    let out = match index {
        Some(idx) => json!({
            "ok": true,
            "type": "local_rag_status",
            "backend": "protheus_memory_core",
            "schema_version": idx.schema_version,
            "generated_at": idx.generated_at,
            "source_count": idx.source_count,
            "chunk_count": idx.chunk_count,
            "tombstone_count": idx.tombstones.len(),
            "index_path": normalize_rel_path(&root, &idx_path),
            "history_path": normalize_rel_path(&root, &hist_path)
        }),
        None => json!({
            "ok": false,
            "type": "local_rag_status",
            "error": "index_missing",
            "index_path": normalize_rel_path(&root, &idx_path)
        }),
    };
    receipt(out)
}

pub fn search_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let idx_path = index_path(&root, args);
    let hist_path = history_path(&root, args);
    let query = clean_text(args.get("q").map_or("", String::as_str), 1_000);
    if query.is_empty() {
        return receipt(json!({
            "ok": false,
            "type": "local_rag_search",
            "error": "query_required"
        }));
    }
    let top = parse_usize(args.get("top"), 1, 50, 5);
    let Some(index) = load_index(&idx_path) else {
        return receipt(json!({
            "ok": false,
            "type": "local_rag_search",
            "error": "index_missing",
            "index_path": normalize_rel_path(&root, &idx_path)
        }));
    };
    let query_tokens = tokenize(&query);
    let mut scored = Vec::new();
    for chunk in index.chunks {
        let hay = chunk.text.to_ascii_lowercase();
        let mut score = 0.0_f64;
        for token in &query_tokens {
            if hay.contains(token) {
                score += 1.0;
            }
        }
        if hay.contains(&query.to_ascii_lowercase()) {
            score += 2.0;
        }
        if score > 0.0 {
            scored.push((chunk, score));
        }
    }
    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let max_score = scored.first().map(|row| row.1).unwrap_or(1.0).max(1.0);
    let hits = scored
        .into_iter()
        .take(top)
        .map(|(chunk, score)| {
            let confidence = (score / max_score).clamp(0.0, 1.0);
            json!({
                "source": chunk.source_path,
                "chunk_id": chunk.chunk_id,
                "offset_start": chunk.offset_start,
                "offset_end": chunk.offset_end,
                "confidence": ((confidence * 1000.0).round() / 1000.0),
                "preview": clean_text(&chunk.text, 280)
            })
        })
        .collect::<Vec<Value>>();

    let out = receipt(json!({
        "ok": true,
        "type": "local_rag_search",
        "backend": "protheus_memory_core",
        "query": query,
        "token_count": query_tokens.len(),
        "index_path": normalize_rel_path(&root, &idx_path),
        "hit_count": hits.len(),
        "hits": hits
    }));
    append_history(&hist_path, &out);
    out
}

pub fn chat_payload(args: &HashMap<String, String>) -> Value {
    let mut search_args = args.clone();
    search_args
        .entry("top".to_string())
        .or_insert_with(|| "4".to_string());
    let search = search_payload(&search_args);
    if !search.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        return receipt(json!({
            "ok": false,
            "type": "local_rag_chat",
            "error": search.get("error").and_then(Value::as_str).unwrap_or("search_failed"),
            "search": search
        }));
    }
    let hits = search
        .get("hits")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let answer = if hits.is_empty() {
        "No matching document chunks were found for this question.".to_string()
    } else {
        let mut lines = vec!["Document-grounded answer:".to_string()];
        for (idx, row) in hits.iter().enumerate() {
            let source = row
                .get("source")
                .and_then(Value::as_str)
                .unwrap_or("unknown");
            let preview = row.get("preview").and_then(Value::as_str).unwrap_or("");
            lines.push(format!("{}. {} — {}", idx + 1, source, preview));
        }
        lines.join("\n")
    };
    receipt(json!({
        "ok": true,
        "type": "local_rag_chat",
        "backend": "protheus_memory_core",
        "answer": answer,
        "citations": hits
    }))
}

pub fn merge_vault_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let idx_path = index_path(&root, args);
    let Some(index) = load_index(&idx_path) else {
        return receipt(json!({
            "ok": false,
            "type": "local_rag_merge_vault",
            "error": "index_missing",
            "index_path": normalize_rel_path(&root, &idx_path)
        }));
    };

    let memory_index_path = root.join("client").join("memory").join("MEMORY_INDEX.md");
    let existing = fs::read_to_string(&memory_index_path).unwrap_or_default();
    let mut existing_ids = BTreeSet::new();
    for line in existing.lines() {
        let trimmed = line.trim();
        if !trimmed.starts_with('|') {
            continue;
        }
        let cols = trimmed
            .trim_matches('|')
            .split('|')
            .map(|v| clean_text(v, 120))
            .collect::<Vec<String>>();
        if cols.is_empty() {
            continue;
        }
        let id = clean_text(cols.first().map_or("", String::as_str), 100);
        if id.starts_with("rag.") {
            existing_ids.insert(id);
        }
    }

    let max_merge = parse_usize(args.get("max-merge"), 1, 5000, 200);
    let mut rows = Vec::new();
    let mut added = 0usize;
    for chunk in index.chunks.iter().take(max_merge) {
        let node_id = format!("rag.{}", &chunk.sha256[..12]);
        if existing_ids.contains(&node_id) {
            continue;
        }
        existing_ids.insert(node_id.clone());
        let uid = chunk.sha256.chars().take(24).collect::<String>();
        let summary = clean_text(&chunk.text, 160);
        rows.push(format!(
            "| {} | {} | {} | {} | rag imported |",
            node_id, uid, chunk.source_path, summary
        ));
        added += 1;
    }

    if added > 0 {
        if let Some(parent) = memory_index_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let mut out = String::new();
        if existing.trim().is_empty() {
            out.push_str("| node_id | uid | file | summary | tags |\n");
            out.push_str("| --- | --- | --- | --- | --- |\n");
        } else {
            out.push_str(&existing);
            if !existing.ends_with('\n') {
                out.push('\n');
            }
        }
        for row in rows {
            out.push_str(&row);
            out.push('\n');
        }
        let _ = fs::write(&memory_index_path, out);
    }

    let result = receipt(json!({
        "ok": true,
        "type": "local_rag_merge_vault",
        "backend": "protheus_memory_core",
        "index_path": normalize_rel_path(&root, &idx_path),
        "memory_index_path": normalize_rel_path(&root, &memory_index_path),
        "rows_added": added
    }));
    append_history(&history_path(&root, args), &result);
    result
}

pub fn byterover_upgrade_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let brv = byterover_root(&root, args);
    let ctx = brv.join("context-tree");
    let timeline = ctx.join("timeline.md");
    let facts = ctx.join("facts.md");
    let meaning = ctx.join("meaning.md");
    let rules = ctx.join("rules.md");
    let manifest = ctx.join("manifest.json");

    let _ = fs::create_dir_all(&ctx);
    let mut created = Vec::new();
    for (path, title) in [
        (&timeline, "Timeline"),
        (&facts, "Facts"),
        (&meaning, "Meaning"),
        (&rules, "Rules"),
    ] {
        if !path.exists() {
            let body = format!("# {title}\n\nInitialized by `memory-upgrade-byterover`.\n");
            if fs::write(path, body).is_ok() {
                created.push(normalize_rel_path(&root, path));
            }
        }
    }

    let snapshot = json!({
        "schema_version": "1.0",
        "profile": "byterover",
        "generated_at": now_iso(),
        "paths": {
            "timeline": normalize_rel_path(&root, &timeline),
            "facts": normalize_rel_path(&root, &facts),
            "meaning": normalize_rel_path(&root, &meaning),
            "rules": normalize_rel_path(&root, &rules)
        }
    });
    let _ = fs::write(
        &manifest,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&snapshot).unwrap_or_else(|_| "{}".to_string())
        ),
    );

    let out = receipt(json!({
        "ok": true,
        "type": "memory_upgrade_byterover",
        "backend": "protheus_memory_core",
        "schema_version": "1.0",
        "profile": "byterover",
        "root": normalize_rel_path(&root, &brv),
        "context_tree_path": normalize_rel_path(&root, &ctx),
        "manifest_path": normalize_rel_path(&root, &manifest),
        "files_created": created,
        "created_count": created.len()
    }));
    append_history(&history_path(&root, args), &out);
    out
}

pub fn memory_metacognitive_enable_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let enabled = parse_bool(args.get("enabled"), true);
    let note = clean_text(args.get("note").map_or("", String::as_str), 300);
    let config_digest = sha256_hex(
        serde_json::to_string(&json!({
            "schema_version": "1.0",
            "enabled": enabled,
            "note": note
        }))
        .unwrap_or_default()
        .as_bytes(),
    );
    let cfg_path = metacognitive_config_path(&root, args);
    let payload = json!({
        "schema_version": "1.0",
        "enabled": enabled,
        "updated_at": now_iso(),
        "note": note
    });
    if let Some(parent) = cfg_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        &cfg_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&payload).unwrap_or_else(|_| "{}".to_string())
        ),
    );
    let out = receipt(json!({
        "ok": true,
        "type": "memory_metacognitive_enable",
        "backend": "protheus_memory_core",
        "enabled": enabled,
        "config_path": normalize_rel_path(&root, &cfg_path),
        "config_digest": config_digest
    }));
    append_history(&history_path(&root, args), &out);
    append_metacognitive_note(
        &root,
        args,
        json!({
            "type": "metacognitive_toggle",
            "ts": now_iso(),
            "enabled": enabled,
            "note": note
        }),
    );
    out
}

pub fn memory_taxonomy_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let idx_path = index_path(&root, args);
    let Some(index) = load_index(&idx_path) else {
        return receipt(json!({
            "ok": false,
            "type": "memory_taxonomy_4w",
            "error": "index_missing",
            "index_path": normalize_rel_path(&root, &idx_path)
        }));
    };
    let which = effective_which(args);
    let mut rows = Vec::new();
    let mut what_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut how_counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut when_missing = 0usize;
    for chunk in index.chunks {
        let when_value = parse_yyyy_mm_dd(&chunk.source_path);
        if when_value.is_empty() {
            when_missing += 1;
        }
        let what_value = classify_what(&chunk.source_path, &chunk.mime, &chunk.text);
        let how_value = classify_how(&chunk.source_path, &chunk.mime);
        *what_counts.entry(what_value.clone()).or_insert(0) += 1;
        *how_counts.entry(how_value.clone()).or_insert(0) += 1;
        let tokenized = tokenize(&chunk.text);
        let keywords = tokenized.into_iter().take(8).collect::<Vec<String>>();
        let mut confidence = 0.6_f64;
        if !when_value.is_empty() {
            confidence += 0.2;
        }
        if !keywords.is_empty() {
            confidence += 0.2;
        }
        rows.push(TaxonomyRow {
            chunk_id: chunk.chunk_id,
            source: chunk.source_path,
            when_value,
            what_value,
            how_value,
            which_value: which.clone(),
            confidence: (confidence * 1000.0).round() / 1000.0,
            keywords,
        });
    }
    rows.sort_by(|a, b| a.chunk_id.cmp(&b.chunk_id));
    let snapshot = TaxonomySnapshot {
        schema_version: "1.0".to_string(),
        generated_at: now_iso(),
        row_count: rows.len(),
        rows,
    };
    let taxonomy_digest = sha256_hex(
        serde_json::to_string(&snapshot.rows)
            .unwrap_or_default()
            .as_bytes(),
    );
    let out_path = taxonomy_path(&root, args);
    if let Some(parent) = out_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        &out_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&snapshot).unwrap_or_else(|_| "{}".to_string())
        ),
    );
    let out = receipt(json!({
        "ok": true,
        "type": "memory_taxonomy_4w",
        "backend": "protheus_memory_core",
        "index_path": normalize_rel_path(&root, &idx_path),
        "taxonomy_path": normalize_rel_path(&root, &out_path),
        "taxonomy_digest": taxonomy_digest,
        "row_count": snapshot.row_count,
        "which": which,
        "when_missing": when_missing,
        "what_counts": what_counts,
        "how_counts": how_counts
    }));
    append_history(&history_path(&root, args), &out);
    if metacognitive_enabled(&root, args) {
        append_metacognitive_note(
            &root,
            args,
            json!({
                "type": "taxonomy_reflection",
                "ts": now_iso(),
                "row_count": snapshot.row_count,
                "when_missing": when_missing,
                "dominant_what": out.get("what_counts").and_then(Value::as_object).and_then(|m| m.iter().max_by_key(|(_,v)| v.as_u64().unwrap_or(0)).map(|(k,_)| k.clone())).unwrap_or_else(|| "unknown".to_string())
            }),
        );
    }
    out
}

pub fn memory_causality_enable_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let hist = history_path(&root, args);
    let rows = load_history_rows(&hist);
    if rows.is_empty() {
        return receipt(json!({
            "ok": false,
            "type": "memory_causality_enable",
            "error": "history_missing",
            "history_path": normalize_rel_path(&root, &hist)
        }));
    }
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    for (idx, row) in rows.iter().enumerate() {
        let seed = format!(
            "{}|{}|{}",
            row.get("receipt_hash")
                .and_then(Value::as_str)
                .unwrap_or(""),
            row.get("type").and_then(Value::as_str).unwrap_or(""),
            idx
        );
        let id = format!("evt.{}", &sha256_hex(seed.as_bytes())[..16]);
        let event_type = clean_text(
            row.get("type").and_then(Value::as_str).unwrap_or("event"),
            120,
        );
        let ts = clean_text(
            row.get("ts")
                .or_else(|| row.get("generated_at"))
                .and_then(Value::as_str)
                .unwrap_or(""),
            80,
        );
        let summary = clean_text(
            &format!(
                "{} {}",
                event_type,
                row.get("query")
                    .or_else(|| row.get("answer"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
            ),
            220,
        );
        nodes.push(CausalNode {
            id: id.clone(),
            ts,
            event_type,
            summary,
        });
        if idx > 0 {
            let prev = nodes[idx - 1].id.clone();
            edges.push(CausalEdge {
                from: prev,
                to: id,
                relation: "temporal_precedes".to_string(),
            });
        }
    }
    let graph = CausalityGraph {
        schema_version: "1.0".to_string(),
        generated_at: now_iso(),
        node_count: nodes.len(),
        edge_count: edges.len(),
        nodes,
        edges,
    };
    let out_path = causality_path(&root, args);
    if let Some(parent) = out_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        &out_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&graph).unwrap_or_else(|_| "{}".to_string())
        ),
    );
    let out = receipt(json!({
        "ok": true,
        "type": "memory_causality_enable",
        "backend": "protheus_memory_core",
        "graph_path": normalize_rel_path(&root, &out_path),
        "history_path": normalize_rel_path(&root, &hist),
        "node_count": graph.node_count,
        "edge_count": graph.edge_count
    }));
    append_history(&history_path(&root, args), &out);
    if metacognitive_enabled(&root, args) {
        append_metacognitive_note(
            &root,
            args,
            json!({
                "type": "causality_reflection",
                "ts": now_iso(),
                "node_count": graph.node_count,
                "edge_count": graph.edge_count
            }),
        );
    }
    out
}

pub fn memory_benchmark_ama_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let graph_path = causality_path(&root, args);
    let Some(raw) = fs::read_to_string(&graph_path).ok() else {
        return receipt(json!({
            "ok": false,
            "type": "memory_benchmark_ama",
            "error": "causality_graph_missing",
            "graph_path": normalize_rel_path(&root, &graph_path)
        }));
    };
    let Ok(graph) = serde_json::from_str::<CausalityGraph>(&raw) else {
        return receipt(json!({
            "ok": false,
            "type": "memory_benchmark_ama",
            "error": "causality_graph_invalid",
            "graph_path": normalize_rel_path(&root, &graph_path)
        }));
    };
    let threshold = args
        .get("threshold")
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.72)
        .clamp(0.1, 1.0);
    let node_ids = graph
        .nodes
        .iter()
        .map(|n| n.id.clone())
        .collect::<HashSet<String>>();
    let valid_edges = graph
        .edges
        .iter()
        .filter(|e| node_ids.contains(&e.from) && node_ids.contains(&e.to))
        .count();
    let edge_validity = if graph.edge_count == 0 {
        0.0
    } else {
        valid_edges as f64 / graph.edge_count as f64
    };
    let covered_nodes = graph
        .nodes
        .iter()
        .filter(|n| !n.summary.trim().is_empty())
        .count();
    let node_coverage = if graph.node_count == 0 {
        0.0
    } else {
        covered_nodes as f64 / graph.node_count as f64
    };
    let mut adjacency: HashMap<String, Vec<String>> = HashMap::new();
    for e in &graph.edges {
        adjacency
            .entry(e.from.clone())
            .or_default()
            .push(e.to.clone());
    }
    let mut two_hop = 0usize;
    for node in &graph.nodes {
        let mut seen: HashSet<String> = HashSet::new();
        let mut q: VecDeque<(String, usize)> = VecDeque::new();
        q.push_back((node.id.clone(), 0));
        while let Some((cur, depth)) = q.pop_front() {
            if depth >= 2 {
                continue;
            }
            for nxt in adjacency.get(&cur).cloned().unwrap_or_default() {
                if seen.insert(nxt.clone()) {
                    q.push_back((nxt, depth + 1));
                }
            }
        }
        if seen.len() >= 2 {
            two_hop += 1;
        }
    }
    let multi_hop_ratio = if graph.node_count == 0 {
        0.0
    } else {
        two_hop as f64 / graph.node_count as f64
    };
    let ama_score =
        (edge_validity * 0.5 + node_coverage * 0.3 + multi_hop_ratio * 0.2).clamp(0.0, 1.0);
    let pass = ama_score >= threshold;
    let benchmark = json!({
        "schema_version": "1.0",
        "generated_at": now_iso(),
        "graph_path": normalize_rel_path(&root, &graph_path),
        "metrics": {
            "edge_validity": ((edge_validity * 1000.0).round() / 1000.0),
            "node_coverage": ((node_coverage * 1000.0).round() / 1000.0),
            "multi_hop_ratio": ((multi_hop_ratio * 1000.0).round() / 1000.0),
            "ama_score": ((ama_score * 1000.0).round() / 1000.0),
            "threshold": ((threshold * 1000.0).round() / 1000.0),
            "pass": pass
        }
    });
    let out_path = ama_benchmark_path(&root, args);
    if let Some(parent) = out_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        &out_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&benchmark).unwrap_or_else(|_| "{}".to_string())
        ),
    );
    let out = receipt(json!({
        "ok": true,
        "type": "memory_benchmark_ama",
        "backend": "protheus_memory_core",
        "benchmark_path": normalize_rel_path(&root, &out_path),
        "graph_path": normalize_rel_path(&root, &graph_path),
        "ama_score": benchmark.get("metrics").and_then(|m| m.get("ama_score")).cloned().unwrap_or(Value::Null),
        "threshold": benchmark.get("metrics").and_then(|m| m.get("threshold")).cloned().unwrap_or(Value::Null),
        "pass": pass
    }));
    append_history(&history_path(&root, args), &out);
    out
}

pub fn memory_share_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let persona = clean_text(args.get("persona").map_or("peer", String::as_str), 120);
    let scope = clean_text(args.get("scope").map_or("task", String::as_str), 40);
    let consent = parse_bool(args.get("consent"), false);
    let reason = clean_text(args.get("reason").map_or("", String::as_str), 240);
    let record = json!({
        "ts": now_iso(),
        "persona": persona,
        "scope": scope,
        "consent": consent,
        "reason": reason
    });
    let consent_scope_digest = sha256_hex(
        serde_json::to_string(&json!({
            "persona": record.get("persona").cloned().unwrap_or(Value::Null),
            "scope": record.get("scope").cloned().unwrap_or(Value::Null),
            "consent": record.get("consent").cloned().unwrap_or(Value::Null),
            "reason": record.get("reason").cloned().unwrap_or(Value::Null)
        }))
        .unwrap_or_default()
        .as_bytes(),
    );
    let path = sharing_ledger_path(&root, args);
    append_history(&path, &record);
    let out = receipt(json!({
        "ok": consent,
        "type": "memory_share",
        "backend": "protheus_memory_core",
        "persona": persona,
        "scope": scope,
        "consent": consent,
        "consent_scope_digest": consent_scope_digest,
        "sharing_ledger_path": normalize_rel_path(&root, &path),
        "error": if consent { Value::Null } else { Value::String("consent_required".to_string()) }
    }));
    append_history(&history_path(&root, args), &out);
    out
}

pub fn memory_evolve_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let h_rows = load_history_rows(&history_path(&root, args));
    let meta_path = metacognitive_journal_path(&root, args);
    let meta_rows = load_history_rows(&meta_path);
    let share_rows = load_history_rows(&sharing_ledger_path(&root, args));
    let generation = parse_usize(args.get("generation"), 1, 100_000, 1);
    let stability_score = ((h_rows.len() as f64 * 0.4
        + meta_rows.len() as f64 * 0.3
        + share_rows.len() as f64 * 0.3)
        .sqrt()
        / 10.0)
        .clamp(0.0, 1.0);
    let snapshot = json!({
        "schema_version": "1.0",
        "generated_at": now_iso(),
        "generation": generation,
        "history_events": h_rows.len(),
        "metacognitive_events": meta_rows.len(),
        "sharing_events": share_rows.len(),
        "stability_score": ((stability_score * 1000.0).round() / 1000.0)
    });
    let evolution_digest = sha256_hex(
        serde_json::to_string(&json!({
            "generation": generation,
            "history_events": h_rows.len(),
            "metacognitive_events": meta_rows.len(),
            "sharing_events": share_rows.len(),
            "stability_score": snapshot.get("stability_score").cloned().unwrap_or(Value::Null)
        }))
        .unwrap_or_default()
        .as_bytes(),
    );
    let out_path = evolution_state_path(&root, args);
    if let Some(parent) = out_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        &out_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&snapshot).unwrap_or_else(|_| "{}".to_string())
        ),
    );
    let out = receipt(json!({
        "ok": true,
        "type": "memory_evolve",
        "backend": "protheus_memory_core",
        "generation": generation,
        "stability_score": snapshot.get("stability_score").cloned().unwrap_or(Value::Null),
        "evolution_digest": evolution_digest,
        "evolution_state_path": normalize_rel_path(&root, &out_path)
    }));
    append_history(&history_path(&root, args), &out);
    out
}

pub fn memory_causal_retrieve_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let graph_path = causality_path(&root, args);
    let Some(raw) = fs::read_to_string(&graph_path).ok() else {
        return receipt(json!({
            "ok": false,
            "type": "memory_causal_retrieve",
            "error": "causality_graph_missing",
            "graph_path": normalize_rel_path(&root, &graph_path)
        }));
    };
    let Ok(graph) = serde_json::from_str::<CausalityGraph>(&raw) else {
        return receipt(json!({
            "ok": false,
            "type": "memory_causal_retrieve",
            "error": "causality_graph_invalid",
            "graph_path": normalize_rel_path(&root, &graph_path)
        }));
    };
    let q = clean_text(args.get("q").map_or("", String::as_str), 200);
    let depth = parse_usize(args.get("depth"), 1, 6, 2);
    let seed = if !q.is_empty() {
        graph
            .nodes
            .iter()
            .find(|n| {
                n.summary
                    .to_ascii_lowercase()
                    .contains(&q.to_ascii_lowercase())
                    || n.event_type
                        .to_ascii_lowercase()
                        .contains(&q.to_ascii_lowercase())
            })
            .map(|n| n.id.clone())
            .or_else(|| graph.nodes.first().map(|n| n.id.clone()))
            .unwrap_or_default()
    } else {
        graph
            .nodes
            .first()
            .map(|n| n.id.clone())
            .unwrap_or_default()
    };
    let mut adjacency: HashMap<String, Vec<String>> = HashMap::new();
    for edge in &graph.edges {
        adjacency
            .entry(edge.from.clone())
            .or_default()
            .push(edge.to.clone());
    }
    let mut visited = HashSet::new();
    let mut queue: VecDeque<(String, usize)> = VecDeque::new();
    queue.push_back((seed.clone(), 0));
    let mut trace = Vec::new();
    while let Some((cur, d)) = queue.pop_front() {
        if !visited.insert(cur.clone()) {
            continue;
        }
        if let Some(node) = graph.nodes.iter().find(|n| n.id == cur) {
            trace.push(json!({
                "id": node.id,
                "depth": d,
                "event_type": node.event_type,
                "summary": node.summary
            }));
        }
        if d >= depth {
            continue;
        }
        for nxt in adjacency.get(&cur).cloned().unwrap_or_default() {
            queue.push_back((nxt, d + 1));
        }
    }
    let out = receipt(json!({
        "ok": true,
        "type": "memory_causal_retrieve",
        "backend": "protheus_memory_core",
        "query": q,
        "seed": seed,
        "depth": depth,
        "trace_count": trace.len(),
        "trace": trace,
        "graph_path": normalize_rel_path(&root, &graph_path)
    }));
    append_history(&history_path(&root, args), &out);
    out
}

pub fn memory_fuse_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let taxonomy_rows = read_json_file(&taxonomy_path(&root, args))
        .and_then(|v| v.get("rows").and_then(Value::as_array).map(|v| v.len()))
        .unwrap_or(0usize);
    let causality = read_json_file(&causality_path(&root, args))
        .and_then(|v| v.get("node_count").and_then(Value::as_u64))
        .unwrap_or(0) as usize;
    let meta = load_history_rows(&metacognitive_journal_path(&root, args)).len();
    let fusion_score = ((taxonomy_rows as f64 * 0.4 + causality as f64 * 0.4 + meta as f64 * 0.2)
        / 100.0)
        .clamp(0.0, 1.0);
    let snapshot = json!({
        "schema_version": "1.0",
        "generated_at": now_iso(),
        "taxonomy_rows": taxonomy_rows,
        "causality_nodes": causality,
        "metacognitive_events": meta,
        "fusion_score": ((fusion_score * 1000.0).round() / 1000.0)
    });
    let out_path = fusion_state_path(&root, args);
    if let Some(parent) = out_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        &out_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&snapshot).unwrap_or_else(|_| "{}".to_string())
        ),
    );
    let out = receipt(json!({
        "ok": true,
        "type": "memory_fuse",
        "backend": "protheus_memory_core",
        "fusion_score": snapshot.get("fusion_score").cloned().unwrap_or(Value::Null),
        "fusion_state_path": normalize_rel_path(&root, &out_path)
    }));
    append_history(&history_path(&root, args), &out);
    out
}

pub fn nano_chat_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let query = clean_text(args.get("q").map_or("nano mode", String::as_str), 500);
    let top = parse_usize(args.get("top"), 1, 20, 5);
    let transport = clean_text(args.get("transport").map_or("cli+web", String::as_str), 80);
    let latest_path = nanochat_latest_path(&root, args);

    let out = receipt(json!({
        "ok": true,
        "type": "nano_chat_mode",
        "backend": "protheus_memory_core",
        "query": query,
        "top": top,
        "transport": transport,
        "history_enabled": true,
        "state_path": normalize_rel_path(&root, &latest_path)
    }));
    if let Some(parent) = latest_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let _ = fs::write(
        &latest_path,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{}".to_string())
        ),
    );
    append_history(&history_path(&root, args), &out);
    out
}

pub fn nano_train_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let depth = parse_usize(args.get("depth"), 1, 64, 12);
    let profile = clean_text(args.get("profile").map_or("nanochat", String::as_str), 80);
    let state_dir = nanochat_state_dir(&root, args);
    let checkpoints = state_dir.join("checkpoints");
    let ckpt = checkpoints.join(format!("depth_{depth}.json"));
    let _ = fs::create_dir_all(&checkpoints);
    let pipeline = json!({
        "stages": ["tokenizer", "pretrain", "sft", "rl"],
        "depth": depth,
        "profile": profile,
        "generated_at": now_iso()
    });
    let _ = fs::write(
        &ckpt,
        format!(
            "{}\n",
            serde_json::to_string_pretty(&pipeline).unwrap_or_else(|_| "{}".to_string())
        ),
    );

    let out = receipt(json!({
        "ok": true,
        "type": "nano_train_mode",
        "backend": "protheus_memory_core",
        "depth": depth,
        "profile": profile,
        "pipeline_stages": ["tokenizer", "pretrain", "sft", "rl"],
        "checkpoint_path": normalize_rel_path(&root, &ckpt)
    }));
    append_history(&history_path(&root, args), &out);
    out
}

pub fn nano_fork_payload(args: &HashMap<String, String>) -> Value {
    let root = root_from_args(args);
    let target = clean_text(
        args.get("target").map_or(".nanochat/fork", String::as_str),
        400,
    );
    let target_path = {
        let p = PathBuf::from(target.clone());
        if p.is_absolute() {
            p
        } else {
            root.join(p)
        }
    };
    let _ = fs::create_dir_all(&target_path);
    let readme = target_path.join("README.md");
    if !readme.exists() {
        let _ = fs::write(
            &readme,
            "# NanoChat Fork Mode\n\nGenerated by `protheus nano fork`.\n",
        );
    }

    let out = receipt(json!({
        "ok": true,
        "type": "nano_fork_mode",
        "backend": "protheus_memory_core",
        "target": target,
        "target_path": normalize_rel_path(&root, &target_path),
        "readme_path": normalize_rel_path(&root, &readme)
    }));
    append_history(&history_path(&root, args), &out);
    out
}

pub fn stable_status_payload() -> Value {
    receipt(json!({
        "ok": true,
        "type": "memory_stable_api_status",
        "backend": "protheus_memory_core",
        "stable_api_version": "v1",
        "supported_versions": ["stable", "v1", "1"],
        "commands": [
            "stable-status",
            "stable-search",
            "stable-get-node",
            "stable-build-index",
            "memory-upgrade-byterover",
            "stable-memory-upgrade-byterover",
            "stable-rag-ingest",
            "stable-rag-search",
            "stable-rag-chat",
            "stable-nano-chat",
            "stable-nano-train",
            "stable-nano-fork",
            "stable-memory-taxonomy",
            "stable-memory-enable-metacognitive",
            "stable-memory-enable-causality",
            "stable-memory-benchmark-ama",
            "stable-memory-share",
            "stable-memory-evolve",
            "stable-memory-causal-retrieve",
            "stable-memory-fuse"
        ]
    }))
}

pub fn ensure_supported_version(args: &HashMap<String, String>) -> Result<String, Value> {
    let version = clean_text(args.get("api-version").map_or("stable", String::as_str), 20)
        .to_ascii_lowercase();
    let normalized = if version == "1" {
        "v1".to_string()
    } else {
        version
    };
    if normalized == "stable" || normalized == "v1" {
        Ok(normalized)
    } else {
        Err(receipt(json!({
            "ok": false,
            "type": "memory_stable_api_error",
            "error": "unsupported_api_version",
            "requested_version": normalized,
            "supported_versions": ["stable", "v1", "1"]
        })))
    }
}

#[cfg(test)]
mod tests {
    use super::{
        byterover_upgrade_payload, chat_payload, ensure_supported_version, ingest_payload,
        memory_benchmark_ama_payload, memory_causal_retrieve_payload,
        memory_causality_enable_payload, memory_evolve_payload, memory_fuse_payload,
        memory_metacognitive_enable_payload, memory_share_payload, memory_taxonomy_payload,
        merge_vault_payload, nano_chat_payload, nano_fork_payload, nano_train_payload,
        search_payload, stable_status_payload, status_payload,
    };
    use std::collections::HashMap;
    use std::fs;

    fn base_args(root: &str) -> HashMap<String, String> {
        let mut args = HashMap::new();
        args.insert("root".to_string(), root.to_string());
        args.insert("path".to_string(), "docs".to_string());
        args
    }

    #[test]
    fn ingest_search_chat_merge_roundtrip() {
        let dir = tempfile::tempdir().expect("tempdir");
        let docs = dir.path().join("docs");
        fs::create_dir_all(&docs).expect("mkdir docs");
        fs::create_dir_all(dir.path().join("client/memory")).expect("mkdir memory");
        fs::write(
            docs.join("alpha.md"),
            "# Alpha\nThis document describes local rag indexing and memory retrieval.\n",
        )
        .expect("write alpha");
        fs::write(
            docs.join("beta.txt"),
            "The second document mentions retrieval confidence and citations.",
        )
        .expect("write beta");

        let args = base_args(&dir.path().to_string_lossy());
        let ingest = ingest_payload(&args);
        assert!(ingest.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        assert!(
            ingest
                .get("chunk_count")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                >= 2
        );

        let mut search_args = args.clone();
        search_args.insert("q".to_string(), "retrieval citations".to_string());
        let search = search_payload(&search_args);
        assert!(search.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        assert!(
            search
                .get("hit_count")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                >= 1
        );

        let chat = chat_payload(&search_args);
        assert!(chat.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        assert!(chat
            .get("answer")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .contains("Document-grounded answer"));

        let merge = merge_vault_payload(&args);
        assert!(merge.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        assert!(
            merge
                .get("rows_added")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                >= 1
        );

        let status = status_payload(&args);
        assert!(status.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
    }

    #[test]
    fn incremental_reuses_unchanged_chunks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let docs = dir.path().join("docs");
        fs::create_dir_all(&docs).expect("mkdir docs");
        fs::write(
            docs.join("stable.md"),
            "Stable file for incremental ingest reuse behavior.",
        )
        .expect("write stable");
        let mut args = base_args(&dir.path().to_string_lossy());
        args.insert("incremental".to_string(), "true".to_string());
        let first = ingest_payload(&args);
        assert!(first.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        let second = ingest_payload(&args);
        assert!(second.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        assert!(
            second
                .get("reused_chunks")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                >= 1
        );
    }

    #[test]
    fn stable_api_version_gate_accepts_and_rejects_expected_values() {
        let mut ok_args = HashMap::new();
        ok_args.insert("api-version".to_string(), "1".to_string());
        assert_eq!(
            ensure_supported_version(&ok_args).expect("v1"),
            "v1".to_string()
        );

        let mut bad_args = HashMap::new();
        bad_args.insert("api-version".to_string(), "v9".to_string());
        let err = ensure_supported_version(&bad_args).expect_err("must reject");
        assert_eq!(
            err.get("error").and_then(|v| v.as_str()),
            Some("unsupported_api_version")
        );
    }

    #[test]
    fn stable_status_reports_expected_commands() {
        let out = stable_status_payload();
        assert!(out.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        let commands = out
            .get("commands")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        assert!(commands
            .iter()
            .any(|v| v.as_str() == Some("stable-rag-search")));
    }

    #[test]
    fn byterover_upgrade_materializes_context_tree() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut args = HashMap::new();
        args.insert("root".to_string(), dir.path().to_string_lossy().to_string());
        let out = byterover_upgrade_payload(&args);
        assert!(out.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        assert!(dir.path().join(".brv/context-tree/timeline.md").exists());
        assert!(dir.path().join(".brv/context-tree/manifest.json").exists());
    }

    #[test]
    fn taxonomy_causality_and_ama_benchmark_workflow() {
        let dir = tempfile::tempdir().expect("tempdir");
        let docs = dir.path().join("docs");
        fs::create_dir_all(&docs).expect("mkdir docs");
        fs::write(
            docs.join("2026-03-12-ops.md"),
            "Policy rule updates with deterministic receipts and causal links.",
        )
        .expect("write doc");

        let mut args = base_args(&dir.path().to_string_lossy());
        let ingest = ingest_payload(&args);
        assert!(ingest.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));

        args.insert("q".to_string(), "policy causal receipts".to_string());
        let search = search_payload(&args);
        assert!(search.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        let chat = chat_payload(&args);
        assert!(chat.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));

        let meta = memory_metacognitive_enable_payload(&base_args(&dir.path().to_string_lossy()));
        assert!(meta.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        assert_eq!(meta.get("enabled").and_then(|v| v.as_bool()), Some(true));
        assert!(meta
            .get("config_digest")
            .and_then(|v| v.as_str())
            .map(|v| !v.is_empty())
            .unwrap_or(false));

        let taxonomy = memory_taxonomy_payload(&base_args(&dir.path().to_string_lossy()));
        assert!(taxonomy
            .get("ok")
            .and_then(|v| v.as_bool())
            .unwrap_or(false));
        assert!(
            taxonomy
                .get("row_count")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                >= 1
        );
        let digest_a = taxonomy
            .get("taxonomy_digest")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        assert!(!digest_a.is_empty());
        let taxonomy_repeat = memory_taxonomy_payload(&base_args(&dir.path().to_string_lossy()));
        let digest_b = taxonomy_repeat
            .get("taxonomy_digest")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        assert_eq!(digest_a, digest_b);

        let causal = memory_causality_enable_payload(&base_args(&dir.path().to_string_lossy()));
        assert!(causal.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        assert!(
            causal
                .get("node_count")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                >= 3
        );

        let ama = memory_benchmark_ama_payload(&base_args(&dir.path().to_string_lossy()));
        assert!(ama.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        assert!(ama.get("ama_score").is_some());
    }

    #[test]
    fn nanochat_modes_emit_receipts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut args = HashMap::new();
        args.insert("root".to_string(), dir.path().to_string_lossy().to_string());
        args.insert("q".to_string(), "teach me nanochat".to_string());
        args.insert("depth".to_string(), "12".to_string());

        let chat = nano_chat_payload(&args);
        assert!(chat.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        assert_eq!(
            chat.get("type").and_then(|v| v.as_str()),
            Some("nano_chat_mode")
        );

        let train = nano_train_payload(&args);
        assert!(train.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        assert_eq!(
            train.get("type").and_then(|v| v.as_str()),
            Some("nano_train_mode")
        );

        let fork = nano_fork_payload(&args);
        assert!(fork.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        assert_eq!(
            fork.get("type").and_then(|v| v.as_str()),
            Some("nano_fork_mode")
        );
    }

    #[test]
    fn memory_share_evolve_retrieve_and_fuse_emit_receipts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let docs = dir.path().join("docs");
        fs::create_dir_all(&docs).expect("mkdir docs");
        fs::write(
            docs.join("flow.md"),
            "Step one causes step two; step two updates strategy.",
        )
        .expect("write");
        let mut args = base_args(&dir.path().to_string_lossy());
        let _ = ingest_payload(&args);
        args.insert("q".to_string(), "strategy".to_string());
        let _ = search_payload(&args);
        let _ = chat_payload(&args);
        let _ = memory_causality_enable_payload(&base_args(&dir.path().to_string_lossy()));
        let mut share_args = base_args(&dir.path().to_string_lossy());
        share_args.insert("persona".to_string(), "peer-shadow".to_string());
        share_args.insert("scope".to_string(), "task".to_string());
        share_args.insert("consent".to_string(), "true".to_string());
        let share = memory_share_payload(&share_args);
        assert!(share.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        assert!(share
            .get("consent_scope_digest")
            .and_then(|v| v.as_str())
            .map(|v| !v.is_empty())
            .unwrap_or(false));

        let evolve = memory_evolve_payload(&base_args(&dir.path().to_string_lossy()));
        assert!(evolve.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        assert!(evolve.get("stability_score").is_some());
        assert!(evolve
            .get("evolution_digest")
            .and_then(|v| v.as_str())
            .map(|v| !v.is_empty())
            .unwrap_or(false));

        let mut retrieve_args = base_args(&dir.path().to_string_lossy());
        retrieve_args.insert("q".to_string(), "strategy".to_string());
        retrieve_args.insert("depth".to_string(), "2".to_string());
        let retrieve = memory_causal_retrieve_payload(&retrieve_args);
        assert!(retrieve
            .get("ok")
            .and_then(|v| v.as_bool())
            .unwrap_or(false));
        assert!(
            retrieve
                .get("trace_count")
                .and_then(|v| v.as_u64())
                .unwrap_or(0)
                >= 1
        );

        let fuse = memory_fuse_payload(&base_args(&dir.path().to_string_lossy()));
        assert!(fuse.get("ok").and_then(|v| v.as_bool()).unwrap_or(false));
        assert!(fuse.get("fusion_score").is_some());
    }
}
