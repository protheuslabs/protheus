#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { stableUid, randomUid, isAlnum } = require('../../lib/uid.js');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function defaultRegistry() {
  return {
    version: 1.5,
    max_active: 25,
    gc: {
      inactive_days: 30,
      min_uses_30d: 1
    },
    habits: []
  };
}

function habitSeed(habit, index) {
  return String(
    habit.id
    || habit.name
    || habit.entrypoint
    || `habit_${index}`
  );
}

function ensureHabitUid(habit, index, used) {
  const candidate = String(habit && habit.uid || '').trim();
  if (candidate && isAlnum(candidate) && !used.has(candidate)) {
    used.add(candidate);
    return candidate;
  }
  const seeded = stableUid(`adaptive_habit|${habitSeed(habit, index)}|v1`, { prefix: 'h', length: 24 });
  if (!used.has(seeded)) {
    used.add(seeded);
    return seeded;
  }
  let uid = randomUid({ prefix: 'h', length: 24 });
  let attempts = 0;
  while (used.has(uid) && attempts < 8) {
    uid = randomUid({ prefix: 'h', length: 24 });
    attempts++;
  }
  used.add(uid);
  return uid;
}

function normalizeRegistry(registry) {
  const base = registry && typeof registry === 'object'
    ? { ...registry }
    : defaultRegistry();
  if (!Array.isArray(base.habits)) base.habits = [];

  const used = new Set();
  let changed = false;
  base.habits = base.habits.map((raw, idx) => {
    const habit = raw && typeof raw === 'object' ? { ...raw } : {};
    const nextUid = ensureHabitUid(habit, idx, used);
    if (String(habit.uid || '') !== nextUid) changed = true;
    habit.uid = nextUid;
    return habit;
  });

  return { registry: base, changed };
}

function readRegistryWithUids(filePath, fallback = defaultRegistry(), autoPersist = true) {
  const raw = readJson(filePath, fallback);
  const normalized = normalizeRegistry(raw);
  if (autoPersist && normalized.changed) {
    writeJson(filePath, normalized.registry);
  }
  return normalized.registry;
}

function writeRegistryWithUids(filePath, registry) {
  const normalized = normalizeRegistry(registry);
  writeJson(filePath, normalized.registry);
  return normalized.registry;
}

module.exports = {
  defaultRegistry,
  ensureHabitUid,
  normalizeRegistry,
  readRegistryWithUids,
  writeRegistryWithUids
};

