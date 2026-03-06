use serde::Serialize;
use std::collections::HashSet;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone)]
struct Finding {
    id: String,
    category: String,
    title: String,
    severity: String,
    score: i64,
    summary: String,
    path: Option<String>,
    evidence: Vec<String>,
    safe_autofix: bool,
    patch_preview: Option<String>,
}

#[derive(Serialize)]
struct Summary {
    finding_count: usize,
    high_count: usize,
    medium_count: usize,
    low_count: usize,
    average_score: f64,
    max_score: i64,
}

#[derive(Serialize)]
struct Metrics {
    required_files_checked: usize,
    required_files_missing: usize,
    suspicious_root_entries: usize,
    personal_marker_hits: usize,
    legacy_ticket_style_hits: usize,
    openclaw_mentions: usize,
}

#[derive(Serialize)]
struct ScanOutput {
    ok: bool,
    r#type: String,
    engine: String,
    trigger: String,
    root: String,
    findings: Vec<Finding>,
    metrics: Metrics,
    summary: Summary,
}

fn parse_arg(args: &[String], key: &str, fallback: &str) -> String {
    for arg in args {
        if let Some(v) = arg.strip_prefix(&(String::from("--") + key + "=")) {
            let trimmed = v.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    fallback.to_string()
}

fn tokenize_csv(input: &str) -> Vec<String> {
    input
        .split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .collect()
}

fn normalized_rel(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn safe_read(path: &Path) -> String {
    fs::read_to_string(path).unwrap_or_default()
}

fn severity_score(severity: &str) -> i64 {
    match severity {
        "high" => 85,
        "medium" => 60,
        _ => 35,
    }
}

fn finding(
    id: &str,
    category: &str,
    title: &str,
    severity: &str,
    summary: &str,
    rel_path: Option<String>,
    evidence: Vec<String>,
    safe_autofix: bool,
    patch_preview: Option<String>,
) -> Finding {
    Finding {
        id: id.to_string(),
        category: category.to_string(),
        title: title.to_string(),
        severity: severity.to_string(),
        score: severity_score(severity),
        summary: summary.to_string(),
        path: rel_path,
        evidence,
        safe_autofix,
        patch_preview,
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("scan");
    if cmd != "scan" {
        let payload = serde_json::json!({
            "ok": false,
            "error": "unsupported_command",
            "supported": ["scan"]
        });
        println!("{}", payload);
        std::process::exit(2);
    }

    let root_raw = parse_arg(&args, "root", ".");
    let trigger = parse_arg(&args, "trigger", "manual");
    let required_files_arg = parse_arg(
        &args,
        "required-files",
        "README.md,CHANGELOG.md,docs/ONBOARDING_PLAYBOOK.md,docs/UI_SURFACE_MATURITY_MATRIX.md,docs/HISTORY_CLEANLINESS.md,.github/ISSUE_TEMPLATE/bug_report.md,.github/ISSUE_TEMPLATE/feature_request.md,.github/ISSUE_TEMPLATE/security_report.md",
    );
    let suspicious_names_arg = parse_arg(
        &args,
        "suspicious-root-names",
        "tmp,scratch,draft,personal,jay,my,notes_old,dump,1,2,3",
    );
    let personal_markers_arg = parse_arg(
        &args,
        "personal-markers",
        "jay_,my_,personal_,private_,local_",
    );

    let root = PathBuf::from(root_raw.clone());
    if !root.exists() {
        let payload = serde_json::json!({
            "ok": false,
            "error": "root_not_found",
            "root": root_raw
        });
        println!("{}", payload);
        std::process::exit(2);
    }

    let required_files = tokenize_csv(&required_files_arg);
    let suspicious_names: HashSet<String> = tokenize_csv(&suspicious_names_arg)
        .into_iter()
        .map(|x| x.to_lowercase())
        .collect();
    let personal_markers: Vec<String> = tokenize_csv(&personal_markers_arg)
        .into_iter()
        .map(|x| x.to_lowercase())
        .collect();

    let mut findings: Vec<Finding> = Vec::new();
    let mut missing_required = 0usize;
    let mut suspicious_root_entries = 0usize;
    let mut personal_marker_hits = 0usize;
    let mut legacy_ticket_style_hits = 0usize;
    let mut openclaw_mentions = 0usize;

    for rel in &required_files {
        let abs = root.join(rel);
        if !abs.exists() {
            missing_required += 1;
            findings.push(finding(
                &format!("missing_file_{}", rel.replace('/', "_")),
                "required_artifact",
                "Required artifact missing",
                "high",
                "A required repository artifact is missing from the expected path.",
                Some(rel.clone()),
                vec![format!("missing: {}", rel)],
                true,
                Some(format!("Create {} with the current standard template.", rel)),
            ));
        }
    }

    if let Ok(entries) = fs::read_dir(&root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let lower = name.to_lowercase();
            if lower.is_empty() || lower == ".git" {
                continue;
            }
            if suspicious_names.contains(&lower) || lower.chars().all(|c| c.is_ascii_digit()) {
                suspicious_root_entries += 1;
                findings.push(finding(
                    &format!("suspicious_root_{}", lower.replace('.', "_")),
                    "root_hygiene",
                    "Suspicious root artifact",
                    "medium",
                    "A root-level file/folder name can leak ad-hoc development patterns.",
                    Some(name.clone()),
                    vec![format!("root_entry: {}", name)],
                    false,
                    Some(format!("Move {} to an internal scoped folder and document purpose.", name)),
                ));
            }
            for marker in &personal_markers {
                if lower.contains(marker) {
                    personal_marker_hits += 1;
                    findings.push(finding(
                        &format!("personal_marker_{}", lower.replace('.', "_")),
                        "identity_leak",
                        "Personal naming marker detected",
                        "medium",
                        "Path naming suggests individual ownership rather than organizational ownership.",
                        Some(name.clone()),
                        vec![format!("marker: {}", marker), format!("entry: {}", name)],
                        false,
                        Some("Rename artifact to a team/domain oriented name.".to_string()),
                    ));
                    break;
                }
            }
        }
    }

    let readme_path = root.join("README.md");
    if readme_path.exists() {
        let readme = safe_read(&readme_path).to_lowercase();
        let count = readme.matches("openclaw").count();
        if count > 0 {
            openclaw_mentions = count;
            findings.push(finding(
                "brand_openclaw_in_readme",
                "branding_consistency",
                "Legacy branding mention in README",
                "low",
                "README contains legacy naming that can weaken a consistent organizational identity surface.",
                Some("README.md".to_string()),
                vec![format!("openclaw_mentions: {}", count)],
                true,
                Some("Replace legacy product naming with current canonical naming where appropriate.".to_string()),
            ));
        }
    }

    let canonical_backlog_path = root.join("SRS.md");
    let compat_backlog_path = root.join("UPGRADE_BACKLOG.md");
    let backlog_path = if canonical_backlog_path.exists() {
        canonical_backlog_path
    } else {
        compat_backlog_path
    };
    if backlog_path.exists() {
        let text = safe_read(&backlog_path);
        let mut hit = 0usize;
        for token in ["| todo |", "| doing |", "Status legend:\n- `todo`", "Status legend:\n- `doing`"] {
            if text.contains(token) {
                hit += 1;
            }
        }
        if hit > 0 {
            legacy_ticket_style_hits = hit;
            findings.push(finding(
                "legacy_ticket_style_markers",
                "backlog_style",
                "Legacy ticket/status style marker",
                "low",
                "Backlog content includes legacy status/ticket style markers.",
                Some(normalized_rel(&root, &backlog_path)),
                vec![format!("legacy_markers: {}", hit)],
                false,
                Some("Normalize status style to queued/in_progress/blocked/done across backlog surfaces.".to_string()),
            ));
        }
    }

    let high_count = findings.iter().filter(|f| f.severity == "high").count();
    let medium_count = findings.iter().filter(|f| f.severity == "medium").count();
    let low_count = findings.iter().filter(|f| f.severity == "low").count();
    let max_score = findings.iter().map(|f| f.score).max().unwrap_or(0);
    let average_score = if findings.is_empty() {
        0.0
    } else {
        let total: i64 = findings.iter().map(|f| f.score).sum();
        (total as f64) / (findings.len() as f64)
    };

    let out = ScanOutput {
        ok: true,
        r#type: "illusion_integrity_rust_scan".to_string(),
        engine: "rust".to_string(),
        trigger,
        root: root_raw,
        findings,
        metrics: Metrics {
            required_files_checked: required_files.len(),
            required_files_missing: missing_required,
            suspicious_root_entries,
            personal_marker_hits,
            legacy_ticket_style_hits,
            openclaw_mentions,
        },
        summary: Summary {
            finding_count: high_count + medium_count + low_count,
            high_count,
            medium_count,
            low_count,
            average_score: ((average_score * 100.0).round()) / 100.0,
            max_score,
        },
    };

    println!("{}", serde_json::to_string(&out).unwrap_or_else(|_| String::from("{\"ok\":false,\"error\":\"serialize_failed\"}")));
}
