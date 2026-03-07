#![forbid(unsafe_code)]
// SPDX-License-Identifier: Apache-2.0

/// Compile-time layers for portable kernel shedding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KernelLayer {
    Layer0,
    Layer1,
    Layer2,
    Layer3,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LayerTopology {
    pub layer0: bool,
    pub layer1: bool,
    pub layer2: bool,
    pub layer3: bool,
}

impl LayerTopology {
    pub const fn active() -> Self {
        Self {
            layer0: cfg!(feature = "layer0"),
            layer1: cfg!(feature = "layer1"),
            layer2: cfg!(feature = "layer2"),
            layer3: cfg!(feature = "layer3"),
        }
    }

    pub fn highest_enabled_layer(&self) -> Option<KernelLayer> {
        if self.layer3 {
            Some(KernelLayer::Layer3)
        } else if self.layer2 {
            Some(KernelLayer::Layer2)
        } else if self.layer1 {
            Some(KernelLayer::Layer1)
        } else if self.layer0 {
            Some(KernelLayer::Layer0)
        } else {
            None
        }
    }
}

#[cfg(feature = "layer0")]
pub mod layer0 {
    pub use resource::{ResourceBudget, ResourceUsage};
    pub use task::{ClaimEvidence, ScheduleDecision, Scheduler, Task};
}

#[cfg(feature = "layer1")]
pub mod layer1 {
    pub use ipc::{deterministic_envelope_hash, IpcEnvelope, IpcError, IpcPolicy};
    pub use isolation::{CapabilityHandle, Sandbox};
    pub use storage::{StorageEngine, StorageError, StorageRecord};
    pub use update::{UpdateDecision, UpdatePackage, UpdatePolicy};
}

#[cfg(feature = "layer2")]
pub mod layer2 {
    pub use conduit::{
        conduit_message_contract_count, process_command, CrossingDirection, KernelLaneCommandHandler,
        TsCommand,
        MAX_CONDUIT_MESSAGE_TYPES,
    };
}

#[cfg(feature = "layer3")]
pub mod layer3 {
    pub use protheus_observability::{
        evaluate_trace_window, load_embedded_observability_profile, TraceEvent, TraceWindowReport,
    };
}

#[cfg(test)]
mod tests {
    use super::{KernelLayer, LayerTopology};

    #[test]
    fn topology_is_monotonic() {
        let topology = LayerTopology::active();
        if topology.layer3 {
            assert!(topology.layer2);
            assert!(topology.layer1);
            assert!(topology.layer0);
        }
        if topology.layer2 {
            assert!(topology.layer1);
            assert!(topology.layer0);
        }
        if topology.layer1 {
            assert!(topology.layer0);
        }
    }

    #[cfg(feature = "layer0")]
    #[test]
    fn layer0_scheduler_remains_available() {
        let scheduler = crate::layer0::Scheduler;
        let task = crate::layer0::Task {
            id: "task-layer0".to_string(),
            description: "compile-time minimal profile".to_string(),
            claim_evidence: vec![crate::layer0::ClaimEvidence {
                claim: "constitution_gate".to_string(),
                evidence: "receipt_hash".to_string(),
            }],
        };

        assert_eq!(
            scheduler.evaluate(&task),
            crate::layer0::ScheduleDecision::Ready
        );
    }

    #[cfg(feature = "layer1")]
    #[test]
    fn layer1_isolation_and_ipc_exports_work() {
        let sandbox = crate::layer1::Sandbox::new(vec![crate::layer1::CapabilityHandle {
            name: "kernel.exec".to_string(),
            granted: true,
        }]);
        assert!(sandbox.run_stub("kernel.exec").is_ok());

        let policy = crate::layer1::IpcPolicy {
            allowed_channels: vec!["kernel.conduit".to_string()],
            max_payload_bytes: 512,
        };
        let envelope = crate::layer1::IpcEnvelope {
            channel: "kernel.conduit".to_string(),
            payload: b"{}".to_vec(),
            nonce: "nonce-arch-001".to_string(),
            ts_millis: 1_762_000_000_000,
        };
        assert!(policy.validate(&envelope).is_ok());
    }

    #[cfg(feature = "layer2")]
    #[test]
    fn layer2_conduit_contract_export_matches_cap() {
        assert_eq!(
            crate::layer2::conduit_message_contract_count(),
            crate::layer2::MAX_CONDUIT_MESSAGE_TYPES
        );
    }

    #[cfg(feature = "layer3")]
    #[test]
    fn layer3_observability_exports_are_reachable() {
        let _ = crate::layer3::TraceEvent {
            trace_id: "trace-layer3".to_string(),
            ts_millis: 1_762_000_000_000,
            source: "kernel_layers".to_string(),
            operation: "smoke".to_string(),
            severity: "low".to_string(),
            tags: vec!["layer3".to_string()],
            payload_digest:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef".to_string(),
            signed: true,
        };
    }

    #[test]
    fn highest_layer_resolution_matches_topology() {
        let topology = LayerTopology::active();
        let highest = topology.highest_enabled_layer();
        if topology.layer3 {
            assert_eq!(highest, Some(KernelLayer::Layer3));
        } else if topology.layer2 {
            assert_eq!(highest, Some(KernelLayer::Layer2));
        } else if topology.layer1 {
            assert_eq!(highest, Some(KernelLayer::Layer1));
        } else if topology.layer0 {
            assert_eq!(highest, Some(KernelLayer::Layer0));
        } else {
            assert_eq!(highest, None);
        }
    }
}
