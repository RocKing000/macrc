/**
 * Contextual verification for HIGH-FP grep patterns.
 *
 * For each regex match, reads ±N surrounding lines to determine whether the
 * hit is at a real call site rather than a schema definition, test fixture,
 * comment, or README. Rule-based string checks on the context window.
 *
 * Not an AST parser: no tree-sitter or Babel. Fast and dependency-free.
 *
 * Exports:
 *   HIGH_FP_KEYS        set of pattern keys that need verification
 *   verifyMatch         (key, line, contextLines[]) returns 'confirmed'|'probable'|'unlikely'
 *   grepSourcesVerified verified drop-in for grepSources
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';

export const HIGH_FP_KEYS = new Set([
  'retry_pattern',
  'fallback_pattern',
  'feature_flag',
  'timeout_config',
  'py_timeout',
  'health_route',
  'bearer_auth',
  'env_service_url',
  'zod_usage',
  'pydantic_usage',
]);

// ── Per-pattern context verifiers ─────────────────────────────────────────────
// Each receives:
// line:    the matched line text
// context: surrounding ±10 lines joined as one string
// Returns: 'confirmed' | 'probable' | 'unlikely'

const VERIFIERS = {

  // zod_usage: z.string() schema definition ≠ .parse(req.body) at route
  zod_usage(line, context) {
    if (/\.(safe)?[Pp]arse\s*\(\s*(req|request|ctx\.request)\.(body|params|query)/.test(context))
      return 'confirmed';
    // Inside a router handler scope
    if (/router\.|app\.(get|post|put|patch|delete)\s*\(/.test(context))
      return 'probable';
    // Schema-only file (no req reference at all)
    if (!/\breq\b|\brequest\b|\bctx\b/.test(context))
      return 'unlikely';
    return 'probable';
  },

  // pydantic_usage: BaseModel class ≠ used as FastAPI request body param
  pydantic_usage(line, context) {
    // FastAPI route decorator near a BaseModel subclass usage
    if (/@app\.(post|put|patch|delete)\s*\(/.test(context))
      return 'confirmed';
    if (/async def \w+\s*\([^)]*:\s*\w+/.test(context))
      return 'probable';
    // Just a plain data class definition with no route nearby
    if (/^class \w+\(BaseModel\)/.test(line) && !/@app\./.test(context))
      return 'unlikely';
    return 'probable';
  },

  // bearer_auth: "Bearer" string in comments/tests ≠ middleware wired to routes
  bearer_auth(line, context) {
    // Looks like a comment or docstring
    if (/^\s*(\/\/|\/\*|\*|#)/.test(line))
      return 'unlikely';
    // Actual middleware or auth function application
    if (/app\.use\s*\(|router\.use\s*\(|authenticate|verifyToken|passport\.authenticate/.test(context))
      return 'confirmed';
    // Authorization header being SET (client code), not verified (server code)
    if (/headers\s*:\s*\{|fetch\s*\(|axios\./.test(context))
      return 'unlikely';
    return 'probable';
  },

  // timeout_config: `timeout: 30` in any object literal
  timeout_config(line, context) {
    // Inside an HTTP client options object
    if (/fetch\s*\(|axios\.(create|get|post|put|patch|delete)\s*\(|httpClient|createClient|\.request\s*\(/.test(context))
      return 'confirmed';
    // Inside a test/jest/describe block
    if (/\b(jest|describe|it|test|beforeEach|afterEach)\s*\(/.test(context))
      return 'unlikely';
    // Inside a known non-HTTP config object (lint, build tools)
    if (/eslint|webpack|vite|rollup|tsconfig/.test(context))
      return 'unlikely';
    return 'unlikely'; // too many non-HTTP objects have a timeout key
  },

  // py_timeout: `timeout=N` as keyword argument
  py_timeout(line, context) {
    if (/requests\.(get|post|put|patch|delete|head|options)\s*\(|httpx\.|aiohttp\.ClientSession/.test(context))
      return 'confirmed';
    if (/subprocess\.|os\.system|sleep\s*\(/.test(context))
      return 'unlikely';
    return 'unlikely'; // conservative
  },

  // health_route: "/health" string anywhere
  health_route(line, context) {
    // Server-side route registration
    if (/app\.(get|route)\s*\(\s*['"`]\/(health|healthz|ping|status)|router\.(get|route)\s*\(\s*['"`]\/(health|healthz|ping|status)|@app\.(get|route)\s*\(\s*['"`]\/(health|healthz|ping|status)/.test(context))
      return 'confirmed';
    // Client calling the health endpoint (fetch/axios)
    if (/fetch\s*\(|axios\.(get|create)|requests\.(get|head)/.test(context))
      return 'unlikely';
    // Test asserting health endpoint exists
    if (/expect\s*\(|assert|supertest|chai/.test(context))
      return 'unlikely';
    return 'unlikely'; // /health in README or openapi spec is common
  },

  // env_service_url: `process.env.X_URL` read
  env_service_url(line, context) {
    // Used as fetch/axios URL argument
    if (/fetch\s*\(\s*process\.env|baseURL\s*:\s*process\.env|baseUrl\s*:\s*process\.env|url\s*:\s*process\.env/.test(context))
      return 'confirmed';
    if (/fetch\(|axios\.(create|get|post)|new URL\s*\(/.test(context))
      return 'probable';
    // Just reading PORT or DATABASE_URL for non-HTTP purposes
    if (/PORT|DATABASE_URL|REDIS_URL|MONGO_URL/.test(line))
      return 'unlikely';
    return 'unlikely'; // env reads for NODE_ENV, LOG_LEVEL, etc. don't count
  },

  // retry_pattern: `maxRetries` / `retryCount` config key
  retry_pattern(line, context) {
    // Inside a retry library configuration
    if (/axiosRetry\s*\(|p-retry|retrying\(|@retry|tenacity|backoff\.on_exception/.test(context))
      return 'confirmed';
    // Near an actual HTTP call site
    if (/fetch\s*\(|axios\.|requests\.(get|post)|await/.test(context))
      return 'probable';
    // Config object in a test file or non-call-site
    return 'unlikely';
  },

  // fallback_pattern: variable/function named "fallback"
  fallback_pattern(line, context) {
    if (/catch\s*\(|\.catch\s*\(|except\s/.test(context))
      return 'probable';
    if (/return\s+fallback|fallbackData|fallbackResponse/.test(line))
      return 'probable';
    return 'unlikely';
  },

  // feature_flag: isEnabled() / featureFlag
  feature_flag(line, context) {
    if (/if\s*\(\s*(isEnabled|featureFlag|feature_flag)/.test(context))
      return 'probable';
    return 'unlikely';
  },
};

// ── Context-window grep ───────────────────────────────────────────────────────

const SOURCE_EXTS_RE = /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs|rb|java|cs|php)$/;
const TEST_PATH_RE   = /\.(test|spec)\.|__tests__|\/tests?\/|test_[\w]+\.py$|_test\.go$/;
const CONTEXT_WINDOW = 10; // lines before + after match

/**
 * Drop-in replacement for grepSources.
 * Returns the same shape {key: count} but for HIGH_FP_KEYS the count is the
 * number of VERIFIED (confirmed + probable) matches, not raw matches.
 */
function listSourceFiles(cloneDir) {
  try {
    const tracked = execSync('git ls-files', { cwd: cloneDir, timeout: 10000 })
      .toString().split('\n').filter(f => f && SOURCE_EXTS_RE.test(f));
    // If git returned files, use them; empty means untracked/non-git, fall through
    if (tracked.length > 0) return tracked;
  } catch {}
  // Fallback for non-git dirs or untracked working trees: shallow walk up to 2 levels
  const results = [];
  function walk(dir, depth) {
    if (depth > 2) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else if (SOURCE_EXTS_RE.test(entry.name)) results.push(full);
      }
    } catch {}
  }
  walk(cloneDir, 0);
  return results;
}

export function grepSourcesVerified(cloneDir, GREP_PATTERNS) {
  const H = {};
  const files = listSourceFiles(cloneDir);

  for (const relPath of files.slice(0, 400)) {
    const isTest = TEST_PATH_RE.test(relPath);
    let content = '';
    try { content = readFileSync(resolve(cloneDir, relPath), 'utf8').replace(/\0/g, ''); } catch { continue; }

    const lines = content.split('\n');

    for (const [key, pattern] of Object.entries(GREP_PATTERNS)) {
      if (key === 'localhost_hardcoded' && isTest) continue;

      if (!HIGH_FP_KEYS.has(key)) {
        // low/medium risk: use raw count
        const matches = content.match(pattern);
        if (matches) H[key] = (H[key] || 0) + matches.length;
        continue;
      }

      // HIGH-FP: scan line by line and apply context verification
      const verifier = VERIFIERS[key];
      let verifiedCount = 0;

      lines.forEach((line, idx) => {
        const p = new RegExp(pattern.source, pattern.flags);
        if (!p.test(line)) return;

        const start  = Math.max(0, idx - CONTEXT_WINDOW);
        const end    = Math.min(lines.length, idx + CONTEXT_WINDOW + 1);
        const ctx    = lines.slice(start, end).join('\n');
        const result = verifier ? verifier(line, ctx) : 'probable';

        if (result === 'confirmed' || result === 'probable') verifiedCount++;
      });

      if (verifiedCount > 0) H[key] = (H[key] || 0) + verifiedCount;
    }
  }

  return H;
}

/**
 * Convenience: verify a single match externally.
 */
export function verifyMatch(key, line, contextLines) {
  if (!HIGH_FP_KEYS.has(key)) return 'confirmed';
  const verifier = VERIFIERS[key];
  if (!verifier) return 'probable';
  return verifier(line, contextLines.join('\n'));
}
