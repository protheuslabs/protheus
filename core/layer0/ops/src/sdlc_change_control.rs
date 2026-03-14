// SPDX-License-Identifier: Apache-2.0
use crate::{deterministic_receipt_hash, now_iso, parse_args};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

const LANE_ID: &str = "sdlc_change_control";
const DEFAULT_POLICY_REL: &str = "client/runtime/config/sdlc_change_control_policy.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum RiskClass {
    Standard,
    Major,
    HighRisk,
}

impl RiskClass {
    fn as_str(&self) -> &'static str {
        match self {
            RiskClass::Standard => "standard",
            RiskClass::Major => "major",
            RiskClass::HighRisk => "high-risk",
        }
    }

    fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "standard" => Some(RiskClass::Standard),
            "major" => Some(RiskClass::Major),
            "high-risk" | "high_risk" | "highrisk" => Some(RiskClass::HighRisk),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
struct Policy {
    strict_default: bool,
    high_risk_path_prefixes: Vec<String>,
    major_path_prefixes: Vec<String>,
    required_approvers_major: usize,
    required_approvers_high_risk: usize,
    require_rfc_for_major: bool,
    require_adr_for_high_risk: bool,
    require_rollback_drill_for_high_risk: bool,
    require_approval_receipts_for_major: bool,
    latest_path: PathBuf,
    history_path: PathBuf,
    policy_path: PathBuf,
}

#[derive(Debug, Clone, Default)]
struct ChangeControlFields {
    risk_class_raw: String,
    rfc_link: String,
    adr_link: String,
    rollback_owner: String,
    rollback_plan: String,
    approvers: Vec<String>,
    approval_receipts: Vec<String>,
    rollback_drill_receipt: String,
}

fn usage() {
    println!("Usage:");
    println!("  protheus-ops sdlc-change-control run [--strict=1|0] [--policy=<path>] [--pr-body-path=<path>] [--changed-paths-path=<path>]");
    println!("  protheus-ops sdlc-change-control status [--policy=<path>]");
}

fn print_json_line(value: &Value) {
    println!(
        "{}",
        serde_json::to_string(value)
            .unwrap_or_else(|_| "{\"ok\":false,\"error\":\"encode_failed\"}".to_string())
    );
}

fn bool_flag(raw: Option<&String>, fallback: bool) -> bool {
    match raw.map(|v| v.trim().to_ascii_lowercase()) {
        Some(v) if matches!(v.as_str(), "1" | "true" | "yes" | "on") => true,
        Some(v) if matches!(v.as_str(), "0" | "false" | "no" | "off") => false,
        _ => fallback,
    }
}

fn resolve_path(root: &Path, raw: Option<&str>, fallback: &str) -> PathBuf {
    let token = raw.unwrap_or(fallback).trim();
    if token.is_empty() {
        return root.join(fallback);
    }
    let candidate = PathBuf::from(token);
    if candidate.is_absolute() {
        candidate
    } else {
        root.join(candidate)
    }
}

fn split_csv(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
        .collect::<Vec<_>>()
}

fn canonical_key(line: &str) -> String {
    line.chars()
        .map(|c| c.to_ascii_lowercase())
        .filter(|c| c.is_ascii_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
        .collect::<String>()
        .replace('_', " ")
        .trim()
        .to_string()
}

fn parse_pr_body_fields(body: &str) -> ChangeControlFields {
    let mut fields = ChangeControlFields::default();

    for line in body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let normalized = trimmed
            .trim_start_matches('-')
            .trim_start_matches('*')
            .trim();
        let Some((k, v)) = normalized.split_once(':') else {
            continue;
        };
        let key = canonical_key(k);
        let value = v.trim().to_string();

        match key.as_str() {
            "risk class" => fields.risk_class_raw = value,
            "rfc" | "rfc link" | "rfc ref" => fields.rfc_link = value,
            "adr" | "adr link" | "adr ref" => fields.adr_link = value,
            "rollback owner" => fields.rollback_owner = value,
            "rollback plan" => fields.rollback_plan = value,
            "approvers" => fields.approvers = split_csv(&value),
            "approval receipts" | "approval receipt" => {
                fields.approval_receipts = split_csv(&value)
            }
            "rollback drill receipt" => fields.rollback_drill_receipt = value,
            _ => {}
        }
    }

    fields
}

fn load_changed_paths(path: &Path) -> Vec<String> {
    let Ok(raw) = fs::read_to_string(path) else {
        return Vec::new();
    };
    raw.lines()
        .map(|line| line.trim().replace('\\', "/"))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
}

fn starts_with_any(path: &str, prefixes: &[String]) -> bool {
    prefixes.iter().any(|prefix| path.starts_with(prefix))
}

fn infer_risk_class(changed_paths: &[String], policy: &Policy) -> RiskClass {
    if changed_paths
        .iter()
        .any(|path| starts_with_any(path, &policy.high_risk_path_prefixes))
    {
        return RiskClass::HighRisk;
    }
    if changed_paths
        .iter()
        .any(|path| starts_with_any(path, &policy.major_path_prefixes))
    {
        return RiskClass::Major;
    }
    RiskClass::Standard
}

fn ref_is_present(raw: &str) -> bool {
    let value = raw.trim();
    !value.is_empty() && !matches!(value.to_ascii_lowercase().as_str(), "n/a" | "none" | "tbd")
}

fn looks_like_url(raw: &str) -> bool {
    let value = raw.trim().to_ascii_lowercase();
    value.starts_with("http://") || value.starts_with("https://")
}

fn ref_exists(root: &Path, raw: &str) -> bool {
    if !ref_is_present(raw) {
        return false;
    }
    if looks_like_url(raw) {
        return true;
    }
    root.join(raw.trim()).exists()
}

fn ensure_parent(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
}

fn write_text_atomic(path: &Path, text: &str) -> Result<(), String> {
    ensure_parent(path);
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&tmp, text).map_err(|e| format!("write_tmp_failed:{}:{e}", path.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("rename_tmp_failed:{}:{e}", path.display()))
}

fn append_jsonl(path: &Path, value: &Value) -> Result<(), String> {
    ensure_parent(path);
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("open_jsonl_failed:{}:{e}", path.display()))?;
    let line = serde_json::to_string(value).map_err(|e| format!("encode_jsonl_failed:{e}"))?;
    f.write_all(line.as_bytes())
        .and_then(|_| f.write_all(b"\n"))
        .map_err(|e| format!("append_jsonl_failed:{}:{e}", path.display()))
}

fn load_policy(root: &Path, policy_override: Option<&String>) -> Policy {
    let policy_path = policy_override
        .map(PathBuf::from)
        .unwrap_or_else(|| root.join(DEFAULT_POLICY_REL));

    let raw = fs::read_to_string(&policy_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| json!({}));

    let high_risk_path_prefixes = raw
        .get("high_risk_path_prefixes")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|v| v.trim().replace('\\', "/"))
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|rows| !rows.is_empty())
        .unwrap_or_else(|| {
            vec![
                "core/layer0/security/".to_string(),
                "core/layer2/conduit/".to_string(),
                "client/runtime/systems/security/".to_string(),
                "client/runtime/config/protheus_conduit_policy.json".to_string(),
                "client/runtime/config/rust_source_of_truth_policy.json".to_string(),
            ]
        });

    let major_path_prefixes = raw
        .get("major_path_prefixes")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(Value::as_str)
                .map(|v| v.trim().replace('\\', "/"))
                .filter(|v| !v.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|rows| !rows.is_empty())
        .unwrap_or_else(|| {
            vec![
                "core/layer0/ops/".to_string(),
                "client/runtime/systems/ops/".to_string(),
                ".github/workflows/".to_string(),
                "client/runtime/config/".to_string(),
            ]
        });

    let outputs = raw.get("outputs").and_then(Value::as_object);

    Policy {
        strict_default: raw
            .get("strict_default")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        high_risk_path_prefixes,
        major_path_prefixes,
        required_approvers_major: raw
            .get("required_approvers_major")
            .and_then(Value::as_u64)
            .unwrap_or(1) as usize,
        required_approvers_high_risk: raw
            .get("required_approvers_high_risk")
            .and_then(Value::as_u64)
            .unwrap_or(2) as usize,
        require_rfc_for_major: raw
            .get("require_rfc_for_major")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        require_adr_for_high_risk: raw
            .get("require_adr_for_high_risk")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        require_rollback_drill_for_high_risk: raw
            .get("require_rollback_drill_for_high_risk")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        require_approval_receipts_for_major: raw
            .get("require_approval_receipts_for_major")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        latest_path: resolve_path(
            root,
            outputs
                .and_then(|o| o.get("latest_path"))
                .and_then(Value::as_str),
            "local/state/ops/sdlc_change_control/latest.json",
        ),
        history_path: resolve_path(
            root,
            outputs
                .and_then(|o| o.get("history_path"))
                .and_then(Value::as_str),
            "local/state/ops/sdlc_change_control/history.jsonl",
        ),
        policy_path,
    }
}

fn evaluate(root: &Path, policy: &Policy, pr_body_path: &Path, changed_paths_path: &Path) -> Value {
    let pr_body = fs::read_to_string(pr_body_path).unwrap_or_default();
    let fields = parse_pr_body_fields(&pr_body);
    let changed_paths = load_changed_paths(changed_paths_path);

    let inferred = infer_risk_class(&changed_paths, policy);
    let declared = RiskClass::parse(&fields.risk_class_raw).unwrap_or(RiskClass::Standard);

    let mut checks = BTreeMap::<String, Value>::new();
    checks.insert(
        "declared_risk_class_valid".to_string(),
        json!({
            "ok": RiskClass::parse(&fields.risk_class_raw).is_some(),
            "declared": fields.risk_class_raw,
            "allowed": ["standard", "major", "high-risk"]
        }),
    );
    checks.insert(
        "declared_not_understated".to_string(),
        json!({
            "ok": declared >= inferred,
            "declared": declared.as_str(),
            "inferred": inferred.as_str()
        }),
    );

    let rollback_plan_ok = ref_is_present(&fields.rollback_plan);
    checks.insert(
        "rollback_plan_present".to_string(),
        json!({
            "ok": rollback_plan_ok,
            "value": fields.rollback_plan
        }),
    );

    let rollback_owner_ok = ref_is_present(&fields.rollback_owner);
    checks.insert(
        "rollback_owner_present".to_string(),
        json!({
            "ok": rollback_owner_ok,
            "value": fields.rollback_owner
        }),
    );

    let rfc_ok = if declared >= RiskClass::Major && policy.require_rfc_for_major {
        ref_exists(root, &fields.rfc_link)
    } else {
        true
    };
    checks.insert(
        "rfc_link_requirement".to_string(),
        json!({
            "ok": rfc_ok,
            "required": declared >= RiskClass::Major && policy.require_rfc_for_major,
            "value": fields.rfc_link
        }),
    );

    let adr_ok = if declared == RiskClass::HighRisk && policy.require_adr_for_high_risk {
        ref_exists(root, &fields.adr_link)
    } else {
        true
    };
    checks.insert(
        "adr_link_requirement".to_string(),
        json!({
            "ok": adr_ok,
            "required": declared == RiskClass::HighRisk && policy.require_adr_for_high_risk,
            "value": fields.adr_link
        }),
    );

    let approver_req = if declared == RiskClass::HighRisk {
        policy.required_approvers_high_risk
    } else if declared == RiskClass::Major {
        policy.required_approvers_major
    } else {
        0
    };
    let approvers_ok = fields.approvers.len() >= approver_req;
    checks.insert(
        "approver_requirement".to_string(),
        json!({
            "ok": approvers_ok,
            "required_count": approver_req,
            "actual_count": fields.approvers.len(),
            "approvers": fields.approvers
        }),
    );

    let approval_receipts_ok =
        if declared >= RiskClass::Major && policy.require_approval_receipts_for_major {
            !fields.approval_receipts.is_empty()
                && fields
                    .approval_receipts
                    .iter()
                    .all(|receipt| ref_exists(root, receipt))
        } else {
            true
        };
    checks.insert(
        "approval_receipts_requirement".to_string(),
        json!({
            "ok": approval_receipts_ok,
            "required": declared >= RiskClass::Major && policy.require_approval_receipts_for_major,
            "receipts": fields.approval_receipts
        }),
    );

    let rollback_drill_ok =
        if declared == RiskClass::HighRisk && policy.require_rollback_drill_for_high_risk {
            ref_exists(root, &fields.rollback_drill_receipt)
        } else {
            true
        };
    checks.insert(
        "rollback_drill_requirement".to_string(),
        json!({
            "ok": rollback_drill_ok,
            "required": declared == RiskClass::HighRisk && policy.require_rollback_drill_for_high_risk,
            "value": fields.rollback_drill_receipt
        }),
    );

    let blocking_checks = checks
        .iter()
        .filter_map(|(k, v)| {
            if v.get("ok").and_then(Value::as_bool).unwrap_or(false) {
                None
            } else {
                Some(k.clone())
            }
        })
        .collect::<Vec<_>>();

    let ok = blocking_checks.is_empty();

    json!({
        "ok": ok,
        "type": "sdlc_change_control_run",
        "schema_id": "sdlc_change_control",
        "schema_version": "1.0",
        "lane": LANE_ID,
        "ts": now_iso(),
        "declared_risk_class": declared.as_str(),
        "inferred_risk_class": inferred.as_str(),
        "checks": checks,
        "blocking_checks": blocking_checks,
        "inputs": {
            "pr_body_path": pr_body_path,
            "changed_paths_path": changed_paths_path,
            "changed_paths_count": changed_paths.len()
        },
        "claim_evidence": [
            {
                "id": "sdlc_change_class_enforcement",
                "claim": "risk_classes_enforce_rfc_adr_approvals_and_rollback_ownership",
                "evidence": {
                    "declared": declared.as_str(),
                    "inferred": inferred.as_str(),
                    "approver_requirement": approver_req,
                    "approver_count": fields.approvers.len(),
                    "rollback_owner_present": rollback_owner_ok,
                    "rollback_plan_present": rollback_plan_ok
                }
            },
            {
                "id": "sdlc_high_risk_merge_gate",
                "claim": "high_risk_changes_fail_closed_without_approval_receipts_and_rollback_drill_evidence",
                "evidence": {
                    "high_risk": declared == RiskClass::HighRisk,
                    "approval_receipts_ok": approval_receipts_ok,
                    "rollback_drill_ok": rollback_drill_ok
                }
            }
        ]
    })
}

fn run_cmd(
    root: &Path,
    policy: &Policy,
    strict: bool,
    pr_body_path: &Path,
    changed_paths_path: &Path,
) -> Result<(Value, i32), String> {
    let mut payload = evaluate(root, policy, pr_body_path, changed_paths_path);
    payload["strict"] = Value::Bool(strict);
    payload["policy_path"] = Value::String(policy.policy_path.to_string_lossy().to_string());
    payload["receipt_hash"] = Value::String(deterministic_receipt_hash(&payload));

    write_text_atomic(
        &policy.latest_path,
        &format!(
            "{}\n",
            serde_json::to_string_pretty(&payload)
                .map_err(|e| format!("encode_latest_failed:{e}"))?
        ),
    )?;
    append_jsonl(&policy.history_path, &payload)?;

    let code = if strict && !payload.get("ok").and_then(Value::as_bool).unwrap_or(false) {
        1
    } else {
        0
    };

    Ok((payload, code))
}

fn status_cmd(policy: &Policy) -> Value {
    let latest = fs::read_to_string(&policy.latest_path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .unwrap_or_else(|| {
            json!({
                "ok": false,
                "type": "sdlc_change_control_status",
                "error": "latest_missing"
            })
        });

    let mut out = json!({
        "ok": latest.get("ok").and_then(Value::as_bool).unwrap_or(false),
        "type": "sdlc_change_control_status",
        "lane": LANE_ID,
        "ts": now_iso(),
        "latest": latest,
        "policy_path": policy.policy_path,
        "latest_path": policy.latest_path,
        "history_path": policy.history_path
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn cli_error_receipt(argv: &[String], err: &str, code: i32) -> Value {
    let mut out = json!({
        "ok": false,
        "type": "sdlc_change_control_cli_error",
        "lane": LANE_ID,
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
    let strict = bool_flag(parsed.flags.get("strict"), policy.strict_default);
    let pr_body_path = resolve_path(
        root,
        parsed.flags.get("pr-body-path").map(String::as_str),
        "local/state/ops/sdlc_change_control/pr_body.md",
    );
    let changed_paths_path = resolve_path(
        root,
        parsed.flags.get("changed-paths-path").map(String::as_str),
        "local/state/ops/sdlc_change_control/changed_paths.txt",
    );

    match cmd.as_str() {
        "run" => match run_cmd(root, &policy, strict, &pr_body_path, &changed_paths_path) {
            Ok((payload, code)) => {
                print_json_line(&payload);
                code
            }
            Err(err) => {
                print_json_line(&cli_error_receipt(argv, &format!("run_failed:{err}"), 1));
                1
            }
        },
        "status" => {
            print_json_line(&status_cmd(&policy));
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
    use tempfile::tempdir;

    fn write_text(path: &Path, text: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("create parent");
        }
        fs::write(path, text).expect("write text");
    }

    fn write_policy(root: &Path) {
        write_text(
            &root.join("client/runtime/config/sdlc_change_control_policy.json"),
            &json!({
                "strict_default": true,
                "required_approvers_major": 1,
                "required_approvers_high_risk": 2,
                "require_rfc_for_major": true,
                "require_adr_for_high_risk": true,
                "require_rollback_drill_for_high_risk": true,
                "require_approval_receipts_for_major": true,
                "high_risk_path_prefixes": ["core/layer0/security/", "client/runtime/systems/security/"],
                "major_path_prefixes": ["core/layer0/ops/", "client/runtime/systems/ops/"],
                "outputs": {
                    "latest_path": "local/state/ops/sdlc_change_control/latest.json",
                    "history_path": "local/state/ops/sdlc_change_control/history.jsonl"
                }
            }).to_string(),
        );
    }

    #[test]
    fn high_risk_change_requires_full_approval_bundle() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        write_policy(root);

        write_text(
            &root.join("local/state/ops/sdlc_change_control/pr_body.md"),
            "- Risk class: high-risk\n- Rollback plan: revert and freeze\n- Rollback owner: ops-oncall\n- Approvers: alice\n- Approval receipts: docs/client/approvals/one.md\n- Rollback drill receipt: docs/client/drills/rollback.json\n",
        );
        write_text(
            &root.join("local/state/ops/sdlc_change_control/changed_paths.txt"),
            "core/layer0/security/src/lib.rs\n",
        );

        write_text(&root.join("docs/client/approvals/one.md"), "ok");
        write_text(&root.join("docs/client/drills/rollback.json"), "{}");

        let code = run(
            root,
            &[
                "run".to_string(),
                "--strict=1".to_string(),
                "--pr-body-path=local/state/ops/sdlc_change_control/pr_body.md".to_string(),
                "--changed-paths-path=local/state/ops/sdlc_change_control/changed_paths.txt".to_string(),
            ],
        );
        assert_eq!(code, 1);

        let latest =
            fs::read_to_string(root.join("local/state/ops/sdlc_change_control/latest.json")).unwrap();
        let payload: Value = serde_json::from_str(&latest).unwrap();
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(false));
        assert!(payload
            .get("blocking_checks")
            .and_then(Value::as_array)
            .map(|rows| rows
                .iter()
                .any(|v| v.as_str() == Some("adr_link_requirement")))
            .unwrap_or(false));
    }

    #[test]
    fn major_change_passes_with_rfc_and_single_approver() {
        let temp = tempdir().expect("tempdir");
        let root = temp.path();
        write_policy(root);

        write_text(&root.join("docs/client/rfc/RFC-1.md"), "rfc");
        write_text(&root.join("docs/client/approvals/approve-1.md"), "receipt");

        write_text(
            &root.join("local/state/ops/sdlc_change_control/pr_body.md"),
            "- Risk class: major\n- RFC link: docs/client/rfc/RFC-1.md\n- Rollback plan: git revert\n- Rollback owner: platform\n- Approvers: alice\n- Approval receipts: docs/client/approvals/approve-1.md\n",
        );
        write_text(
            &root.join("local/state/ops/sdlc_change_control/changed_paths.txt"),
            "core/layer0/ops/src/main.rs\n",
        );

        let code = run(
            root,
            &[
                "run".to_string(),
                "--strict=1".to_string(),
                "--pr-body-path=local/state/ops/sdlc_change_control/pr_body.md".to_string(),
                "--changed-paths-path=local/state/ops/sdlc_change_control/changed_paths.txt".to_string(),
            ],
        );
        assert_eq!(code, 0);

        let latest =
            fs::read_to_string(root.join("local/state/ops/sdlc_change_control/latest.json")).unwrap();
        let payload: Value = serde_json::from_str(&latest).unwrap();
        assert_eq!(payload.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(
            payload.get("declared_risk_class").and_then(Value::as_str),
            Some("major")
        );
    }
}
