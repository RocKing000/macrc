/**
 * Policy engine: loads .macrc.yml and applies block/warn/pass rules per dim.
 *
 * Exports: loadPolicy(dir), applyPolicy(policy, auditResult) → PolicyResult
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const DEFAULT_POLICY = {
  version: 1,
  dims: {},
  defaults: {
    absent:  'warn',
    partial: 'pass',
    present: 'pass',
    n_a:     'pass',
  },
};

function parseSimpleYaml(text) {
  const result = { dims: {}, defaults: {} };
  let currentSection = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trimEnd();
    if (!line.trim()) continue;

    if (/^version\s*:/.test(line)) {
      result.version = parseInt(line.split(':')[1].trim(), 10);
      continue;
    }

    if (/^dims\s*:/.test(line)) { currentSection = 'dims'; continue; }
    if (/^defaults\s*:/.test(line)) { currentSection = 'defaults'; continue; }

    const m = line.match(/^  ([\w.]+)\s*:\s*(.+)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (currentSection === 'dims')     result.dims[key]     = val.trim();
    if (currentSection === 'defaults') result.defaults[key] = val.trim();
  }
  return result;
}

export function loadPolicy(dir) {
  const candidates = ['.macrc.yml', '.macrc.yaml', 'macrc.yml', 'macrc.yaml'];
  for (const name of candidates) {
    const p = resolve(dir, name);
    if (existsSync(p)) {
      try {
        const raw  = readFileSync(p, 'utf8');
        const parsed = parseSimpleYaml(raw);
        return { ...DEFAULT_POLICY, ...parsed, dims: { ...DEFAULT_POLICY.dims, ...parsed.dims }, defaults: { ...DEFAULT_POLICY.defaults, ...parsed.defaults }, _hasFile: true };
      } catch (err) {
        console.warn(`[policy] failed to parse ${p}: ${err.message}`);
      }
    }
  }
  return { ...DEFAULT_POLICY, _hasFile: false };
}

export function applyPolicy(policy, auditLayers) {
  const results  = [];
  let blocked    = false;
  let warnCount  = 0;

  const ALL_DIMS = {
    security:       ['auth','input_validation','transport_security','dependency_hygiene','secrets_management'],
    reliability:    ['error_handling','retry_logic','circuit_breaking','graceful_degradation','timeout_handling'],
    observability:  ['logging','metrics_emission','tracing','alerting','health_checks'],
    scale_contract: ['statelessness','load_balancing_awareness','distributed_assumptions','rate_limiting','caching_strategy'],
  };

  for (const [layer, dims] of Object.entries(ALL_DIMS)) {
    for (const dim of dims) {
      const result = auditLayers[layer]?.[dim];
      if (!result) continue;

      const { state, severity, notes } = result;

      const policyKey = `${layer}.${dim}`;
      let action = policy.dims[policyKey] || policy.dims[dim] || policy.defaults[state] || 'pass';

      if (action === 'block')   { blocked = true; }
      if (action === 'warn')    { warnCount++; }

      results.push({ layer, dim, state, severity, notes, action });
    }
  }

  return { results, blocked, warnCount, passed: !blocked };
}

export function formatPolicyReport(policyResult) {
  const lines = [];
  for (const r of policyResult.results) {
    if (r.action === 'pass') continue;
    const icon = r.action === 'block' ? '✗' : '⚠';
    lines.push(`  ${icon} ${r.layer}.${r.dim}  [${r.state}]  ${r.notes}`);
  }
  if (lines.length === 0) lines.push('  ✓ all dimensions pass policy');
  return lines.join('\n');
}
