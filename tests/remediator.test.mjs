/**
 * Integration tests for cli/lib/remediator.mjs
 * Run: node --test tests/remediator.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import { buildPatches, applyPatches } from '../cli/lib/remediator.mjs';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmp() {
  const dir = join(tmpdir(), 'macrc-test-' + randomBytes(4).toString('hex'));
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, 'src'), { recursive: true });
  // Minimal package.json so detectLanguage returns 'js'
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: 'test-app', type: 'module', dependencies: { express: '^4', axios: '^1' }
  }));
  return dir;
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}

function fakeAudit(absentDims) {
  const layers = {
    security:       { auth: absent(), input_validation: absent(), transport_security: present(), dependency_hygiene: pending(), secrets_management: pending() },
    reliability:    { error_handling: present(), retry_logic: present(), circuit_breaking: present(), graceful_degradation: present(), timeout_handling: present() },
    observability:  { logging: present(), metrics_emission: present(), tracing: present(), alerting: present(), health_checks: present() },
    scale_contract: { statelessness: present(), load_balancing_awareness: present(), distributed_assumptions: present(), rate_limiting: present(), caching_strategy: present() },
  };
  for (const dim of absentDims) {
    for (const layer of Object.values(layers)) {
      if (dim in layer) layer[dim] = absent();
    }
  }
  return { schema_version: '1.0', layers };
}

const absent  = () => ({ state: 'absent',  severity: 'high', notes: '', snippets: [] });
const present = () => ({ state: 'present', severity: null,   notes: '', snippets: [] });
const pending = () => ({ state: 'pending', severity: null,   notes: '', snippets: [] });

// ── health_checks ─────────────────────────────────────────────────────────────

test('health_checks: injects /health endpoint before app.listen', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'src', 'index.js'),
      "import express from 'express';\nconst app = express();\napp.listen(3000);\n");
    const audit = fakeAudit(['health_checks']);
    const patches = buildPatches(audit, dir);
    applyPatches(patches, dir, false);
    const result = readFileSync(join(dir, 'src', 'index.js'), 'utf8');
    assert.ok(result.includes("app.get('/health'"), "health route injected");
    assert.ok(result.includes('app.listen('), 'listen call preserved');
  } finally { cleanup(dir); }
});

// ── timeout_handling ──────────────────────────────────────────────────────────

test('timeout_handling: adds axios instance with timeout when bare axios calls found', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'src', 'api.js'),
      "import axios from 'axios';\nexport async function fetch(url) { return axios.get(url); }\n");
    const audit = fakeAudit(['timeout_handling']);
    const patches = buildPatches(audit, dir);
    applyPatches(patches, dir, false);
    const result = readFileSync(join(dir, 'src', 'api.js'), 'utf8');
    assert.ok(result.includes('axios.create({ timeout: 10000 })'), 'timeout instance created');
  } finally { cleanup(dir); }
});

// ── retry_logic ───────────────────────────────────────────────────────────────

test('retry_logic: adds axios-retry import and wires it', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'src', 'api.js'),
      "import axios from 'axios';\nexport async function call(url) { return axios.get(url); }\n");
    const audit = fakeAudit(['retry_logic']);
    const patches = buildPatches(audit, dir);
    applyPatches(patches, dir, false);
    const result = readFileSync(join(dir, 'src', 'api.js'), 'utf8');
    assert.ok(result.includes("from 'axios-retry'"), 'axios-retry imported');
    assert.ok(result.includes('axiosRetry(axios'), 'axiosRetry wired');
  } finally { cleanup(dir); }
});

// ── input_validation ──────────────────────────────────────────────────────────

test('input_validation: injects validateBody factory after last import in route file', () => {
  const dir = makeTmp();
  try {
    mkdirSync(join(dir, 'src', 'routes'), { recursive: true });
    writeFileSync(join(dir, 'src', 'routes', 'users.js'),
      "import { Router } from 'express';\nimport { db } from '../db.js';\nconst router = Router();\n");
    const audit = fakeAudit(['input_validation']);
    const patches = buildPatches(audit, dir);
    applyPatches(patches, dir, false);
    const result = readFileSync(join(dir, 'src', 'routes', 'users.js'), 'utf8');
    assert.ok(result.includes('function validateBody(schema)'), 'validateBody injected');
    // Must appear after the import block
    const importEnd = result.lastIndexOf("import { db }");
    const fnStart   = result.indexOf('function validateBody');
    assert.ok(fnStart > importEnd, 'validateBody placed after imports');
  } finally { cleanup(dir); }
});

// ── distributed_assumptions ───────────────────────────────────────────────────

test('distributed_assumptions: replaces localhost URLs with env vars', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'src', 'api.js'),
      "import axios from 'axios';\nconst res = await axios.get('http://localhost:8080/items');\n");
    const audit = fakeAudit(['distributed_assumptions']);
    const patches = buildPatches(audit, dir);
    applyPatches(patches, dir, false);
    const result = readFileSync(join(dir, 'src', 'api.js'), 'utf8');
    // localhost is kept only as a fallback value inside the env expression
    assert.ok(result.includes('process.env.SERVICE_URL_8080'), 'env var substituted');
    assert.ok(!result.includes("axios.get('http://localhost"), 'bare localhost call replaced');
  } finally { cleanup(dir); }
});

// ── auth ──────────────────────────────────────────────────────────────────────

test('auth: injects requireAuth stub after last import in router file', () => {
  const dir = makeTmp();
  try {
    mkdirSync(join(dir, 'src', 'routes'), { recursive: true });
    writeFileSync(join(dir, 'src', 'routes', 'api.js'),
      "import { Router } from 'express';\nimport { db } from '../db.js';\nconst router = Router();\nrouter.get('/', (req, res) => res.json([]));\n");
    const audit = fakeAudit(['auth']);
    const patches = buildPatches(audit, dir);
    applyPatches(patches, dir, false);
    const result = readFileSync(join(dir, 'src', 'routes', 'api.js'), 'utf8');
    assert.ok(result.includes('function requireAuth(req, res, next)'), 'requireAuth injected');
    const lastImport = result.lastIndexOf("import { db }");
    const fnStart    = result.indexOf('function requireAuth');
    assert.ok(fnStart > lastImport, 'requireAuth placed after imports');
  } finally { cleanup(dir); }
});

// ── statelessness ─────────────────────────────────────────────────────────────

test('statelessness: adds connect-redis import for ESM express-session', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'src', 'index.js'),
      "import express from 'express';\nimport session from 'express-session';\nconst app = express();\napp.use(session({ secret: 'x', resave: false, saveUninitialized: true }));\napp.listen(3000);\n");
    const audit = fakeAudit(['statelessness']);
    const patches = buildPatches(audit, dir);
    applyPatches(patches, dir, false);
    const result = readFileSync(join(dir, 'src', 'index.js'), 'utf8');
    assert.ok(result.includes("from 'connect-redis'"), 'connect-redis imported');
    assert.ok(result.includes('RedisStore'), 'RedisStore defined');
  } finally { cleanup(dir); }
});

// ── load_balancing_awareness ──────────────────────────────────────────────────

test('load_balancing_awareness: injects /health endpoint (prerequisite for LB probes)', () => {
  const dir = makeTmp();
  try {
    writeFileSync(join(dir, 'src', 'index.js'),
      "import express from 'express';\nconst app = express();\napp.listen(8080);\n");
    const audit = fakeAudit(['load_balancing_awareness']);
    const patches = buildPatches(audit, dir);
    applyPatches(patches, dir, false);
    const result = readFileSync(join(dir, 'src', 'index.js'), 'utf8');
    assert.ok(result.includes("app.get('/health'"), 'health probe endpoint injected');
  } finally { cleanup(dir); }
});
