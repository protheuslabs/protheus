// SPDX-License-Identifier: Apache-2.0
pub const CHECK_ID: &str = "burn_oracle_budget_gate";
pub const RECEIPT_SCHEMA_ID: &str = "burn_oracle_budget_gate_receipt";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OracleStatus {
    Available { remaining_burn_units: u64 },
    Unavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BurnOracleBudgetRequest {
    pub requested_burn_units: u64,
    pub max_allowed_burn_units: u64,
    pub oracle_status: OracleStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BurnOracleBudgetReceipt {
    pub schema_id: &'static str,
    pub check_id: &'static str,
    pub ok: bool,
    pub code: &'static str,
    pub requested_burn_units: u64,
    pub max_allowed_burn_units: u64,
    pub oracle_remaining_burn_units: Option<u64>,
    pub deterministic_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BurnOracleBudgetDecision {
    pub ok: bool,
    pub code: &'static str,
    pub receipt: BurnOracleBudgetReceipt,
}

impl BurnOracleBudgetDecision {
    fn denied(
        code: &'static str,
        requested_burn_units: u64,
        max_allowed_burn_units: u64,
        oracle_remaining_burn_units: Option<u64>,
    ) -> Self {
        Self {
            ok: false,
            code,
            receipt: BurnOracleBudgetReceipt::new(
                false,
                code,
                requested_burn_units,
                max_allowed_burn_units,
                oracle_remaining_burn_units,
            ),
        }
    }

    fn allow(
        requested_burn_units: u64,
        max_allowed_burn_units: u64,
        oracle_remaining_burn_units: Option<u64>,
    ) -> Self {
        Self {
            ok: true,
            code: "ok",
            receipt: BurnOracleBudgetReceipt::new(
                true,
                "ok",
                requested_burn_units,
                max_allowed_burn_units,
                oracle_remaining_burn_units,
            ),
        }
    }
}

impl BurnOracleBudgetReceipt {
    fn new(
        ok: bool,
        code: &'static str,
        requested_burn_units: u64,
        max_allowed_burn_units: u64,
        oracle_remaining_burn_units: Option<u64>,
    ) -> Self {
        let remaining = oracle_remaining_burn_units
            .map(|v| v.to_string())
            .unwrap_or_else(|| "none".to_string());
        let deterministic_key = format!(
            "{CHECK_ID}|{}|{code}|{requested_burn_units}|{max_allowed_burn_units}|{remaining}",
            if ok { 1 } else { 0 }
        );
        Self {
            schema_id: RECEIPT_SCHEMA_ID,
            check_id: CHECK_ID,
            ok,
            code,
            requested_burn_units,
            max_allowed_burn_units,
            oracle_remaining_burn_units,
            deterministic_key,
        }
    }
}

pub fn evaluate_burn_oracle_budget_gate(
    request: BurnOracleBudgetRequest,
) -> BurnOracleBudgetDecision {
    if request.max_allowed_burn_units == 0 {
        return BurnOracleBudgetDecision::denied(
            "budget_policy_invalid",
            request.requested_burn_units,
            request.max_allowed_burn_units,
            match request.oracle_status {
                OracleStatus::Available {
                    remaining_burn_units,
                } => Some(remaining_burn_units),
                OracleStatus::Unavailable => None,
            },
        );
    }

    if request.requested_burn_units == 0 {
        return BurnOracleBudgetDecision::denied(
            "request_below_minimum",
            request.requested_burn_units,
            request.max_allowed_burn_units,
            match request.oracle_status {
                OracleStatus::Available {
                    remaining_burn_units,
                } => Some(remaining_burn_units),
                OracleStatus::Unavailable => None,
            },
        );
    }

    if request.requested_burn_units > request.max_allowed_burn_units {
        return BurnOracleBudgetDecision::denied(
            "budget_bound_exceeded",
            request.requested_burn_units,
            request.max_allowed_burn_units,
            match request.oracle_status {
                OracleStatus::Available {
                    remaining_burn_units,
                } => Some(remaining_burn_units),
                OracleStatus::Unavailable => None,
            },
        );
    }

    match request.oracle_status {
        OracleStatus::Unavailable => BurnOracleBudgetDecision::denied(
            "oracle_unavailable_fail_closed",
            request.requested_burn_units,
            request.max_allowed_burn_units,
            None,
        ),
        OracleStatus::Available {
            remaining_burn_units,
        } if request.requested_burn_units > remaining_burn_units => {
            BurnOracleBudgetDecision::denied(
                "oracle_budget_exceeded",
                request.requested_burn_units,
                request.max_allowed_burn_units,
                Some(remaining_burn_units),
            )
        }
        OracleStatus::Available {
            remaining_burn_units,
        } => BurnOracleBudgetDecision::allow(
            request.requested_burn_units,
            request.max_allowed_burn_units,
            Some(remaining_burn_units),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_limit_zero_fails_closed() {
        let decision = evaluate_burn_oracle_budget_gate(BurnOracleBudgetRequest {
            requested_burn_units: 2,
            max_allowed_burn_units: 0,
            oracle_status: OracleStatus::Available {
                remaining_burn_units: 5,
            },
        });
        assert!(!decision.ok);
        assert_eq!(decision.code, "budget_policy_invalid");
    }
}
