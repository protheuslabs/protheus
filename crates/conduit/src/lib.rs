use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::fmt;
use std::io::{self, BufRead, Write};
use std::time::{SystemTime, UNIX_EPOCH};

pub const CONDUIT_SCHEMA_ID: &str = "protheus_conduit";
pub const CONDUIT_SCHEMA_VERSION: &str = "1.0";

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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RustEvent {
    AgentStarted {
        agent_id: String,
    },
    AgentStopped {
        agent_id: String,
    },
    ReceiptAdded {
        receipt_hash: String,
    },
    SystemStatus {
        status: String,
        detail: Value,
    },
    PolicyViolation {
        reason: String,
    },
}

pub const RUST_EVENT_TYPES: [&str; 5] = [
    "agent_started",
    "agent_stopped",
    "receipt_added",
    "system_status",
    "policy_violation",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CommandEnvelope {
    pub schema_id: String,
    pub schema_version: String,
    pub request_id: String,
    pub ts_ms: u64,
    pub command: TsCommand,
}

impl CommandEnvelope {
    pub fn new(request_id: impl Into<String>, command: TsCommand) -> Self {
        Self {
            schema_id: CONDUIT_SCHEMA_ID.to_string(),
            schema_version: CONDUIT_SCHEMA_VERSION.to_string(),
            request_id: request_id.into(),
            ts_ms: now_ts_ms(),
            command,
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

pub trait CommandHandler {
    fn handle(&mut self, command: &TsCommand) -> RustEvent;
}

#[derive(Debug, Default)]
pub struct EchoCommandHandler;

impl CommandHandler for EchoCommandHandler {
    fn handle(&mut self, command: &TsCommand) -> RustEvent {
        match command {
            TsCommand::StartAgent { agent_id } => RustEvent::AgentStarted {
                agent_id: agent_id.clone(),
            },
            TsCommand::StopAgent { agent_id } => RustEvent::AgentStopped {
                agent_id: agent_id.clone(),
            },
            TsCommand::QueryReceiptChain { .. } => RustEvent::ReceiptAdded {
                receipt_hash: "query_receipt_chain_ack".to_string(),
            },
            TsCommand::ListActiveAgents | TsCommand::GetSystemStatus => RustEvent::SystemStatus {
                status: "ok".to_string(),
                detail: serde_json::json!({"mode":"hosted"}),
            },
            TsCommand::ApplyPolicyUpdate { .. } => RustEvent::SystemStatus {
                status: "policy_update_accepted".to_string(),
                detail: serde_json::json!({"source":"conduit"}),
            },
            TsCommand::InstallExtension { extension_id, .. } => RustEvent::SystemStatus {
                status: "extension_install_accepted".to_string(),
                detail: serde_json::json!({"extension_id": extension_id}),
            },
        }
    }
}

pub fn deterministic_receipt_hash<T: Serialize>(value: &T) -> String {
    let canonical = canonical_json(value);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hex::encode(hasher.finalize())
}

pub fn validate_command<P: PolicyGate>(command: &TsCommand, policy: &P) -> ValidationReceipt {
    let structural = validate_structure(command);
    if let Some(reason) = structural {
        return fail_closed_receipt(reason);
    }

    if matches!(command, TsCommand::ApplyPolicyUpdate { patch_id, .. } if !patch_id.starts_with("constitution_safe/"))
    {
        return fail_closed_receipt("policy_update_must_be_constitution_safe");
    }

    let decision = policy.evaluate(command);
    if !decision.allow {
        return fail_closed_receipt(decision.reason);
    }

    let ok_payload = serde_json::json!({
        "ok": true,
        "fail_closed": false,
        "reason": "validated"
    });
    ValidationReceipt {
        ok: true,
        fail_closed: false,
        reason: "validated".to_string(),
        receipt_hash: deterministic_receipt_hash(&ok_payload),
    }
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

fn fail_closed_receipt(reason: impl Into<String>) -> ValidationReceipt {
    let reason = reason.into();
    let payload = serde_json::json!({
        "ok": false,
        "fail_closed": true,
        "reason": reason,
    });
    ValidationReceipt {
        ok: false,
        fail_closed: true,
        reason,
        receipt_hash: deterministic_receipt_hash(&payload),
    }
}

fn is_valid_sha256(raw: &str) -> bool {
    raw.len() == 64 && raw.chars().all(|ch| ch.is_ascii_hexdigit())
}

pub fn process_command<P: PolicyGate, H: CommandHandler>(
    envelope: &CommandEnvelope,
    policy: &P,
    handler: &mut H,
) -> ResponseEnvelope {
    let validation = validate_command(&envelope.command, policy);
    let command_type = command_type_name(&envelope.command);

    let event = if validation.ok {
        handler.handle(&envelope.command)
    } else {
        RustEvent::PolicyViolation {
            reason: validation.reason.clone(),
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
    handler: &mut H,
) -> io::Result<bool> {
    let mut line = String::new();
    let read = reader.read_line(&mut line)?;
    if read == 0 {
        return Ok(false);
    }

    let parsed = serde_json::from_str::<CommandEnvelope>(&line).map_err(invalid_data)?;
    let response = process_command(&parsed, policy, handler);
    serde_json::to_writer(&mut *writer, &response).map_err(invalid_data)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(true)
}

#[cfg(unix)]
pub fn run_unix_socket_server<P: AsRef<std::path::Path>, G: PolicyGate, H: CommandHandler>(
    socket_path: P,
    policy: &G,
    handler: &mut H,
) -> io::Result<()> {
    use std::fs;
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

    while run_stdio_once(&mut reader, &mut writer, policy, handler)? {}
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
        process_command, run_stdio_once, AllowAllPolicy, CommandEnvelope, EchoCommandHandler,
        PolicyDecision, PolicyGate, TsCommand, RUST_EVENT_TYPES, TS_COMMAND_TYPES,
    };
    use std::io::{BufReader, Cursor};

    struct DenyPolicy;

    impl PolicyGate for DenyPolicy {
        fn evaluate(&self, _command: &TsCommand) -> PolicyDecision {
            PolicyDecision::deny("blocked_by_policy")
        }
    }

    #[test]
    fn command_and_event_contract_counts_match_spec() {
        assert_eq!(TS_COMMAND_TYPES.len(), 7);
        assert_eq!(RUST_EVENT_TYPES.len(), 5);
    }

    #[test]
    fn deterministic_receipt_hash_is_stable_for_equal_payloads() {
        let command = TsCommand::GetSystemStatus;
        let a = CommandEnvelope {
            schema_id: super::CONDUIT_SCHEMA_ID.to_string(),
            schema_version: super::CONDUIT_SCHEMA_VERSION.to_string(),
            request_id: "req-1".to_string(),
            ts_ms: 42,
            command: command.clone(),
        };
        let b = CommandEnvelope {
            schema_id: super::CONDUIT_SCHEMA_ID.to_string(),
            schema_version: super::CONDUIT_SCHEMA_VERSION.to_string(),
            request_id: "req-1".to_string(),
            ts_ms: 42,
            command,
        };
        assert_eq!(
            super::deterministic_receipt_hash(&a),
            super::deterministic_receipt_hash(&b)
        );
    }

    #[test]
    fn policy_update_requires_constitution_safe_prefix() {
        let command = CommandEnvelope {
            schema_id: super::CONDUIT_SCHEMA_ID.to_string(),
            schema_version: super::CONDUIT_SCHEMA_VERSION.to_string(),
            request_id: "req-2".to_string(),
            ts_ms: 5,
            command: TsCommand::ApplyPolicyUpdate {
                patch_id: "unsafe/patch".to_string(),
                patch: serde_json::json!({"mode":"danger"}),
            },
        };

        let mut handler = EchoCommandHandler;
        let response = process_command(&command, &AllowAllPolicy, &mut handler);
        assert!(!response.validation.ok);
        assert!(response.validation.fail_closed);
        assert_eq!(
            response.validation.reason,
            "policy_update_must_be_constitution_safe"
        );
    }

    #[test]
    fn policy_gate_denial_fails_closed() {
        let command = CommandEnvelope {
            schema_id: super::CONDUIT_SCHEMA_ID.to_string(),
            schema_version: super::CONDUIT_SCHEMA_VERSION.to_string(),
            request_id: "req-3".to_string(),
            ts_ms: 7,
            command: TsCommand::GetSystemStatus,
        };

        let mut handler = EchoCommandHandler;
        let response = process_command(&command, &DenyPolicy, &mut handler);
        assert!(!response.validation.ok);
        assert!(response.validation.fail_closed);
        assert_eq!(response.validation.reason, "blocked_by_policy");
    }

    #[test]
    fn stdio_roundtrip_returns_json_response() {
        let command = CommandEnvelope {
            schema_id: super::CONDUIT_SCHEMA_ID.to_string(),
            schema_version: super::CONDUIT_SCHEMA_VERSION.to_string(),
            request_id: "req-4".to_string(),
            ts_ms: 8,
            command: TsCommand::StartAgent {
                agent_id: "agent-alpha".to_string(),
            },
        };

        let mut payload = serde_json::to_string(&command).expect("serialize command");
        payload.push('\n');

        let cursor = Cursor::new(payload.into_bytes());
        let reader = BufReader::new(cursor);
        let mut writer = Vec::new();
        let mut handler = EchoCommandHandler;

        let wrote = run_stdio_once(reader, &mut writer, &AllowAllPolicy, &mut handler)
            .expect("stdio call should succeed");
        assert!(wrote);

        let text = String::from_utf8(writer).expect("utf8 response");
        let response: super::ResponseEnvelope =
            serde_json::from_str(text.trim()).expect("json response");
        assert!(response.validation.ok);
        assert_eq!(response.request_id, "req-4");
    }
}
