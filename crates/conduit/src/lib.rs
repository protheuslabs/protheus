use conduit_security::{
    deterministic_hash, CapabilityToken, CapabilityTokenAuthority, MessageSigner, RateLimitPolicy,
    RateLimiter, SecurityError,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;
use std::fs;
use std::io::{self, BufRead, Write};
use std::time::{SystemTime, UNIX_EPOCH};

pub const CONDUIT_SCHEMA_ID: &str = "protheus_conduit";
pub const CONDUIT_SCHEMA_VERSION: &str = "1.0";
pub const MAX_CONDUIT_MESSAGE_TYPES: usize = 10;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum TsCommand {
    StartAgent {
        agent_id: String,
    },
    StopAgent {
        agent_id: String,
    },
    QueryReceiptChain {
        from_hash: Option<String>,
        limit: Option<u32>,
    },
    ListActiveAgents,
    GetSystemStatus,
    ApplyPolicyUpdate {
        patch_id: String,
        patch: Value,
    },
    InstallExtension {
        extension_id: String,
        wasm_sha256: String,
        capabilities: Vec<String>,
    },
}

pub const TS_COMMAND_TYPES: [&str; 7] = [
    "start_agent",
    "stop_agent",
    "query_receipt_chain",
    "list_active_agents",
    "get_system_status",
    "apply_policy_update",
    "install_extension",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentLifecycleState {
    Started,
    Stopped,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RustEvent {
    AgentLifecycle {
        state: AgentLifecycleState,
        agent_id: String,
    },
    ReceiptAdded { receipt_hash: String },
    SystemFeedback {
        status: String,
        detail: Value,
        violation_reason: Option<String>,
    },
}

pub const RUST_EVENT_TYPES: [&str; 3] = [
    "agent_lifecycle",
    "receipt_added",
    "system_feedback",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EdgeBridgeMessage {
    EdgeInference {
        prompt: String,
        max_tokens: Option<u32>,
    },
    EdgeStatus {
        probe: Option<String>,
    },
}

pub const EDGE_BRIDGE_MESSAGE_TYPES: [&str; 2] = ["edge_inference", "edge_status"];

fn default_bridge_message_budget_max() -> usize {
    MAX_CONDUIT_MESSAGE_TYPES
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandSecurityMetadata {
    pub client_id: String,
    pub key_id: String,
    pub nonce: String,
    pub signature: String,
    pub capability_token: CapabilityToken,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandEnvelope {
    pub schema_id: String,
    pub schema_version: String,
    pub request_id: String,
    pub ts_ms: u64,
    pub command: TsCommand,
    pub security: CommandSecurityMetadata,
}

impl CommandEnvelope {
    pub fn new(
        request_id: impl Into<String>,
        command: TsCommand,
        security: CommandSecurityMetadata,
    ) -> Self {
        Self {
            schema_id: CONDUIT_SCHEMA_ID.to_string(),
            schema_version: CONDUIT_SCHEMA_VERSION.to_string(),
            request_id: request_id.into(),
            ts_ms: now_ts_ms(),
            command,
            security,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResponseEnvelope {
    pub schema_id: String,
    pub schema_version: String,
    pub request_id: String,
    pub ts_ms: u64,
    pub event: RustEvent,
    pub validation: ValidationReceipt,
    pub crossing: CrossingReceipt,
    pub receipt_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum CrossingDirection {
    TsToRust,
    RustToTs,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CrossingReceipt {
    pub crossing_id: String,
    pub direction: CrossingDirection,
    pub command_type: String,
    pub deterministic_hash: String,
    pub ts_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ValidationReceipt {
    pub ok: bool,
    pub fail_closed: bool,
    pub reason: String,
    pub policy_receipt_hash: String,
    pub security_receipt_hash: String,
    pub receipt_hash: String,
}

pub trait PolicyGate {
    fn evaluate(&self, command: &TsCommand) -> PolicyDecision;
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PolicyDecision {
    pub allow: bool,
    pub reason: String,
}

impl PolicyDecision {
    pub fn allow() -> Self {
        Self {
            allow: true,
            reason: "policy_allow".to_string(),
        }
    }

    pub fn deny(reason: impl Into<String>) -> Self {
        Self {
            allow: false,
            reason: reason.into(),
        }
    }
}

pub struct FailClosedPolicy;

impl PolicyGate for FailClosedPolicy {
    fn evaluate(&self, _command: &TsCommand) -> PolicyDecision {
        PolicyDecision::deny("policy_gate_not_configured")
    }
}

pub struct AllowAllPolicy;

impl PolicyGate for AllowAllPolicy {
    fn evaluate(&self, _command: &TsCommand) -> PolicyDecision {
        PolicyDecision::allow()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConduitPolicy {
    pub constitution_path: String,
    pub guard_registry_path: String,
    pub required_constitution_markers: Vec<String>,
    pub required_guard_checks: Vec<String>,
    pub command_required_capabilities: BTreeMap<String, String>,
    pub allow_policy_update_prefixes: Vec<String>,
    pub rate_limit: RateLimitPolicy,
    #[serde(default = "default_bridge_message_budget_max")]
    pub bridge_message_budget_max: usize,
}

impl Default for ConduitPolicy {
    fn default() -> Self {
        let mut capabilities = BTreeMap::new();
        capabilities.insert("start_agent".to_string(), "agent.lifecycle".to_string());
        capabilities.insert("stop_agent".to_string(), "agent.lifecycle".to_string());
        capabilities.insert(
            "query_receipt_chain".to_string(),
            "receipt.read".to_string(),
        );
        capabilities.insert("list_active_agents".to_string(), "system.read".to_string());
        capabilities.insert("get_system_status".to_string(), "system.read".to_string());
        capabilities.insert(
            "apply_policy_update".to_string(),
            "policy.update".to_string(),
        );
        capabilities.insert(
            "install_extension".to_string(),
            "extension.install".to_string(),
        );

        Self {
            constitution_path: "AGENT-CONSTITUTION.md".to_string(),
            guard_registry_path: "config/guard_check_registry.json".to_string(),
            required_constitution_markers: vec![
                "Mind Sovereignty Covenant".to_string(),
                "RSI Guardrails".to_string(),
            ],
            required_guard_checks: vec![
                "contract_check".to_string(),
                "formal_invariant_engine".to_string(),
            ],
            command_required_capabilities: capabilities,
            allow_policy_update_prefixes: vec!["constitution_safe/".to_string()],
            rate_limit: RateLimitPolicy::default(),
            bridge_message_budget_max: MAX_CONDUIT_MESSAGE_TYPES,
        }
    }
}

impl ConduitPolicy {
    pub fn from_path(path: impl AsRef<std::path::Path>) -> io::Result<Self> {
        let raw = fs::read_to_string(path)?;
        serde_json::from_str(&raw).map_err(invalid_data)
    }
}

pub fn conduit_message_contract_count() -> usize {
    TS_COMMAND_TYPES.len() + RUST_EVENT_TYPES.len()
}

pub fn validate_conduit_contract_budget(max_budget: usize) -> Result<(), String> {
    if max_budget == 0 {
        return Err("conduit_message_budget_invalid_zero".to_string());
    }
    let count = conduit_message_contract_count();
    if count > max_budget {
        return Err(format!(
            "conduit_message_budget_exceeded:{count}>{max_budget}"
        ));
    }
    Ok(())
}

pub struct RegistryPolicyGate {
    policy: ConduitPolicy,
    bootstrap_error: Option<String>,
}

impl RegistryPolicyGate {
    pub fn new(policy: ConduitPolicy) -> Self {
        let mut gate = Self {
            policy,
            bootstrap_error: None,
        };
        gate.bootstrap();
        gate
    }

    pub fn policy(&self) -> &ConduitPolicy {
        &self.policy
    }

    fn bootstrap(&mut self) {
        if let Err(reason) = validate_conduit_contract_budget(self.policy.bridge_message_budget_max)
        {
            self.bootstrap_error = Some(reason);
            return;
        }

        if self.policy.command_required_capabilities.len() != TS_COMMAND_TYPES.len() {
            self.bootstrap_error = Some("command_capability_mapping_cardinality_mismatch".to_string());
            return;
        }
        for command_type in TS_COMMAND_TYPES {
            if !self.policy.command_required_capabilities.contains_key(command_type) {
                self.bootstrap_error =
                    Some(format!("policy_missing_command_capability_mapping:{command_type}"));
                return;
            }
        }

        let constitution_body = match fs::read_to_string(&self.policy.constitution_path) {
            Ok(body) => body,
            Err(_) => {
                self.bootstrap_error = Some("constitution_file_unavailable".to_string());
                return;
            }
        };
        for marker in &self.policy.required_constitution_markers {
            if !constitution_body.contains(marker) {
                self.bootstrap_error = Some(format!("constitution_marker_missing:{marker}"));
                return;
            }
        }

        let registry_body = match fs::read_to_string(&self.policy.guard_registry_path) {
            Ok(body) => body,
            Err(_) => {
                self.bootstrap_error = Some("guard_registry_unavailable".to_string());
                return;
            }
        };
        let checks = match parse_guard_registry_check_ids(&registry_body) {
            Ok(ids) => ids,
            Err(reason) => {
                self.bootstrap_error = Some(reason);
                return;
            }
        };
        for required in &self.policy.required_guard_checks {
            if !checks.contains(required) {
                self.bootstrap_error =
                    Some(format!("guard_registry_required_check_missing:{required}"));
                return;
            }
        }
    }

    fn validate_command_mapping(&self, command: &TsCommand) -> Result<(), String> {
        let command_type = command_type_name(command);
        if !self
            .policy
            .command_required_capabilities
            .contains_key(command_type)
        {
            return Err(format!(
                "policy_missing_command_capability_mapping:{command_type}"
            ));
        }
        if let TsCommand::ApplyPolicyUpdate { patch_id, .. } = command {
            if !self
                .policy
                .allow_policy_update_prefixes
                .iter()
                .any(|prefix| patch_id.starts_with(prefix))
            {
                return Err("policy_update_must_be_constitution_safe".to_string());
            }
        }
        Ok(())
    }
}

impl PolicyGate for RegistryPolicyGate {
    fn evaluate(&self, command: &TsCommand) -> PolicyDecision {
        if let Some(reason) = &self.bootstrap_error {
            return PolicyDecision::deny(reason.clone());
        }
        if let Err(reason) = self.validate_command_mapping(command) {
            return PolicyDecision::deny(reason);
        }
        PolicyDecision::allow()
    }
}

#[derive(Debug, Deserialize)]
struct GuardRegistrySnapshot {
    merge_guard: Option<GuardRegistryMergeGuard>,
}

#[derive(Debug, Deserialize)]
struct GuardRegistryMergeGuard {
    checks: Option<Vec<GuardRegistryCheck>>,
}

#[derive(Debug, Deserialize)]
struct GuardRegistryCheck {
    id: Option<String>,
}

fn parse_guard_registry_check_ids(raw: &str) -> Result<std::collections::BTreeSet<String>, String> {
    let parsed: GuardRegistrySnapshot =
        serde_json::from_str(raw).map_err(|_| "guard_registry_invalid_json".to_string())?;
    let checks = parsed
        .merge_guard
        .and_then(|mg| mg.checks)
        .ok_or_else(|| "guard_registry_checks_missing".to_string())?;

    let mut ids = std::collections::BTreeSet::new();
    for row in checks {
        if let Some(id) = row.id {
            ids.insert(id);
        }
    }
    Ok(ids)
}

#[derive(Debug, Clone)]
pub struct ConduitSecurityContext {
    signer: MessageSigner,
    token_authority: CapabilityTokenAuthority,
    rate_limiter: RateLimiter,
    command_required_capabilities: BTreeMap<String, String>,
}

impl ConduitSecurityContext {
    pub fn new(
        signer: MessageSigner,
        token_authority: CapabilityTokenAuthority,
        rate_limiter: RateLimiter,
        command_required_capabilities: BTreeMap<String, String>,
    ) -> Self {
        Self {
            signer,
            token_authority,
            rate_limiter,
            command_required_capabilities,
        }
    }

    pub fn from_policy(
        policy: &ConduitPolicy,
        signing_key_id: impl Into<String>,
        signing_secret: impl Into<String>,
        token_key_id: impl Into<String>,
        token_secret: impl Into<String>,
    ) -> Self {
        Self {
            signer: MessageSigner::new(signing_key_id, signing_secret),
            token_authority: CapabilityTokenAuthority::new(token_key_id, token_secret),
            rate_limiter: RateLimiter::new(policy.rate_limit.clone()),
            command_required_capabilities: policy.command_required_capabilities.clone(),
        }
    }

    pub fn mint_security_metadata(
        &self,
        client_id: impl Into<String>,
        request_id: &str,
        ts_ms: u64,
        command: &TsCommand,
        token_ttl_ms: u64,
    ) -> CommandSecurityMetadata {
        let client_id = client_id.into();
        let command_type = command_type_name(command);
        let scope = self
            .command_required_capabilities
            .get(command_type)
            .cloned()
            .unwrap_or_else(|| "system.read".to_string());
        let issued_at_ms = now_ts_ms();
        let token = self.token_authority.mint(
            format!("tok-{request_id}-{issued_at_ms}"),
            client_id.clone(),
            vec![scope],
            issued_at_ms,
            issued_at_ms.saturating_add(token_ttl_ms),
        );

        let nonce = format!("nonce-{request_id}-{issued_at_ms}");
        let payload = signing_payload(SigningPayload {
            schema_id: CONDUIT_SCHEMA_ID,
            schema_version: CONDUIT_SCHEMA_VERSION,
            request_id,
            ts_ms,
            command,
            client_id: &client_id,
            key_id: self.signer.key_id(),
            nonce: &nonce,
            capability_token: &token,
        });

        let signature = self.signer.sign_value(&payload);
        CommandSecurityMetadata {
            client_id,
            key_id: self.signer.key_id().to_string(),
            nonce,
            signature,
            capability_token: token,
        }
    }

    pub fn validate(&mut self, envelope: &CommandEnvelope) -> Result<String, SecurityError> {
        if envelope.security.key_id != self.signer.key_id() {
            return Err(SecurityError::SignatureInvalid);
        }

        let payload = signing_payload(SigningPayload {
            schema_id: &envelope.schema_id,
            schema_version: &envelope.schema_version,
            request_id: &envelope.request_id,
            ts_ms: envelope.ts_ms,
            command: &envelope.command,
            client_id: &envelope.security.client_id,
            key_id: &envelope.security.key_id,
            nonce: &envelope.security.nonce,
            capability_token: &envelope.security.capability_token,
        });

        if !self
            .signer
            .verify_value(&payload, &envelope.security.signature)
        {
            return Err(SecurityError::SignatureInvalid);
        }

        let command_type = command_type_name(&envelope.command);
        let required_scope = self
            .command_required_capabilities
            .get(command_type)
            .ok_or_else(|| SecurityError::CapabilityTokenMissingScope(command_type.to_string()))?
            .clone();

        self.token_authority.validate(
            &envelope.security.capability_token,
            now_ts_ms(),
            &required_scope,
        )?;

        self.rate_limiter
            .allow(&envelope.security.client_id, command_type, envelope.ts_ms)?;

        let receipt = serde_json::json!({
            "allow": true,
            "command_type": command_type,
            "client_id": envelope.security.client_id,
            "required_scope": required_scope,
            "token_key_id": self.token_authority.key_id(),
            "signing_key_id": self.signer.key_id()
        });
        Ok(deterministic_hash(&receipt))
    }
}

pub trait CommandHandler {
    fn handle(&mut self, command: &TsCommand) -> RustEvent;
}

#[derive(Debug, Default)]
pub struct EchoCommandHandler;

impl CommandHandler for EchoCommandHandler {
    fn handle(&mut self, command: &TsCommand) -> RustEvent {
        match command {
            TsCommand::StartAgent { agent_id } => RustEvent::AgentLifecycle {
                state: AgentLifecycleState::Started,
                agent_id: agent_id.clone(),
            },
            TsCommand::StopAgent { agent_id } => RustEvent::AgentLifecycle {
                state: AgentLifecycleState::Stopped,
                agent_id: agent_id.clone(),
            },
            TsCommand::QueryReceiptChain { .. } => RustEvent::ReceiptAdded {
                receipt_hash: "query_receipt_chain_ack".to_string(),
            },
            TsCommand::ListActiveAgents | TsCommand::GetSystemStatus => RustEvent::SystemFeedback {
                status: "ok".to_string(),
                detail: serde_json::json!({"mode":"hosted"}),
                violation_reason: None,
            },
            TsCommand::ApplyPolicyUpdate { .. } => RustEvent::SystemFeedback {
                status: "policy_update_accepted".to_string(),
                detail: serde_json::json!({"source":"conduit"}),
                violation_reason: None,
            },
            TsCommand::InstallExtension { extension_id, .. } => RustEvent::SystemFeedback {
                status: "extension_install_accepted".to_string(),
                detail: serde_json::json!({"extension_id": extension_id}),
                violation_reason: None,
            },
        }
    }
}

#[derive(Debug, Default)]
pub struct KernelLaneCommandHandler;

impl CommandHandler for KernelLaneCommandHandler {
    fn handle(&mut self, command: &TsCommand) -> RustEvent {
        match command {
            TsCommand::StartAgent { agent_id } => {
                match decode_edge_bridge_message(agent_id) {
                    Ok(Some(message)) => return execute_edge_bridge_message(message),
                    Ok(None) => {
                        if agent_id.starts_with("lane:") {
                            let lane_receipt = build_legacy_lane_receipt(
                                agent_id
                                    .strip_prefix("lane:")
                                    .unwrap_or_default(),
                            );
                            let status = if lane_receipt
                                .get("ok")
                                .and_then(Value::as_bool)
                                .unwrap_or(false)
                            {
                                "legacy_lane_receipt"
                            } else {
                                "legacy_lane_error"
                            };
                            return RustEvent::SystemFeedback {
                                status: status.to_string(),
                                detail: serde_json::json!({ "lane_receipt": lane_receipt }),
                                violation_reason: None,
                            };
                        }
                    }
                    Err(reason) => {
                        let detail = serde_json::json!({
                            "ok": false,
                            "type": "edge_bridge_error",
                            "reason": reason,
                            "receipt_hash": deterministic_receipt_hash(&serde_json::json!({
                                "type": "edge_bridge_error",
                                "reason": reason
                            }))
                        });
                        return RustEvent::SystemFeedback {
                            status: "edge_bridge_error".to_string(),
                            detail,
                            violation_reason: Some("edge_bridge_parse_failed".to_string()),
                        };
                    }
                }
                let mut fallback = EchoCommandHandler;
                fallback.handle(command)
            }
            _ => {
                let mut fallback = EchoCommandHandler;
                fallback.handle(command)
            }
        }
    }
}

fn build_legacy_lane_receipt(raw_lane_id: &str) -> Value {
    let lane_id = clean_lane_id(raw_lane_id);
    if lane_id.is_empty() {
        return build_legacy_lane_error(raw_lane_id, "lane_id_missing_or_invalid");
    }

    let ts_ms = now_ts_ms();
    let lane_hash_seed = serde_json::json!({
        "lane": lane_id,
        "ts_ms": ts_ms,
        "type": "legacy_retired_lane",
    });
    let lane_hash_full = deterministic_receipt_hash(&lane_hash_seed);
    let lane_hash = lane_hash_full.chars().take(32).collect::<String>();

    let mut out = serde_json::json!({
        "ok": true,
        "type": "legacy_retired_lane",
        "lane_id": lane_id,
        "ts_ms": ts_ms,
        "lane_hash": lane_hash,
        "contract": {
            "deterministic": true,
            "reversible": true,
            "receipt_ready": true,
            "migrated_to_rust": true
        }
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn build_legacy_lane_error(raw_lane_id: &str, reason: &str) -> Value {
    let mut out = serde_json::json!({
        "ok": false,
        "type": "legacy_retired_lane_cli_error",
        "lane_id": clean_lane_id(raw_lane_id),
        "error": reason,
        "ts_ms": now_ts_ms(),
    });
    out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
    out
}

fn decode_edge_bridge_message(agent_id: &str) -> Result<Option<EdgeBridgeMessage>, String> {
    let trimmed = agent_id.trim();
    if trimmed.eq_ignore_ascii_case("edge_status") {
        return Ok(Some(EdgeBridgeMessage::EdgeStatus { probe: None }));
    }
    if let Some(prompt) = trimmed.strip_prefix("edge_inference:") {
        return Ok(Some(EdgeBridgeMessage::EdgeInference {
            prompt: prompt.to_string(),
            max_tokens: Some(64),
        }));
    }
    if let Some(raw_json) = trimmed.strip_prefix("edge_json:") {
        let parsed = serde_json::from_str::<EdgeBridgeMessage>(raw_json)
            .map_err(|err| format!("edge_bridge_json_invalid:{err}"))?;
        return Ok(Some(parsed));
    }
    Ok(None)
}

fn execute_edge_bridge_message(message: EdgeBridgeMessage) -> RustEvent {
    match message {
        EdgeBridgeMessage::EdgeStatus { probe } => {
            let detail = serde_json::json!({
                "ok": true,
                "type": "edge_status",
                "probe": probe,
                "backend": edge_backend_label(),
                "available": cfg!(feature = "edge"),
                "compile_time_feature_edge": cfg!(feature = "edge")
            });
            let mut out = detail;
            out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
            RustEvent::SystemFeedback {
                status: "edge_status".to_string(),
                detail: out,
                violation_reason: None,
            }
        }
        EdgeBridgeMessage::EdgeInference { prompt, max_tokens } => {
            if !cfg!(feature = "edge") {
                let detail = serde_json::json!({
                    "ok": false,
                    "type": "edge_inference",
                    "backend": edge_backend_label(),
                    "reason": "edge_feature_disabled",
                    "compile_time_feature_edge": false,
                });
                let mut out = detail;
                out["receipt_hash"] = Value::String(deterministic_receipt_hash(&out));
                return RustEvent::SystemFeedback {
                    status: "edge_backend_unavailable".to_string(),
                    detail: out,
                    violation_reason: Some("edge_feature_disabled".to_string()),
                };
            }
            let normalized = normalize_edge_prompt(&prompt);
            let token_cap = max_tokens.unwrap_or(64).clamp(1, 256) as usize;
            let output_text = summarize_for_edge_backend(&normalized, token_cap);
            let output_tokens = output_text.split_whitespace().count() as u32;
            let mut detail = serde_json::json!({
                "ok": true,
                "type": "edge_inference",
                "backend": edge_backend_label(),
                "input": {
                    "prompt_hash": deterministic_hash(&normalized),
                    "max_tokens": token_cap,
                },
                "output": {
                    "text": output_text,
                    "token_count": output_tokens,
                    "truncated": normalized.split_whitespace().count() > token_cap
                }
            });
            detail["receipt_hash"] = Value::String(deterministic_receipt_hash(&detail));
            RustEvent::SystemFeedback {
                status: "edge_inference".to_string(),
                detail,
                violation_reason: None,
            }
        }
    }
}

fn edge_backend_label() -> &'static str {
    if cfg!(feature = "edge") {
        "picolm_static_stub"
    } else {
        "edge_feature_disabled"
    }
}

fn normalize_edge_prompt(prompt: &str) -> String {
    let normalized = prompt
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if normalized.is_empty() {
        "(empty_prompt)".to_string()
    } else {
        normalized
    }
}

fn summarize_for_edge_backend(prompt: &str, token_cap: usize) -> String {
    let tokens = prompt.split_whitespace().collect::<Vec<_>>();
    if tokens.len() <= token_cap {
        return tokens.join(" ");
    }
    tokens.into_iter().take(token_cap).collect::<Vec<_>>().join(" ")
}

fn clean_lane_id(raw: &str) -> String {
    raw.trim()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        .collect::<String>()
        .to_ascii_uppercase()
}

pub fn deterministic_receipt_hash<T: Serialize>(value: &T) -> String {
    let canonical = canonical_json(value);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn validate_command<P: PolicyGate>(
    envelope: &CommandEnvelope,
    policy: &P,
    security: &mut ConduitSecurityContext,
) -> ValidationReceipt {
    if envelope.schema_id != CONDUIT_SCHEMA_ID || envelope.schema_version != CONDUIT_SCHEMA_VERSION
    {
        return fail_closed_receipt(
            "conduit_schema_mismatch",
            "policy_not_evaluated",
            "security_not_evaluated",
        );
    }

    let structural = validate_structure(&envelope.command);
    if let Some(reason) = structural {
        return fail_closed_receipt(reason, "policy_not_evaluated", "security_not_evaluated");
    }

    let decision = policy.evaluate(&envelope.command);
    let policy_receipt_hash = deterministic_hash(&serde_json::json!({
        "allow": decision.allow,
        "reason": decision.reason,
        "command_type": command_type_name(&envelope.command)
    }));

    if !decision.allow {
        return fail_closed_receipt(
            decision.reason,
            policy_receipt_hash,
            "security_not_evaluated",
        );
    }

    let security_receipt_hash = match security.validate(envelope) {
        Ok(receipt_hash) => receipt_hash,
        Err(err) => {
            return fail_closed_receipt(err.to_string(), policy_receipt_hash, "security_denied");
        }
    };

    success_receipt(policy_receipt_hash, security_receipt_hash)
}

fn validate_structure(command: &TsCommand) -> Option<String> {
    match command {
        TsCommand::StartAgent { agent_id } | TsCommand::StopAgent { agent_id } => {
            if agent_id.trim().is_empty() {
                return Some("agent_id_required".to_string());
            }
        }
        TsCommand::QueryReceiptChain { limit, .. } => {
            if let Some(value) = limit {
                if *value == 0 || *value > 1000 {
                    return Some("receipt_query_limit_out_of_range".to_string());
                }
            }
        }
        TsCommand::ApplyPolicyUpdate { patch_id, .. } => {
            if patch_id.trim().is_empty() {
                return Some("policy_patch_id_required".to_string());
            }
            if !patch_id.starts_with("constitution_safe/") {
                return Some("policy_update_must_be_constitution_safe".to_string());
            }
        }
        TsCommand::InstallExtension {
            extension_id,
            wasm_sha256,
            capabilities,
        } => {
            if extension_id.trim().is_empty() {
                return Some("extension_id_required".to_string());
            }
            if !is_valid_sha256(wasm_sha256) {
                return Some("extension_wasm_sha256_invalid".to_string());
            }
            if capabilities.is_empty() || capabilities.iter().any(|cap| cap.trim().is_empty()) {
                return Some("extension_capabilities_invalid".to_string());
            }
        }
        TsCommand::ListActiveAgents | TsCommand::GetSystemStatus => {}
    }
    None
}

fn fail_closed_receipt(
    reason: impl Into<String>,
    policy_receipt_hash: impl Into<String>,
    security_receipt_hash: impl Into<String>,
) -> ValidationReceipt {
    let reason = reason.into();
    let policy_receipt_hash = policy_receipt_hash.into();
    let security_receipt_hash = security_receipt_hash.into();
    let payload = serde_json::json!({
        "ok": false,
        "fail_closed": true,
        "reason": reason,
        "policy_receipt_hash": policy_receipt_hash,
        "security_receipt_hash": security_receipt_hash,
    });
    ValidationReceipt {
        ok: false,
        fail_closed: true,
        reason,
        policy_receipt_hash,
        security_receipt_hash,
        receipt_hash: deterministic_receipt_hash(&payload),
    }
}

fn success_receipt(
    policy_receipt_hash: impl Into<String>,
    security_receipt_hash: impl Into<String>,
) -> ValidationReceipt {
    let policy_receipt_hash = policy_receipt_hash.into();
    let security_receipt_hash = security_receipt_hash.into();
    let payload = serde_json::json!({
        "ok": true,
        "fail_closed": false,
        "reason": "validated",
        "policy_receipt_hash": policy_receipt_hash,
        "security_receipt_hash": security_receipt_hash,
    });

    ValidationReceipt {
        ok: true,
        fail_closed: false,
        reason: "validated".to_string(),
        policy_receipt_hash,
        security_receipt_hash,
        receipt_hash: deterministic_receipt_hash(&payload),
    }
}

fn is_valid_sha256(raw: &str) -> bool {
    raw.len() == 64 && raw.chars().all(|ch| ch.is_ascii_hexdigit())
}

pub fn process_command<P: PolicyGate, H: CommandHandler>(
    envelope: &CommandEnvelope,
    policy: &P,
    security: &mut ConduitSecurityContext,
    handler: &mut H,
) -> ResponseEnvelope {
    let validation = validate_command(envelope, policy, security);
    let command_type = command_type_name(&envelope.command);

    let event = if validation.ok {
        handler.handle(&envelope.command)
    } else {
        RustEvent::SystemFeedback {
            status: "policy_violation".to_string(),
            detail: serde_json::json!({"fail_closed": validation.fail_closed}),
            violation_reason: Some(validation.reason.clone()),
        }
    };

    let crossing = CrossingReceipt {
        crossing_id: envelope.request_id.clone(),
        direction: CrossingDirection::TsToRust,
        command_type: command_type.to_string(),
        deterministic_hash: deterministic_receipt_hash(envelope),
        ts_ms: now_ts_ms(),
    };

    let mut response = ResponseEnvelope {
        schema_id: CONDUIT_SCHEMA_ID.to_string(),
        schema_version: CONDUIT_SCHEMA_VERSION.to_string(),
        request_id: envelope.request_id.clone(),
        ts_ms: now_ts_ms(),
        event,
        validation,
        crossing,
        receipt_hash: String::new(),
    };
    response.receipt_hash = deterministic_receipt_hash(&response);
    response
}

pub fn run_stdio_once<R: BufRead, W: Write, P: PolicyGate, H: CommandHandler>(
    mut reader: R,
    writer: &mut W,
    policy: &P,
    security: &mut ConduitSecurityContext,
    handler: &mut H,
) -> io::Result<bool> {
    let mut line = String::new();
    let read = reader.read_line(&mut line)?;
    if read == 0 {
        return Ok(false);
    }

    let parsed = serde_json::from_str::<CommandEnvelope>(&line).map_err(invalid_data)?;
    let response = process_command(&parsed, policy, security, handler);
    serde_json::to_writer(&mut *writer, &response).map_err(invalid_data)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(true)
}

#[cfg(unix)]
pub fn run_unix_socket_server<P: AsRef<std::path::Path>, G: PolicyGate, H: CommandHandler>(
    socket_path: P,
    policy: &G,
    security: &mut ConduitSecurityContext,
    handler: &mut H,
) -> io::Result<()> {
    use std::io::BufReader;
    use std::os::unix::net::UnixListener;

    let path = socket_path.as_ref();
    if path.exists() {
        fs::remove_file(path)?;
    }

    let listener = UnixListener::bind(path)?;
    let (stream, _) = listener.accept()?;
    let read_stream = stream.try_clone()?;
    let mut reader = BufReader::new(read_stream);
    let mut writer = stream;

    while run_stdio_once(&mut reader, &mut writer, policy, security, handler)? {}
    Ok(())
}

fn invalid_data(err: impl fmt::Display) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, err.to_string())
}

fn command_type_name(command: &TsCommand) -> &'static str {
    match command {
        TsCommand::StartAgent { .. } => "start_agent",
        TsCommand::StopAgent { .. } => "stop_agent",
        TsCommand::QueryReceiptChain { .. } => "query_receipt_chain",
        TsCommand::ListActiveAgents => "list_active_agents",
        TsCommand::GetSystemStatus => "get_system_status",
        TsCommand::ApplyPolicyUpdate { .. } => "apply_policy_update",
        TsCommand::InstallExtension { .. } => "install_extension",
    }
}

struct SigningPayload<'a> {
    schema_id: &'a str,
    schema_version: &'a str,
    request_id: &'a str,
    ts_ms: u64,
    command: &'a TsCommand,
    client_id: &'a str,
    key_id: &'a str,
    nonce: &'a str,
    capability_token: &'a CapabilityToken,
}

fn signing_payload(input: SigningPayload<'_>) -> Value {
    serde_json::json!({
        "schema_id": input.schema_id,
        "schema_version": input.schema_version,
        "request_id": input.request_id,
        "ts_ms": input.ts_ms,
        "command": input.command,
        "security": {
            "client_id": input.client_id,
            "key_id": input.key_id,
            "nonce": input.nonce,
            "capability_token": input.capability_token,
        }
    })
}

fn canonical_json<T: Serialize>(value: &T) -> String {
    let json = serde_json::to_value(value).expect("serialization must succeed");
    let normalized = normalize_value(json);
    serde_json::to_string(&normalized).expect("canonical serialization must succeed")
}

fn normalize_value(value: Value) -> Value {
    match value {
        Value::Array(rows) => Value::Array(rows.into_iter().map(normalize_value).collect()),
        Value::Object(map) => {
            let mut entries = map.into_iter().collect::<Vec<_>>();
            entries.sort_by(|(lhs, _), (rhs, _)| lhs.cmp(rhs));
            let mut out = Map::new();
            for (key, value) in entries {
                out.insert(key, normalize_value(value));
            }
            Value::Object(out)
        }
        other => other,
    }
}

fn now_ts_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::{
        conduit_message_contract_count, process_command, run_stdio_once, validate_conduit_contract_budget,
        ConduitPolicy, ConduitSecurityContext, EchoCommandHandler, KernelLaneCommandHandler,
        PolicyGate, RegistryPolicyGate, RustEvent, MAX_CONDUIT_MESSAGE_TYPES, RUST_EVENT_TYPES,
        TS_COMMAND_TYPES,
    };
    use super::{CommandEnvelope, TsCommand};
    use conduit_security::{CapabilityTokenAuthority, MessageSigner, RateLimitPolicy, RateLimiter};
    use serde_json::Value;
    use std::fs;
    use std::io::{BufReader, Cursor};
    use std::path::PathBuf;

    fn test_policy_paths() -> (PathBuf, PathBuf, tempfile::TempDir) {
        let temp = tempfile::tempdir().expect("tempdir");
        let constitution = temp.path().join("AGENT-CONSTITUTION.md");
        let guard_registry = temp.path().join("guard_check_registry.json");

        fs::write(&constitution, "Mind Sovereignty Covenant\nRSI Guardrails\n")
            .expect("write constitution");

        fs::write(
            &guard_registry,
            serde_json::json!({
                "merge_guard": {
                    "checks": [
                        {"id":"contract_check"},
                        {"id":"formal_invariant_engine"}
                    ]
                }
            })
            .to_string(),
        )
        .expect("write guard registry");

        (constitution, guard_registry, temp)
    }

    fn test_policy() -> ConduitPolicy {
        let (constitution, guard_registry, temp) = test_policy_paths();
        std::mem::forget(temp);
        ConduitPolicy {
            constitution_path: constitution.to_string_lossy().to_string(),
            guard_registry_path: guard_registry.to_string_lossy().to_string(),
            rate_limit: RateLimitPolicy {
                window_ms: 5_000,
                per_client_max: 10,
                per_client_command_max: 10,
            },
            ..ConduitPolicy::default()
        }
    }

    fn test_security(policy: &ConduitPolicy) -> ConduitSecurityContext {
        ConduitSecurityContext::new(
            MessageSigner::new("msg-k1", "msg-secret"),
            CapabilityTokenAuthority::new("tok-k1", "tok-secret"),
            RateLimiter::new(policy.rate_limit.clone()),
            policy.command_required_capabilities.clone(),
        )
    }

    fn signed_envelope(policy: &ConduitPolicy, command: TsCommand) -> CommandEnvelope {
        let security = test_security(policy);
        let request_id = "req-test";
        let ts_ms = 123;
        let security_metadata =
            security.mint_security_metadata("client-a", request_id, ts_ms, &command, 60_000);
        CommandEnvelope {
            schema_id: super::CONDUIT_SCHEMA_ID.to_string(),
            schema_version: super::CONDUIT_SCHEMA_VERSION.to_string(),
            request_id: request_id.to_string(),
            ts_ms,
            command,
            security: security_metadata,
        }
    }

    #[test]
    fn command_and_event_contract_counts_match_spec() {
        assert_eq!(TS_COMMAND_TYPES.len(), 7);
        assert_eq!(RUST_EVENT_TYPES.len(), 3);
        assert_eq!(conduit_message_contract_count(), MAX_CONDUIT_MESSAGE_TYPES);
        assert!(validate_conduit_contract_budget(MAX_CONDUIT_MESSAGE_TYPES).is_ok());
    }

    #[test]
    fn secure_signed_command_passes_and_returns_receipts() {
        let policy = test_policy();
        let gate = RegistryPolicyGate::new(policy.clone());
        let mut security = test_security(&policy);
        let command = signed_envelope(
            &policy,
            TsCommand::StartAgent {
                agent_id: "agent-alpha".to_string(),
            },
        );

        let mut handler = EchoCommandHandler;
        let response = process_command(&command, &gate, &mut security, &mut handler);
        assert!(response.validation.ok);
        assert!(!response.validation.policy_receipt_hash.is_empty());
        assert!(!response.validation.security_receipt_hash.is_empty());
    }

    #[test]
    fn bad_signature_fails_closed() {
        let policy = test_policy();
        let gate = RegistryPolicyGate::new(policy.clone());
        let mut security = test_security(&policy);
        let mut command = signed_envelope(&policy, TsCommand::GetSystemStatus);
        command.security.signature = "deadbeef".to_string();

        let mut handler = EchoCommandHandler;
        let response = process_command(&command, &gate, &mut security, &mut handler);
        assert!(!response.validation.ok);
        assert!(response.validation.fail_closed);
        assert_eq!(response.validation.reason, "message_signature_invalid");
    }

    #[test]
    fn missing_scope_fails_closed() {
        let envelope_policy = test_policy();
        let command = signed_envelope(
            &envelope_policy,
            TsCommand::InstallExtension {
                extension_id: "ext-1".to_string(),
                wasm_sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
                    .to_string(),
                capabilities: vec!["metrics.read".to_string()],
            },
        );

        let mut runtime_policy = envelope_policy.clone();
        runtime_policy.command_required_capabilities.insert(
            "install_extension".to_string(),
            "extension.install.strict".to_string(),
        );

        let gate = RegistryPolicyGate::new(runtime_policy.clone());
        let mut security = test_security(&runtime_policy);

        let mut handler = EchoCommandHandler;
        let response = process_command(&command, &gate, &mut security, &mut handler);
        assert!(!response.validation.ok);
        assert!(response.validation.fail_closed);
        assert!(response
            .validation
            .reason
            .starts_with("capability_token_missing_scope"));
    }

    #[test]
    fn rate_limiting_fails_closed() {
        let mut policy = test_policy();
        policy.rate_limit = RateLimitPolicy {
            window_ms: 10_000,
            per_client_max: 2,
            per_client_command_max: 1,
        };

        let gate = RegistryPolicyGate::new(policy.clone());
        let mut security = test_security(&policy);
        let mut handler = EchoCommandHandler;

        let c1 = signed_envelope(&policy, TsCommand::GetSystemStatus);
        let c2 = signed_envelope(&policy, TsCommand::GetSystemStatus);

        let first = process_command(&c1, &gate, &mut security, &mut handler);
        assert!(first.validation.ok);

        let second = process_command(&c2, &gate, &mut security, &mut handler);
        assert!(!second.validation.ok);
        assert!(second.validation.reason.starts_with("rate_limited:"));
    }

    #[test]
    fn registry_policy_denies_when_constitution_missing_marker() {
        let temp = tempfile::tempdir().expect("tempdir");
        let constitution = temp.path().join("constitution.md");
        fs::write(&constitution, "missing markers").expect("constitution");

        let guard_registry = temp.path().join("guard_registry.json");
        fs::write(
            &guard_registry,
            serde_json::json!({"merge_guard":{"checks":[{"id":"contract_check"}]}}).to_string(),
        )
        .expect("guard registry");

        let policy = ConduitPolicy {
            constitution_path: constitution.to_string_lossy().to_string(),
            guard_registry_path: guard_registry.to_string_lossy().to_string(),
            ..ConduitPolicy::default()
        };
        let gate = RegistryPolicyGate::new(policy);

        let decision = gate.evaluate(&TsCommand::GetSystemStatus);
        assert!(!decision.allow);
        assert!(decision.reason.starts_with("constitution_marker_missing:"));
    }

    #[test]
    fn stdio_roundtrip_returns_json_response() {
        let policy = test_policy();
        let gate = RegistryPolicyGate::new(policy.clone());
        let mut security = test_security(&policy);

        let command = signed_envelope(
            &policy,
            TsCommand::StartAgent {
                agent_id: "agent-alpha".to_string(),
            },
        );

        let mut payload = serde_json::to_string(&command).expect("serialize command");
        payload.push('\n');

        let cursor = Cursor::new(payload.into_bytes());
        let reader = BufReader::new(cursor);
        let mut writer = Vec::new();
        let mut handler = EchoCommandHandler;

        let wrote = run_stdio_once(reader, &mut writer, &gate, &mut security, &mut handler)
            .expect("stdio call should succeed");
        assert!(wrote);

        let text = String::from_utf8(writer).expect("utf8 response");
        let response: super::ResponseEnvelope =
            serde_json::from_str(text.trim()).expect("json response");
        assert!(response.validation.ok);
        assert_eq!(response.request_id, "req-test");
    }

    #[test]
    fn kernel_lane_handler_returns_lane_receipt_for_lane_start() {
        let policy = test_policy();
        let gate = RegistryPolicyGate::new(policy.clone());
        let mut security = test_security(&policy);
        let command = signed_envelope(
            &policy,
            TsCommand::StartAgent {
                agent_id: "lane:SYSTEMS-ASSIMILATION-ASSIMILATION-CONTROLLER".to_string(),
            },
        );

        let mut handler = KernelLaneCommandHandler;
        let response = process_command(&command, &gate, &mut security, &mut handler);
        assert!(response.validation.ok);

        match response.event {
            RustEvent::SystemFeedback {
                status,
                detail,
                violation_reason,
            } => {
                assert_eq!(status, "legacy_lane_receipt");
                assert_eq!(violation_reason, None);
                let lane_receipt = detail
                    .get("lane_receipt")
                    .and_then(serde_json::Value::as_object)
                    .expect("lane receipt object");
                assert_eq!(
                    lane_receipt.get("ok").and_then(serde_json::Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    lane_receipt
                        .get("lane_id")
                        .and_then(serde_json::Value::as_str),
                    Some("SYSTEMS-ASSIMILATION-ASSIMILATION-CONTROLLER")
                );
                assert!(lane_receipt.contains_key("receipt_hash"));
            }
            _ => panic!("expected system_feedback event"),
        }
    }

    #[test]
    fn kernel_lane_handler_returns_edge_status_payload() {
        let policy = test_policy();
        let gate = RegistryPolicyGate::new(policy.clone());
        let mut security = test_security(&policy);
        let command = signed_envelope(
            &policy,
            TsCommand::StartAgent {
                agent_id: "edge_status".to_string(),
            },
        );

        let mut handler = KernelLaneCommandHandler;
        let response = process_command(&command, &gate, &mut security, &mut handler);
        assert!(response.validation.ok);

        match response.event {
            RustEvent::SystemFeedback { status, detail, .. } => {
                assert_eq!(status, "edge_status");
                assert_eq!(detail.get("type").and_then(Value::as_str), Some("edge_status"));
                assert!(detail.get("receipt_hash").and_then(Value::as_str).is_some());
            }
            _ => panic!("expected system_feedback event"),
        }
    }

    #[test]
    fn kernel_lane_handler_accepts_edge_json_inference_contract() {
        let policy = test_policy();
        let gate = RegistryPolicyGate::new(policy.clone());
        let mut security = test_security(&policy);
        let command = signed_envelope(
            &policy,
            TsCommand::StartAgent {
                agent_id: "edge_json:{\"type\":\"edge_inference\",\"prompt\":\"hello tiny edge world\",\"max_tokens\":3}".to_string(),
            },
        );

        let mut handler = KernelLaneCommandHandler;
        let response = process_command(&command, &gate, &mut security, &mut handler);
        assert!(response.validation.ok);

        match response.event {
            RustEvent::SystemFeedback { status, detail, .. } => {
                if cfg!(feature = "edge") {
                    assert_eq!(status, "edge_inference");
                    assert_eq!(
                        detail
                            .get("output")
                            .and_then(Value::as_object)
                            .and_then(|o| o.get("token_count"))
                            .and_then(Value::as_u64),
                        Some(3)
                    );
                } else {
                    assert_eq!(status, "edge_backend_unavailable");
                    assert_eq!(
                        detail.get("reason").and_then(Value::as_str),
                        Some("edge_feature_disabled")
                    );
                }
                assert!(detail.get("receipt_hash").and_then(Value::as_str).is_some());
            }
            _ => panic!("expected system_feedback event"),
        }
    }
}
