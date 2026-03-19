// SPDX-License-Identifier: Apache-2.0
// Layer ownership: core/layer0/ops::crawl_middleware (authoritative)

use crate::{research_batch6, ParsedArgs};
use serde_json::{json, Value};
use std::path::Path;

pub fn run(root: &Path, parsed: &ParsedArgs, strict: bool) -> Value {
    let mut out = research_batch6::run_middleware(root, parsed, strict);
    let claim = out
        .get("claim_evidence")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    out["runtime_component"] = Value::String("crawl_middleware".to_string());
    out["runtime_contract"] = Value::String("V6-RESEARCH-002.2".to_string());
    out["runtime_claim"] = json!({
        "id": "V6-RESEARCH-002.2",
        "claim": "scrapy_runtime_middleware_lane_is_wired_and_receipted_through_research_plane",
        "evidence": {
            "component": "crawl_middleware",
            "claim_count": claim.len()
        }
    });
    out
}
