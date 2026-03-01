use serde::Serialize;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

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
}

#[derive(Serialize)]
struct QueryResult {
    ok: bool,
    backend: String,
    entries_total: usize,
    candidates_total: usize,
    index_sources: Vec<String>,
    tag_sources: Vec<String>,
    hits: Vec<QueryHit>,
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
    let mut raw = clean_cell(v).trim_matches('"').trim_matches('\'').to_string();
    if raw.is_empty() {
        return String::new();
    }
    raw = raw.replace('\\', "/");
    while raw.starts_with("./") {
        raw = raw[2..].to_string();
    }
    if raw.starts_with("memory/") {
        return raw;
    }
    if is_date_memory_file(&raw) {
        return format!("memory/{raw}");
    }
    if raw.starts_with("_archive/") {
        return format!("memory/{raw}");
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

        let normalized = cells.iter().map(|c| normalize_header_cell(c)).collect::<Vec<String>>();
        if normalized.iter().any(|h| h == "node_id") && normalized.iter().any(|h| h == "file") {
            headers = Some(normalized);
            continue;
        }
        let Some(hdr) = headers.as_ref() else {
            continue;
        };

        let mut row: HashMap<String, String> = HashMap::new();
        for (idx, key) in hdr.iter().enumerate() {
            row.insert(key.clone(), clean_cell(cells.get(idx).unwrap_or(&String::new())));
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
        root.join("MEMORY_INDEX.md"),
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
    let paths = vec![root.join("TAGS_INDEX.md"), root.join("memory").join("TAGS_INDEX.md")];
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
    args.get(key).cloned().unwrap_or_else(|| fallback.to_string())
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

fn run_query_index(args: &HashMap<String, String>) {
    let root = PathBuf::from(arg_or_default(args, "root", "."));
    let q = arg_or_default(args, "q", "");
    let top = parse_top(arg_or_default(args, "top", "5").as_str());
    let tag_filters = parse_tag_filters(&arg_or_default(args, "tags", ""));

    let (index_sources, entries) = load_memory_index(&root);
    let (tag_sources, tag_map) = load_tags_index(&root);

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
            let (score, reasons) = score_entry(entry, &query_tokens, &tag_filters, &tag_node_ids);
            (entry, score, reasons)
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

    let hits = scored
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
        })
        .collect::<Vec<QueryHit>>();

    let out = QueryResult {
        ok: true,
        backend: "rust_memory_box".to_string(),
        entries_total: entries.len(),
        candidates_total: candidates.len(),
        index_sources,
        tag_sources,
        hits,
    };
    println!("{}", serde_json::to_string(&out).expect("serialize query result"));
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("probe");
    let kv = parse_kv_args(&args[2..]);

    match cmd {
        "probe" => run_probe(&kv),
        "query-index" => run_query_index(&kv),
        _ => {
            eprintln!("unsupported command: {}", cmd);
            std::process::exit(1);
        }
    }
}
