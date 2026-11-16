/**
 * Targeted LLM verification for Tier-1 dimensions.
 *
 * Called only when heuristic says partial or present on a Tier-1 dim.
 * Uses the Anthropic API (ANTHROPIC_API_KEY env var).
 *
 * Exports: verifyDim(cloneDir, dim, heuristicResult, options) → DimResult
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

const PROMPTS = {
  input_validation: (snippets) => `
You are auditing a software repo for input validation at HTTP entry points.
Snippets below come from route/controller files only.

Validation library found in dependencies. Does it actually protect entry points?

Snippets:
${snippets}

Answer with ONLY valid JSON:
{"state":"present"|"partial"|"absent","severity":null|"low"|"medium"|"high"|"critical","notes":"<one sentence>"}

- present: validation library applied at request boundaries for all major routes
- partial: validation exists in some routes but not all, or only on internal helpers
- absent: library imported but not wired to request handlers
`.trim(),

  auth: (snippets) => `
You are auditing a software repo for authentication enforcement.
Snippets below come from route/middleware files only.

Auth library found in dependencies. Is middleware actually protecting routes?

Snippets:
${snippets}

Answer with ONLY valid JSON:
{"state":"present"|"partial"|"absent","severity":null|"low"|"medium"|"high"|"critical","notes":"<one sentence>"}

- present: auth middleware applied to all protected routes
- partial: some routes protected, some not; or JWT verified but no route guard
- absent: auth library imported but not applied to routes
`.trim(),

  distributed_assumptions: (snippets) => `
You are auditing a software repo for distributed-system assumptions.
Snippets show env-var usage and any service URL patterns.

Question: are inter-service calls consistently using env-var-configured addresses?

Snippets:
${snippets}

Answer with ONLY valid JSON:
{"state":"present"|"partial"|"absent","severity":null|"low"|"medium"|"high"|"critical","notes":"<one sentence>"}

- present: all service-to-service calls use env-configured addresses
- partial: mix of env vars and hardcoded service names/localhost
- absent: hardcoded service addresses or localhost in production code paths
`.trim(),

  statelessness: (snippets) => `
You are auditing a software repo for statelessness (no in-process session state).
Snippets show module-level variables and any state management.

Question: does the app hold per-request or per-user state in module-level variables or in-process stores?

Snippets:
${snippets}

Answer with ONLY valid JSON:
{"state":"present"|"partial"|"absent","severity":null|"low"|"medium"|"high"|"critical","notes":"<one sentence>"}

- present: no in-process request state; all state in external store or JWT
- partial: some in-process state but mitigated (Redis-backed sessions, etc.)
- absent: in-process maps/arrays used to store per-user or per-request data
`.trim(),

  timeout_handling: (snippets) => `
You are auditing a software repo for timeout handling on outbound calls.
Snippets show HTTP client usage and any timeout configuration.

Question: are outbound HTTP/DB/external calls protected by explicit timeouts?

Snippets:
${snippets}

Answer with ONLY valid JSON:
{"state":"present"|"partial"|"absent","severity":null|"low"|"medium"|"high"|"critical","notes":"<one sentence>"}

- present: timeouts set on all significant outbound call sites
- partial: some call sites have timeouts, others rely on platform defaults
- absent: no explicit timeouts; connections can hang indefinitely
`.trim(),

  health_checks: (snippets) => `
You are auditing a software repo for health check implementation.
Snippets show route definitions and any health-related files.

Question: is there a real health check endpoint that probes internal dependencies?

Snippets:
${snippets}

Answer with ONLY valid JSON:
{"state":"present"|"partial"|"absent","severity":null|"low"|"medium"|"high"|"critical","notes":"<one sentence>"}

- present: health endpoint that checks internal dependencies (DB, cache, etc.)
- partial: health endpoint exists but always returns 200 without probing deps
- absent: no health check endpoint
`.trim(),

  load_balancing_awareness: (snippets) => `
You are auditing a software repo for load-balancing readiness.
Snippets show deployment config and health check patterns.

Question: is the app designed for horizontal scaling behind a load balancer?

Snippets:
${snippets}

Answer with ONLY valid JSON:
{"state":"present"|"partial"|"absent","severity":null|"low"|"medium"|"high"|"critical","notes":"<one sentence>"}

- present: health endpoint + stateless design + multi-replica config
- partial: health endpoint present but state or sticky-session issues remain
- absent: no health endpoint, relies on single-instance deployment
`.trim(),

  retry_logic: (snippets) => `
You are auditing a software repo for retry logic on external calls.
Snippets show HTTP client usage and any retry patterns.

Question: are retries applied to outbound calls that can transiently fail?

Snippets:
${snippets}

Answer with ONLY valid JSON:
{"state":"present"|"partial"|"absent","severity":null|"low"|"medium"|"high"|"critical","notes":"<one sentence>"}

- present: retry library or explicit retry loop applied to external call sites
- partial: retries on some calls; others fire once and fail permanently
- absent: no retry logic; single failures propagate immediately
`.trim(),
};

function collectSnippets(cloneDir, dim) {
  const SOURCE_EXTS = /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs)$/;
  const ROUTE_PATH  = /route|controller|handler|api|endpoint|view|middleware/i;
  let files = [];
  try {
    files = execSync('git ls-files', { cwd: cloneDir, timeout: 10000 })
      .toString().split('\n')
      .filter(f => f && SOURCE_EXTS.test(f) && ROUTE_PATH.test(f));
  } catch {}

  const snippets = [];
  for (const relPath of files.slice(0, 20)) {
    let content = '';
    try { content = readFileSync(resolve(cloneDir, relPath), 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    snippets.push(`\n--- ${relPath} (${lines.length} lines) ---`);
    snippets.push(lines.slice(0, 60).join('\n'));
  }
  return snippets.join('\n').slice(0, 8000);
}

export async function verifyDim(cloneDir, dim, heuristicResult, options = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const promptFn = PROMPTS[dim];
  if (!promptFn) throw new Error(`No targeted prompt for dim: ${dim}`);

  const snippets = collectSnippets(cloneDir, dim);
  const prompt   = promptFn(snippets);

  const model = options.model || 'claude-haiku-4-5';

  const body = JSON.stringify({
    model,
    max_tokens: 256,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  });

  const { default: https } = await import('https');
  const raw = await new Promise((resolve, reject) => {
    const url = new URL(ANTHROPIC_API_URL);
    const req = https.request({
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const response = JSON.parse(raw);
  if (response.error) throw new Error(`Anthropic API error: ${response.error.message}`);

  const text = response.content?.[0]?.text?.trim() || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`LLM returned non-JSON: ${text.slice(0, 200)}`);

  const result = JSON.parse(jsonMatch[0]);
  return {
    state:    result.state,
    severity: result.severity || null,
    notes:    result.notes || '',
    snippets: [],
    _source:  'targeted-llm',
    _model:   model,
  };
}
