// Layer ownership: core/layer2/ops (authoritative)
// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_epoch_ms};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

const CONTRACT_ROOT: &str = "planes/contracts/srs";
const STATE_ROOT: &str = "state/ops/srs_contract_runtime";
const HISTORY_FILE: &str = "history.jsonl";

fn contract_path(root: &Path, id: &str) -> PathBuf {
    root.join(CONTRACT_ROOT).join(format!("{id}.json"))
}

fn latest_path(root: &Path, id: &str) -> PathBuf {
    root.join(STATE_ROOT).join(id).join("latest.json")
}

fn history_path(root: &Path) -> PathBuf {
    root.join(STATE_ROOT).join(HISTORY_FILE)
}

fn read_json(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("read_failed:{e}"))?;
    serde_json::from_str::<Value>(&raw).map_err(|e| format!("parse_failed:{e}"))
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{e}"))?;
    }
    let mut body = serde_json::to_string_pretty(value).map_err(|e| format!("encode_failed:{e}"))?;
    body.push('\n');
    fs::write(path, body).map_err(|e| format!("write_failed:{e}"))
}

fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{e}"))?;
    }
    let line = serde_json::to_string(value).map_err(|e| format!("encode_failed:{e}"))?;
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open_failed:{e}"))?;
    use std::io::Write;
    file.write_all(format!("{line}\n").as_bytes())
        .map_err(|e| format!("append_failed:{e}"))
}

fn parse_flag(argv: &[String], key: &str) -> Option<String> {
    let pref = format!("--{key}=");
    let long = format!("--{key}");
    let mut idx = 0usize;
    while idx < argv.len() {
        let token = argv[idx].trim();
        if let Some(v) = token.strip_prefix(&pref) {
            return Some(v.to_string());
        }
        if token == long && idx + 1 < argv.len() {
            return Some(argv[idx + 1].clone());
        }
        idx += 1;
    }
    None
}

fn parse_id(argv: &[String]) -> Option<String> {
    parse_flag(argv, "id")
        .or_else(|| {
            argv.iter()
                .skip(1)
                .find(|row| !row.trim().starts_with('-'))
                .cloned()
        })
        .map(|v| v.trim().to_ascii_uppercase())
        .filter(|v| !v.is_empty())
}

fn normalize_id(raw: &str) -> Option<String> {
    let id = raw.trim().to_ascii_uppercase();
    if id.is_empty() {
        None
    } else {
        Some(id)
    }
}

fn parse_id_list(root: &Path, argv: &[String]) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();

    if let Some(csv) = parse_flag(argv, "ids") {
        for token in csv.split(',') {
            if let Some(id) = normalize_id(token) {
                out.push(id);
            }
        }
    }

    if let Some(file) = parse_flag(argv, "ids-file") {
        let fpath = if Path::new(&file).is_absolute() {
            PathBuf::from(file)
        } else {
            root.join(file)
        };
        let raw = fs::read_to_string(&fpath).map_err(|e| format!("ids_file_read_failed:{e}"))?;
        for line in raw.lines() {
            for token in line.split(',') {
                if let Some(id) = normalize_id(token) {
                    out.push(id);
                }
            }
        }
    }

    if out.is_empty() {
        if let Some(id) = parse_id(argv) {
            out.push(id);
        }
    }

    if out.is_empty() {
        return Err("missing_ids".to_string());
    }

    out.sort();
    out.dedup();
    Ok(out)
}

fn validate_contract_shape(id: &str, contract: &Value) -> Result<(), String> {
    let cid = contract
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "contract_missing_id".to_string())?;
    if cid != id {
        return Err("contract_id_mismatch".to_string());
    }
    if contract
        .get("upgrade")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        return Err("contract_missing_upgrade".to_string());
    }
    if contract
        .get("layer_map")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .is_empty()
    {
        return Err("contract_missing_layer_map".to_string());
    }
    if contract
        .get("deliverables")
        .and_then(Value::as_array)
        .map(|rows| rows.is_empty())
        .unwrap_or(true)
    {
        return Err("contract_missing_deliverables".to_string());
    }
    Ok(())
}

fn with_hash(mut payload: Value) -> Value {
    payload["receipt_hash"] = Value::String(deterministic_receipt_hash(&payload));
    payload
}

pub fn contract_exists(root: &Path, id: &str) -> bool {
    contract_path(root, &id.to_ascii_uppercase()).exists()
}

pub fn execute_contract(root: &Path, id: &str) -> Result<Value, String> {
    let normalized_id = id.trim().to_ascii_uppercase();
    if normalized_id.is_empty() {
        return Err("missing_id".to_string());
    }

    let cpath = contract_path(root, &normalized_id);
    if !cpath.exists() {
        return Err("contract_not_found".to_string());
    }

    let contract = read_json(&cpath)?;
    validate_contract_shape(&normalized_id, &contract)?;

    let contract_bytes =
        serde_json::to_vec(&contract).map_err(|e| format!("contract_encode_failed:{e}"))?;
    let mut hasher = Sha256::new();
    hasher.update(contract_bytes);
    let contract_digest = format!("sha256:{}", hex::encode(hasher.finalize()));
    let now_ms = now_epoch_ms();

    let receipt = with_hash(json!({
        "ok": true,
        "type": "srs_contract_runtime_receipt",
        "lane": "srs_contract_runtime",
        "id": normalized_id,
        "ts_epoch_ms": now_ms,
        "contract_path": cpath.to_string_lossy(),
        "contract_digest": contract_digest,
        "contract": contract,
        "claim_evidence": [
            {
                "id": normalized_id,
                "claim": "srs_actionable_item_has_contract_receipt_and_deliverables",
                "evidence": {
                    "lane": "core/layer2/ops:srs_contract_runtime",
                    "state_root": STATE_ROOT
                }
            }
        ]
    }));

    write_json(&latest_path(root, &normalized_id), &receipt)?;
    append_jsonl(&history_path(root), &receipt)?;
    Ok(receipt)
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops srs-contract-runtime run --id=<V6-...>");
    println!("  protheus-ops srs-contract-runtime run-many --ids=<ID1,ID2,...>");
    println!("  protheus-ops srs-contract-runtime run-many --ids-file=<path>");
    println!("  protheus-ops srs-contract-runtime status --id=<V6-...>");
}

pub fn run(root: &Path, argv: &[String]) -> i32 {
    let cmd = argv
        .first()
        .map(|v| v.trim().to_ascii_lowercase())
        .unwrap_or_else(|| "status".to_string());

    if matches!(cmd.as_str(), "help" | "--help" | "-h") {
        usage();
        return 0;
    }

    match cmd.as_str() {
        "run-many" | "run-batch" => {
            let ids = match parse_id_list(root, argv) {
                Ok(rows) => rows,
                Err(code) => {
                    print_json_line(&with_hash(json!({
                        "ok": false,
                        "type": "srs_contract_runtime_error",
                        "code": code,
                        "message": "expected --ids=<ID1,ID2> or --ids-file=<path>"
                    })));
                    return 2;
                }
            };

            let mut results: Vec<Value> = Vec::new();
            let mut executed = 0usize;
            let mut failed = 0usize;
            for id in &ids {
                match execute_contract(root, id) {
                    Ok(receipt) => {
                        executed += 1;
                        results.push(json!({
                            "id": id,
                            "ok": true,
                            "receipt_hash": receipt.get("receipt_hash").cloned().unwrap_or(Value::Null)
                        }));
                    }
                    Err(err) => {
                        failed += 1;
                        results.push(json!({
                            "id": id,
                            "ok": false,
                            "code": err
                        }));
                    }
                }
            }

            let out = with_hash(json!({
                "ok": failed == 0,
                "type": "srs_contract_runtime_batch_receipt",
                "lane": "srs_contract_runtime",
                "command": "run-many",
                "counts": {
                    "scanned": ids.len(),
                    "executed": executed,
                    "failed": failed
                },
                "results": results
            }));
            print_json_line(&out);
            if failed == 0 { 0 } else { 1 }
        }
        "run" => {
            let Some(id) = parse_id(argv) else {
                print_json_line(&with_hash(json!({
                    "ok": false,
                    "type": "srs_contract_runtime_error",
                    "code": "missing_id",
                    "message": "expected --id=<SRS-ID>"
                })));
                return 2;
            };
            match execute_contract(root, &id) {
            Ok(out) => {
                print_json_line(&out);
                0
            }
            Err(err) => {
                print_json_line(&with_hash(json!({
                    "ok": false,
                    "type": "srs_contract_runtime_error",
                    "id": id,
                    "code": err
                })));
                1
            }
            }
        }
        "status" => {
            let Some(id) = parse_id(argv) else {
                print_json_line(&with_hash(json!({
                    "ok": false,
                    "type": "srs_contract_runtime_error",
                    "code": "missing_id",
                    "message": "expected --id=<SRS-ID>"
                })));
                return 2;
            };
            let latest = latest_path(root, &id);
            let out = if latest.exists() {
                read_json(&latest).unwrap_or_else(|_| {
                    with_hash(json!({
                        "ok": false,
                        "type": "srs_contract_runtime_error",
                        "id": id,
                        "code": "status_read_failed"
                    }))
                })
            } else {
                with_hash(json!({
                    "ok": false,
                    "type": "srs_contract_runtime_error",
                    "id": id,
                    "code": "status_not_found"
                }))
            };
            print_json_line(&out);
            if out.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                0
            } else {
                1
            }
        }
        _ => {
            let id = parse_id(argv).unwrap_or_default();
            usage();
            print_json_line(&with_hash(json!({
                "ok": false,
                "type": "srs_contract_runtime_error",
                "id": id,
                "code": "unknown_command"
            })));
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn execute_contract_writes_latest_and_history() {
        let tmp = tempdir().expect("tmp");
        let root = tmp.path();
        let id = "V6-TEST-900.1";
        let cpath = root.join(CONTRACT_ROOT).join(format!("{id}.json"));
        if let Some(parent) = cpath.parent() {
            fs::create_dir_all(parent).expect("mkdir");
        }
        fs::write(
            &cpath,
            serde_json::to_string_pretty(&json!({
                "id": id,
                "upgrade": "Test Contract",
                "layer_map": "0/1/2",
                "deliverables": [{"type":"contract","path":"planes/contracts/srs/V6-TEST-900.1.json"}]
            }))
            .expect("encode"),
        )
        .expect("write contract");

        let receipt = execute_contract(root, id).expect("execute");
        assert_eq!(receipt.get("ok").and_then(Value::as_bool), Some(true));
        assert!(latest_path(root, id).exists());
        assert!(history_path(root).exists());
    }

    #[test]
    fn execute_contract_rejects_missing_contract() {
        let tmp = tempdir().expect("tmp");
        let root = tmp.path();
        let err = execute_contract(root, "V6-TEST-404.1").expect_err("missing");
        assert_eq!(err, "contract_not_found");
    }

    #[test]
    fn parse_id_list_supports_csv_and_file() {
        let tmp = tempdir().expect("tmp");
        let root = tmp.path();
        let ids_file = root.join("ids.txt");
        fs::write(&ids_file, "V6-TEST-100.1\nv6-test-100.2").expect("write ids");

        let argv = vec![
            "run-many".to_string(),
            "--ids=V6-TEST-100.1,V6-TEST-100.3".to_string(),
            format!("--ids-file={}", ids_file.display()),
        ];
        let ids = parse_id_list(root, &argv).expect("ids");
        assert_eq!(
            ids,
            vec![
                "V6-TEST-100.1".to_string(),
                "V6-TEST-100.2".to_string(),
                "V6-TEST-100.3".to_string()
            ]
        );
    }
}
