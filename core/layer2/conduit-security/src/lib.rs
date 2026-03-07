// SPDX-License-Identifier: Apache-2.0
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CapabilityToken {
    pub token_id: String,
    pub subject: String,
    pub capabilities: Vec<String>,
    pub issued_at_ms: u64,
    pub expires_at_ms: u64,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecurityError {
    SignatureInvalid,
    CapabilityTokenInvalid,
    CapabilityTokenExpired,
    CapabilityTokenMissingScope(String),
    RateLimited {
        scope: String,
        limit: u32,
        window_ms: u64,
    },
}

impl fmt::Display for SecurityError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SecurityError::SignatureInvalid => write!(f, "message_signature_invalid"),
            SecurityError::CapabilityTokenInvalid => write!(f, "capability_token_invalid"),
            SecurityError::CapabilityTokenExpired => write!(f, "capability_token_expired"),
            SecurityError::CapabilityTokenMissingScope(scope) => {
                write!(f, "capability_token_missing_scope:{scope}")
            }
            SecurityError::RateLimited {
                scope,
                limit,
                window_ms,
            } => write!(f, "rate_limited:{scope}:{limit}:{window_ms}"),
        }
    }
}

impl std::error::Error for SecurityError {}

#[derive(Debug, Clone)]
pub struct MessageSigner {
    key_id: String,
    secret: String,
}

impl MessageSigner {
    pub fn new(key_id: impl Into<String>, secret: impl Into<String>) -> Self {
        Self {
            key_id: key_id.into(),
            secret: secret.into(),
        }
    }

    pub fn key_id(&self) -> &str {
        &self.key_id
    }

    pub fn sign_value<T: Serialize>(&self, value: &T) -> String {
        let payload = canonical_json(value);
        self.sign_payload(&payload)
    }

    pub fn verify_value<T: Serialize>(&self, value: &T, signature: &str) -> bool {
        let payload = canonical_json(value);
        self.verify_payload(&payload, signature)
    }

    pub fn sign_payload(&self, payload: &str) -> String {
        sign_secret_payload(&self.key_id, &self.secret, payload)
    }

    pub fn verify_payload(&self, payload: &str, signature: &str) -> bool {
        self.sign_payload(payload) == signature
    }
}

#[derive(Debug, Clone)]
pub struct CapabilityTokenAuthority {
    signer: MessageSigner,
}

impl CapabilityTokenAuthority {
    pub fn new(key_id: impl Into<String>, secret: impl Into<String>) -> Self {
        Self {
            signer: MessageSigner::new(key_id, secret),
        }
    }

    pub fn key_id(&self) -> &str {
        self.signer.key_id()
    }

    pub fn mint(
        &self,
        token_id: impl Into<String>,
        subject: impl Into<String>,
        mut capabilities: Vec<String>,
        issued_at_ms: u64,
        expires_at_ms: u64,
    ) -> CapabilityToken {
        capabilities.sort();
        capabilities.dedup();

        let mut token = CapabilityToken {
            token_id: token_id.into(),
            subject: subject.into(),
            capabilities,
            issued_at_ms,
            expires_at_ms,
            signature: String::new(),
        };
        token.signature = self.signer.sign_value(&token_claims_view(&token));
        token
    }

    pub fn validate(
        &self,
        token: &CapabilityToken,
        now_ms: u64,
        required_scope: &str,
    ) -> Result<(), SecurityError> {
        let signed = self
            .signer
            .verify_value(&token_claims_view(token), &token.signature);
        if !signed {
            return Err(SecurityError::CapabilityTokenInvalid);
        }
        if now_ms > token.expires_at_ms {
            return Err(SecurityError::CapabilityTokenExpired);
        }
        if !token
            .capabilities
            .iter()
            .any(|scope| scope == required_scope)
        {
            return Err(SecurityError::CapabilityTokenMissingScope(
                required_scope.to_string(),
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RateLimitPolicy {
    pub window_ms: u64,
    pub per_client_max: u32,
    pub per_client_command_max: u32,
}

impl Default for RateLimitPolicy {
    fn default() -> Self {
        Self {
            window_ms: 1_000,
            per_client_max: 60,
            per_client_command_max: 20,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct WindowCounter {
    window_start_ms: u64,
    count: u32,
}

impl WindowCounter {
    fn new(now_ms: u64) -> Self {
        Self {
            window_start_ms: now_ms,
            count: 0,
        }
    }

    fn increment(&mut self, now_ms: u64, window_ms: u64) {
        if now_ms.saturating_sub(self.window_start_ms) >= window_ms {
            self.window_start_ms = now_ms;
            self.count = 0;
        }
        self.count = self.count.saturating_add(1);
    }
}

#[derive(Debug, Clone)]
pub struct RateLimiter {
    policy: RateLimitPolicy,
    per_client: HashMap<String, WindowCounter>,
    per_client_command: HashMap<String, WindowCounter>,
}

impl RateLimiter {
    pub fn new(policy: RateLimitPolicy) -> Self {
        Self {
            policy,
            per_client: HashMap::new(),
            per_client_command: HashMap::new(),
        }
    }

    pub fn policy(&self) -> &RateLimitPolicy {
        &self.policy
    }

    pub fn allow(
        &mut self,
        client_id: &str,
        command_type: &str,
        now_ms: u64,
    ) -> Result<(), SecurityError> {
        let client_counter = self
            .per_client
            .entry(client_id.to_string())
            .or_insert_with(|| WindowCounter::new(now_ms));
        client_counter.increment(now_ms, self.policy.window_ms);
        if client_counter.count > self.policy.per_client_max {
            return Err(SecurityError::RateLimited {
                scope: "client".to_string(),
                limit: self.policy.per_client_max,
                window_ms: self.policy.window_ms,
            });
        }

        let command_key = format!("{client_id}:{command_type}");
        let command_counter = self
            .per_client_command
            .entry(command_key)
            .or_insert_with(|| WindowCounter::new(now_ms));
        command_counter.increment(now_ms, self.policy.window_ms);
        if command_counter.count > self.policy.per_client_command_max {
            return Err(SecurityError::RateLimited {
                scope: "client_command".to_string(),
                limit: self.policy.per_client_command_max,
                window_ms: self.policy.window_ms,
            });
        }
        Ok(())
    }
}

pub fn deterministic_hash<T: Serialize>(value: &T) -> String {
    let canonical = canonical_json(value);
    let mut hasher = Sha256::new();
    hasher.update(canonical.as_bytes());
    hex::encode(hasher.finalize())
}

fn sign_secret_payload(key_id: &str, secret: &str, payload: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(key_id.as_bytes());
    hasher.update(b":");
    hasher.update(secret.as_bytes());
    hasher.update(b":");
    hasher.update(payload.as_bytes());
    hex::encode(hasher.finalize())
}

fn token_claims_view(token: &CapabilityToken) -> Value {
    serde_json::json!({
        "token_id": token.token_id,
        "subject": token.subject,
        "capabilities": token.capabilities,
        "issued_at_ms": token.issued_at_ms,
        "expires_at_ms": token.expires_at_ms
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

#[cfg(test)]
mod tests {
    use super::{
        deterministic_hash, CapabilityTokenAuthority, MessageSigner, RateLimitPolicy, RateLimiter,
        SecurityError,
    };

    #[test]
    fn deterministic_hash_is_stable() {
        let a = serde_json::json!({"b":2,"a":[3,1]});
        let b = serde_json::json!({"a":[3,1],"b":2});
        assert_eq!(deterministic_hash(&a), deterministic_hash(&b));
    }

    #[test]
    fn message_signer_round_trip_verifies() {
        let signer = MessageSigner::new("k-1", "super-secret");
        let payload = serde_json::json!({"command":"start_agent","agent_id":"alpha"});
        let sig = signer.sign_value(&payload);
        assert!(signer.verify_value(&payload, &sig));
        assert!(!signer.verify_value(&serde_json::json!({"command":"stop_agent"}), &sig));
    }

    #[test]
    fn capability_token_validation_checks_scope_and_expiry() {
        let authority = CapabilityTokenAuthority::new("tok-k1", "token-secret");
        let token = authority.mint(
            "tok-1",
            "client-a",
            vec!["system.read".to_string()],
            1_000,
            2_000,
        );

        assert!(authority.validate(&token, 1_500, "system.read").is_ok());

        let missing = authority
            .validate(&token, 1_500, "agent.lifecycle")
            .expect_err("missing scope should fail");
        assert_eq!(
            missing,
            SecurityError::CapabilityTokenMissingScope("agent.lifecycle".to_string())
        );

        let expired = authority
            .validate(&token, 2_001, "system.read")
            .expect_err("expired should fail");
        assert_eq!(expired, SecurityError::CapabilityTokenExpired);
    }

    #[test]
    fn rate_limiter_blocks_after_threshold() {
        let policy = RateLimitPolicy {
            window_ms: 1_000,
            per_client_max: 4,
            per_client_command_max: 2,
        };
        let mut limiter = RateLimiter::new(policy);

        assert!(limiter.allow("client-a", "get_system_status", 10).is_ok());
        assert!(limiter.allow("client-a", "get_system_status", 20).is_ok());
        let command_limited = limiter
            .allow("client-a", "get_system_status", 30)
            .expect_err("per-command limit should trip first");
        assert!(matches!(
            command_limited,
            SecurityError::RateLimited {
                scope,
                limit: 2,
                window_ms: 1_000
            } if scope == "client_command"
        ));

        assert!(limiter.allow("client-a", "query_receipt_chain", 40).is_ok());
        let client_limited = limiter
            .allow("client-a", "query_receipt_chain", 50)
            .expect_err("per-client limit should now trip");
        assert!(matches!(
            client_limited,
            SecurityError::RateLimited {
                scope,
                limit: 4,
                window_ms: 1_000
            } if scope == "client"
        ));

        assert!(limiter
            .allow("client-a", "get_system_status", 1_500)
            .is_ok());
    }
}
