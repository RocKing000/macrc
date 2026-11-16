import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { queryTimeoutHandling, queryDistributedAssumptions } from '../cli/lib/syntax-queries.mjs';

const TMP_DIR = fileURLToPath(new URL('.', import.meta.url));

function tmp(name, src) {
  const p = resolve(TMP_DIR, `_tmp_sq_${name}.js`);
  writeFileSync(p, src);
  return p;
}
function rm(p) { try { unlinkSync(p); } catch {} }

// ── queryTimeoutHandling ───────────────────────────────────────────────────────

test('timeout_handling: absent when axios.get has no timeout', () => {
  const p = tmp('t1', `import axios from 'axios';\naxios.get('http://api.example.com/data');`);
  const r = queryTimeoutHandling(p);
  rm(p);
  assert.equal(r?.state, 'absent');
  assert.equal(r?.callsFound, 1);
  assert.equal(r?.callsWithTimeout, 0);
});

test('timeout_handling: present when axios.get has { timeout }', () => {
  const p = tmp('t2', `import axios from 'axios';\naxios.get('http://api.example.com/data', { timeout: 5000 });`);
  const r = queryTimeoutHandling(p);
  rm(p);
  assert.equal(r?.state, 'present');
  assert.equal(r?.callsWithTimeout, 1);
});

test('timeout_handling: present when fetch has AbortSignal in { signal }', () => {
  const p = tmp('t3', `fetch('http://api.example.com', { signal: AbortSignal.timeout(5000) });`);
  const r = queryTimeoutHandling(p);
  rm(p);
  assert.equal(r?.state, 'present');
});

test('timeout_handling: null for file with no HTTP calls', () => {
  const p = tmp('t4', `const x = 1 + 2;\nconsole.log(x);`);
  const r = queryTimeoutHandling(p);
  rm(p);
  assert.equal(r, null);
});

test('timeout_handling: partial when mixed (some with, some without)', () => {
  const p = tmp('t5', [
    `import axios from 'axios';`,
    `axios.get('/a');`,
    `axios.get('/b', { timeout: 3000 });`,
  ].join('\n'));
  const r = queryTimeoutHandling(p);
  rm(p);
  assert.equal(r?.state, 'partial');
  assert.equal(r?.callsFound, 2);
  assert.equal(r?.callsWithTimeout, 1);
});

// ── queryDistributedAssumptions ────────────────────────────────────────────────

test('distributed_assumptions: absent when localhost in call argument', () => {
  const p = tmp('d1', `fetch('http://localhost:3000/api');`);
  const r = queryDistributedAssumptions(p);
  rm(p);
  assert.equal(r?.state, 'absent');
  assert.ok(r?.hardcodedUrls.length >= 1);
});

test('distributed_assumptions: null when localhost not in call argument', () => {
  const p = tmp('d2', `const URL = 'http://localhost:3000';`);
  const r = queryDistributedAssumptions(p);
  rm(p);
  assert.equal(r, null);
});

test('distributed_assumptions: null when localhost in test block', () => {
  const p = tmp('d3', [
    `describe('test', () => {`,
    `  it('calls local', () => {`,
    `    fetch('http://localhost:3000/api');`,
    `  });`,
    `});`,
  ].join('\n'));
  const r = queryDistributedAssumptions(p);
  rm(p);
  assert.equal(r, null);
});

test('distributed_assumptions: absent for 127.0.0.1 in call argument', () => {
  const p = tmp('d4', `axios.get('http://127.0.0.1:8080/health');`);
  const r = queryDistributedAssumptions(p);
  rm(p);
  assert.equal(r?.state, 'absent');
});
