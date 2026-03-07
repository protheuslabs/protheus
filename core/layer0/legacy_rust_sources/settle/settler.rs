//! V4-SETTLE-001 Rust settle primitive scaffold.
//! Compile + memory-map + re-exec contract helpers.

use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct SettleRequest {
    pub runtime_hash: String,
    pub target: String,
    pub module: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SettleReceipt {
    pub runtime_hash: String,
    pub target: String,
    pub mapped_bytes: usize,
    pub reexec_ready: bool,
    pub metadata: BTreeMap<String, String>,
}

pub fn compile_runtime_image(req: &SettleRequest) -> SettleReceipt {
    let mut metadata = BTreeMap::new();
    metadata.insert("phase".into(), "compiled".into());
    metadata.insert("module".into(), req.module.clone().unwrap_or_else(|| "core".into()));

    SettleReceipt {
        runtime_hash: req.runtime_hash.clone(),
        target: req.target.clone(),
        mapped_bytes: 4096,
        reexec_ready: true,
        metadata,
    }
}

pub fn memory_map_image(receipt: &mut SettleReceipt, size_hint: usize) {
    receipt.mapped_bytes = size_hint.max(4096);
    receipt.metadata.insert("phase".into(), "mapped".into());
}

pub fn health_check(receipt: &SettleReceipt) -> bool {
    receipt.reexec_ready
        && !receipt.runtime_hash.is_empty()
        && !receipt.target.is_empty()
        && receipt.mapped_bytes >= 4096
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settle_contract_smoke() {
        let req = SettleRequest {
            runtime_hash: "abc123".into(),
            target: "binary".into(),
            module: Some("autonomy".into()),
        };
        let mut receipt = compile_runtime_image(&req);
        memory_map_image(&mut receipt, 8192);
        assert!(health_check(&receipt));
    }
}
