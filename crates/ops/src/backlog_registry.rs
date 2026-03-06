use crate::{deterministic_receipt_hash, now_iso, parse_args};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
struct Paths {
    backlog_path: PathBuf,
    registry_path: PathBuf,
    active_view_path: PathBuf,
    archive_view_path: PathBuf,
    priority_view_path: PathBuf,
    reviewed_view_path: PathBuf,
    execution_path_view_path: PathBuf,
    state_path: PathBuf,
    latest_path: PathBuf,
    receipts_path: PathBuf,
}

#[derive(Debug, Clone)]
struct Policy {
    version: String,
    strict_default: bool,
    active_statuses: BTreeSet<String>,
    archive_statuses: BTreeSet<String>,
    paths: Paths,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RegistryRow {
    id: String,
    class: String,
    wave: String,
    status: String,
    title: String,
    problem: String,
    acceptance: String,
    dependencies: Vec<String>,
}

#[derive(Debug, Clone)]
struct ParsedRow {
    row: RegistryRow,
    canonical: bool,
    source_index: usize,
}

#[derive(Debug, Clone)]
struct CompiledBacklog {
    generated_at: String,
    rows: Vec<RegistryRow>,
    conflicts: Vec<Value>,
    active_view: String,
    archive_view: String,
    priority_view: String,
    reviewed_view: String,
    execution_view: String,
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops backlog-registry sync [--policy=<path>]");
    println!("  protheus-ops backlog-registry check [--strict=1|0] [--policy=<path>]");
    println!("  protheus-ops backlog-registry status [--policy=<path>]");
}

fn normalize_token(raw: &str, max_len: usize) -> String {
    let mut out = String::new();
    for ch in raw.trim().chars().take(max_len) {
        let c = ch.to_ascii_lowercase();
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | ':' | '/' | '-') {
            out.push(c);
        } else {
            out.push('_');
        }
    }
    let mut squashed = String::new();
    let mut prev_us = false;
    for ch in out.chars() {
        let is_us = ch == '_';
        if is_us && prev_us {
            continue;
        }
        squashed.push(ch);
        prev_us = is_us;
    }
    squashed.trim_matches('_').to_string()
}

fn clean_text(raw: &str, max_len: usize) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max_len)
        .collect::<String>()
}

fn normalize_id(raw: &str) -> Option<String> {
    let id = clean_text(raw, 120).trim_matches('`').to_ascii_uppercase();
    if id.is_empty() {
        return None;
    }
    let parts: Vec<&str> = id.split('-').collect();
    if parts.len() < 2 {
        return None;
    }
    if parts.iter().any(|p| p.is_empty()) {
        return None;
    }
    if parts
        .iter()
        .all(|p| p.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()))
    {
        Some(id)
    } else {
        None
    }
}

fn parse_bool(raw: Option<&String>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

fn path_from_policy(root: &Path, raw: Option<&str>, fallback: &str) -> PathBuf {
    let v = raw.unwrap_or(fallback).trim();
    if v.is_empty() {
        return root.join(fallback);
    }
    let candidate = PathBuf::from(v);
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

fn load_policy(root: &Path, policy_override: Option<&String>) -> Policy {
    let default_path = root.join("config/backlog_registry_policy.json");
    let policy_path = policy_override
        .map(PathBuf::from)
        .unwrap_or(default_path);

    let raw = fs::read_to_string(&policy_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}));

    let version = raw
        .get("version")
        .and_then(Value::as_str)
        .map(|s| clean_text(s, 32))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "1.0".to_string());

    let strict_default = raw
        .get("strict_default")
        .and_then(Value::as_bool)
        .unwrap_or(true);

    let active_statuses = raw
        .get("active_statuses")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(|v| normalize_token(v, 40))
                .filter(|v| !v.is_empty())
                .collect::<BTreeSet<_>>()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            ["queued", "in_progress", "blocked", "proposed"]
                .iter()
                .map(|v| (*v).to_string())
                .collect()
        });

    let archive_statuses = raw
        .get("archive_statuses")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(|v| normalize_token(v, 40))
                .filter(|v| !v.is_empty())
                .collect::<BTreeSet<_>>()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            ["done", "dropped", "archived", "obsolete"]
                .iter()
                .map(|v| (*v).to_string())
                .collect()
        });

    let paths_obj = raw.get("paths").and_then(Value::as_object);

    let paths = Paths {
        backlog_path: path_from_policy(
            root,
            paths_obj
                .and_then(|o| o.get("backlog_path"))
                .and_then(Value::as_str),
            "SRS.md",
        ),
        registry_path: path_from_policy(
            root,
            paths_obj
                .and_then(|o| o.get("registry_path"))
                .and_then(Value::as_str),
            "config/backlog_registry.json",
        ),
        active_view_path: path_from_policy(
            root,
            paths_obj
                .and_then(|o| o.get("active_view_path"))
                .and_then(Value::as_str),
            "docs/backlog_views/active.md",
        ),
        archive_view_path: path_from_policy(
            root,
            paths_obj
                .and_then(|o| o.get("archive_view_path"))
                .and_then(Value::as_str),
            "docs/backlog_views/archive.md",
        ),
        priority_view_path: root.join("docs/backlog_views/priority_queue.md"),
        reviewed_view_path: root.join("docs/backlog_views/reviewed.md"),
        execution_path_view_path: root.join("docs/backlog_views/execution_path.md"),
        state_path: path_from_policy(
            root,
            paths_obj
                .and_then(|o| o.get("state_path"))
                .and_then(Value::as_str),
            "state/ops/backlog_registry/state.json",
        ),
        latest_path: path_from_policy(
            root,
            paths_obj
                .and_then(|o| o.get("latest_path"))
                .and_then(Value::as_str),
            "state/ops/backlog_registry/latest.json",
        ),
        receipts_path: path_from_policy(
            root,
            paths_obj
                .and_then(|o| o.get("receipts_path"))
                .and_then(Value::as_str),
            "state/ops/backlog_registry/receipts.jsonl",
        ),
    };

    Policy {
        version,
        strict_default,
        active_statuses,
        archive_statuses,
        paths,
    }
}

fn split_markdown_row(line: &str) -> Vec<String> {
    let trimmed = line.trim();
    if !trimmed.starts_with('|') {
        return Vec::new();
    }
    let mut row = trimmed.trim_start_matches('|').to_string();
    if row.ends_with('|') {
        row.pop();
    }

    let mut cells = Vec::new();
    let mut current = String::new();
    let mut in_backtick = false;
    let mut escaped = false;

    for ch in row.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            current.push(ch);
            continue;
        }
        if ch == '`' {
            in_backtick = !in_backtick;
            current.push(ch);
            continue;
        }
        if ch == '|' && !in_backtick {
            cells.push(clean_text(&current.replace("\\|", "|"), 8000));
            current.clear();
            continue;
        }
        current.push(ch);
    }
    cells.push(clean_text(&current.replace("\\|", "|"), 8000));
    cells
}

fn is_separator_row(cells: &[String]) -> bool {
    if cells.is_empty() {
        return true;
    }
    let first = cells[0].replace(['-', ':', ' '], "");
    first.is_empty()
}

fn status_weight(status: &str) -> i32 {
    match status {
        "reviewed" => 700,
        "done" => 650,
        "in_progress" => 500,
        "blocked" => 350,
        "queued" => 250,
        "proposed" => 200,
        "archived" | "obsolete" | "dropped" => 180,
        _ => 100,
    }
}

fn parse_dependencies(raw: &str) -> Vec<String> {
    let mut out = Vec::new();
    let upper = raw.to_ascii_uppercase();
    for token in upper.split(|c: char| !(c.is_ascii_uppercase() || c.is_ascii_digit() || c == '-')) {
        if let Some(id) = normalize_id(token) {
            if !out.contains(&id) {
                out.push(id);
            }
        }
    }
    out
}

fn parse_backlog_rows(markdown: &str) -> Vec<ParsedRow> {
    let mut parsed = Vec::new();
    for (idx, raw_line) in markdown.lines().enumerate() {
        let line = raw_line.trim();
        if !line.starts_with('|') {
            continue;
        }
        let cells = split_markdown_row(line);
        if cells.len() < 5 || is_separator_row(&cells) {
            continue;
        }

        let Some(id) = normalize_id(&cells[0]) else {
            continue;
        };

        let compact_status = cells.get(1).map(|s| normalize_token(s, 40)).unwrap_or_default();
        let canonical_status = cells.get(3).map(|s| normalize_token(s, 40)).unwrap_or_default();

        let (canonical, class, wave, status, title, problem, acceptance, deps_raw) =
            if cells.len() >= 8 && !canonical_status.is_empty() {
                (
                    true,
                    normalize_token(&cells[1], 80),
                    clean_text(&cells[2], 40),
                    canonical_status,
                    clean_text(&cells[4], 500),
                    clean_text(&cells[5], 8000),
                    clean_text(&cells[6], 12000),
                    cells.get(7).cloned().unwrap_or_default(),
                )
            } else if !compact_status.is_empty() {
                (
                    false,
                    "backlog".to_string(),
                    id.split('-').next().unwrap_or("V?").to_string(),
                    compact_status,
                    clean_text(cells.get(2).map(String::as_str).unwrap_or(""), 500),
                    clean_text(cells.get(3).map(String::as_str).unwrap_or(""), 8000),
                    clean_text(cells.get(4).map(String::as_str).unwrap_or(""), 12000),
                    cells.get(5).cloned().unwrap_or_default(),
                )
            } else {
                continue;
            };

        let row = RegistryRow {
            id,
            class: if class.is_empty() {
                "backlog".to_string()
            } else {
                class
            },
            wave: if wave.is_empty() {
                "V?".to_string()
            } else {
                wave
            },
            status: if status.is_empty() {
                "queued".to_string()
            } else {
                status
            },
            title,
            problem,
            acceptance,
            dependencies: parse_dependencies(&deps_raw),
        };

        parsed.push(ParsedRow {
            row,
            canonical,
            source_index: idx,
        });
    }
    parsed
}

fn resolve_rows(parsed: Vec<ParsedRow>) -> (Vec<RegistryRow>, Vec<Value>) {
    let mut by_id: BTreeMap<String, Vec<ParsedRow>> = BTreeMap::new();
    for row in parsed {
        by_id.entry(row.row.id.clone()).or_default().push(row);
    }

    let mut conflicts = Vec::new();
    let mut out = Vec::new();

    for (id, rows) in by_id {
        let mut statuses = BTreeSet::new();
        for row in &rows {
            statuses.insert(row.row.status.clone());
        }

        let pick = rows
            .iter()
            .max_by_key(|r| {
                let mut score = status_weight(&r.row.status) * 10_000;
                if r.canonical {
                    score += 200;
                }
                score += (r.row.acceptance.len().min(500) + r.row.problem.len().min(500)) as i32;
                score += r.source_index as i32;
                score
            })
            .expect("at least one row");

        if statuses.len() > 1 {
            conflicts.push(json!({
                "id": id,
                "statuses": statuses,
                "selected_status": pick.row.status,
                "selected_title": pick.row.title
            }));
        }

        out.push(pick.row.clone());
    }

    (out, conflicts)
}

fn render_table_view(title: &str, rows: &[RegistryRow], generated_at: &str) -> String {
    let mut lines = vec![
        format!("# {title}"),
        String::new(),
        format!("Generated: {generated_at}"),
        String::new(),
        "| ID | Class | Wave | Status | Title | Dependencies |".to_string(),
        "|---|---|---|---|---|---|".to_string(),
    ];

    for row in rows {
        let deps = if row.dependencies.is_empty() {
            String::new()
        } else {
            row.dependencies.join(", ")
        };
        lines.push(format!(
            "| {} | {} | {} | {} | {} | {} |",
            row.id, row.class, row.wave, row.status, row.title, deps
        ));
    }

    lines.push(String::new());
    lines.join("\n")
}

fn impact_for_class(class: &str) -> i32 {
    match class {
        "primitive-upgrade" => 18,
        "hardening" => 12,
        "governance" => 10,
        "scale-readiness" => 8,
        "launch-polish" => 4,
        _ => 6,
    }
}

fn risk_for_status(status: &str) -> i32 {
    match status {
        "blocked" => 16,
        "in_progress" => 10,
        "queued" => 8,
        "proposed" => 6,
        _ => 4,
    }
}

fn status_bonus(status: &str) -> i32 {
    match status {
        "in_progress" => 10,
        "queued" => 8,
        "proposed" => 6,
        "blocked" => 4,
        _ => 0,
    }
}

fn render_priority_queue(rows: &[RegistryRow], active_statuses: &BTreeSet<String>) -> String {
    let generated_at = now_iso();

    let mut unlock_map: HashMap<String, i32> = HashMap::new();
    for row in rows {
        for dep in &row.dependencies {
            *unlock_map.entry(dep.clone()).or_insert(0) += 1;
        }
    }

    let done_set: BTreeSet<String> = rows
        .iter()
        .filter(|r| matches!(r.status.as_str(), "done" | "reviewed" | "archived" | "dropped" | "obsolete"))
        .map(|r| r.id.clone())
        .collect();

    #[derive(Clone)]
    struct Ranked {
        id: String,
        status: String,
        title: String,
        priority: i32,
        impact: i32,
        risk: i32,
        unresolved: i32,
        unlock_count: i32,
    }

    let mut ranked = Vec::new();
    for row in rows {
        if !active_statuses.contains(&row.status) {
            continue;
        }
        let unresolved = row
            .dependencies
            .iter()
            .filter(|dep| !done_set.contains((*dep).as_str()))
            .count() as i32;
        let unlock = *unlock_map.get(&row.id).unwrap_or(&0);
        let impact = impact_for_class(&row.class);
        let risk = risk_for_status(&row.status);
        let priority = impact + risk + status_bonus(&row.status) + (unlock * 2) - (unresolved * 3);
        ranked.push(Ranked {
            id: row.id.clone(),
            status: row.status.clone(),
            title: row.title.clone(),
            priority,
            impact,
            risk,
            unresolved,
            unlock_count: unlock,
        });
    }

    ranked.sort_by(|a, b| {
        b.priority
            .cmp(&a.priority)
            .then_with(|| a.id.cmp(&b.id))
    });

    let total_rows = rows.len();
    let active_rows = ranked.len();
    let completed_rows = rows.iter().filter(|r| !active_statuses.contains(&r.status)).count();

    let mut lines = vec![
        "# Backlog Priority Queue".to_string(),
        String::new(),
        format!("Generated: {generated_at}"),
        String::new(),
        "Scoring model: impact + risk + dependency pressure (unblocks and unresolved deps), with status weighting.".to_string(),
        String::new(),
        "## Summary".to_string(),
        String::new(),
        format!("- Total rows: {total_rows}"),
        format!("- Active rows: {active_rows}"),
        format!("- Completed rows: {completed_rows}"),
        String::new(),
        "## Active Execution Order".to_string(),
        String::new(),
        "| Rank | ID | Status | Priority | Impact | Risk | Unresolved Deps | Unlock Count | Title |".to_string(),
        "|---|---|---|---:|---:|---:|---:|---:|---|".to_string(),
    ];

    for (idx, row) in ranked.iter().enumerate() {
        lines.push(format!(
            "| {} | {} | {} | {} | {} | {} | {} | {} | {} |",
            idx + 1,
            row.id,
            row.status,
            row.priority,
            row.impact,
            row.risk,
            row.unresolved,
            row.unlock_count,
            row.title
        ));
    }

    lines.push(String::new());
    lines.join("\n")
}

fn render_reviewed(rows: &[RegistryRow], active_statuses: &BTreeSet<String>) -> String {
    let generated_at = now_iso();
    let total = rows.len();

    let mut reviewed_count = 0usize;
    let mut pass = 0usize;
    let mut warn = 0usize;
    let mut blocked = 0usize;

    let mut lines = vec![
        "# Backlog Reviewed View".to_string(),
        String::new(),
        format!("Generated: {generated_at}"),
        String::new(),
        "| ID | Status | Reviewed Status | Review Result | Reviewed | Title |".to_string(),
        "|---|---|---|---|---|---|".to_string(),
    ];

    for row in rows {
        let (reviewed_status, result, reviewed) = match row.status.as_str() {
            "done" | "reviewed" | "archived" | "dropped" | "obsolete" => {
                reviewed_count += 1;
                pass += 1;
                ("reviewed", "pass", "yes")
            }
            "blocked" => {
                blocked += 1;
                ("blocked", "blocked", "no")
            }
            _ => {
                warn += 1;
                let rs = if active_statuses.contains(&row.status) {
                    row.status.as_str()
                } else {
                    "queued"
                };
                (rs, "needs_implementation", "no")
            }
        };

        lines.push(format!(
            "| {} | {} | {} | {} | {} | {} |",
            row.id, row.status, reviewed_status, result, reviewed, row.title
        ));
    }

    lines.insert(
        4,
        format!(
            "Summary: reviewed {reviewed_count}/{total} | pass {pass} | warn {warn} | fail 0 | blocked {blocked}"
        ),
    );
    lines.insert(5, String::new());

    lines.push(String::new());
    lines.join("\n")
}

fn render_execution_path(rows: &[RegistryRow], active_statuses: &BTreeSet<String>) -> String {
    let generated_at = now_iso();

    let mut done_ids = BTreeSet::new();
    for row in rows {
        if matches!(row.status.as_str(), "done" | "reviewed" | "archived" | "dropped" | "obsolete") {
            done_ids.insert(row.id.clone());
        }
    }

    #[derive(Clone)]
    struct QueueRow {
        row: RegistryRow,
        open_deps: Vec<String>,
        priority: i32,
    }

    let mut queued = Vec::new();
    let mut blocked = Vec::new();

    let mut unlock_map: HashMap<String, i32> = HashMap::new();
    for row in rows {
        for dep in &row.dependencies {
            *unlock_map.entry(dep.clone()).or_insert(0) += 1;
        }
    }

    for row in rows {
        if !active_statuses.contains(&row.status) {
            continue;
        }
        let open_deps = row
            .dependencies
            .iter()
            .filter(|dep| !done_ids.contains((*dep).as_str()))
            .cloned()
            .collect::<Vec<_>>();

        let unresolved = open_deps.len() as i32;
        let unlock = *unlock_map.get(&row.id).unwrap_or(&0);
        let priority = impact_for_class(&row.class)
            + risk_for_status(&row.status)
            + status_bonus(&row.status)
            + (unlock * 2)
            - (unresolved * 3);

        let q = QueueRow {
            row: row.clone(),
            open_deps,
            priority,
        };

        if row.status == "blocked" {
            blocked.push(q);
        } else if matches!(row.status.as_str(), "queued" | "proposed" | "in_progress") {
            queued.push(q);
        }
    }

    queued.sort_by(|a, b| b.priority.cmp(&a.priority).then_with(|| a.row.id.cmp(&b.row.id)));
    blocked.sort_by(|a, b| a.row.id.cmp(&b.row.id));

    let mut lines = vec![
        "# Backlog Execution Path".to_string(),
        String::new(),
        format!("Generated: {generated_at}"),
        String::new(),
        "## Summary".to_string(),
        String::new(),
        format!("- Active rows: {}", queued.len() + blocked.len()),
        format!("- Queued rows: {}", queued.len()),
        format!("- Blocked rows: {}", blocked.len()),
        "- Ordering strategy: impact-first with dependency-valid sequencing.".to_string(),
        String::new(),
        "## Impact + Dependency Execution Order".to_string(),
        String::new(),
    ];

    if queued.is_empty() {
        lines.push("No queued backlog rows remain in this view.".to_string());
    } else {
        lines.push("| Rank | ID | Status | Priority | Open Dependencies | Title |".to_string());
        lines.push("|---|---|---|---:|---|---|".to_string());
        for (idx, item) in queued.iter().enumerate() {
            let deps = if item.open_deps.is_empty() {
                String::new()
            } else {
                item.open_deps.join(", ")
            };
            lines.push(format!(
                "| {} | {} | {} | {} | {} | {} |",
                idx + 1,
                item.row.id,
                item.row.status,
                item.priority,
                deps,
                item.row.title
            ));
        }
    }

    lines.push(String::new());
    lines.push("## Deferred / Blocked".to_string());
    lines.push(String::new());
    lines.push("| ID | Class | Status | Block Reason |".to_string());
    lines.push("|---|---|---|---|".to_string());
    for item in blocked {
        let reason = if item.open_deps.is_empty() {
            "Blocked status in SRS".to_string()
        } else {
            format!("Open dependencies: {}", item.open_deps.join(", "))
        };
        lines.push(format!(
            "| {} | {} | {} | {} |",
            item.row.id, item.row.class, item.row.status, reason
        ));
    }

    lines.push(String::new());
    lines.join("\n")
}

fn ensure_parent(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
}

fn write_text_atomic(path: &Path, text: &str) -> Result<(), String> {
    ensure_parent(path);
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&tmp, text).map_err(|e| format!("write_tmp_failed:{}", e))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename_tmp_failed:{}", e))
}

fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path);
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open_jsonl_failed:{}", e))?;
    let line = serde_json::to_string(value).map_err(|e| format!("encode_jsonl_failed:{}", e))?;
    f.write_all(line.as_bytes())
        .and_then(|_| f.write_all(b"\n"))
        .map_err(|e| format!("append_jsonl_failed:{}", e))
}

fn canonical_rows_hash(rows: &[RegistryRow]) -> String {
    let value = serde_json::to_value(rows).unwrap_or_else(|_| json!([]));
    deterministic_receipt_hash(&value)
}

fn normalize_text_compare(text: &str) -> String {
    text.replace("\r\n", "\n")
        .lines()
        .filter(|line| !line.trim_start().starts_with("Generated: "))
        .collect::<Vec<_>>()
        .join("\n")
        .trim_end()
        .to_string()
}

fn compile_backlog(policy: &Policy) -> Result<CompiledBacklog, String> {
    let raw = fs::read_to_string(&policy.paths.backlog_path)
        .map_err(|e| format!("read_backlog_failed:{}", e))?;
    let parsed = parse_backlog_rows(&raw);
    let (rows, conflicts) = resolve_rows(parsed);
    let generated_at = now_iso();

    let active_rows = rows
        .iter()
        .filter(|r| policy.active_statuses.contains(&r.status))
        .cloned()
        .collect::<Vec<_>>();
    let archive_rows = rows
        .iter()
        .filter(|r| policy.archive_statuses.contains(&r.status))
        .cloned()
        .collect::<Vec<_>>();

    Ok(CompiledBacklog {
        generated_at: generated_at.clone(),
        rows: rows.clone(),
        conflicts,
        active_view: render_table_view("Backlog Active View", &active_rows, &generated_at),
        archive_view: render_table_view("Backlog Archive View", &archive_rows, &generated_at),
        priority_view: render_priority_queue(&rows, &policy.active_statuses),
        reviewed_view: render_reviewed(&rows, &policy.active_statuses),
        execution_view: render_execution_path(&rows, &policy.active_statuses),
    })
}

fn sync(policy: &Policy) -> Result<Value, String> {
    let compiled = compile_backlog(policy)?;

    let registry_json = json!({
        "schema_id": "backlog_registry",
        "schema_version": policy.version,
        "generated_at": compiled.generated_at,
        "row_count": compiled.rows.len(),
        "rows": compiled.rows,
        "conflicts": compiled.conflicts,
    });

    let registry_text = serde_json::to_string_pretty(&registry_json)
        .map(|s| format!("{}\n", s))
        .map_err(|e| format!("encode_registry_failed:{}", e))?;

    write_text_atomic(&policy.paths.registry_path, &registry_text)?;
    write_text_atomic(&policy.paths.active_view_path, &format!("{}\n", compiled.active_view))?;
    write_text_atomic(&policy.paths.archive_view_path, &format!("{}\n", compiled.archive_view))?;
    write_text_atomic(&policy.paths.priority_view_path, &format!("{}\n", compiled.priority_view))?;
    write_text_atomic(&policy.paths.reviewed_view_path, &format!("{}\n", compiled.reviewed_view))?;
    write_text_atomic(
        &policy.paths.execution_path_view_path,
        &format!("{}\n", compiled.execution_view),
    )?;

    let payload = json!({
        "ok": true,
        "type": "backlog_registry_sync",
        "ts": now_iso(),
        "backlog_path": policy.paths.backlog_path,
        "registry_path": policy.paths.registry_path,
        "rows": registry_json.get("row_count").and_then(Value::as_u64).unwrap_or(0),
        "conflicts": registry_json.get("conflicts").and_then(Value::as_array).map(|v| v.len()).unwrap_or(0),
        "rows_hash": canonical_rows_hash(&compiled.rows),
        "claim_evidence": [
            {
                "id": "backlog_registry_sync",
                "claim": "backlog_views_generated_from_srs",
                "evidence": {
                    "backlog": policy.paths.backlog_path,
                    "active_view": policy.paths.active_view_path,
                    "archive_view": policy.paths.archive_view_path,
                    "priority_view": policy.paths.priority_view_path,
                    "reviewed_view": policy.paths.reviewed_view_path,
                    "execution_view": policy.paths.execution_path_view_path
                }
            }
        ]
    });

    let mut latest = payload.clone();
    latest["receipt_hash"] = Value::String(deterministic_receipt_hash(&latest));

    write_text_atomic(
        &policy.paths.latest_path,
        &format!(
            "{}\n",
            serde_json::to_string_pretty(&latest).map_err(|e| format!("encode_latest_failed:{}", e))?
        ),
    )?;

    write_text_atomic(
        &policy.paths.state_path,
        &format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({
                "schema_id": "backlog_registry_state",
                "schema_version": "1.0",
                "updated_at": now_iso(),
                "rows_hash": latest.get("rows_hash").cloned().unwrap_or(Value::Null),
                "row_count": latest.get("rows").cloned().unwrap_or(Value::Null)
            }))
            .map_err(|e| format!("encode_state_failed:{}", e))?
        ),
    )?;

    append_jsonl(&policy.paths.receipts_path, &latest)?;
    Ok(latest)
}

fn check(policy: &Policy, strict: bool) -> Result<(Value, i32), String> {
    let compiled = compile_backlog(policy)?;

    let expected_registry_json = json!({
        "schema_id": "backlog_registry",
        "schema_version": policy.version,
        "generated_at": compiled.generated_at,
        "row_count": compiled.rows.len(),
        "rows": compiled.rows,
        "conflicts": compiled.conflicts,
    });

    let expected_rows = expected_registry_json
        .get("rows")
        .cloned()
        .unwrap_or_else(|| json!([]));
    let expected_hash = deterministic_receipt_hash(&expected_rows);

    let actual_registry = fs::read_to_string(&policy.paths.registry_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok());

    let actual_hash = actual_registry
        .as_ref()
        .and_then(|v| v.get("rows").cloned())
        .map(|v| deterministic_receipt_hash(&v));

    let mut mismatches = Vec::new();
    if actual_hash.as_deref() != Some(expected_hash.as_str()) {
        mismatches.push(json!({
            "path": policy.paths.registry_path,
            "reason": "rows_hash_mismatch",
            "expected": expected_hash,
            "actual": actual_hash
        }));
    }

    let checks: Vec<(PathBuf, String)> = vec![
        (policy.paths.active_view_path.clone(), format!("{}\n", compiled.active_view)),
        (policy.paths.archive_view_path.clone(), format!("{}\n", compiled.archive_view)),
        (policy.paths.priority_view_path.clone(), format!("{}\n", compiled.priority_view)),
        (policy.paths.reviewed_view_path.clone(), format!("{}\n", compiled.reviewed_view)),
        (
            policy.paths.execution_path_view_path.clone(),
            format!("{}\n", compiled.execution_view),
        ),
    ];

    for (path, expected) in checks {
        let actual = fs::read_to_string(&path).unwrap_or_default();
        if normalize_text_compare(&actual) != normalize_text_compare(&expected) {
            mismatches.push(json!({
                "path": path,
                "reason": "view_mismatch"
            }));
        }
    }

    let ok = mismatches.is_empty();
    let mut payload = json!({
        "ok": ok,
        "type": "backlog_registry_check",
        "ts": now_iso(),
        "strict": strict,
        "mismatch_count": mismatches.len(),
        "mismatches": mismatches,
        "expected_rows_hash": expected_hash,
        "claim_evidence": [
            {
                "id": "backlog_consistency_gate",
                "claim": "all_generated_backlog_views_match_srs_compiler",
                "evidence": {
                    "backlog": policy.paths.backlog_path,
                    "strict": strict,
                    "checks": [
                        policy.paths.registry_path,
                        policy.paths.active_view_path,
                        policy.paths.archive_view_path,
                        policy.paths.priority_view_path,
                        policy.paths.reviewed_view_path,
                        policy.paths.execution_path_view_path
                    ]
                }
            }
        ]
    });
    payload["receipt_hash"] = Value::String(deterministic_receipt_hash(&payload));

    let code = if strict && !ok { 1 } else { 0 };
    Ok((payload, code))
}

fn status(policy: &Policy) -> Value {
    let latest = fs::read_to_string(&policy.paths.latest_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| {
            json!({
                "ok": false,
                "type": "backlog_registry_status",
                "error": "latest_missing"
            })
        });

    let mut out = json!({
        "ok": latest.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "type": "backlog_registry_status",
        "ts": now_iso(),
        "latest": latest,
        "backlog_path": policy.paths.backlog_path,
        "registry_path": policy.paths.registry_path,
        "active_view_path": policy.paths.active_view_path,
        "archive_view_path": policy.paths.archive_view_path,
        "priority_view_path": policy.paths.priority_view_path,
        "reviewed_view_path": policy.paths.reviewed_view_path,
        "execution_view_path": policy.paths.execution_path_view_path
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn cli_error_receipt(argv: &[String], err: &str, code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "backlog_registry_cli_error",
        "ts": now_iso(),
        "argv": argv,
        "error": err,
        "exit_code": code
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let parsed = parse_args(argv);
    let cmd = parsed
        .positional
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    let policy = load_policy(root, parsed.flags.get("policy"));
    let strict = parse_bool(parsed.flags.get("strict"), policy.strict_default);

    match cmd.as_str() {
        "sync" => match sync(&policy) {
            Ok(payload) => {
                print_json_line(&payload);
                0
            }
            Err(err) => {
                print_json_line(&cli_error_receipt(argv, &format!("sync_failed:{err}"), 1));
                1
            }
        },
        "check" => match check(&policy, strict) {
            Ok((payload, code)) => {
                print_json_line(&payload);
                code
            }
            Err(err) => {
                print_json_line(&cli_error_receipt(argv, &format!("check_failed:{err}"), 1));
                1
            }
        },
        "status" => {
            print_json_line(&status(&policy));
            0
        }
        _ => {
            usage();
            print_json_line(&cli_error_receipt(argv, "unknown_command", 2));
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_prefers_done_over_queued_conflict() {
        let parsed = vec![
            ParsedRow {
                row: RegistryRow {
                    id: "V6-TEST-001".to_string(),
                    class: "backlog".to_string(),
                    wave: "V6".to_string(),
                    status: "queued".to_string(),
                    title: "X".to_string(),
                    problem: "p".to_string(),
                    acceptance: "a".to_string(),
                    dependencies: vec![],
                },
                canonical: true,
                source_index: 2,
            },
            ParsedRow {
                row: RegistryRow {
                    id: "V6-TEST-001".to_string(),
                    class: "backlog".to_string(),
                    wave: "V6".to_string(),
                    status: "done".to_string(),
                    title: "X".to_string(),
                    problem: "p".to_string(),
                    acceptance: "a".to_string(),
                    dependencies: vec![],
                },
                canonical: false,
                source_index: 1,
            },
        ];

        let (rows, conflicts) = resolve_rows(parsed);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, "done");
        assert_eq!(conflicts.len(), 1);
    }

    #[test]
    fn parse_dependencies_extracts_ids() {
        let deps = parse_dependencies("V6-AAA-001, req V6-BBB-010 and [V6-CCC-999]");
        assert_eq!(deps, vec!["V6-AAA-001", "V6-BBB-010", "V6-CCC-999"]);
    }
}
