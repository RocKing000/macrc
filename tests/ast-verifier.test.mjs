/**
 * Unit tests for cli/lib/ast-verifier.mjs
 * Run: node --test tests/ast-verifier.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyMatch } from '../cli/lib/ast-verifier.mjs';

// ── zod_usage ─────────────────────────────────────────────────────────────────

test('zod_usage: confirmed when safeParse(req.body) in route context', () => {
  const result = verifyMatch('zod_usage', 'const schema = z.object({ name: z.string() })', [
    "router.post('/users', (req, res) => {",
    '  const result = schema.safeParse(req.body);',
    '  if (!result.success) return res.status(400).json({ error: result.error });',
    '  res.json(result.data);',
    '})',
  ]);
  assert.equal(result, 'confirmed');
});

test('zod_usage: unlikely when only schema definition, no req reference', () => {
  const result = verifyMatch('zod_usage', 'export const UserSchema = z.object({ id: z.string() })', [
    'import { z } from "zod";',
    'export const UserSchema = z.object({ id: z.string() })',
    'export const OrderSchema = z.object({ amount: z.number() })',
  ]);
  assert.equal(result, 'unlikely');
});

// ── bearer_auth ───────────────────────────────────────────────────────────────

test('bearer_auth: confirmed when app.use(authenticate) in context', () => {
  const result = verifyMatch('bearer_auth', "const token = req.headers.authorization.split('Bearer ')[1]", [
    "app.use('/api', authenticate);",
    'function authenticate(req, res, next) {',
    "  const token = req.headers.authorization.split('Bearer ')[1]",
    '  if (!token) return res.status(401).end();',
    '}',
  ]);
  assert.equal(result, 'confirmed');
});

test('bearer_auth: unlikely when "Bearer" is in a fetch client header', () => {
  const result = verifyMatch('bearer_auth', "headers: { Authorization: 'Bearer ' + token }", [
    'const response = await fetch(url, {',
    "  headers: { Authorization: 'Bearer ' + token }",
    '});',
  ]);
  assert.equal(result, 'unlikely');
});

// ── health_route ──────────────────────────────────────────────────────────────

test('health_route: confirmed when app.get route registration', () => {
  const result = verifyMatch('health_route', "app.get('/health', (req, res) => res.json({ status: 'ok' }))", [
    'const app = express();',
    "app.get('/health', (req, res) => res.json({ status: 'ok' }))",
    'app.listen(3000);',
  ]);
  assert.equal(result, 'confirmed');
});

test('health_route: unlikely when "/health" is in a test assertion', () => {
  const result = verifyMatch('health_route', "expect(res.status).toBe(200) // GET /health", [
    "it('should return 200 for health check', async () => {",
    "  const res = await request(app).get('/health');",
    "  expect(res.status).toBe(200) // GET /health",
    '});',
  ]);
  assert.equal(result, 'unlikely');
});

// ── timeout_config ────────────────────────────────────────────────────────────

test('timeout_config: confirmed when inside axios.create options', () => {
  const result = verifyMatch('timeout_config', 'timeout: 5000,', [
    'const client = axios.create({',
    '  baseURL: process.env.API_URL,',
    '  timeout: 5000,',
    '  headers: { Accept: "application/json" },',
    '});',
  ]);
  assert.equal(result, 'confirmed');
});

test('timeout_config: unlikely when timeout is in a jest config', () => {
  const result = verifyMatch('timeout_config', 'timeout: 30000', [
    'module.exports = {',
    '  testEnvironment: "node",',
    '  timeout: 30000',
    '};',
  ]);
  assert.equal(result, 'unlikely');
});

// ── env_service_url ───────────────────────────────────────────────────────────

test('env_service_url: confirmed when used as baseURL in axios.create', () => {
  const result = verifyMatch('env_service_url', 'baseURL: process.env.API_URL,', [
    'const http = axios.create({',
    '  baseURL: process.env.API_URL,',
    '  timeout: 5000,',
    '});',
  ]);
  assert.equal(result, 'confirmed');
});

test('env_service_url: unlikely when only process.env.PORT is read', () => {
  const result = verifyMatch('env_service_url', 'const port = process.env.PORT || 3000;', [
    'const app = express();',
    'const port = process.env.PORT || 3000;',
    'app.listen(port);',
  ]);
  assert.equal(result, 'unlikely');
});

// ── retry_pattern ─────────────────────────────────────────────────────────────

test('retry_pattern: confirmed when inside axiosRetry call', () => {
  const result = verifyMatch('retry_pattern', 'retries: 3,', [
    'axiosRetry(axios, {',
    '  retries: 3,',
    '  retryDelay: axiosRetry.exponentialDelay,',
    '});',
  ]);
  assert.equal(result, 'confirmed');
});

test('retry_pattern: unlikely when retryCount is in a plain config object', () => {
  const result = verifyMatch('retry_pattern', 'maxRetries: 3,', [
    'const config = {',
    '  maxRetries: 3,',
    '  pageSize: 100,',
    '};',
  ]);
  assert.equal(result, 'unlikely');
});

// ── py_timeout ────────────────────────────────────────────────────────────────

test('py_timeout: confirmed when timeout= in requests.get call', () => {
  const result = verifyMatch('py_timeout', 'response = requests.get(url, timeout=10)', [
    'import requests',
    'def fetch(url):',
    '    response = requests.get(url, timeout=10)',
    '    return response.json()',
  ]);
  assert.equal(result, 'confirmed');
});

test('py_timeout: unlikely when timeout= is in subprocess call', () => {
  const result = verifyMatch('py_timeout', 'result = subprocess.run(cmd, timeout=30)', [
    'import subprocess',
    'def run_cmd(cmd):',
    '    result = subprocess.run(cmd, timeout=30)',
    '    return result.stdout',
  ]);
  assert.equal(result, 'unlikely');
});

// ── pydantic_usage ────────────────────────────────────────────────────────────

test('pydantic_usage: confirmed when BaseModel used in FastAPI POST route', () => {
  const result = verifyMatch('pydantic_usage', 'class UserCreate(BaseModel):', [
    '@app.post("/users")',
    'async def create_user(body: UserCreate):',
    '    return {"id": 1}',
    'class UserCreate(BaseModel):',
    '    name: str',
    '    email: str',
  ]);
  assert.equal(result, 'confirmed');
});

test('pydantic_usage: unlikely when plain BaseModel data class with no route nearby', () => {
  const result = verifyMatch('pydantic_usage', 'class Config(BaseModel):', [
    'from pydantic import BaseModel',
    'class Config(BaseModel):',
    '    db_host: str = "localhost"',
    '    db_port: int = 5432',
  ]);
  assert.equal(result, 'unlikely');
});
