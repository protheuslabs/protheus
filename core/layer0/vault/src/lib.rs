// SPDX-License-Identifier: Apache-2.0
mod blob;

use protheus_memory_core_v6::{
    load_embedded_vault_policy as load_embedded_vault_policy_from_memory, EmbeddedVaultPolicy,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::{CStr, CString};
use std::fmt::{Display, Formatter};
use std::os::raw::c_char;

const MIN_FHE_NOISE_BUDGET: u32 = 12;

pub use blob::{
    load_embedded_vault_runtime_envelope, BlobError, VaultRuntimeEnvelope, VAULT_RUNTIME_BLOB_ID,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultOperationRequest {
    pub operation_id: String,
    pub key_id: String,
    pub action: String,
    pub zk_proof: Option<String>,
    pub ciphertext_digest: Option<String>,
    pub fhe_noise_budget: u32,
    pub key_age_hours: u32,
    pub tamper_signal: bool,
    pub operator_quorum: u8,
    pub audit_receipt_nonce: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuleEvaluation {
    pub rule_id: String,
    pub passed: bool,
    pub fail_closed: bool,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VaultDecision {
    pub policy_id: String,
    pub policy_digest: String,
    pub operation_id: String,
    pub key_id: String,
    pub action: String,
    pub allowed: bool,
    pub fail_closed: bool,
    pub status: String,
    pub should_rotate: bool,
    pub rotate_reason: Option<String>,
    pub reasons: Vec<String>,
    pub rule_results: Vec<RuleEvaluation>,
}

#[derive(Debug, Clone)]
pub enum VaultError {
    PolicyLoadFailed(String),
    InvalidRequest(String),
    EncodeFailed(String),
}

impl Display for VaultError {
    fn fmt(&self, f: &mut Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultError::PolicyLoadFailed(msg) => write!(f, "policy_load_failed:{msg}"),
            VaultError::InvalidRequest(msg) => write!(f, "invalid_request:{msg}"),
            VaultError::EncodeFailed(msg) => write!(f, "encode_failed:{msg}"),
        }
    }
}

impl std::error::Error for VaultError {}

fn normalize_text(input: &str, max: usize) -> String {
    input
        .trim()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(max)
        .collect()
}

fn has_value(v: &Option<String>) -> bool {
    v.as_ref().map(|s| !s.trim().is_empty()).unwrap_or(false)
}

fn auto_rotate_signal(
    policy: &EmbeddedVaultPolicy,
    request: &VaultOperationRequest,
) -> (bool, Option<String>) {
    if !policy.auto_rotate.enabled {
        return (false, None);
    }

    if request.tamper_signal && policy.auto_rotate.emergency_rotate_on_tamper {
        return (true, Some("tamper_signal_detected".to_string()));
    }

    if request.key_age_hours >= policy.auto_rotate.rotate_after_hours {
        return (
            true,
            Some(format!(
                "key_age_exceeds_rotate_after:{}h",
                policy.auto_rotate.rotate_after_hours
            )),
        );
    }

    (false, None)
}

fn policy_digest(policy: &EmbeddedVaultPolicy) -> String {
    let mut parts: Vec<String> = vec![
        policy.policy_id.clone(),
        policy.version.to_string(),
        policy.key_domain.clone(),
        policy.cryptographic_profile.clone(),
        policy.auto_rotate.enabled.to_string(),
        policy.auto_rotate.rotate_after_hours.to_string(),
        policy.auto_rotate.max_key_age_hours.to_string(),
        policy.auto_rotate.grace_window_minutes.to_string(),
        policy.auto_rotate.quorum_required.to_string(),
        policy.auto_rotate.emergency_rotate_on_tamper.to_string(),
    ];

    for item in &policy.attestation_chain {
        parts.push(item.clone());
    }
    for rule in &policy.rules {
        parts.push(rule.id.clone());
        parts.push(rule.objective.clone());
        parts.push(rule.zk_requirement.clone());
        parts.push(rule.fhe_requirement.clone());
        parts.push(rule.severity.clone());
        parts.push(rule.fail_closed.to_string());
    }

    let mut hasher = Sha256::new();
    hasher.update(parts.join("|").as_bytes());
    hex::encode(hasher.finalize())
}

pub fn load_embedded_vault_policy() -> Result<EmbeddedVaultPolicy, VaultError> {
    load_embedded_vault_policy_from_memory()
        .map_err(|err| VaultError::PolicyLoadFailed(err.to_string()))
}

pub fn evaluate_vault_policy(
    policy: &EmbeddedVaultPolicy,
    request: &VaultOperationRequest,
) -> VaultDecision {
    let runtime_envelope = load_embedded_vault_runtime_envelope().ok();
    let action = normalize_text(&request.action, 64).to_ascii_lowercase();
    let (rotate_due, rotate_reason) = auto_rotate_signal(policy, request);
    let mut should_rotate = rotate_due;
    let mut rule_results: Vec<RuleEvaluation> = Vec::new();
    let mut reasons: Vec<String> = Vec::new();

    for rule in &policy.rules {
        let (passed, reason) = match rule.id.as_str() {
            "vault.zk.required" => {
                let requires_zk = matches!(action.as_str(), "seal" | "unseal" | "rotate");
                let passed = !requires_zk || has_value(&request.zk_proof);
                let reason = if passed {
                    "zk_proof_validated".to_string()
                } else {
                    "zk_proof_missing".to_string()
                };
                (passed, reason)
            }
            "vault.fhe.policy" => {
                let has_cipher = has_value(&request.ciphertext_digest);
                let noise_ok = request.fhe_noise_budget >= MIN_FHE_NOISE_BUDGET;
                let passed = has_cipher && noise_ok;
                let reason = if passed {
                    "fhe_constraints_satisfied".to_string()
                } else if !has_cipher {
                    "ciphertext_digest_missing".to_string()
                } else {
                    format!(
                        "fhe_noise_budget_below_min:{}<{}",
                        request.fhe_noise_budget, MIN_FHE_NOISE_BUDGET
                    )
                };
                (passed, reason)
            }
            "vault.rotation.window" => {
                let exceeds_max_age = request.key_age_hours > policy.auto_rotate.max_key_age_hours;
                let quorum_ok = request.operator_quorum >= policy.auto_rotate.quorum_required;
                let rotate_action = action == "rotate";

                if exceeds_max_age && !rotate_action {
                    should_rotate = true;
                    (
                        false,
                        format!(
                            "key_age_exceeds_max_without_rotate:{}>{}",
                            request.key_age_hours, policy.auto_rotate.max_key_age_hours
                        ),
                    )
                } else if request.tamper_signal && !rotate_action {
                    should_rotate = true;
                    (false, "tamper_requires_immediate_rotate".to_string())
                } else if rotate_due && !quorum_ok {
                    (
                        false,
                        format!(
                            "rotate_quorum_insufficient:{}<{}",
                            request.operator_quorum, policy.auto_rotate.quorum_required
                        ),
                    )
                } else {
                    let reason = if rotate_due {
                        "rotation_window_enforced".to_string()
                    } else {
                        "rotation_not_required".to_string()
                    };
                    (true, reason)
                }
            }
            "vault.audit.trace" => {
                let passed = has_value(&request.audit_receipt_nonce);
                let reason = if passed {
                    "audit_receipt_bound".to_string()
                } else {
                    "audit_receipt_nonce_missing".to_string()
                };
                (passed, reason)
            }
            _ => (true, "unrecognized_rule_treated_as_pass".to_string()),
        };

        if !passed {
            reasons.push(format!("{}:{}", rule.id, reason));
        }

        rule_results.push(RuleEvaluation {
            rule_id: rule.id.clone(),
            passed,
            fail_closed: rule.fail_closed,
            reason,
        });
    }

    if let Some(envelope) = runtime_envelope {
        let quorum_ok = request.operator_quorum >= envelope.min_operator_quorum;
        let key_age_ok = request.key_age_hours <= envelope.max_key_age_hours;
        let audit_ok = !envelope.require_audit_nonce || has_value(&request.audit_receipt_nonce);
        let passed = quorum_ok && key_age_ok && audit_ok;
        let reason = if passed {
            "runtime_envelope_satisfied".to_string()
        } else if !quorum_ok {
            format!(
                "runtime_envelope_quorum_insufficient:{}<{}",
                request.operator_quorum, envelope.min_operator_quorum
            )
        } else if !key_age_ok {
            format!(
                "runtime_envelope_key_age_exceeded:{}>{}",
                request.key_age_hours, envelope.max_key_age_hours
            )
        } else {
            "runtime_envelope_audit_nonce_missing".to_string()
        };

        if !passed {
            reasons.push(format!("vault.runtime.envelope:{}", reason));
        }

        rule_results.push(RuleEvaluation {
            rule_id: "vault.runtime.envelope".to_string(),
            passed,
            fail_closed: envelope.enforce_fail_closed,
            reason,
        });
    } else {
        reasons.push("vault.runtime.envelope:missing_runtime_envelope_blob".to_string());
        rule_results.push(RuleEvaluation {
            rule_id: "vault.runtime.envelope".to_string(),
            passed: false,
            fail_closed: true,
            reason: "missing_runtime_envelope_blob".to_string(),
        });
    }

    let allowed = rule_results.iter().all(|r| r.passed);
    let fail_closed = rule_results.iter().any(|r| !r.passed && r.fail_closed);
    let status = if allowed {
        "allow".to_string()
    } else if fail_closed {
        "deny_fail_closed".to_string()
    } else {
        "deny_soft".to_string()
    };

    VaultDecision {
        policy_id: policy.policy_id.clone(),
        policy_digest: policy_digest(policy),
        operation_id: normalize_text(&request.operation_id, 160),
        key_id: normalize_text(&request.key_id, 160),
        action,
        allowed,
        fail_closed,
        status,
        should_rotate,
        rotate_reason,
        reasons,
        rule_results,
    }
}

pub fn evaluate_vault_policy_json(request_json: &str) -> Result<String, VaultError> {
    let request: VaultOperationRequest = serde_json::from_str(request_json)
        .map_err(|err| VaultError::InvalidRequest(format!("request_parse_failed:{err}")))?;
    let policy = load_embedded_vault_policy()?;
    let decision = evaluate_vault_policy(&policy, &request);
    serde_json::to_string(&decision).map_err(|err| VaultError::EncodeFailed(err.to_string()))
}

pub fn load_embedded_vault_policy_json() -> Result<String, VaultError> {
    let policy = load_embedded_vault_policy()?;
    serde_json::to_string(&policy).map_err(|err| VaultError::EncodeFailed(err.to_string()))
}

fn c_str_to_string(ptr: *const c_char) -> Result<String, VaultError> {
    if ptr.is_null() {
        return Err(VaultError::InvalidRequest("null_pointer".to_string()));
    }
    // SAFETY: caller owns pointer and guarantees NUL-terminated string.
    let s = unsafe { CStr::from_ptr(ptr) }
        .to_str()
        .map_err(|_| VaultError::InvalidRequest("invalid_utf8".to_string()))?;
    Ok(s.to_string())
}

fn into_c_string_ptr(payload: String) -> *mut c_char {
    let sanitized = payload.replace('\0', "");
    match CString::new(sanitized) {
        Ok(c) => c.into_raw(),
        Err(_) => CString::new("{\"ok\":false,\"error\":\"cstring_encode_failed\"}")
            .unwrap_or_else(|_| CString::new("{}").expect("literal CString should be valid"))
            .into_raw(),
    }
}

#[allow(clippy::not_unsafe_ptr_arg_deref)]
#[no_mangle]
pub extern "C" fn evaluate_vault_policy_ffi(request_json: *const c_char) -> *mut c_char {
    let payload =
        match c_str_to_string(request_json).and_then(|req| evaluate_vault_policy_json(&req)) {
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
pub extern "C" fn load_embedded_vault_policy_ffi() -> *mut c_char {
    let payload = match load_embedded_vault_policy_json() {
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
pub extern "C" fn vault_free(ptr: *mut c_char) {
    if ptr.is_null() {
        return;
    }
    // SAFETY: pointer originated from CString::into_raw in this crate.
    unsafe {
        let _ = CString::from_raw(ptr);
    }
}

#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn evaluate_vault_policy_wasm(request_json: &str) -> String {
    match evaluate_vault_policy_json(request_json) {
        Ok(v) => v,
        Err(err) => serde_json::json!({
            "ok": false,
            "error": err.to_string()
        })
        .to_string(),
    }
}

#[cfg(target_arch = "wasm32")]
#[wasm_bindgen]
pub fn load_embedded_vault_policy_wasm() -> String {
    match load_embedded_vault_policy_json() {
        Ok(v) => v,
        Err(err) => serde_json::json!({
            "ok": false,
            "error": err.to_string()
        })
        .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_request(action: &str) -> VaultOperationRequest {
        VaultOperationRequest {
            operation_id: "op_sample_001".to_string(),
            key_id: "vault_key_primary".to_string(),
            action: action.to_string(),
            zk_proof: Some("zkp:valid".to_string()),
            ciphertext_digest: Some("sha256:abc123".to_string()),
            fhe_noise_budget: 20,
            key_age_hours: 12,
            tamper_signal: false,
            operator_quorum: 2,
            audit_receipt_nonce: Some("nonce-1".to_string()),
        }
    }

    #[test]
    fn allow_path_passes() {
        let policy = load_embedded_vault_policy().expect("policy should load");
        let req = sample_request("seal");
        let decision = evaluate_vault_policy(&policy, &req);
        assert!(decision.allowed);
        assert!(!decision.fail_closed);
        assert_eq!(decision.status, "allow");
    }

    #[test]
    fn fail_closed_when_zk_missing() {
        let policy = load_embedded_vault_policy().expect("policy should load");
        let mut req = sample_request("unseal");
        req.zk_proof = None;
        let decision = evaluate_vault_policy(&policy, &req);
        assert!(!decision.allowed);
        assert!(decision.fail_closed);
        assert_eq!(decision.status, "deny_fail_closed");
    }

    #[test]
    fn fail_closed_on_tamper_without_rotate() {
        let policy = load_embedded_vault_policy().expect("policy should load");
        let mut req = sample_request("seal");
        req.tamper_signal = true;
        let decision = evaluate_vault_policy(&policy, &req);
        assert!(!decision.allowed);
        assert!(decision.fail_closed);
        assert!(decision.should_rotate);
    }
}
