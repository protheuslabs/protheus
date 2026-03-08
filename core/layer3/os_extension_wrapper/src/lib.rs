#![forbid(unsafe_code)]

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OsExtensionDescriptor {
    pub extension_id: String,
    pub namespace: String,
    pub capability_manifest_hash: String,
    pub syscall_surface: Vec<String>,
    pub driver_surface: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OsExtensionEnvelope {
    pub source_layer: String,
    pub extension_id: String,
    pub namespace: String,
    pub action: String,
    pub ts_ms: i64,
}

pub fn wrap_os_extension(descriptor: &OsExtensionDescriptor, action: &str, ts_ms: i64) -> OsExtensionEnvelope {
    OsExtensionEnvelope {
        source_layer: "layer3".to_string(),
        extension_id: descriptor.extension_id.clone(),
        namespace: descriptor.namespace.clone(),
        action: action.trim().to_string(),
        ts_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wraps_extension_action() {
        let d = OsExtensionDescriptor {
            extension_id: "os.netstack.v1".to_string(),
            namespace: "protheus.net".to_string(),
            capability_manifest_hash: "abc123".to_string(),
            syscall_surface: vec!["net.open".to_string()],
            driver_surface: vec!["driver.nic".to_string()],
        };
        let env = wrap_os_extension(&d, "activate", 1_762_000_000_000);
        assert_eq!(env.source_layer, "layer3");
        assert_eq!(env.action, "activate");
    }
}
