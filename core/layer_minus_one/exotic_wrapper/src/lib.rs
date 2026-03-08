#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum ExoticDomain {
    Ternary,
    Quantum,
    Neural,
    Analog,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ExoticEnvelope {
    pub domain: ExoticDomain,
    pub adapter_id: String,
    pub signal_type: String,
    pub payload_ref: String,
    pub ts_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Layer0Envelope {
    pub source_layer: String,
    pub adapter_id: String,
    pub capability_class: String,
    pub deterministic_digest: String,
    pub ts_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DegradationContract {
    pub primary: String,
    pub fallback: String,
    pub reason: String,
}

pub fn wrap_exotic_signal(env: &ExoticEnvelope, capability_class: &str) -> Layer0Envelope {
    let mut hasher = Sha256::new();
    hasher.update(format!(
        "{:?}|{}|{}|{}|{}|{}",
        env.domain,
        env.adapter_id,
        env.signal_type,
        env.payload_ref,
        env.ts_ms,
        capability_class
    ));
    let digest = format!("{:x}", hasher.finalize());
    Layer0Envelope {
        source_layer: "layer_minus_one".to_string(),
        adapter_id: env.adapter_id.clone(),
        capability_class: capability_class.trim().to_string(),
        deterministic_digest: digest,
        ts_ms: env.ts_ms,
    }
}

pub fn default_degradation(domain: &ExoticDomain) -> DegradationContract {
    match domain {
        ExoticDomain::Quantum => DegradationContract {
            primary: "quantum_domain".to_string(),
            fallback: "classical_approximation".to_string(),
            reason: "qpu_unavailable_or_fidelity_below_gate".to_string(),
        },
        ExoticDomain::Neural => DegradationContract {
            primary: "neural_io".to_string(),
            fallback: "standard_ui_io".to_string(),
            reason: "consent_kernel_unavailable".to_string(),
        },
        ExoticDomain::Ternary => DegradationContract {
            primary: "ternary_domain".to_string(),
            fallback: "binary_encoding".to_string(),
            reason: "no_ternary_backend".to_string(),
        },
        _ => DegradationContract {
            primary: "exotic_domain".to_string(),
            fallback: "binary_safe_mode".to_string(),
            reason: "unsupported_or_unknown_domain".to_string(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wrapper_is_deterministic() {
        let env = ExoticEnvelope {
            domain: ExoticDomain::Quantum,
            adapter_id: "qpu.ibm.sim".to_string(),
            signal_type: "measurement_batch".to_string(),
            payload_ref: "blob://abc".to_string(),
            ts_ms: 1_762_000_000_000,
        };
        let a = wrap_exotic_signal(&env, "measure.quantum");
        let b = wrap_exotic_signal(&env, "measure.quantum");
        assert_eq!(a, b);
    }
}
