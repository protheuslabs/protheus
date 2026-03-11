'use strict';

function asString(v) {
  return String(v == null ? '' : v).trim();
}

function asLower(v) {
  return asString(v).toLowerCase();
}

function asStringArrayLower(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const item of v) {
    const s = asLower(item);
    if (!s) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function normalizeCampaigns(strategy) {
  const campaigns = strategy && Array.isArray(strategy.campaigns) ? strategy.campaigns : [];
  return campaigns
    .filter((campaign) => asLower(campaign && campaign.status) === 'active')
    .map((campaign) => {
      const phases = Array.isArray(campaign && campaign.phases) ? campaign.phases : [];
      const activePhases = phases
        .filter((phase) => asLower(phase && phase.status) === 'active')
        .sort((a, b) => {
          const ao = Number(a && a.order || 99);
          const bo = Number(b && b.order || 99);
          if (ao !== bo) return ao - bo;
          const ap = Number(a && a.priority || 0);
          const bp = Number(b && b.priority || 0);
          if (bp !== ap) return bp - ap;
          return asString(a && a.id).localeCompare(asString(b && b.id));
        });
      return {
        id: asLower(campaign && campaign.id),
        name: asString(campaign && campaign.name),
        objective_id: asString(campaign && campaign.objective_id),
        priority: Number(campaign && campaign.priority || 50),
        proposal_types: asStringArrayLower(campaign && campaign.proposal_types),
        source_eyes: asStringArrayLower(campaign && campaign.source_eyes),
        tags: asStringArrayLower(campaign && campaign.tags),
        phases: activePhases.map((phase) => ({
          id: asLower(phase && phase.id),
          name: asString(phase && phase.name),
          objective_id: asString(phase && phase.objective_id),
          order: Number(phase && phase.order || 99),
          priority: Number(phase && phase.priority || 0),
          proposal_types: asStringArrayLower(phase && phase.proposal_types),
          source_eyes: asStringArrayLower(phase && phase.source_eyes),
          tags: asStringArrayLower(phase && phase.tags)
        }))
      };
    })
    .filter((campaign) => campaign.id && campaign.phases.length > 0)
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.id.localeCompare(b.id);
    });
}

function candidateObjectiveId(candidate) {
  const c = candidate && typeof candidate === 'object' ? candidate : {};
  const proposal = c.proposal && typeof c.proposal === 'object' ? c.proposal : {};
  const meta = proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
  const actionSpec = proposal.action_spec && typeof proposal.action_spec === 'object' ? proposal.action_spec : {};
  const parts = [
    c.objective_binding && c.objective_binding.objective_id,
    c.directive_pulse && c.directive_pulse.objective_id,
    meta.objective_id,
    meta.directive_objective_id,
    actionSpec.objective_id
  ];
  for (const value of parts) {
    const s = asString(value);
    if (s) return s;
  }
  return '';
}

function candidateType(candidate) {
  return asLower(candidate && candidate.proposal && candidate.proposal.type);
}

function candidateSourceEye(candidate) {
  return asLower(candidate && candidate.proposal && candidate.proposal.meta && candidate.proposal.meta.source_eye);
}

function candidateTagSet(candidate) {
  const proposal = candidate && candidate.proposal && typeof candidate.proposal === 'object'
    ? candidate.proposal
    : {};
  const tagsA = asStringArrayLower(proposal.tags);
  const tagsB = asStringArrayLower(proposal.meta && proposal.meta.tags);
  return new Set([...tagsA, ...tagsB]);
}

function hasAnyOverlap(list, setObj) {
  if (!Array.isArray(list) || list.length === 0) return true;
  for (const item of list) {
    if (setObj.has(item)) return true;
  }
  return false;
}

function isFilterMatch(requiredList, value) {
  if (!Array.isArray(requiredList) || requiredList.length === 0) return true;
  return requiredList.includes(value);
}

function scoreMatch(campaign, phase, info) {
  if (!campaign || !phase || !info) return null;

  const objectiveId = asString(info.objective_id);
  const proposalType = asString(info.proposal_type);
  const sourceEye = asString(info.source_eye);

  if (campaign.objective_id && objectiveId !== campaign.objective_id) return null;
  if (phase.objective_id && objectiveId !== phase.objective_id) return null;
  if (!isFilterMatch(campaign.proposal_types, proposalType)) return null;
  if (!isFilterMatch(phase.proposal_types, proposalType)) return null;
  if (!isFilterMatch(campaign.source_eyes, sourceEye)) return null;
  if (!isFilterMatch(phase.source_eyes, sourceEye)) return null;
  if (!hasAnyOverlap(campaign.tags, info.tags)) return null;
  if (!hasAnyOverlap(phase.tags, info.tags)) return null;

  const tagOverlap = Math.max(
    0,
    [...info.tags].filter((tag) => campaign.tags.includes(tag) || phase.tags.includes(tag)).length
  );

  let score = 0;
  score += Math.max(0, 120 - Number(campaign.priority || 50));
  score += Math.max(0, 80 - (Number(phase.order || 99) * 5));
  score += Number(phase.priority || 0);
  if (campaign.objective_id && objectiveId) score += 35;
  if (phase.objective_id && objectiveId) score += 20;
  if (campaign.proposal_types.length > 0) score += 18;
  if (phase.proposal_types.length > 0) score += 14;
  if (campaign.source_eyes.length > 0 || phase.source_eyes.length > 0) score += 10;
  score += Math.min(20, tagOverlap * 4);

  return {
    matched: true,
    score: Number(score.toFixed(3)),
    campaign_id: campaign.id,
    campaign_name: campaign.name || campaign.id,
    campaign_priority: Number(campaign.priority || 50),
    phase_id: phase.id,
    phase_name: phase.name || phase.id,
    phase_order: Number(phase.order || 99),
    phase_priority: Number(phase.priority || 0),
    objective_id: objectiveId || campaign.objective_id || phase.objective_id || null
  };
}

function bestCampaignMatch(candidate, campaigns) {
  if (!Array.isArray(campaigns) || campaigns.length === 0) return null;
  const info = {
    objective_id: candidateObjectiveId(candidate),
    proposal_type: candidateType(candidate),
    source_eye: candidateSourceEye(candidate),
    tags: candidateTagSet(candidate)
  };
  let best = null;
  for (const campaign of campaigns) {
    const phases = Array.isArray(campaign && campaign.phases) ? campaign.phases : [];
    for (const phase of phases) {
      const match = scoreMatch(campaign, phase, info);
      if (!match) continue;
      if (!best || Number(match.score || 0) > Number(best.score || 0)) best = match;
    }
  }
  return best;
}

function annotateCampaignPriority(candidates, strategy) {
  const list = Array.isArray(candidates) ? candidates : [];
  const campaigns = normalizeCampaigns(strategy);
  if (!campaigns.length) {
    for (const candidate of list) {
      candidate.campaign_match = null;
      candidate.campaign_sort_bucket = 0;
      candidate.campaign_sort_score = 0;
    }
    return {
      enabled: false,
      campaign_count: 0,
      matched_count: 0
    };
  }

  let matchedCount = 0;
  const byCampaign = {};
  for (const candidate of list) {
    const match = bestCampaignMatch(candidate, campaigns);
    if (match && match.matched) {
      matchedCount += 1;
      byCampaign[match.campaign_id] = Number(byCampaign[match.campaign_id] || 0) + 1;
      candidate.campaign_match = match;
      candidate.campaign_sort_bucket = 1;
      candidate.campaign_sort_score = Number(match.score || 0);
    } else {
      candidate.campaign_match = null;
      candidate.campaign_sort_bucket = 0;
      candidate.campaign_sort_score = 0;
    }
  }
  return {
    enabled: true,
    campaign_count: campaigns.length,
    matched_count: matchedCount,
    unmatched_count: Math.max(0, list.length - matchedCount),
    matched_by_campaign: byCampaign
  };
}

function proposalStatusLower(proposal) {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  return asLower(p.status || p.state || '');
}

function isTerminalProposalStatus(status) {
  const s = asLower(status);
  return s === 'resolved'
    || s === 'done'
    || s === 'closed'
    || s === 'shipped'
    || s === 'no_change'
    || s === 'reverted'
    || s === 'rejected'
    || s === 'filtered'
    || s === 'superseded'
    || s === 'archived'
    || s === 'dropped';
}

function sanitizeToken(v, fallback = 'na') {
  const raw = asLower(v).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return raw ? raw.slice(0, 28) : fallback;
}

function campaignSeedKey(campaign, phase, proposalType, objectiveId) {
  const campaignId = sanitizeToken(campaign && campaign.id, 'campaign');
  const phaseId = sanitizeToken(phase && phase.id, 'phase');
  const pType = sanitizeToken(proposalType, 'proposal');
  const objective = sanitizeToken(objectiveId, 'objective');
  return `${campaignId}|${phaseId}|${pType}|${objective}`;
}

function campaignSeedId(seedKey) {
  const compact = sanitizeToken(seedKey.replace(/\|/g, '-'), 'seed');
  return `CAMP-${compact.slice(0, 52).toUpperCase()}`;
}

function existingCampaignSeedKeys(proposals) {
  const out = new Set();
  const list = Array.isArray(proposals) ? proposals : [];
  for (const proposal of list) {
    if (!proposal || typeof proposal !== 'object') continue;
    const meta = proposal.meta && typeof proposal.meta === 'object' ? proposal.meta : {};
    const key = asLower(meta.campaign_seed_key || '');
    if (key) out.add(key);
  }
  return out;
}

function openProposalTypeCounts(proposals) {
  const counts = {};
  const list = Array.isArray(proposals) ? proposals : [];
  for (const proposal of list) {
    if (!proposal || typeof proposal !== 'object') continue;
    if (isTerminalProposalStatus(proposalStatusLower(proposal))) continue;
    const proposalType = asLower(proposal.type || '');
    if (!proposalType) continue;
    counts[proposalType] = Number(counts[proposalType] || 0) + 1;
  }
  return counts;
}

function buildCampaignDecompositionPlans(proposals, strategy, opts = {}) {
  const campaigns = normalizeCampaigns(strategy);
  const minOpenPerType = Math.max(1, Number(opts.min_open_per_type || 1));
  const maxAdditions = Math.max(0, Number(opts.max_additions || 0));
  const defaultObjectiveId = asString(opts.default_objective_id || '');
  const defaultRisk = asLower(opts.default_risk || 'low') || 'low';
  const defaultImpact = asLower(opts.default_impact || 'medium') || 'medium';
  if (!campaigns.length || maxAdditions <= 0) {
    return {
      enabled: campaigns.length > 0,
      additions: [],
      campaign_count: campaigns.length,
      min_open_per_type: minOpenPerType,
      max_additions: maxAdditions
    };
  }

  const existing = Array.isArray(proposals) ? proposals : [];
  const existingIds = new Set(existing.map((p) => asString(p && p.id)).filter(Boolean));
  const existingKeys = existingCampaignSeedKeys(existing);
  const openCounts = openProposalTypeCounts(existing);
  const additions = [];

  for (const campaign of campaigns) {
    const phases = Array.isArray(campaign && campaign.phases) ? campaign.phases : [];
    for (const phase of phases) {
      const phaseProposalTypes = Array.isArray(phase && phase.proposal_types) ? phase.proposal_types : [];
      const objectiveId = asString(phase && phase.objective_id)
        || asString(campaign && campaign.objective_id)
        || defaultObjectiveId;
      for (const proposalType of phaseProposalTypes) {
        if (additions.length >= maxAdditions) break;
        const normalizedType = asLower(proposalType);
        if (!normalizedType) continue;
        const open = Number(openCounts[normalizedType] || 0);
        if (open >= minOpenPerType) continue;
        const seedKey = campaignSeedKey(campaign, phase, normalizedType, objectiveId || 'objective');
        if (existingKeys.has(seedKey)) continue;

        const id = campaignSeedId(seedKey);
        if (existingIds.has(id)) continue;

        const campaignName = asString(campaign && campaign.name) || asString(campaign && campaign.id) || 'Campaign';
        const phaseName = asString(phase && phase.name) || asString(phase && phase.id) || 'Phase';
        const objectiveClause = objectiveId ? ` objective ${objectiveId}` : '';
        const task = [
          `Create one bounded, deterministic action for campaign "${campaignName}"`,
          `phase "${phaseName}"`,
          `proposal type "${normalizedType}"`,
          `aligned to${objectiveClause}.`,
          'Use low-risk reversible steps with explicit verification and rollback.'
        ].join(' ');
        const verify = [
          'Route execution plan succeeds in dry-run',
          'Success criteria include measurable checks',
          'Rollback path remains available'
        ];
        additions.push({
          id,
          type: normalizedType,
          title: `[Campaign] ${campaignName} :: ${phaseName} :: ${normalizedType}`,
          summary: `Campaign decomposition seed for ${campaignName}/${phaseName} (${normalizedType}).`,
          expected_impact: defaultImpact,
          risk: defaultRisk,
          validation: verify.slice(),
          suggested_next_command: `node systems/routing/route_execute.js --task="${task}" --tokens_est=650 --repeats_14d=1 --errors_30d=0 --dry-run`,
          action_spec: {
            version: 1,
            objective: `Generate concrete ${normalizedType} action for campaign ${campaignName}/${phaseName}`,
            objective_id: objectiveId || null,
            next_command: `node systems/routing/route_execute.js --task="${task}" --tokens_est=650 --repeats_14d=1 --errors_30d=0 --dry-run`,
            verify: verify.slice(),
            rollback: 'Drop generated campaign seed proposal if verification fails'
          },
          meta: {
            source_eye: 'strategy_campaign',
            campaign_generated: true,
            campaign_id: campaign.id,
            campaign_name: campaignName,
            campaign_priority: Number(campaign.priority || 50),
            campaign_phase_id: phase.id,
            campaign_phase_name: phaseName,
            campaign_phase_order: Number(phase.order || 99),
            campaign_seed_key: seedKey,
            objective_id: objectiveId || null,
            directive_objective_id: objectiveId || null,
            generated_at: new Date().toISOString()
          }
        });
        existingIds.add(id);
        existingKeys.add(seedKey);
        openCounts[normalizedType] = open + 1;
      }
      if (additions.length >= maxAdditions) break;
    }
    if (additions.length >= maxAdditions) break;
  }

  return {
    enabled: true,
    additions,
    campaign_count: campaigns.length,
    min_open_per_type: minOpenPerType,
    max_additions: maxAdditions
  };
}

module.exports = {
  normalizeCampaigns,
  annotateCampaignPriority,
  buildCampaignDecompositionPlans
};
