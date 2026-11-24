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
//   no auth packages/patterns              → secEnhancement.auth             absent
//   no validation packages/patterns        → secEnhancement.input_validation  absent
//   express.json() with no limit           → secEnhancement.payload_size_gate absent
//   no retry packages/patterns             → reliability.retry_logic          absent
//   no timeout patterns                    → reliability.timeout_handling      absent
//   no health route                        → observability.health_checks       absent
//   express-session, no redis              → scale_contract.statelessness      absent
//   localhost URLs in api.js               → scale_contract.distributed_assumptions absent
//   no rate-limit packages                 → scale_contract.rate_limiting      absent

const ABSENT = [
  ['secEnhancement', 'auth'],
  ['secEnhancement', 'input_validation'],
  ['secEnhancement', 'payload_size_gate'],
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

// ── Single-process app: tracing N/A ───────────────────────────────────────────
// A codebase with no HTTP client deps (axios, node-fetch, etc.) is single-process.
// tracing must be n_a, not absent or present — no inter-service calls to trace.

const SINGLE_PROCESS = resolve(__dir, 'fixtures/single-process-app');
const singleProcResult = runHeuristic(SINGLE_PROCESS, 'api-service', { verified: true });

test('observability.tracing is n_a when no HTTP client deps', () => {
  const state = singleProcResult.observability?.tracing?.state;
  assert.equal(state, 'n_a', `expected n_a, got "${state}"`);
});

test('observability.tracing n_a note mentions single-process', () => {
  const notes = singleProcResult.observability?.tracing?.notes ?? '';
  assert.ok(notes.includes('single-process'), `expected note to mention single-process, got: "${notes}"`);
});

// ── Serverless/edge-specific dim assertions ────────────────────────────────────
// serverless-edge-app:
//   let cache = null at module scope, no Redis        → scale_contract.isolate_cache_scope  absent
//   3 sequential DB awaits with Promise.all also used → reliability.sequential_db_calls     partial
//   Promise.all with .map over DB calls               → scale_contract.query_fan_out        partial

const EDGE = resolve(__dir, 'fixtures/serverless-edge-app');
const edgeResult = runHeuristic(EDGE, 'mcp-server', { verified: true });

test('scale_contract.isolate_cache_scope is absent in serverless-edge-app', () => {
  const state = edgeResult.scale_contract?.isolate_cache_scope?.state;
  assert.equal(state, 'absent', `expected absent, got "${state}"`);
});

test('reliability.sequential_db_calls is partial in serverless-edge-app', () => {
  const state = edgeResult.reliability?.sequential_db_calls?.state;
  assert.equal(state, 'partial', `expected partial, got "${state}"`);
});

test('scale_contract.query_fan_out is partial in serverless-edge-app', () => {
  const state = edgeResult.scale_contract?.query_fan_out?.state;
  assert.equal(state, 'partial', `expected partial, got "${state}"`);
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
