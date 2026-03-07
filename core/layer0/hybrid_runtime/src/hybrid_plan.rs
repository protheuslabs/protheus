use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Default, Clone, Serialize)]
pub struct LanguageStats {
    pub rust_files: usize,
    pub rust_bytes: u64,
    pub ts_files: usize,
    pub ts_bytes: u64,
    pub js_files: usize,
    pub js_bytes: u64,
}

fn should_skip(path: &Path, ignore: &HashSet<&str>) -> bool {
    path.file_name()
        .and_then(|v| v.to_str())
        .map(|name| ignore.contains(name))
        .unwrap_or(false)
}

fn scan_dir(root: &Path, cur: &Path, ignore: &HashSet<&str>, stats: &mut LanguageStats) {
    if should_skip(cur, ignore) {
        return;
    }
    let entries = match fs::read_dir(cur) {
        Ok(v) => v,
        Err(_) => return,
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if should_skip(&path, ignore) {
                continue;
            }
            scan_dir(root, &path, ignore, stats);
            continue;
        }
        if !path.is_file() {
            continue;
        }

        let len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        match path.extension().and_then(|v| v.to_str()) {
            Some("rs") => {
                stats.rust_files += 1;
                stats.rust_bytes += len;
            }
            Some("ts") => {
                stats.ts_files += 1;
                stats.ts_bytes += len;
            }
            Some("js") => {
                stats.js_files += 1;
                stats.js_bytes += len;
            }
            _ => {}
        }

        let _ = path.strip_prefix(root).ok();
    }
}

pub fn scan_language_share(root: &Path, min_pct: f64, max_pct: f64) -> serde_json::Value {
    let ignore: HashSet<&str> = [
        ".git",
        "node_modules",
        "dist",
        "state",
        "tmp",
        "target",
        "coverage",
    ]
    .iter()
    .copied()
    .collect();

    let mut stats = LanguageStats::default();
    scan_dir(root, root, &ignore, &mut stats);

    let rs_ts_total = stats.rust_bytes + stats.ts_bytes;
    let rust_vs_ts_pct = if rs_ts_total == 0 {
        0.0
    } else {
        (stats.rust_bytes as f64 * 100.0) / rs_ts_total as f64
    };

    let target_min = min_pct.max(0.0);
    let target_max = max_pct.max(target_min);
    let within_target = rust_vs_ts_pct >= target_min && rust_vs_ts_pct <= target_max;

    json!({
        "ok": true,
        "lane": "V5-RUST-HYB-001",
        "root": root.to_string_lossy(),
        "stats": stats,
        "rust_vs_ts_pct": rust_vs_ts_pct,
        "target_range_pct": {"min": target_min, "max": target_max},
        "within_target": within_target,
        "recommendation": if within_target {"maintain_hybrid_band"} else {"increase_rust_hotpath_share"}
    })
}

pub fn resolve_root(input: Option<&str>) -> PathBuf {
    match input {
        Some(v) if !v.trim().is_empty() => PathBuf::from(v),
        _ => PathBuf::from("."),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_non_negative_share() {
        let value = scan_language_share(Path::new("."), 15.0, 25.0);
        assert_eq!(value.get("ok").and_then(|v| v.as_bool()), Some(true));
        let pct = value
            .get("rust_vs_ts_pct")
            .and_then(|v| v.as_f64())
            .unwrap_or(-1.0);
        assert!(pct >= 0.0);
    }
}
