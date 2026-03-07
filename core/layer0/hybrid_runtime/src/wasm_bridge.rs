use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdapterManifest {
    pub schema_version: String,
    pub adapter: String,
    pub exports: Vec<String>,
    pub fallback: String,
}

pub fn validate_manifest(m: &AdapterManifest) -> bool {
    !m.schema_version.trim().is_empty()
        && m.adapter.starts_with("protheus_")
        && !m.exports.is_empty()
        && !m.fallback.trim().is_empty()
}

pub fn sample_report() -> serde_json::Value {
    let manifest = AdapterManifest {
        schema_version: "1.0".into(),
        adapter: "protheus_wasm_bridge".into(),
        exports: vec![
            "query".into(),
            "merge".into(),
            "emit".into(),
            "memory_hotpath".into(),
            "execution_replay".into(),
            "security_vault".into(),
        ],
        fallback: "ts_adapter_lane".into(),
    };
    let valid = validate_manifest(&manifest);

    json!({
        "ok": true,
        "lane": "V5-RUST-HYB-009",
        "v6_lane": "V6-RUST50-006",
        "manifest": manifest,
        "manifest_valid": valid,
        "mobile_targets": ["ios", "android", "wasm32-unknown-unknown"],
        "background_safe": true
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_validation_works() {
        let m = AdapterManifest {
            schema_version: "1.0".into(),
            adapter: "protheus_wasm_bridge".into(),
            exports: vec!["run".into()],
            fallback: "ts".into(),
        };
        assert!(validate_manifest(&m));
    }
}
