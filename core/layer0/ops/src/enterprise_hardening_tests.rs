// SPDX-License-Identifier: Apache-2.0
use super::*;

fn write_text(root: &Path, rel: &str, body: &str) {
    let p = root.join(rel);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).expect("mkdir");
    }
    fs::write(p, body).expect("write");
}

#[test]
fn cron_integrity_rejects_none_delivery_mode() {
    let tmp = tempfile::tempdir().expect("tmp");
    write_text(
        tmp.path(),
        "client/runtime/config/cron_jobs.json",
        r#"{"jobs":[{"id":"j1","name":"x","enabled":true,"sessionTarget":"isolated","delivery":{"mode":"none","channel":"last"}}]}"#,
    );
    let (ok, details) =
        check_cron_delivery_integrity(tmp.path(), "client/runtime/config/cron_jobs.json")
            .expect("audit");
    assert!(!ok);
    assert!(details.to_string().contains("delivery_mode_none_forbidden"));
}

#[test]
fn cron_integrity_rejects_missing_delivery_for_enabled_jobs() {
    let tmp = tempfile::tempdir().expect("tmp");
    write_text(
        tmp.path(),
        "client/runtime/config/cron_jobs.json",
        r#"{"jobs":[{"id":"j1","name":"x","enabled":true,"sessionTarget":"main"}]}"#,
    );
    let (ok, details) =
        check_cron_delivery_integrity(tmp.path(), "client/runtime/config/cron_jobs.json")
            .expect("audit");
    assert!(!ok);
    assert!(details
        .to_string()
        .contains("missing_delivery_for_enabled_job"));
}

#[test]
fn run_control_json_fields_detects_missing_field() {
    let tmp = tempfile::tempdir().expect("tmp");
    write_text(
        tmp.path(),
        "client/runtime/config/x.json",
        r#"{"a":{"b":1}}"#,
    );
    let control = json!({
        "id": "c1",
        "title": "json",
        "type": "json_fields",
        "path": "client/runtime/config/x.json",
        "required_fields": ["a.b", "a.c"]
    });
    let out = run_control(tmp.path(), control.as_object().expect("obj"));
    assert_eq!(out.get("ok").and_then(Value::as_bool), Some(false));
    assert!(out.to_string().contains("a.c"));
}

#[test]
fn enable_bedrock_produces_sigv4_private_profile() {
    let tmp = tempfile::tempdir().expect("tmp");
    write_text(
        tmp.path(),
        DEFAULT_BEDROCK_POLICY_REL,
        r#"{
  "version": "v1",
  "kind": "enterprise_bedrock_proxy_contract",
  "provider": "bedrock",
  "region": "us-west-2",
  "auth": {
    "mode": "sigv4_instance_profile",
    "require_sigv4": true
  },
  "network": {
    "vpc": "vpc-prod",
    "subnet": "subnet-private-a",
    "require_private_subnet": true
  },
  "secrets": {
    "ssm_path": "/protheus/bedrock/proxy",
    "require_ssm": true
  }
}"#,
    );
    let out = run_enable_bedrock(tmp.path(), true, &std::collections::HashMap::new())
        .expect("enable bedrock");
    assert_eq!(
        out.get("type").and_then(Value::as_str),
        Some("enterprise_hardening_enable_bedrock")
    );
    assert_eq!(out.get("ok").and_then(Value::as_bool), Some(true));
    assert!(out
        .pointer("/profile/auth/mode")
        .and_then(Value::as_str)
        .map(|row| row == "sigv4_instance_profile")
        .unwrap_or(false));
    let claim_ok = out
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .iter()
        .any(|row| row.get("id").and_then(Value::as_str) == Some("V7-ASSIMILATE-001.5.1"));
    assert!(claim_ok, "missing bedrock claim evidence");
}
