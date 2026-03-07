use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

#[derive(Clone, Debug)]
struct IdlePaths {
    dreams_dir: PathBuf,
    idle_dir: PathBuf,
    rem_dir: PathBuf,
    state_path: PathBuf,
}

#[derive(Clone, Debug)]
struct IdleState {
    updated_ts: Option<String>,
    last_idle_ts: Option<String>,
    last_rem_ts: Option<String>,
    idle_runs: i64,
    rem_runs: i64,
    idle_runs_since_rem: i64,
    last_idle_model: Option<String>,
    last_rem_model: Option<String>,
    model_health: BTreeMap<String, Value>,
}

fn now_utc_secs() -> i64 {
    OffsetDateTime::now_utc().unix_timestamp()
}

fn today_utc() -> String {
    let now = OffsetDateTime::now_utc();
    let month: u8 = now.month().into();
    format!("{:04}-{:02}-{:02}", now.year(), month, now.day())
}

fn normalize_model_name(raw: &str) -> String {
    raw.to_lowercase()
        .chars()
        .filter(|ch| {
            ch.is_ascii_alphanumeric() || *ch == ':' || *ch == '.' || *ch == '-' || *ch == '_'
        })
        .collect::<String>()
}

fn resolve_paths(root: &Path) -> IdlePaths {
    let dreams_dir = std::env::var("IDLE_DREAM_DREAMS_DIR")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join("state/client/memory/dreams"));
    let idle_dir = std::env::var("IDLE_DREAM_IDLE_DIR")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dreams_dir.join("idle"));
    let rem_dir = std::env::var("IDLE_DREAM_REM_DIR")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dreams_dir.join("rem"));
    let state_path = std::env::var("IDLE_DREAM_STATE_PATH")
        .ok()
        .filter(|v| !v.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| dreams_dir.join("idle_state.json"));
    IdlePaths {
        dreams_dir,
        idle_dir,
        rem_dir,
        state_path,
    }
}

fn read_json(path: &Path, fallback: Value) -> Value {
    let Ok(raw) = fs::read_to_string(path) else {
        return fallback;
    };
    serde_json::from_str::<Value>(&raw).unwrap_or(fallback)
}

fn load_state(path: &Path) -> IdleState {
    let base = read_json(path, json!({}));
    let mut model_health: BTreeMap<String, Value> = BTreeMap::new();
    if let Some(raw_map) = base.get("model_health").and_then(Value::as_object) {
        for (key, value) in raw_map {
            let model = normalize_model_name(key);
            if model.is_empty() {
                continue;
            }
            if value.is_object() {
                model_health.insert(model, value.clone());
            } else {
                model_health.insert(model, json!({}));
            }
        }
    }
    IdleState {
        updated_ts: base
            .get("updated_ts")
            .and_then(Value::as_str)
            .map(|v| v.to_string()),
        last_idle_ts: base
            .get("last_idle_ts")
            .and_then(Value::as_str)
            .map(|v| v.to_string()),
        last_rem_ts: base
            .get("last_rem_ts")
            .and_then(Value::as_str)
            .map(|v| v.to_string()),
        idle_runs: base.get("idle_runs").and_then(Value::as_i64).unwrap_or(0),
        rem_runs: base.get("rem_runs").and_then(Value::as_i64).unwrap_or(0),
        idle_runs_since_rem: base
            .get("idle_runs_since_rem")
            .and_then(Value::as_i64)
            .unwrap_or(0),
        last_idle_model: base
            .get("last_idle_model")
            .and_then(Value::as_str)
            .map(|v| v.to_string()),
        last_rem_model: base
            .get("last_rem_model")
            .and_then(Value::as_str)
            .map(|v| v.to_string()),
        model_health,
    }
}

fn count_jsonl_rows(path: &Path) -> usize {
    let Ok(raw) = fs::read_to_string(path) else {
        return 0;
    };
    raw.lines().filter(|line| !line.trim().is_empty()).count()
}

fn parse_iso_ms(raw: &str) -> i64 {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return 0;
    }
    if let Ok(parsed) = OffsetDateTime::parse(trimmed, &Rfc3339) {
        return parsed.unix_timestamp_nanos() as i64 / 1_000_000;
    }
    raw.parse::<i64>().unwrap_or(0)
}

fn status_payload(root: &Path) -> Value {
    let paths = resolve_paths(root);
    let state = load_state(&paths.state_path);
    let today = today_utc();
    let idle_today = paths.idle_dir.join(format!("{today}.jsonl"));
    let rem_today = paths.rem_dir.join(format!("{today}.json"));
    let rem_value = read_json(&rem_today, Value::Null);
    let now = now_utc_secs() * 1_000;
    let active_cooldowns = state
        .model_health
        .iter()
        .filter_map(|(model, row)| {
            let cooldown_until = row
                .get("cooldown_until_ts")
                .and_then(Value::as_str)
                .unwrap_or("");
            let ts_ms = parse_iso_ms(cooldown_until);
            if ts_ms <= now {
                return None;
            }
            Some(json!({
                "model": model,
                "cooldown_until_ts": if cooldown_until.is_empty() { Value::Null } else { Value::String(cooldown_until.to_string()) },
                "failure_streak": row.get("failure_streak").and_then(Value::as_i64).unwrap_or(0),
                "last_failure_reason": row.get("last_failure_reason").cloned().unwrap_or(Value::Null)
            }))
        })
        .collect::<Vec<Value>>();
    json!({
        "ok": true,
        "type": "idle_dream_cycle_status",
        "state": {
            "version": "1.0",
            "updated_ts": state.updated_ts,
            "last_idle_ts": state.last_idle_ts,
            "last_rem_ts": state.last_rem_ts,
            "idle_runs": state.idle_runs,
            "rem_runs": state.rem_runs,
            "idle_runs_since_rem": state.idle_runs_since_rem,
            "last_idle_model": state.last_idle_model,
            "last_rem_model": state.last_rem_model,
            "model_health": state.model_health
        },
        "today": today,
        "idle_rows_today": count_jsonl_rows(&idle_today),
        "rem_exists_today": rem_value.is_object(),
        "rem_quantized_today": rem_value
            .get("quantized")
            .and_then(Value::as_array)
            .map(|rows| rows.len())
            .unwrap_or(0),
        "active_model_cooldowns": active_cooldowns,
        "paths": {
            "dreams_dir": paths.dreams_dir.to_string_lossy(),
            "idle_dir": paths.idle_dir.to_string_lossy(),
            "rem_dir": paths.rem_dir.to_string_lossy()
        }
    })
}

fn usage() {
    println!("Usage:");
    println!("  idle_dream_cycle status");
    println!(
        "  idle_dream_cycle run [YYYY-MM-DD] [--force=1] [--rem-only=1]  (delegates to legacy)"
    );
}

pub fn maybe_run(root: &Path, argv: &[String]) -> Option<i32> {
    let cmd = argv
        .first()
        .map(|v| v.trim().to_lowercase())
        .unwrap_or_else(|| "status".to_string());
    match cmd.as_str() {
        "status" => {
            println!(
                "{}",
                serde_json::to_string(&status_payload(root))
                    .unwrap_or_else(|_| "{\"ok\":false}".to_string())
            );
            Some(0)
        }
        "help" | "--help" | "-h" => {
            usage();
            Some(0)
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{status_payload, IdleState};
    use serde_json::json;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|dur| dur.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("{prefix}-{now}"));
        let _ = fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn state_shape_is_stable_for_status_contract() {
        let state = IdleState {
            updated_ts: Some("1".to_string()),
            last_idle_ts: Some("2".to_string()),
            last_rem_ts: Some("3".to_string()),
            idle_runs: 5,
            rem_runs: 4,
            idle_runs_since_rem: 1,
            last_idle_model: Some("smallthinker".to_string()),
            last_rem_model: Some("qwen3:4b".to_string()),
            model_health: Default::default(),
        };
        let encoded = serde_json::to_value(json!({
            "version": "1.0",
            "updated_ts": state.updated_ts,
            "last_idle_ts": state.last_idle_ts,
            "last_rem_ts": state.last_rem_ts,
            "idle_runs": state.idle_runs,
            "rem_runs": state.rem_runs,
            "idle_runs_since_rem": state.idle_runs_since_rem,
            "last_idle_model": state.last_idle_model,
            "last_rem_model": state.last_rem_model,
            "model_health": state.model_health
        }))
        .expect("encode");
        assert!(encoded.get("idle_runs").is_some());
        assert!(encoded.get("model_health").is_some());
    }

    #[test]
    fn status_payload_reads_state_and_outputs_expected_keys() {
        let root = unique_temp_dir("idle-dream-status");
        let dreams_dir = root.join("state/client/memory/dreams");
        let idle_dir = dreams_dir.join("idle");
        let rem_dir = dreams_dir.join("rem");
        fs::create_dir_all(&idle_dir).expect("mkdir idle");
        fs::create_dir_all(&rem_dir).expect("mkdir rem");
        fs::write(
            dreams_dir.join("idle_state.json"),
            serde_json::to_string_pretty(&json!({
                "idle_runs": 2,
                "rem_runs": 1,
                "model_health": {
                    "smallthinker": {
                        "cooldown_until_ts": "9999999999999",
                        "failure_streak": 1,
                        "last_failure_reason": "timeout"
                    }
                }
            }))
            .expect("encode state"),
        )
        .expect("write state");

        std::env::set_var(
            "IDLE_DREAM_DREAMS_DIR",
            dreams_dir.to_string_lossy().to_string(),
        );
        let payload = status_payload(&root);
        std::env::remove_var("IDLE_DREAM_DREAMS_DIR");

        assert_eq!(payload.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(
            payload.get("type").and_then(|v| v.as_str()),
            Some("idle_dream_cycle_status")
        );
        assert!(payload.get("state").is_some());
        assert!(payload.get("active_model_cooldowns").is_some());
    }
}
