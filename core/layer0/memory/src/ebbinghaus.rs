// SPDX-License-Identifier: Apache-2.0
use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct RetentionCurve {
    pub lambda: f64,
    pub age_days: f64,
    pub repetitions: u32,
    pub retention_score: f64,
}

pub fn retention_score(age_days: f64, repetitions: u32, lambda: f64) -> f64 {
    let safe_age = age_days.max(0.0);
    let safe_reps = repetitions.max(1) as f64;
    let repetition_boost = 1.0 + safe_reps.ln();
    let denom = (lambda.max(0.0001) / repetition_boost).max(0.00001);
    (-denom * safe_age).exp().clamp(0.0, 1.0)
}

pub fn curve(age_days: f64, repetitions: u32, lambda: f64) -> RetentionCurve {
    RetentionCurve {
        lambda,
        age_days,
        repetitions,
        retention_score: retention_score(age_days, repetitions, lambda),
    }
}

#[allow(dead_code)]
pub fn should_retain(age_days: f64, repetitions: u32, lambda: f64, threshold: f64) -> bool {
    retention_score(age_days, repetitions, lambda) >= threshold
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_decays_with_time() {
        let fresh = retention_score(0.1, 1, 0.02);
        let old = retention_score(30.0, 1, 0.02);
        assert!(fresh > old);
    }

    #[test]
    fn repetitions_improve_retention() {
        let low = retention_score(7.0, 1, 0.02);
        let high = retention_score(7.0, 5, 0.02);
        assert!(high > low);
    }
}
