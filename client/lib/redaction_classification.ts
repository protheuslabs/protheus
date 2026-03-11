'use strict';

export {};

const fs = require('fs');
const path = require('path');
function normalizeText(v, maxLen = 4000) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function loadPolicy(policyPath = null) { const root = path.resolve(__dirname, '..'); const resolved = policyPath ? path.resolve(String(policyPath)) : path.join(root, 'config', 'redaction_classification_policy.json'); try { if (!fs.existsSync(resolved)) return { patterns: [], labels: [] }; const raw = JSON.parse(fs.readFileSync(resolved, 'utf8')); return raw && typeof raw === 'object' ? raw : { patterns: [], labels: [] }; } catch { return { patterns: [], labels: [] }; } }
function compilePatterns(policy) { const rows = Array.isArray(policy && policy.patterns) ? policy.patterns : []; return rows.map((row) => { const source = normalizeText(row && row.pattern, 512); const flags = normalizeText(row && row.flags, 16) || 'gi'; const label = normalizeText(row && row.label, 80) || 'sensitive'; if (!source) return null; try { return { regex: new RegExp(source, flags), label }; } catch { return null; } }).filter(Boolean); }
function classifyText(text, policyPath = null) { const policy = loadPolicy(policyPath); const patterns = compilePatterns(policy); const source = String(text == null ? '' : text); const findings = []; for (const row of patterns) { let m; while ((m = row.regex.exec(source))) { findings.push({ label: row.label, match: normalizeText(m[0], 120), index: m.index }); if (!row.regex.global) break; } } return { ok: true, findings, labels: [...new Set(findings.map((f) => f.label))] }; }
function redactText(text, policyPath = null, replacement = '[REDACTED]') { const policy = loadPolicy(policyPath); const patterns = compilePatterns(policy); let out = String(text == null ? '' : text); for (const row of patterns) out = out.replace(row.regex, replacement); return { ok: true, text: out, replacement: String(replacement) }; }
function classifyAndRedact(text, policyPath = null, replacement = '[REDACTED]') { const classification = classifyText(text, policyPath); const redaction = redactText(text, policyPath, replacement); return { ok: true, classification, redaction }; }
module.exports = { loadPolicy, classifyText, redactText, classifyAndRedact };
