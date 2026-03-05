use burn_oracle_budget_gate::{
    evaluate_burn_oracle_budget_gate, BurnOracleBudgetRequest, OracleStatus,
};

#[test]
fn budget_bounds_enforced_fail_closed() {
    let exceeds_policy = evaluate_burn_oracle_budget_gate(BurnOracleBudgetRequest {
        requested_burn_units: 11,
        max_allowed_burn_units: 10,
        oracle_status: OracleStatus::Available {
            remaining_burn_units: 100,
        },
    });
    assert!(!exceeds_policy.ok);
    assert_eq!(exceeds_policy.code, "budget_bound_exceeded");

    let below_minimum = evaluate_burn_oracle_budget_gate(BurnOracleBudgetRequest {
        requested_burn_units: 0,
        max_allowed_burn_units: 10,
        oracle_status: OracleStatus::Available {
            remaining_burn_units: 100,
        },
    });
    assert!(!below_minimum.ok);
    assert_eq!(below_minimum.code, "request_below_minimum");
}

#[test]
fn oracle_unavailable_fails_closed() {
    let decision = evaluate_burn_oracle_budget_gate(BurnOracleBudgetRequest {
        requested_burn_units: 4,
        max_allowed_burn_units: 10,
        oracle_status: OracleStatus::Unavailable,
    });
    assert!(!decision.ok);
    assert_eq!(decision.code, "oracle_unavailable_fail_closed");
}

#[test]
fn oracle_budget_limit_is_enforced() {
    let decision = evaluate_burn_oracle_budget_gate(BurnOracleBudgetRequest {
        requested_burn_units: 9,
        max_allowed_burn_units: 10,
        oracle_status: OracleStatus::Available {
            remaining_burn_units: 8,
        },
    });
    assert!(!decision.ok);
    assert_eq!(decision.code, "oracle_budget_exceeded");
}

#[test]
fn deterministic_receipts_are_stable_for_equal_inputs() {
    let request = BurnOracleBudgetRequest {
        requested_burn_units: 5,
        max_allowed_burn_units: 10,
        oracle_status: OracleStatus::Available {
            remaining_burn_units: 20,
        },
    };

    let first = evaluate_burn_oracle_budget_gate(request);
    let second = evaluate_burn_oracle_budget_gate(request);

    assert_eq!(first.receipt, second.receipt);
    assert_eq!(
        first.receipt.deterministic_key,
        second.receipt.deterministic_key
    );
}
