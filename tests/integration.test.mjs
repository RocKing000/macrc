import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { runHeuristic } from '../cli/lib/heuristic.mjs';
import { buildPatches } from '../cli/lib/remediator.mjs';

const __dir = fileURLToPath(new URL('.', import.meta.url));
const DEMO  = resolve(__dir, '../demo/bad-express-app');

// ── Absent-dim assertions ──────────────────────────────────────────────────────
// bad-express-app:
//   no auth packages/patterns              → secEnhancement.auth       absent
//   no validation packages/patterns        → secEnhancement.input_validation absent
//   no retry packages/patterns             → reliability.retry_logic   absent
//   no timeout patterns                    → reliability.timeout_handling absent
//   no health route                        → observability.health_checks absent
//   express-session, no redis              → scale_contract.statelessness absent
//   localhost URLs in api.js               → scale_contract.distributed_assumptions absent
//   no rate-limit packages                 → scale_contract.rate_limiting absent

const ABSENT = [
  ['secEnhancement', 'auth'],
  ['secEnhancement', 'input_validation'],
  ['reliability',    'retry_logic'],
  ['reliability',    'timeout_handling'],
  ['observability',  'health_checks'],
  ['scale_contract', 'statelessness'],
  ['scale_contract', 'distributed_assumptions'],
  ['scale_contract', 'rate_limiting'],
];

// Run once; reuse across all tests
const heuristicResult = runHeuristic(DEMO, 'ai-web-app', { verified: true });

for (const [layer, dim] of ABSENT) {
  test(`${layer}.${dim} is absent in bad-express-app`, () => {
    const dimResult = heuristicResult[layer]?.[dim];
    // secEnhancement only records present/partial — undefined means absent
    const state = dimResult?.state ?? 'absent';
    assert.equal(state, 'absent', `expected absent, got "${state}"`);
  });
}

// ── Patch count test ───────────────────────────────────────────────────────────
// buildPatches expects auditResult.layers with 'security' (not 'secEnhancement')

test('buildPatches produces ≥7 patches on bad-express-app audit', () => {
  const security = {
    auth:               heuristicResult.secEnhancement.auth               || { state: 'absent', severity: null, notes: '', snippets: [] },
    input_validation:   heuristicResult.secEnhancement.input_validation   || { state: 'absent', severity: null, notes: '', snippets: [] },
    transport_security: heuristicResult.secEnhancement.transport_security || { state: 'absent', severity: null, notes: '', snippets: [] },
    dependency_hygiene: { state: 'pending', severity: null, notes: '', snippets: [] },
    secrets_management: { state: 'pending', severity: null, notes: '', snippets: [] },
  };
  const auditResult = {
    layers: {
      security,
      reliability:    heuristicResult.reliability,
      observability:  heuristicResult.observability,
      scale_contract: heuristicResult.scale_contract,
    },
  };
  const patches = buildPatches(auditResult, DEMO);
  assert.ok(patches.length >= 7, `expected ≥7 patches, got ${patches.length}: ${patches.map(p => p._dim).join(', ')}`);
});

// ── Diff regression test ───────────────────────────────────────────────────────

test('diff detects auth absent→present as IMPROVED', () => {
  const FIX_BEFORE = resolve(__dir, 'fixtures/diff-before.json');
  const FIX_AFTER  = resolve(__dir, 'fixtures/diff-after.json');
  const MACRC      = resolve(__dir, '../cli/macrc.mjs');

  const r = spawnSync(process.execPath, [MACRC, 'diff', FIX_BEFORE, FIX_AFTER], { encoding: 'utf8' });
  assert.equal(r.status, 0, `CLI exited ${r.status}: ${r.stderr}`);
  assert.ok(
    r.stdout.includes('IMPROVED') && r.stdout.includes('auth'),
    `expected "IMPROVED" and "auth" in diff output, got:\n${r.stdout}`
  );
});
