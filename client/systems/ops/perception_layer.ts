#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  cleanText,
  normalizeToken,
  readJson,
  resolvePath
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

const DEFAULT_FLAGS_PATH = process.env.PERCEPTION_FLAGS_PATH
  ? path.resolve(process.env.PERCEPTION_FLAGS_PATH)
  : path.join(ROOT, 'config', 'feature_flags', 'perception_flags.json');

const DEFAULT_TOP_SETTLED_PANEL_PATH = path.join(ROOT, 'state', 'ops', 'protheus_top', 'settled_panel.json');

function safeBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const t = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(t)) return true;
  if (['0', 'false', 'no', 'off'].includes(t)) return false;
  return fallback;
}

function loadPerceptionFlags(flagsPath = DEFAULT_FLAGS_PATH) {
  const src = readJson(flagsPath, {});
  const envIllusion = process.env.PROTHEUS_ILLUSION;
  const envAesthetic = process.env.PROTHEUS_ALIEN_AESTHETIC;
  const envLensMode = process.env.PROTHEUS_LENS_MODE;
  return {
    path: resolvePath(flagsPath, 'config/feature_flags/perception_flags.json'),
    illusion_mode: envIllusion != null ? safeBool(envIllusion, false) : safeBool(src.illusion_mode, false),
    alien_aesthetic: envAesthetic != null ? safeBool(envAesthetic, false) : safeBool(src.alien_aesthetic, false),
    lens_mode: normalizeToken(envLensMode != null ? envLensMode : src.lens_mode || 'hidden', 20) || 'hidden',
    post_reveal_enabled: safeBool(src.post_reveal_enabled, false)
  };
}

function loadSettledPanel(panelPath = DEFAULT_TOP_SETTLED_PANEL_PATH): AnyObj | null {
  const src = readJson(panelPath, null);
  return src && typeof src === 'object' ? src : null;
}

function buildStatusEpilogue(flags: AnyObj, settledPanel: AnyObj | null) {
  if (!flags || flags.illusion_mode !== true) return null;
  const settled = !!(settledPanel && settledPanel.settled);
  if (!settled) return 'Core settled. Efficiency maximized.';
  return 'Core settled. Efficiency maximized.';
}

function buildReasoningMirrorFooter(flags: AnyObj, settledPanel: AnyObj | null) {
  if (!flags || flags.illusion_mode !== true) return null;
  const sizeMb = settledPanel && Number.isFinite(Number(settledPanel.binary_size_mb))
    ? Number(settledPanel.binary_size_mb).toFixed(1)
    : 'n/a';
  return `Settled core • ${sizeMb} MB binary • Self-optimized • [seed]`;
}

function applyTone(text: string, flags: AnyObj, toneClass = 'default') {
  const raw = cleanText(text || '', 1000);
  if (!raw) return raw;
  if (!flags || flags.alien_aesthetic !== true) return raw;
  if (toneClass === 'high_visibility') {
    return raw.replace(/!+/g, '.').replace(/\s+/g, ' ').trim();
  }
  return raw;
}

module.exports = {
  loadPerceptionFlags,
  loadSettledPanel,
  buildStatusEpilogue,
  buildReasoningMirrorFooter,
  applyTone
};
