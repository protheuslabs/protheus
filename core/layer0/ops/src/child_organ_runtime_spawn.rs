// SPDX-License-Identifier: Apache-2.0
use super::*;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

fn truncate_bytes(input: &str, max_bytes: usize) -> String {
    if input.as_bytes().len() <= max_bytes {
        return input.to_string();
    }
    let mut out = String::new();
    for ch in input.chars() {
        if out.as_bytes().len() + ch.len_utf8() > max_bytes {
            break;
        }
        out.push(ch);
    }
    out
}

fn run_child(
    root: &Path,
    command: &str,
    args: &[String],
    budget: &Budget,
) -> Result<(i32, String, String, u64, bool), String> {
    let mut child = Command::new(command)
        .args(args)
        .current_dir(root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("spawn_failed:{err}"))?;

    let start = Instant::now();
    let mut timeout_hit = false;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if start.elapsed() >= Duration::from_millis(budget.max_runtime_ms) {
                    timeout_hit = true;
                    let _ = child.kill();
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(err) => return Err(format!("wait_failed:{err}")),
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|err| format!("wait_output_failed:{err}"))?;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    let exit_code = output
        .status
        .code()
        .unwrap_or(if timeout_hit { 124 } else { 1 });
    let stdout = truncate_bytes(
        &String::from_utf8_lossy(&output.stdout),
        budget.max_output_bytes,
    );
    let stderr = truncate_bytes(
        &String::from_utf8_lossy(&output.stderr),
        budget.max_output_bytes,
    );
    Ok((exit_code, stdout, stderr, elapsed_ms, timeout_hit))
}

pub(super) fn spawn_payload(
    root: &Path,
    policy: &RuntimePolicy,
    argv: &[String],
) -> Result<Value, String> {
    let organ_id = clean_id(parse_flag(argv, "organ-id").as_deref(), "organ");
    let command = clean_text(parse_flag(argv, "command").as_deref(), 128);
    if command.is_empty() {
        return Err("command_missing".to_string());
    }
    let apply = parse_bool(parse_flag(argv, "apply").as_deref(), true);
    let args = collect_flags(argv, "arg")
        .into_iter()
        .map(|v| clean_text(Some(v.as_str()), 512))
        .collect::<Vec<_>>();

    let inline_budget = parse_budget(parse_flag(argv, "budget-json").as_deref(), policy)?;
    let plan_budget = load_plan_map(root)
        .get(&organ_id)
        .map(|v| budget_from_plan_value(v, policy));
    let budget = plan_budget.unwrap_or(inline_budget);

    if !budget.allow_commands.iter().any(|c| c == &command) {
        return Err("command_blocked_by_budget_policy".to_string());
    }

    let mut run_row = json!({
        "organ_id": organ_id,
        "command": command,
        "args": args,
        "started_at": now_iso(),
        "budget": {
            "max_runtime_ms": budget.max_runtime_ms,
            "max_output_bytes": budget.max_output_bytes
        }
    });

    if apply {
        let (exit_code, stdout, stderr, elapsed_ms, timeout_hit) = run_child(
            root,
            run_row["command"].as_str().unwrap_or(""),
            run_row["args"]
                .as_array()
                .unwrap_or(&Vec::new())
                .iter()
                .filter_map(Value::as_str)
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .as_slice(),
            &budget,
        )?;
        run_row["exit_code"] = Value::Number(exit_code.into());
        run_row["elapsed_ms"] = Value::Number(elapsed_ms.into());
        run_row["timeout_hit"] = Value::Bool(timeout_hit);
        run_row["stdout"] = Value::String(stdout);
        run_row["stderr"] = Value::String(stderr);
        run_row["ok"] = Value::Bool(exit_code == 0 && !timeout_hit);
    } else {
        run_row["ok"] = Value::Bool(true);
        run_row["exit_code"] = Value::Number(0.into());
        run_row["elapsed_ms"] = Value::Number(0.into());
        run_row["timeout_hit"] = Value::Bool(false);
        run_row["stdout"] = Value::String(String::new());
        run_row["stderr"] = Value::String(String::new());
    }

    let run_name = format!(
        "{}_{}.json",
        clean_id(
            Some(run_row["organ_id"].as_str().unwrap_or("organ")),
            "organ"
        ),
        now_iso()
            .replace([':', '.'], "-")
            .replace('T', "_")
            .replace('Z', "")
    );
    let run_path = runs_dir(root).join(run_name);
    if apply {
        write_json(&run_path, &run_row)?;
        append_jsonl(
            &history_path(root),
            &json!({
                "type": "child_organ_spawn",
                "organ_id": run_row["organ_id"],
                "ts": now_iso(),
                "run_path": rel_path(root, &run_path),
                "ok": run_row["ok"],
                "exit_code": run_row["exit_code"],
                "timeout_hit": run_row["timeout_hit"]
            }),
        )?;
    }

    let mut out = json!({
        "ok": run_row.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "type": "child_organ_runtime_spawn",
        "lane": LANE_ID,
        "apply": apply,
        "organ_id": run_row["organ_id"],
        "run_path": rel_path(root, &run_path),
        "exit_code": run_row["exit_code"],
        "elapsed_ms": run_row["elapsed_ms"],
        "timeout_hit": run_row["timeout_hit"],
        "stdout": run_row["stdout"],
        "stderr": run_row["stderr"],
        "budget": run_row["budget"],
        "claim_evidence": [{
            "id": "spawn_with_budget_isolation",
            "claim": "child_organ_executes_under_command_allowlist_and_runtime_budget",
            "evidence": {
                "command": run_row["command"],
                "max_runtime_ms": budget.max_runtime_ms,
                "max_output_bytes": budget.max_output_bytes
            }
        }]
    });
    out["receipt_hash"] = Value::String(receipt_hash(&out));
    Ok(out)
}
