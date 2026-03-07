// SPDX-License-Identifier: Apache-2.0
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceBudget {
    pub cpu_quota_millis: u64,
    pub memory_quota_bytes: u64,
    pub io_quota_bytes: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ResourceUsage {
    pub cpu_used_millis: u64,
    pub memory_used_bytes: u64,
    pub io_used_bytes: u64,
}

pub const EDGE_MEMORY_THRESHOLD_BYTES: u64 = 512 * 1024 * 1024;
pub const EDGE_CPU_CORE_THRESHOLD: u16 = 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HardwareProfile {
    pub total_memory_bytes: u64,
    pub cpu_cores: u16,
    pub has_mmu: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InferenceBackend {
    Primary,
    Edge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BackendOverride {
    ForcePrimary,
    ForceEdge,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BackendSelectionReceipt {
    pub backend: InferenceBackend,
    pub constrained_hardware: bool,
    pub reason: &'static str,
}

impl ResourceBudget {
    pub fn allows(&self, usage: ResourceUsage) -> bool {
        usage.cpu_used_millis <= self.cpu_quota_millis
            && usage.memory_used_bytes <= self.memory_quota_bytes
            && usage.io_used_bytes <= self.io_quota_bytes
    }
}

pub fn is_constrained_hardware(profile: HardwareProfile) -> bool {
    !profile.has_mmu
        || profile.total_memory_bytes < EDGE_MEMORY_THRESHOLD_BYTES
        || profile.cpu_cores <= EDGE_CPU_CORE_THRESHOLD
}

pub fn select_inference_backend(
    profile: HardwareProfile,
    backend_override: Option<BackendOverride>,
) -> BackendSelectionReceipt {
    let constrained = is_constrained_hardware(profile);
    if let Some(requested) = backend_override {
        return match requested {
            BackendOverride::ForcePrimary => BackendSelectionReceipt {
                backend: InferenceBackend::Primary,
                constrained_hardware: constrained,
                reason: "override_force_primary",
            },
            BackendOverride::ForceEdge => BackendSelectionReceipt {
                backend: InferenceBackend::Edge,
                constrained_hardware: constrained,
                reason: "override_force_edge",
            },
        };
    }

    if constrained {
        BackendSelectionReceipt {
            backend: InferenceBackend::Edge,
            constrained_hardware: true,
            reason: "tier_d_constrained_hardware",
        }
    } else {
        BackendSelectionReceipt {
            backend: InferenceBackend::Primary,
            constrained_hardware: false,
            reason: "default_primary_backend",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        select_inference_backend, BackendOverride, HardwareProfile, InferenceBackend, ResourceBudget,
        ResourceUsage,
    };

    #[test]
    fn budget_enforces_cpu_memory_and_io_quotas() {
        let budget = ResourceBudget {
            cpu_quota_millis: 500,
            memory_quota_bytes: 8 * 1024,
            io_quota_bytes: 4 * 1024,
        };

        let under_quota = ResourceUsage {
            cpu_used_millis: 350,
            memory_used_bytes: 6 * 1024,
            io_used_bytes: 1 * 1024,
        };
        assert!(budget.allows(under_quota));

        let over_cpu = ResourceUsage {
            cpu_used_millis: 501,
            memory_used_bytes: 6 * 1024,
            io_used_bytes: 1 * 1024,
        };
        assert!(!budget.allows(over_cpu));
    }

    #[test]
    fn constrained_hardware_defaults_to_edge_backend() {
        let profile = HardwareProfile {
            total_memory_bytes: 256 * 1024 * 1024,
            cpu_cores: 1,
            has_mmu: true,
        };
        let receipt = select_inference_backend(profile, None);
        assert_eq!(receipt.backend, InferenceBackend::Edge);
        assert!(receipt.constrained_hardware);
        assert_eq!(receipt.reason, "tier_d_constrained_hardware");
    }

    #[test]
    fn unconstrained_hardware_defaults_to_primary_backend() {
        let profile = HardwareProfile {
            total_memory_bytes: 8 * 1024 * 1024 * 1024,
            cpu_cores: 8,
            has_mmu: true,
        };
        let receipt = select_inference_backend(profile, None);
        assert_eq!(receipt.backend, InferenceBackend::Primary);
        assert!(!receipt.constrained_hardware);
        assert_eq!(receipt.reason, "default_primary_backend");
    }

    #[test]
    fn no_mmu_forces_edge_backend_when_no_override() {
        let profile = HardwareProfile {
            total_memory_bytes: 2 * 1024 * 1024 * 1024,
            cpu_cores: 4,
            has_mmu: false,
        };
        let receipt = select_inference_backend(profile, None);
        assert_eq!(receipt.backend, InferenceBackend::Edge);
        assert!(receipt.constrained_hardware);
    }

    #[test]
    fn explicit_override_force_primary_wins_for_testing() {
        let profile = HardwareProfile {
            total_memory_bytes: 128 * 1024 * 1024,
            cpu_cores: 1,
            has_mmu: false,
        };
        let receipt = select_inference_backend(profile, Some(BackendOverride::ForcePrimary));
        assert_eq!(receipt.backend, InferenceBackend::Primary);
        assert!(receipt.constrained_hardware);
        assert_eq!(receipt.reason, "override_force_primary");
    }

    #[test]
    fn explicit_override_force_edge_supported_on_unconstrained_hosts() {
        let profile = HardwareProfile {
            total_memory_bytes: 16 * 1024 * 1024 * 1024,
            cpu_cores: 12,
            has_mmu: true,
        };
        let receipt = select_inference_backend(profile, Some(BackendOverride::ForceEdge));
        assert_eq!(receipt.backend, InferenceBackend::Edge);
        assert!(!receipt.constrained_hardware);
        assert_eq!(receipt.reason, "override_force_edge");
    }
}
