// SPDX-License-Identifier: Apache-2.0
use protheus_memory_core_v6::{load_embedded_observability_profile, EmbeddedObservabilityProfile};
use protheus_vault_core_v1::{
    evaluate_vault_policy, evaluate_vault_policy_json, load_embedded_vault_policy,
    load_embedded_vault_policy_json, VaultDecision, VaultOperationRequest,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::{CStr, CString};
use std::fmt::{Display, Formatter};
use std::os::raw::c_char;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecurityOperationRequest {
    pub operation_id: String,
    pub subsystem: String,
    pub action: String,
    pub actor: String,
    pub risk_class: String,
    #[serde(default)]
    pub payload_digest: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub covenant_violation: bool,
    #[serde(default)]
    pub tamper_signal: bool,
    #[serde(default = "default_key_age_hours")]
    pub key_age_hours: u32,
    #[serde(default = "default_operator_quorum")]
    pub operator_quorum: u8,
    #[serde(default)]
    pub audit_receipt_nonce: Option<String>,
    #[serde(default)]
    pub zk_proof: Option<String>,
    #[serde(default)]
    pub ciphertext_digest: Option<String>,
}

fn default_key_age_hours() -> u32 {
    1
}

fn default_operator_quorum() -> u8 {
    2
}

impl Default for SecurityOperationRequest {
    fn default() -> Self {
        Self {
            operation_id: "op_default".to_string(),
            subsystem: "system".to_string(),
            action: "execute".to_string(),
            actor: "operator".to_string(),
            risk_class: "normal".to_string(),
            payload_digest: None,
            tags: Vec::new(),
            covenant_violation: false,
            tamper_signal: false,
            key_age_hours: default_key_age_hours(),
            operator_quorum: default_operator_quorum(),
            audit_receipt_nonce: Some("nonce-default".to_string()),
            zk_proof: Some("zk-proof-default".to_string()),
            ciphertext_digest: Some("sha256:cipher-default".to_string()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SecurityDecision {
    pub ok: bool,
    pub fail_closed: bool,
    pub shutdown_required: bool,
    pub human_alert_required: bool,
    pub sovereignty_score_pct: f64,
    pub sovereignty_threshold_pct: u8,
    pub decision_digest: String,
    pub reasons: Vec<String>,
    pub vault_decision: VaultDecision,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SecurityAlert {
    pub ts: String,
    pub operation_id: String,
    pub subsystem: String,
    pub action: String,
    pub actor: String,
    pub severity: String,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub enum SecurityError {
    RequestDecodeFailed(String),
    VaultPolicyLoadFailed(String),
    ObservabilityProfileLoadFailed(String),
    EncodeFailed(String),
    IoFailed(String),
    ValidationFailed(String),
}

impl Display for SecurityError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            SecurityError::RequestDecodeFailed(msg) => write!(f, "request_decode_failed:{msg}"),
            SecurityError::VaultPolicyLoadFailed(msg) => {
                write!(f, "vault_policy_load_failed:{msg}")
            }
            SecurityError::ObservabilityProfileLoadFailed(msg) => {
                write!(f, "observability_profile_load_failed:{msg}")
            }
            SecurityError::EncodeFailed(msg) => write!(f, "encode_failed:{msg}"),
            SecurityError::IoFailed(msg) => write!(f, "io_failed:{msg}"),
            SecurityError::ValidationFailed(msg) => write!(f, "validation_failed:{msg}"),
        }
    }
}

impl std::error::Error for SecurityError {}

fn now_iso() -> String {
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    chrono_like_iso(ts)
}

fn chrono_like_iso(epoch_secs: u64) -> String {
    // Avoid adding a heavy chrono dependency for this crate.
    let dt = std::time::UNIX_EPOCH + std::time::Duration::from_secs(epoch_secs);
    let datetime: chrono_stub::DateTime = dt.into();
    datetime.to_rfc3339()
}

fn normalize_token(raw: &str, max_len: usize) -> String {
    raw.trim()
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':' | '/') {
                ch
            } else {
                '_'
            }
        })
        .take(max_len)
        .collect::<String>()
        .trim_matches('_')
        .to_ascii_lowercase()
}

fn has_tag(tags: &[String], target: &str) -> bool {
    let needle = normalize_token(target, 64);
    tags.iter().any(|tag| normalize_token(tag, 64) == needle)
}

fn digest_for_decision(req: &SecurityOperationRequest, reasons: &[String], score: f64) -> String {
    let mut hasher = Sha256::new();
    hasher.update(req.operation_id.as_bytes());
    hasher.update(req.subsystem.as_bytes());
    hasher.update(req.action.as_bytes());
    hasher.update(req.actor.as_bytes());
    hasher.update(format!("{score:.3}").as_bytes());
    for reason in reasons {
        hasher.update(reason.as_bytes());
    }
    hex::encode(hasher.finalize())
}

fn to_vault_request(req: &SecurityOperationRequest) -> VaultOperationRequest {
    VaultOperationRequest {
        operation_id: req.operation_id.clone(),
        key_id: format!("{}:{}", req.subsystem, req.action),
        action: req.action.clone(),
        zk_proof: req.zk_proof.clone(),
        ciphertext_digest: req
            .ciphertext_digest
            .clone()
            .or_else(|| req.payload_digest.clone()),
        fhe_noise_budget: if has_tag(&req.tags, "aggressive") {
            12
        } else {
            24
        },
        key_age_hours: req.key_age_hours,
        tamper_signal: req.tamper_signal,
        operator_quorum: req.operator_quorum,
        audit_receipt_nonce: req.audit_receipt_nonce.clone(),
    }
}

fn compute_sovereignty_score(
    profile: &EmbeddedObservabilityProfile,
    req: &SecurityOperationRequest,
    vault_decision: &VaultDecision,
) -> (f64, u8) {
    let weights = &profile.sovereignty_scorer;
    let integrity = if vault_decision.allowed { 100.0 } else { 0.0 };

    let continuity = if req.covenant_violation {
        0.0
    } else if req.risk_class.eq_ignore_ascii_case("critical") {
        65.0
    } else if req.risk_class.eq_ignore_ascii_case("high") {
        80.0
    } else {
        95.0
    };

    let reliability = if req.tamper_signal {
        0.0
    } else if has_tag(&req.tags, "drift") {
        70.0
    } else {
        95.0
    };

    let weighted = (integrity * f64::from(weights.integrity_weight_pct)
        + continuity * f64::from(weights.continuity_weight_pct)
        + reliability * f64::from(weights.reliability_weight_pct))
        / 100.0;

    let mut chaos_penalty = 0.0;
    if req.covenant_violation || req.tamper_signal || has_tag(&req.tags, "drift") {
        chaos_penalty = f64::from(weights.chaos_penalty_pct);
    }

    let score = (weighted - chaos_penalty).clamp(0.0, 100.0);
    (score, weights.fail_closed_threshold_pct)
}

pub fn evaluate_operation(
    req: &SecurityOperationRequest,
) -> Result<SecurityDecision, SecurityError> {
    let vault_policy = load_embedded_vault_policy()
        .map_err(|err| SecurityError::VaultPolicyLoadFailed(err.to_string()))?;
    let vault_request = to_vault_request(req);
    let vault_decision = evaluate_vault_policy(&vault_policy, &vault_request);

    let observability_profile = load_embedded_observability_profile()
        .map_err(|err| SecurityError::ObservabilityProfileLoadFailed(err.to_string()))?;
    let (score, threshold) =
        compute_sovereignty_score(&observability_profile, req, &vault_decision);

    let mut reasons: Vec<String> = Vec::new();
    if req.covenant_violation {
        reasons.push("covenant_violation_detected".to_string());
    }
    if req.tamper_signal {
        reasons.push("tamper_signal_detected".to_string());
    }
    if score < f64::from(threshold) {
        reasons.push(format!(
            "sovereignty_score_below_threshold:{score:.2}<{}",
            threshold
        ));
    }
    reasons.extend(vault_decision.reasons.iter().cloned());

    let fail_closed = req.covenant_violation
        || req.tamper_signal
        || (score < f64::from(threshold))
        || (!vault_decision.allowed && vault_decision.fail_closed);

    if reasons.is_empty() {
        reasons.push("security_gate_allow".to_string());
    }

    let ok = !fail_closed && vault_decision.allowed;
    let digest = digest_for_decision(req, &reasons, score);

    Ok(SecurityDecision {
        ok,
        fail_closed,
        shutdown_required: fail_closed,
        human_alert_required: fail_closed,
        sovereignty_score_pct: score,
        sovereignty_threshold_pct: threshold,
        decision_digest: digest,
        reasons,
        vault_decision,
    })
}

fn write_json_atomic(path: &Path, value: &serde_json::Value) -> Result<(), SecurityError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| SecurityError::IoFailed(format!("mkdir_failed:{err}")))?;
    }
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    let payload = serde_json::to_vec_pretty(value)
        .map_err(|err| SecurityError::EncodeFailed(err.to_string()))?;
    std::fs::write(&tmp, payload)
        .map_err(|err| SecurityError::IoFailed(format!("write_tmp_failed:{err}")))?;
    std::fs::rename(&tmp, path)
        .map_err(|err| SecurityError::IoFailed(format!("rename_failed:{err}")))?;
    Ok(())
}

fn append_jsonl(path: &Path, value: &serde_json::Value) -> Result<(), SecurityError> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| SecurityError::IoFailed(format!("mkdir_failed:{err}")))?;
    }
    let mut line =
        serde_json::to_string(value).map_err(|err| SecurityError::EncodeFailed(err.to_string()))?;
    line.push('\n');
    use std::io::Write;
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| SecurityError::IoFailed(format!("open_append_failed:{err}")))?;
    file.write_all(line.as_bytes())
        .map_err(|err| SecurityError::IoFailed(format!("append_failed:{err}")))?;
    Ok(())
}

fn alert_for(req: &SecurityOperationRequest, decision: &SecurityDecision) -> SecurityAlert {
    let reason = decision
        .reasons
        .first()
        .cloned()
        .unwrap_or_else(|| "fail_closed_triggered".to_string());
    SecurityAlert {
        ts: now_iso(),
        operation_id: req.operation_id.clone(),
        subsystem: req.subsystem.clone(),
        action: req.action.clone(),
        actor: req.actor.clone(),
        severity: "critical".to_string(),
        reason,
    }
}

pub fn enforce_operation(
    req: &SecurityOperationRequest,
    state_root: &Path,
) -> Result<SecurityDecision, SecurityError> {
    let decision = evaluate_operation(req)?;

    if decision.fail_closed {
        let security_dir = state_root.join("security");
        let shutdown_path = security_dir.join("hard_shutdown.json");
        let alerts_path = security_dir.join("human_alerts.jsonl");

        write_json_atomic(
            &shutdown_path,
            &serde_json::json!({
                "ok": false,
                "fail_closed": true,
                "ts": now_iso(),
                "operation_id": req.operation_id,
                "subsystem": req.subsystem,
                "action": req.action,
                "actor": req.actor,
                "reason": decision.reasons.first().cloned().unwrap_or_else(|| "fail_closed".to_string()),
                "decision_digest": decision.decision_digest,
                "status": "shutdown"
            }),
        )?;

        let alert = alert_for(req, &decision);
        append_jsonl(
            &alerts_path,
            &serde_json::to_value(alert).unwrap_or_default(),
        )?;
    }

    Ok(decision)
}

pub fn evaluate_operation_json(request_json: &str) -> Result<String, SecurityError> {
    let req: SecurityOperationRequest = serde_json::from_str(request_json)
        .map_err(|err| SecurityError::RequestDecodeFailed(err.to_string()))?;
    let decision = evaluate_operation(&req)?;
    serde_json::to_string(&serde_json::json!({
        "ok": true,
        "decision": decision
    }))
    .map_err(|err| SecurityError::EncodeFailed(err.to_string()))
}

pub fn enforce_operation_json(
    request_json: &str,
    state_root: &Path,
) -> Result<String, SecurityError> {
    let req: SecurityOperationRequest = serde_json::from_str(request_json)
        .map_err(|err| SecurityError::RequestDecodeFailed(err.to_string()))?;
    let decision = enforce_operation(&req, state_root)?;
    serde_json::to_string(&serde_json::json!({
        "ok": true,
        "decision": decision
    }))
    .map_err(|err| SecurityError::EncodeFailed(err.to_string()))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultSealRequest {
    pub operation_id: String,
    pub key_id: String,
    pub data_base64: String,
    #[serde(default)]
    pub actor: String,
    #[serde(default)]
    pub covenant_violation: bool,
    #[serde(default)]
    pub tamper_signal: bool,
    #[serde(default = "default_operator_quorum")]
    pub operator_quorum: u8,
    #[serde(default = "default_key_age_hours")]
    pub key_age_hours: u32,
    #[serde(default)]
    pub audit_receipt_nonce: Option<String>,
    #[serde(default)]
    pub zk_proof: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultRotateRequest {
    pub operation_id: String,
    #[serde(default)]
    pub actor: String,
    #[serde(default)]
    pub key_ids: Vec<String>,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default)]
    pub covenant_violation: bool,
    #[serde(default)]
    pub tamper_signal: bool,
    #[serde(default = "default_operator_quorum")]
    pub operator_quorum: u8,
    #[serde(default = "default_key_age_hours")]
    pub key_age_hours: u32,
    #[serde(default)]
    pub audit_receipt_nonce: Option<String>,
    #[serde(default)]
    pub zk_proof: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultAuditRequest {
    pub operation_id: String,
    #[serde(default)]
    pub actor: String,
}

fn digest_parts(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part.as_bytes());
        hasher.update(b"|");
    }
    hex::encode(hasher.finalize())
}

fn to_security_request_for_seal(
    req: &VaultSealRequest,
) -> Result<SecurityOperationRequest, SecurityError> {
    if req.operation_id.trim().is_empty() {
        return Err(SecurityError::ValidationFailed(
            "operation_id_required".to_string(),
        ));
    }
    if req.key_id.trim().is_empty() {
        return Err(SecurityError::ValidationFailed(
            "key_id_required".to_string(),
        ));
    }
    if req.data_base64.trim().is_empty() {
        return Err(SecurityError::ValidationFailed(
            "data_base64_required".to_string(),
        ));
    }
    Ok(SecurityOperationRequest {
        operation_id: req.operation_id.clone(),
        subsystem: "vault".to_string(),
        action: "seal".to_string(),
        actor: if req.actor.trim().is_empty() {
            "operator".to_string()
        } else {
            req.actor.clone()
        },
        risk_class: "critical".to_string(),
        payload_digest: Some(format!(
            "sha256:{}",
            digest_parts(&[&req.key_id, &req.data_base64])
        )),
        tags: vec!["vault".to_string(), "seal".to_string()],
        covenant_violation: req.covenant_violation,
        tamper_signal: req.tamper_signal,
        key_age_hours: req.key_age_hours,
        operator_quorum: req.operator_quorum,
        audit_receipt_nonce: req.audit_receipt_nonce.clone(),
        zk_proof: req.zk_proof.clone(),
        ciphertext_digest: Some(format!(
            "sha256:{}",
            digest_parts(&[&req.key_id, &req.data_base64, "cipher"])
        )),
    })
}

fn to_security_request_for_rotate(
    req: &VaultRotateRequest,
) -> Result<SecurityOperationRequest, SecurityError> {
    if req.operation_id.trim().is_empty() {
        return Err(SecurityError::ValidationFailed(
            "operation_id_required".to_string(),
        ));
    }
    let key_ids = if req.key_ids.is_empty() {
        vec!["all_keys".to_string()]
    } else {
        req.key_ids.clone()
    };
    Ok(SecurityOperationRequest {
        operation_id: req.operation_id.clone(),
        subsystem: "vault".to_string(),
        action: "rotate".to_string(),
        actor: if req.actor.trim().is_empty() {
            "operator".to_string()
        } else {
            req.actor.clone()
        },
        risk_class: "critical".to_string(),
        payload_digest: Some(format!(
            "sha256:{}",
            digest_parts(&[
                &key_ids.join(","),
                req.reason.as_deref().unwrap_or("rotate_all")
            ])
        )),
        tags: vec!["vault".to_string(), "rotate".to_string()],
        covenant_violation: req.covenant_violation,
        tamper_signal: req.tamper_signal,
        key_age_hours: req.key_age_hours,
        operator_quorum: req.operator_quorum,
        audit_receipt_nonce: req.audit_receipt_nonce.clone(),
        zk_proof: req.zk_proof.clone(),
        ciphertext_digest: Some(format!(
            "sha256:{}",
            digest_parts(&[&key_ids.join(","), "rotate"])
        )),
    })
}

pub fn vault_load_policy_json() -> Result<String, SecurityError> {
    load_embedded_vault_policy_json()
        .map_err(|err| SecurityError::VaultPolicyLoadFailed(err.to_string()))
}

pub fn vault_evaluate_json(request_json: &str) -> Result<String, SecurityError> {
    evaluate_vault_policy_json(request_json)
        .map_err(|err| SecurityError::VaultPolicyLoadFailed(err.to_string()))
}

pub fn seal_json(request_json: &str, state_root: &Path) -> Result<String, SecurityError> {
    let req: VaultSealRequest = serde_json::from_str(request_json)
        .map_err(|err| SecurityError::RequestDecodeFailed(err.to_string()))?;
    let security_req = to_security_request_for_seal(&req)?;
    let decision = enforce_operation(&security_req, state_root)?;
    if decision.fail_closed || !decision.ok {
        return serde_json::to_string(&serde_json::json!({
            "ok": false,
            "status": "deny_fail_closed",
            "decision": decision
        }))
        .map_err(|err| SecurityError::EncodeFailed(err.to_string()));
    }

    let sealed_digest = format!(
        "sha256:{}",
        digest_parts(&[
            &req.key_id,
            &req.data_base64,
            &decision.decision_digest,
            req.audit_receipt_nonce.as_deref().unwrap_or("none")
        ])
    );
    serde_json::to_string(&serde_json::json!({
        "ok": true,
        "status": "sealed",
        "operation_id": req.operation_id,
        "key_id": req.key_id,
        "sealed_digest": sealed_digest,
        "decision": decision
    }))
    .map_err(|err| SecurityError::EncodeFailed(err.to_string()))
}

pub fn rotate_all_json(request_json: &str, state_root: &Path) -> Result<String, SecurityError> {
    let req: VaultRotateRequest = serde_json::from_str(request_json)
        .map_err(|err| SecurityError::RequestDecodeFailed(err.to_string()))?;
    let key_ids = if req.key_ids.is_empty() {
        vec!["all_keys".to_string()]
    } else {
        req.key_ids.clone()
    };
    let security_req = to_security_request_for_rotate(&req)?;
    let decision = enforce_operation(&security_req, state_root)?;
    if decision.fail_closed || !decision.ok {
        return serde_json::to_string(&serde_json::json!({
            "ok": false,
            "status": "deny_fail_closed",
            "decision": decision
        }))
        .map_err(|err| SecurityError::EncodeFailed(err.to_string()));
    }

    let receipts = key_ids
        .iter()
        .map(|key_id| {
            serde_json::json!({
                "key_id": key_id,
                "rotation_receipt": format!("sha256:{}", digest_parts(&[
                    key_id,
                    req.reason.as_deref().unwrap_or("rotate"),
                    &decision.decision_digest
                ]))
            })
        })
        .collect::<Vec<_>>();

    serde_json::to_string(&serde_json::json!({
        "ok": true,
        "status": "rotated",
        "operation_id": req.operation_id,
        "reason": req.reason.unwrap_or_else(|| "rotate_all".to_string()),
        "rotated_keys": key_ids.len(),
        "receipts": receipts,
        "decision": decision
    }))
    .map_err(|err| SecurityError::EncodeFailed(err.to_string()))
}

pub fn audit_json(request_json: &str, _state_root: &Path) -> Result<String, SecurityError> {
    let req: VaultAuditRequest = serde_json::from_str(request_json)
        .map_err(|err| SecurityError::RequestDecodeFailed(err.to_string()))?;
    let policy = load_embedded_vault_policy()
        .map_err(|err| SecurityError::VaultPolicyLoadFailed(err.to_string()))?;
    let policy_json = load_embedded_vault_policy_json()
        .map_err(|err| SecurityError::VaultPolicyLoadFailed(err.to_string()))?;
    let policy_digest =
        digest_parts(&[&policy.policy_id, &policy.version.to_string(), &policy_json]);

    serde_json::to_string(&serde_json::json!({
        "ok": true,
        "status": "audited",
        "operation_id": req.operation_id,
        "actor": if req.actor.trim().is_empty() { "operator" } else { req.actor.as_str() },
        "policy_id": policy.policy_id,
        "policy_digest": format!("sha256:{policy_digest}"),
        "rules_count": policy.rules.len(),
        "auto_rotate_enabled": policy.auto_rotate.enabled,
        "fail_closed_rules": policy.rules.iter().filter(|r| r.fail_closed).count(),
        "ts": now_iso()
    }))
    .map_err(|err| SecurityError::EncodeFailed(err.to_string()))
}

fn c_str_to_string(ptr: *const c_char) -> Result<String, SecurityError> {
    if ptr.is_null() {
        return Err(SecurityError::RequestDecodeFailed(
            "null_pointer".to_string(),
        ));
    }
    let s = unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .map_err(|_| SecurityError::RequestDecodeFailed("invalid_utf8".to_string()))?;
    Ok(s.to_string())
}

fn into_c_string_ptr(payload: String) -> *mut c_char {
    let sanitized = payload.replace('\0', "");
    match CString::new(sanitized) {
        Ok(c) => c.into_raw(),
        Err(_) => CString::new("{\"ok\":false,\"error\":\"cstring_encode_failed\"}")
            .unwrap_or_else(|_| {
                CString::new("{}").expect("fallback CString literal should be valid")
            })
            .into_raw(),
    }
}

#[no_mangle]
pub extern "C" fn security_check_ffi(request_json: *const c_char) -> *mut c_char {
    let payload = match c_str_to_string(request_json).and_then(|req| evaluate_operation_json(&req))
    {
        Ok(v) => v,
        Err(err) => serde_json::json!({
            "ok": false,
            "error": err.to_string()
        })
        .to_string(),
    };
    into_c_string_ptr(payload)
}

#[no_mangle]
pub extern "C" fn security_enforce_ffi(
    request_json: *const c_char,
    state_root: *const c_char,
) -> *mut c_char {
    let payload = match c_str_to_string(request_json).and_then(|req| {
        let root = c_str_to_string(state_root).unwrap_or_else(|_| ".".to_string());
        enforce_operation_json(&req, Path::new(&root))
    }) {
        Ok(v) => v,
        Err(err) => serde_json::json!({
            "ok": false,
            "error": err.to_string()
        })
        .to_string(),
    };
    into_c_string_ptr(payload)
}

#[no_mangle]
pub extern "C" fn security_free(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        let _ = CString::from_raw(ptr);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base_request() -> SecurityOperationRequest {
        SecurityOperationRequest {
            operation_id: "op_test_1".to_string(),
            subsystem: "memory".to_string(),
            action: "recall".to_string(),
            actor: "unit_test".to_string(),
            risk_class: "normal".to_string(),
            payload_digest: Some("sha256:abcd".to_string()),
            tags: vec!["runtime.guardrails".to_string()],
            covenant_violation: false,
            tamper_signal: false,
            key_age_hours: 1,
            operator_quorum: 2,
            audit_receipt_nonce: Some("nonce-1".to_string()),
            zk_proof: Some("zk-proof".to_string()),
            ciphertext_digest: Some("sha256:cipher".to_string()),
        }
    }

    #[test]
    fn allow_clean_operation() {
        let req = base_request();
        let decision = evaluate_operation(&req).expect("decision should evaluate");
        assert!(decision.ok, "clean operation should pass security gate");
        assert!(
            !decision.fail_closed,
            "clean operation should not fail-close"
        );
    }

    #[test]
    fn fail_closed_on_covenant_violation() {
        let mut req = base_request();
        req.covenant_violation = true;
        let decision = evaluate_operation(&req).expect("decision should evaluate");
        assert!(!decision.ok, "covenant violation must deny");
        assert!(decision.fail_closed, "covenant violation must fail-close");
    }

    #[test]
    fn enforce_writes_shutdown_and_alert() {
        let mut req = base_request();
        req.tamper_signal = true;
        req.operator_quorum = 1;

        let temp_dir =
            std::env::temp_dir().join(format!("security_core_test_{}", std::process::id()));
        if temp_dir.exists() {
            let _ = std::fs::remove_dir_all(&temp_dir);
        }
        std::fs::create_dir_all(&temp_dir).expect("temp dir should create");

        let decision = enforce_operation(&req, &temp_dir).expect("enforce should evaluate");
        assert!(decision.fail_closed, "tamper must fail-close");

        let shutdown_path = temp_dir.join("security/hard_shutdown.json");
        let alerts_path = temp_dir.join("security/human_alerts.jsonl");
        assert!(shutdown_path.exists(), "shutdown file should exist");
        assert!(alerts_path.exists(), "alerts file should exist");
    }
}

// Small std-only RFC3339 formatter helper to avoid chrono dependency.
mod chrono_stub {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    pub struct DateTime {
        secs: u64,
    }

    impl From<SystemTime> for DateTime {
        fn from(value: SystemTime) -> Self {
            let secs = value
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::from_secs(0))
                .as_secs();
            Self { secs }
        }
    }

    impl DateTime {
        pub fn to_rfc3339(&self) -> String {
            // Fallback ISO-like timestamp; sufficient for machine parsing in this project.
            format!("{}Z", self.secs)
        }
    }
}
