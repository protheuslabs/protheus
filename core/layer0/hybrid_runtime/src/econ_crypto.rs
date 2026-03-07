use serde_json::json;
use sha2::{Digest, Sha256};

pub fn checked_margin_bps(revenue_cents: i128, cost_cents: i128) -> Option<i64> {
    if revenue_cents <= 0 || cost_cents < 0 {
        return None;
    }
    let profit = revenue_cents.checked_sub(cost_cents)?;
    let scaled = profit.checked_mul(10_000)?;
    let bps = scaled.checked_div(revenue_cents)?;
    i64::try_from(bps).ok()
}

pub fn ledger_hash(lines: &[String]) -> String {
    let mut h = Sha256::new();
    for line in lines {
        h.update(line.as_bytes());
        h.update([0u8]);
    }
    format!("{:x}", h.finalize())
}

pub fn sample_report() -> serde_json::Value {
    let revenue = 1_250_000_i128;
    let cost = 820_000_i128;
    let margin_bps = checked_margin_bps(revenue, cost);
    let hash = ledger_hash(&[
        "rev:1250000".to_string(),
        "cost:820000".to_string(),
        "ops:120000".to_string(),
    ]);

    json!({
        "ok": true,
        "lane": "V5-RUST-HYB-006",
        "economics": {
            "revenue_cents": revenue,
            "cost_cents": cost,
            "margin_bps": margin_bps
        },
        "integrity": {
            "ledger_hash": hash,
            "hash_alg": "sha256"
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn margin_is_computed() {
        assert_eq!(checked_margin_bps(1000, 500), Some(5000));
    }

    #[test]
    fn invalid_inputs_fail() {
        assert_eq!(checked_margin_bps(0, 10), None);
        assert_eq!(checked_margin_bps(100, -1), None);
    }
}
