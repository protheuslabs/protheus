import { compileProposalSuccessCriteria } from './success_criteria_compiler';

const HIGH_TIER_TYPE_RE = /(self|mutat|security|routing|governance|integrity|policy|strategy|kernel|spine|attestation)/i;
const HIGH_TIER_CMD_RE = /(systems\/(security|spine)\/|config\/directives\/|strategy_controller|policy_rootd|capability_lease|integrity_kernel|startup_attestation)/i;
const ROLLBACK_RE = /(rollback|revert|undo|restore)/i;

type Proposal = Record<string, any>;

type QuorumPass = {
  name: string;
  high_tier: boolean;
  allow: boolean;
  signals: Record<string, boolean | number>;
};

type QuorumVerdict = {
  requires_quorum: boolean;
  ok: boolean;
  agreement: boolean;
  reason: string;
  passes: QuorumPass[];
};

function normalizeText(v: unknown): string {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function normalizeRisk(v: unknown): 'high' | 'medium' | 'low' {
  const s = normalizeText(v).toLowerCase();
  if (s === 'high' || s === 'medium' || s === 'low') return s;
  return 'medium';
}

function suggestionBlob(proposal: Proposal): string {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  return [
    p.type,
    p.title,
    p.suggested_next_command,
    p.description,
    p.summary,
    p.meta && p.meta.summary,
    p.action_spec && p.action_spec.command,
    p.action_spec && p.action_spec.rollback_command
  ].map(normalizeText).filter(Boolean).join(' | ');
}

function countMeasurableCriteria(proposal: Proposal): number {
  const rows = compileProposalSuccessCriteria(proposal, {
    include_verify: true,
    include_validation: true,
    allow_fallback: false
  });
  return rows.filter((row) => row && row.measurable === true).length;
}

function hasRollbackSignal(proposal: Proposal, blob: string): boolean {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const actionSpec = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : {};
  const rollbackField = normalizeText(actionSpec.rollback_command || p.rollback_plan || (p.meta && p.meta.rollback_plan));
  if (rollbackField && ROLLBACK_RE.test(rollbackField)) return true;
  return ROLLBACK_RE.test(blob);
}

function passA(proposal: Proposal): QuorumPass {
  const risk = normalizeRisk(proposal && proposal.risk);
  const blob = suggestionBlob(proposal);
  const type = normalizeText(proposal && proposal.type).toLowerCase();
  const highTier = risk === 'high' || HIGH_TIER_TYPE_RE.test(type) || HIGH_TIER_CMD_RE.test(blob);

  const hasCommand = normalizeText(proposal && proposal.suggested_next_command) !== ''
    || normalizeText(proposal && proposal.action_spec && proposal.action_spec.command) !== '';
  const measurableCount = countMeasurableCriteria(proposal);
  const hasRollback = hasRollbackSignal(proposal, blob);

  const allow = hasCommand && measurableCount >= 1 && hasRollback;
  return {
    name: 'primary',
    high_tier: highTier,
    allow,
    signals: {
      has_command: hasCommand,
      measurable_count: measurableCount,
      has_rollback: hasRollback
    }
  };
}

function passB(proposal: Proposal): QuorumPass {
  const risk = normalizeRisk(proposal && proposal.risk);
  const blob = suggestionBlob(proposal);
  const type = normalizeText(proposal && proposal.type).toLowerCase();
  const actionSpec = proposal && proposal.action_spec && typeof proposal.action_spec === 'object' ? proposal.action_spec : {};
  const objectiveId = normalizeText(
    (proposal && proposal.meta && proposal.meta.directive_objective_id)
      || (proposal && proposal.meta && proposal.meta.objective_id)
      || actionSpec.objective_id
  );

  const highTier = risk === 'high'
    || HIGH_TIER_CMD_RE.test(blob)
    || /(strategy|policy|security|routing|integrity|governance)/i.test(type);

  const hasBoundObjective = /^T[0-9]_[A-Za-z0-9_]+$/.test(objectiveId);
  const networkDanger = /\b(curl|wget|Invoke-WebRequest|fetch\(|axios\.)\b/i.test(blob);
  const dryRunOrPreview = /--dry-run|--dry_run|preview|score_only/.test(blob);

  const allow = hasBoundObjective && !networkDanger && dryRunOrPreview;
  return {
    name: 'secondary',
    high_tier: highTier,
    allow,
    signals: {
      bound_objective: hasBoundObjective,
      network_danger: networkDanger,
      dry_run_or_preview: dryRunOrPreview
    }
  };
}

function evaluateProposalQuorum(proposal: Proposal): QuorumVerdict {
  const a = passA(proposal);
  const b = passB(proposal);
  const requiresQuorum = a.high_tier || b.high_tier;

  if (!requiresQuorum) {
    return {
      requires_quorum: false,
      ok: true,
      agreement: true,
      reason: 'not_required',
      passes: [a, b]
    };
  }

  const agreement = a.allow === b.allow;
  const ok = agreement && a.allow === true && b.allow === true;
  let reason = 'approved';
  if (!agreement) reason = 'validator_disagreement';
  else if (!ok) reason = 'validators_denied';

  return {
    requires_quorum: true,
    ok,
    agreement,
    reason,
    passes: [a, b]
  };
}

export {
  evaluateProposalQuorum
};
