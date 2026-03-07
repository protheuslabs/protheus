// SPDX-License-Identifier: Apache-2.0
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimEvidence {
    pub claim: String,
    pub evidence: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Task {
    pub id: String,
    pub description: String,
    pub claim_evidence: Vec<ClaimEvidence>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScheduleDecision {
    Ready,
    MissingClaimEvidence,
}

#[derive(Debug, Default)]
pub struct Scheduler;

impl Scheduler {
    pub fn evaluate(&self, task: &Task) -> ScheduleDecision {
        if task.claim_evidence.is_empty() {
            return ScheduleDecision::MissingClaimEvidence;
        }

        let has_invalid_evidence = task
            .claim_evidence
            .iter()
            .any(|entry| entry.claim.trim().is_empty() || entry.evidence.trim().is_empty());

        if has_invalid_evidence {
            ScheduleDecision::MissingClaimEvidence
        } else {
            ScheduleDecision::Ready
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{ClaimEvidence, ScheduleDecision, Scheduler, Task};

    #[test]
    fn scheduler_requires_claim_evidence_before_ready() {
        let scheduler = Scheduler;
        let mut task = Task {
            id: "task-1".to_string(),
            description: "dispatch background job".to_string(),
            claim_evidence: Vec::new(),
        };

        assert_eq!(
            scheduler.evaluate(&task),
            ScheduleDecision::MissingClaimEvidence
        );

        task.claim_evidence.push(ClaimEvidence {
            claim: "job_is_authorized".to_string(),
            evidence: "policy:allow/background".to_string(),
        });

        assert_eq!(scheduler.evaluate(&task), ScheduleDecision::Ready);
    }
}
