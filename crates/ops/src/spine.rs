use crate::legacy_bridge::{run_legacy_script, split_legacy_fallback_flag};
use crate::now_iso;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

const LEGACY_SCRIPT_REL: &str = "systems/spine/spine_legacy.js";

#[derive(Debug, Clone)]
struct CliArgs {
    mode: String,
    date: String,
    max_eyes: Option<i64>,
}

#[derive(Debug, Clone)]
struct StepResult {
    ok: bool,
    code: i32,
    payload: Option<Value>,
    stdout: String,
    stderr: String,
}

#[derive(Debug, Clone)]
struct LedgerWriter {
    root: PathBuf,
    date: String,
    run_id: String,
    seq: u64,
}

fn stable_hash(seed: &str, len: usize) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seed.as_bytes());
    let hex = hex::encode(hasher.finalize());
    hex[..len.min(hex.len())].to_string()
}

fn stable_json_string(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => {
            if *b {
                "true".to_string()
            } else {
                "false".to_string()
            }
        }
        Value::Number(n) => n.to_string(),
        Value::String(s) => serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(arr) => format!(
            "[{}]",
            arr.iter()
                .map(stable_json_string)
                .collect::<Vec<_>>()
                .join(",")
        ),
        Value::Object(map) => {
            let mut keys = map.keys().cloned().collect::<Vec<_>>();
            keys.sort();
            let mut out = String::from("{");
            for (idx, k) in keys.iter().enumerate() {
                if idx > 0 {
                    out.push(',');
                }
                out.push_str(&serde_json::to_string(k).unwrap_or_else(|_| "\"\"".to_string()));
                out.push(':');
                out.push_str(&stable_json_string(map.get(k).unwrap_or(&Value::Null)));
            }
            out.push('}');
            out
        }
    }
}

fn receipt_hash(v: &Value) -> String {
    stable_hash(&stable_json_string(v), 64)
}

fn to_base36(mut n: u64) -> String {
    if n == 0 {
        return "0".to_string();
    }
    let mut out = Vec::new();
    while n > 0 {
        let digit = (n % 36) as u8;
        let ch = if digit < 10 {
            (b'0' + digit) as char
        } else {
            (b'a' + (digit - 10)) as char
        };
        out.push(ch);
        n /= 36;
    }
    out.into_iter().rev().collect()
}

fn parse_cli(argv: &[String]) -> Option<CliArgs> {
    if argv.is_empty() {
        return None;
    }

    let mut idx = 0usize;
    let mut mode = argv[idx].to_ascii_lowercase();
    if mode == "run" {
        idx += 1;
        mode = argv.get(idx)?.to_ascii_lowercase();
    }

    if mode != "eyes" && mode != "daily" {
        return None;
    }

    idx += 1;
    let date = argv
        .get(idx)
        .map(|s| s.trim().to_string())
        .filter(|s| s.len() == 10 && s.chars().nth(4) == Some('-') && s.chars().nth(7) == Some('-'))
        .unwrap_or_else(|| now_iso()[..10].to_string());

    let mut max_eyes = None::<i64>;
    for token in argv {
        if let Some((k, v)) = token.split_once('=') {
            if k == "--max-eyes" {
                if let Ok(n) = v.parse::<i64>() {
                    max_eyes = Some(n.clamp(1, 500));
                }
            }
        }
    }

    Some(CliArgs {
        mode,
        date,
        max_eyes,
    })
}

fn usage() {
    eprintln!("Usage:");
    eprintln!("  protheus-ops spine eyes [YYYY-MM-DD] [--max-eyes=N]");
    eprintln!("  protheus-ops spine daily [YYYY-MM-DD] [--max-eyes=N]");
    eprintln!("  protheus-ops spine run [eyes|daily] [YYYY-MM-DD] [--max-eyes=N]");
    eprintln!("  add --legacy-fallback=1 to execute systems/spine/spine_legacy.js");
}

fn run_node_json(root: &Path, args: &[String]) -> StepResult {
    let output = Command::new("node")
        .args(args)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output();

    match output {
        Ok(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout).to_string();
            let stderr = String::from_utf8_lossy(&out.stderr).to_string();
            let payload = parse_json_payload(&stdout);
            StepResult {
                ok: out.status.success(),
                code: out.status.code().unwrap_or(1),
                payload,
                stdout,
                stderr,
            }
        }
        Err(err) => StepResult {
            ok: false,
            code: 1,
            payload: None,
            stdout: String::new(),
            stderr: format!("spawn_failed:{err}"),
        },
    }
}

fn parse_json_payload(raw: &str) -> Option<Value> {
    let text = raw.trim();
    if text.is_empty() {
        return None;
    }
    if let Ok(v) = serde_json::from_str::<Value>(text) {
        return Some(v);
    }
    for line in text.lines().rev() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            return Some(v);
        }
    }
    None
}

fn spine_runs_dir(root: &Path) -> PathBuf {
    root.join("state/spine/runs")
}

fn ensure_dir(path: &Path) {
    let _ = fs::create_dir_all(path);
}

fn write_json_atomic(path: &Path, value: &Value) {
    if let Some(parent) = path.parent() {
        ensure_dir(parent);
    }
    let tmp = path.with_extension(format!(
        "tmp-{}-{}",
        std::process::id(),
        chrono::Utc::now().timestamp_millis()
    ));
    if let Ok(mut payload) = serde_json::to_string_pretty(value) {
        payload.push('\n');
        if fs::write(&tmp, payload).is_ok() {
            let _ = fs::rename(tmp, path);
        }
    }
}

impl LedgerWriter {
    fn new(root: &Path, date: &str, run_id: &str) -> Self {
        Self {
            root: root.to_path_buf(),
            date: date.to_string(),
            run_id: run_id.to_string(),
            seq: 0,
        }
    }

    fn append(&mut self, mut evt: Value) {
        self.seq = self.seq.saturating_add(1);
        if let Some(map) = evt.as_object_mut() {
            map.insert("run_id".to_string(), Value::String(self.run_id.clone()));
            map.insert("ledger_seq".to_string(), Value::Number(self.seq.into()));
            if !map.contains_key("ts") {
                map.insert("ts".to_string(), Value::String(now_iso()));
            }
            if !map.contains_key("date") {
                map.insert("date".to_string(), Value::String(self.date.clone()));
            }
        }

        let dir = spine_runs_dir(&self.root);
        ensure_dir(&dir);
        let file = dir.join(format!("{}.jsonl", self.date));
        if let Ok(payload) = serde_json::to_string(&evt) {
            let _ = fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(file)
                .and_then(|mut f| {
                    std::io::Write::write_all(&mut f, format!("{payload}\n").as_bytes())
                });
        }

        write_json_atomic(&dir.join("latest.json"), &evt);
    }
}

fn constitution_hash(root: &Path) -> (bool, Option<String>, Option<String>) {
    let path = root.join("AGENT-CONSTITUTION.md");
    match fs::read_to_string(&path) {
        Ok(raw) => {
            let digest = stable_hash(&raw, 64);
            let expected = std::env::var("PROTHEUS_CONSTITUTION_HASH").ok();
            if let Some(exp) = expected {
                (digest == exp, Some(digest), Some(exp))
            } else {
                (true, Some(digest), None)
            }
        }
        Err(_) => (false, None, None),
    }
}

fn compute_evidence_run_plan(
    configured_runs_raw: Option<i64>,
    budget: Option<&str>,
    projected: Option<&str>,
) -> Value {
    let configured_runs = configured_runs_raw.unwrap_or(2).clamp(0, 6);
    let normalize = |v: Option<&str>| -> String {
        match v.unwrap_or_default().trim().to_ascii_lowercase().as_str() {
            "soft" => "soft".to_string(),
            "hard" => "hard".to_string(),
            _ => "none".to_string(),
        }
    };
    let budget_pressure = normalize(budget);
    let projected_pressure = normalize(projected);
    let pressure_throttle = budget_pressure != "none" || projected_pressure != "none";
    let evidence_runs = if pressure_throttle {
        configured_runs.min(1)
    } else {
        configured_runs
    };
    json!({
        "configured_runs": configured_runs,
        "budget_pressure": budget_pressure,
        "projected_pressure": projected_pressure,
        "pressure_throttle": pressure_throttle,
        "evidence_runs": evidence_runs
    })
}

fn run_guard(root: &Path, files: &[&str]) -> StepResult {
    let file_list = files.join(",");
    run_node_json(
        root,
        &[
            "systems/security/guard.js".to_string(),
            format!("--files={file_list}"),
        ],
    )
}

fn step(
    root: &Path,
    name: &str,
    args: Vec<String>,
    ledger: &mut LedgerWriter,
    mode: &str,
    date: &str,
) -> Result<StepResult, String> {
    let res = run_node_json(root, &args);
    ledger.append(json!({
        "type": "spine_step",
        "mode": mode,
        "date": date,
        "step": name,
        "ok": res.ok,
        "code": res.code,
        "payload": res.payload,
        "reason": if res.ok { Value::Null } else { Value::String(clean_reason(&res.stderr, &res.stdout)) }
    }));

    if res.ok {
        Ok(res)
    } else {
        Err(format!("step_failed:{name}:{}", res.code))
    }
}

fn clean_reason(stderr: &str, stdout: &str) -> String {
    let merged = format!("{} {}", stderr, stdout)
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if merged.len() <= 180 {
        merged
    } else {
        merged[..180].to_string()
    }
}

fn execute_native(root: &Path, cli: &CliArgs) -> i32 {
    if std::env::var("CLEARANCE")
        .ok()
        .unwrap_or_default()
        .trim()
        .is_empty()
    {
        std::env::set_var("CLEARANCE", "3");
    }

    let run_id = format!(
        "spine_{}_{}",
        to_base36(chrono::Utc::now().timestamp_millis() as u64),
        std::process::id()
    );

    let mut ledger = LedgerWriter::new(root, &cli.date, &run_id);
    let invoked = vec![
        "systems/spine/spine.js",
        "systems/security/guard.js",
        "habits/scripts/external_eyes.js",
        "habits/scripts/eyes_insight.js",
        "habits/scripts/sensory_queue.js",
        "systems/actuation/bridge_from_proposals.js",
        "systems/sensory/cross_signal_engine.js",
        "systems/autonomy/autonomy_controller.js",
    ];

    let (constitution_ok, constitution_hash, expected_hash) = constitution_hash(root);
    ledger.append(json!({
        "type": "spine_run_started",
        "mode": cli.mode,
        "date": cli.date,
        "max_eyes": cli.max_eyes,
        "files_touched": invoked,
        "constitution_hash": constitution_hash,
        "expected_constitution_hash": expected_hash,
        "constitution_integrity_ok": constitution_ok
    }));

    if !constitution_ok {
        ledger.append(json!({
            "type": "spine_run_failed",
            "mode": cli.mode,
            "date": cli.date,
            "failure_reason": "constitution_integrity_failed"
        }));
        return 1;
    }

    let guard_res = run_guard(root, &invoked);
    ledger.append(json!({
        "type": "spine_guard",
        "mode": cli.mode,
        "date": cli.date,
        "ok": guard_res.ok,
        "code": guard_res.code,
        "reason": if guard_res.ok { Value::Null } else { Value::String(clean_reason(&guard_res.stderr, &guard_res.stdout)) }
    }));
    if !guard_res.ok {
        ledger.append(json!({
            "type": "spine_run_failed",
            "mode": cli.mode,
            "date": cli.date,
            "failure_reason": "guard_failed"
        }));
        return 1;
    }

    let mut step_args = vec![
        "habits/scripts/external_eyes.js".to_string(),
        "run".to_string(),
    ];
    if let Some(max_eyes) = cli.max_eyes {
        step_args.push(format!("--max-eyes={max_eyes}"));
    }
    if let Err(reason) = step(
        root,
        "external_eyes_run",
        step_args,
        &mut ledger,
        &cli.mode,
        &cli.date,
    ) {
        ledger.append(json!({
            "type": "spine_run_failed",
            "mode": cli.mode,
            "date": cli.date,
            "failure_reason": reason
        }));
        return 1;
    }

    if cli.mode == "daily" {
        for (name, args) in [
            (
                "external_eyes_canary",
                vec![
                    "habits/scripts/external_eyes.js".to_string(),
                    "canary".to_string(),
                ],
            ),
            (
                "external_eyes_canary_signal",
                vec![
                    "habits/scripts/external_eyes.js".to_string(),
                    "canary-signal".to_string(),
                ],
            ),
        ] {
            if let Err(reason) = step(root, name, args, &mut ledger, &cli.mode, &cli.date) {
                ledger.append(json!({
                    "type": "spine_run_failed",
                    "mode": cli.mode,
                    "date": cli.date,
                    "failure_reason": reason
                }));
                return 1;
            }
        }
    }

    for (name, args) in [
        (
            "external_eyes_score",
            vec![
                "habits/scripts/external_eyes.js".to_string(),
                "score".to_string(),
                cli.date.clone(),
            ],
        ),
        (
            "external_eyes_evolve",
            vec![
                "habits/scripts/external_eyes.js".to_string(),
                "evolve".to_string(),
                cli.date.clone(),
            ],
        ),
        (
            "cross_signal_engine",
            vec![
                "systems/sensory/cross_signal_engine.js".to_string(),
                "run".to_string(),
                cli.date.clone(),
            ],
        ),
        (
            "eyes_insight",
            vec![
                "habits/scripts/eyes_insight.js".to_string(),
                "run".to_string(),
                cli.date.clone(),
            ],
        ),
        (
            "sensory_queue_ingest",
            vec![
                "habits/scripts/sensory_queue.js".to_string(),
                "ingest".to_string(),
                cli.date.clone(),
            ],
        ),
        (
            "bridge_from_proposals",
            vec![
                "systems/actuation/bridge_from_proposals.js".to_string(),
                "run".to_string(),
                cli.date.clone(),
            ],
        ),
    ] {
        if let Err(reason) = step(root, name, args, &mut ledger, &cli.mode, &cli.date) {
            ledger.append(json!({
                "type": "spine_run_failed",
                "mode": cli.mode,
                "date": cli.date,
                "failure_reason": reason
            }));
            return 1;
        }
    }

    let mut evidence_ok = 0i64;
    let evidence_plan = if cli.mode == "daily" {
        let configured = std::env::var("AUTONOMY_EVIDENCE_RUNS")
            .ok()
            .and_then(|v| v.parse::<i64>().ok());
        let budget_pressure = std::env::var("SPINE_BUDGET_PRESSURE").ok();
        let projected_pressure = std::env::var("SPINE_PROJECTED_BUDGET_PRESSURE").ok();
        let plan = compute_evidence_run_plan(
            configured,
            budget_pressure.as_deref(),
            projected_pressure.as_deref(),
        );

        let runs = plan
            .get("evidence_runs")
            .and_then(Value::as_i64)
            .unwrap_or(0)
            .max(0);

        let type_cap = std::env::var("SPINE_AUTONOMY_EVIDENCE_MAX_PER_TYPE")
            .ok()
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(1)
            .clamp(0, 6);
        let mut per_type = HashMap::<String, i64>::new();

        for idx in 0..runs {
            let res = run_node_json(
                root,
                &[
                    "systems/autonomy/autonomy_controller.js".to_string(),
                    "evidence".to_string(),
                    cli.date.clone(),
                ],
            );
            let proposal_type = res
                .payload
                .as_ref()
                .and_then(|p| p.get("proposal_type"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();

            let current = per_type.get(&proposal_type).copied().unwrap_or(0);
            let over_cap = type_cap > 0 && !proposal_type.is_empty() && current >= type_cap;
            if over_cap {
                ledger.append(json!({
                    "type": "spine_autonomy_evidence_skipped_type_cap",
                    "mode": cli.mode,
                    "date": cli.date,
                    "attempt": idx + 1,
                    "proposal_type": proposal_type,
                    "type_cap": type_cap
                }));
                continue;
            }

            if !proposal_type.is_empty() {
                per_type.insert(proposal_type.clone(), current + 1);
            }

            if res.ok {
                evidence_ok += 1;
            }
            ledger.append(json!({
                "type": "spine_autonomy_evidence",
                "mode": cli.mode,
                "date": cli.date,
                "attempt": idx + 1,
                "ok": res.ok,
                "proposal_type": if proposal_type.is_empty() { Value::Null } else { Value::String(proposal_type) },
                "preview_receipt_id": res.payload.as_ref().and_then(|p| p.get("preview_receipt_id")).cloned().unwrap_or(Value::Null),
                "reason": if res.ok { Value::Null } else { Value::String(clean_reason(&res.stderr, &res.stdout)) }
            }));
        }

        plan
    } else {
        json!({
            "configured_runs": 0,
            "budget_pressure": "none",
            "projected_pressure": "none",
            "pressure_throttle": false,
            "evidence_runs": 0
        })
    };

    if cli.mode == "daily" {
        for (name, args) in [
            (
                "queue_gc",
                vec![
                    "habits/scripts/queue_gc.js".to_string(),
                    "run".to_string(),
                    cli.date.clone(),
                ],
            ),
            (
                "git_outcomes",
                vec![
                    "habits/scripts/git_outcomes.js".to_string(),
                    "run".to_string(),
                    cli.date.clone(),
                ],
            ),
            (
                "dopamine_closeout",
                vec![
                    "habits/scripts/dopamine_engine.js".to_string(),
                    "closeout".to_string(),
                    cli.date.clone(),
                ],
            ),
            (
                "sensory_digest_daily",
                vec![
                    "habits/scripts/sensory_digest.js".to_string(),
                    "daily".to_string(),
                    cli.date.clone(),
                ],
            ),
        ] {
            if let Err(reason) = step(root, name, args, &mut ledger, &cli.mode, &cli.date) {
                ledger.append(json!({
                    "type": "spine_run_failed",
                    "mode": cli.mode,
                    "date": cli.date,
                    "failure_reason": reason
                }));
                return 1;
            }
        }
    }

    let claim_evidence = json!([
        {
            "id": "constitution_integrity",
            "claim": "agent_constitution_integrity_verified",
            "evidence": {
                "constitution_hash": constitution_hash,
                "integrity_ok": constitution_ok
            }
        },
        {
            "id": "evidence_loop",
            "claim": "autonomy_evidence_loop_respected_budget_plan",
            "evidence": {
                "plan": evidence_plan,
                "evidence_ok": evidence_ok
            }
        }
    ]);

    let persona_lenses = json!({
        "guardian": {
            "clearance": std::env::var("CLEARANCE").ok().unwrap_or_else(|| "3".to_string()),
            "constitution_integrity_ok": constitution_ok
        },
        "strategist": {
            "mode": cli.mode,
            "evidence_runs": evidence_plan.get("evidence_runs").and_then(Value::as_i64).unwrap_or(0)
        }
    });

    let mut receipt = json!({
        "ok": true,
        "type": "spine_run_complete",
        "ts": now_iso(),
        "run_id": run_id,
        "mode": cli.mode,
        "date": cli.date,
        "claim_evidence": claim_evidence,
        "persona_lenses": persona_lenses,
        "evidence_plan": evidence_plan,
        "evidence_ok": evidence_ok
    });
    receipt["receipt_hash"] = Value::String(receipt_hash(&receipt));

    ledger.append(receipt.clone());

    println!(
        "{}",
        serde_json::to_string(&receipt)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );

    0
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let (use_legacy, cleaned_argv) = split_legacy_fallback_flag(argv, "PROTHEUS_OPS_SPINE_LEGACY");
    if use_legacy {
        return run_legacy_script(root, LEGACY_SCRIPT_REL, &cleaned_argv, "spine");
    }

    let Some(cli) = parse_cli(&cleaned_argv) else {
        usage();
        return 2;
    };

    execute_native(root, &cli)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parity_fixture_evidence_plan_matches_ts_rules() {
        let a = compute_evidence_run_plan(Some(2), Some("none"), Some("none"));
        assert_eq!(a.get("evidence_runs").and_then(Value::as_i64), Some(2));

        let b = compute_evidence_run_plan(Some(2), Some("soft"), Some("none"));
        assert_eq!(
            b.get("pressure_throttle").and_then(Value::as_bool),
            Some(true)
        );
        assert_eq!(b.get("evidence_runs").and_then(Value::as_i64), Some(1));
    }

    #[test]
    fn deterministic_receipt_hash_for_fixture() {
        let payload = json!({
            "ok": true,
            "type": "spine_run_complete",
            "mode": "eyes",
            "date": "2026-03-04",
            "claim_evidence": [{"id":"c1","claim":"x","evidence":{"a":1}}]
        });
        let h1 = receipt_hash(&payload);
        let h2 = receipt_hash(&payload);
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 64);
    }

    #[test]
    fn parse_cli_supports_run_alias() {
        let args = vec![
            "run".to_string(),
            "daily".to_string(),
            "2026-03-04".to_string(),
            "--max-eyes=7".to_string(),
        ];
        let parsed = parse_cli(&args).expect("parsed");
        assert_eq!(parsed.mode, "daily");
        assert_eq!(parsed.date, "2026-03-04");
        assert_eq!(parsed.max_eyes, Some(7));
    }
}
