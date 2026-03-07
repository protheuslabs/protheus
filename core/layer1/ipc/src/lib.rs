// SPDX-License-Identifier: Apache-2.0
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IpcEnvelope {
    pub channel: String,
    pub payload: Vec<u8>,
    pub nonce: String,
    pub ts_millis: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IpcPolicy {
    pub allowed_channels: Vec<String>,
    pub max_payload_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IpcError {
    InvalidChannel,
    PayloadTooLarge,
    MissingNonce,
}

impl IpcPolicy {
    pub fn validate(&self, envelope: &IpcEnvelope) -> Result<(), IpcError> {
        if envelope.nonce.trim().is_empty() {
            return Err(IpcError::MissingNonce);
        }
        if envelope.payload.len() > self.max_payload_bytes {
            return Err(IpcError::PayloadTooLarge);
        }
        let channel_allowed = self
            .allowed_channels
            .iter()
            .any(|ch| ch.as_str() == envelope.channel.as_str());
        if !channel_allowed {
            return Err(IpcError::InvalidChannel);
        }
        Ok(())
    }
}

pub fn deterministic_envelope_hash(envelope: &IpcEnvelope) -> String {
    let mut hasher = Sha256::new();
    hasher.update(envelope.channel.as_bytes());
    hasher.update(b"|");
    hasher.update(envelope.nonce.as_bytes());
    hasher.update(b"|");
    hasher.update(envelope.ts_millis.to_string().as_bytes());
    hasher.update(b"|");
    hasher.update(&envelope.payload);
    hex::encode(hasher.finalize())
}

#[cfg(test)]
mod tests {
    use super::{deterministic_envelope_hash, IpcEnvelope, IpcError, IpcPolicy};

    fn policy() -> IpcPolicy {
        IpcPolicy {
            allowed_channels: vec!["kernel.conduit".to_string(), "kernel.status".to_string()],
            max_payload_bytes: 1024,
        }
    }

    #[test]
    fn policy_allows_known_channel_and_bounded_payload() {
        let envelope = IpcEnvelope {
            channel: "kernel.conduit".to_string(),
            payload: b"{\"ok\":true}".to_vec(),
            nonce: "nonce-1".to_string(),
            ts_millis: 1_762_000_000_000,
        };
        assert!(policy().validate(&envelope).is_ok());
    }

    #[test]
    fn policy_rejects_unknown_channel() {
        let envelope = IpcEnvelope {
            channel: "external.unknown".to_string(),
            payload: b"{}".to_vec(),
            nonce: "nonce-2".to_string(),
            ts_millis: 1_762_000_000_001,
        };
        assert_eq!(policy().validate(&envelope), Err(IpcError::InvalidChannel));
    }

    #[test]
    fn policy_rejects_missing_nonce_and_oversized_payload() {
        let mut envelope = IpcEnvelope {
            channel: "kernel.conduit".to_string(),
            payload: vec![1u8; 2048],
            nonce: String::new(),
            ts_millis: 1_762_000_000_002,
        };
        assert_eq!(policy().validate(&envelope), Err(IpcError::MissingNonce));
        envelope.nonce = "nonce-3".to_string();
        assert_eq!(policy().validate(&envelope), Err(IpcError::PayloadTooLarge));
    }

    #[test]
    fn deterministic_hash_is_stable_for_same_envelope() {
        let envelope = IpcEnvelope {
            channel: "kernel.status".to_string(),
            payload: b"{\"mode\":\"run\"}".to_vec(),
            nonce: "nonce-4".to_string(),
            ts_millis: 1_762_000_000_003,
        };
        let h1 = deterministic_envelope_hash(&envelope);
        let h2 = deterministic_envelope_hash(&envelope);
        assert_eq!(h1, h2);
    }
}
