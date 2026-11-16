/**
 * MACRC Remediator: auto-patch generator for absent/partial Tier-1 dims.
 *
 * Each patch is a { file, description, search, replace } object.
 * "search" is a string or regex to find the insertion point.
 * "replace" is the replacement/insertion text.
 *
 * Exports:
 *   detectLanguage(cloneDir)                      → 'ts'|'js'|'py'|'go'|'rust'
 *   buildPatches(auditResult, cloneDir)           → Patch[]
 *   applyPatches(patches, cloneDir, dryRun)       → PatchReport
 *   formatPatchReport(report, {color})            → string
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { resolve, basename, extname, relative } from 'path';
import { execSync } from 'child_process';

// ── Language detection ────────────────────────────────────────────────────────

export function detectLanguage(cloneDir) {
  if (existsSync(resolve(cloneDir, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(resolve(cloneDir, 'package.json'), 'utf8'));
      const all = { ...pkg.dependencies, ...pkg.devDependencies };
      if (all['typescript'] || all['ts-node'] || all['@types/node']) return 'ts';
    } catch {}
    return 'js';
  }
  if (existsSync(resolve(cloneDir, 'requirements.txt')) ||
      existsSync(resolve(cloneDir, 'pyproject.toml'))) return 'py';
  if (existsSync(resolve(cloneDir, 'go.mod'))) return 'go';
  if (existsSync(resolve(cloneDir, 'Cargo.toml'))) return 'rust';
  return 'js';
}

// ── File finders ──────────────────────────────────────────────────────────────

const SRC_EXT_RE = /\.(js|ts|mjs|cjs|py|go|rs)$/;

function listFiles(cloneDir) {
  try {
    const gitFiles = execSync('git ls-files', { cwd: cloneDir, timeout: 10000 })
      .toString().split('\n').filter(Boolean);
    // Empty means untracked/non-git working tree, fall through to filesystem walk
    if (gitFiles.length > 0) return gitFiles;
  } catch {}
  // Fallback: filesystem walk (untracked/non-git dirs)
  const results = [];
  function walk(dir, depth) {
    if (depth > 4) return;
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) walk(full, depth + 1);
        else results.push(relative(cloneDir, full).replace(/\\/g, '/'));
      }
    } catch {}
  }
  walk(cloneDir, 0);
  return results;
}

function findMainServerFile(cloneDir, lang) {
  const files = listFiles(cloneDir);

  if (lang === 'ts' || lang === 'js') {
    const priorities = ['src/index.ts','src/index.js','src/app.ts','src/app.js',
      'index.ts','index.js','app.ts','app.js','server.ts','server.js',
      'src/server.ts','src/server.js'];
    for (const p of priorities) {
      if (files.includes(p)) return p;
    }
    // Fall back: file with app.listen
    return files.find(f => /\.(ts|js)$/.test(f) && (() => {
      try { return readFileSync(resolve(cloneDir, f), 'utf8').includes('app.listen'); } catch { return false; }
    })()) || null;
  }

  if (lang === 'py') {
    const priorities = ['main.py','app.py','src/main.py','src/app.py','api/main.py'];
    for (const p of priorities) {
      if (files.includes(p)) return p;
    }
    return files.find(f => /\.py$/.test(f) && (() => {
      try { const c = readFileSync(resolve(cloneDir, f), 'utf8');
        return c.includes('@app.') || c.includes('FastAPI') || c.includes('Flask'); } catch { return false; }
    })()) || null;
  }

  return null;
}

function findHttpCallFiles(cloneDir, lang) {
  const TEST_RE = /\.(test|spec)\.|__tests__|\/tests?\//;
  const files = listFiles(cloneDir);
  if (lang === 'ts' || lang === 'js') {
    return files.filter(f => /\.(ts|js|mjs)$/.test(f) && !TEST_RE.test(f) && (() => {
      try { const c = readFileSync(resolve(cloneDir, f), 'utf8');
        return /fetch\s*\(|axios\.(get|post|put|patch|delete|create)\s*\(/.test(c); } catch { return false; }
    })());
  }
  if (lang === 'py') {
    return files.filter(f => /\.py$/.test(f) && !TEST_RE.test(f) && (() => {
      try { const c = readFileSync(resolve(cloneDir, f), 'utf8');
        return /requests\.(get|post|put|patch|delete)\s*\(|httpx\./.test(c); } catch { return false; }
    })());
  }
  return [];
}

// ── Patch builders per dim ────────────────────────────────────────────────────

function patchHealthChecks(cloneDir, lang, notes) {
  const patches = [];
  const main = findMainServerFile(cloneDir, lang);
  if (!main) return patches;

  if (lang === 'ts' || lang === 'js') {
    const content = readFileSync(resolve(cloneDir, main), 'utf8');
    if (/['"`]\/(health|healthz|ping)\b/.test(content)) return patches; // already exists

    const listenMatch = content.match(/app\.listen\s*\(/);
    if (!listenMatch) return patches;

    patches.push({
      file: main,
      description: 'Inject /health endpoint returning {status,uptime}',
      search: 'app.listen(',
      replace:
`app.get('/health', (_req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

app.listen(`,
    });
  }

  if (lang === 'py') {
    const content = readFileSync(resolve(cloneDir, main), 'utf8');
    if (/['"`]\/(health|healthz|ping)\b/.test(content)) return patches;

    // Insert before the last line that starts the server
    const uvicornMatch = content.match(/if __name__ == ['"]__main__['"]/);
    const target = uvicornMatch ? 'if __name__ == ' : null;

    if (target) {
      patches.push({
        file: main,
        description: 'Inject /health endpoint returning {status: "ok"}',
        search: 'if __name__ == ',
        replace:
`@app.get("/health")
async def health_check():
    return {"status": "ok", "uptime": True}


if __name__ == `,
      });
    }
  }

  return patches;
}

function patchTimeoutHandling(cloneDir, lang) {
  const patches = [];
  const files = findHttpCallFiles(cloneDir, lang);

  for (const relPath of files.slice(0, 5)) {
    let content;
    try { content = readFileSync(resolve(cloneDir, relPath), 'utf8'); } catch { continue; }

    if (lang === 'ts' || lang === 'js') {
      // axios.create({}) without timeout → inject timeout
      if (/axios\.create\s*\(\s*\{/.test(content) && !/timeout\s*:/.test(content.match(/axios\.create\s*\(\{([^}]*)\}/)?.[0] || '')) {
        patches.push({
          file: relPath,
          description: `Add default timeout to axios.create in ${basename(relPath)}`,
          search: 'axios.create({',
          replace: 'axios.create({ timeout: 10000,',
        });
        continue;
      }

      // Direct axios.get/post calls without timeout in the same file → create an axios instance with timeout
      if (/axios\.(get|post|put|patch|delete)\s*\(/.test(content) && !content.includes('axios.create') && !/timeout\s*:/.test(content)) {
        const axiosImportLine = content.match(/^import axios.+$/m)?.[0];
        if (axiosImportLine) {
          patches.push({
            file: relPath,
            description: `Replace bare axios calls with a timeout-configured instance in ${basename(relPath)}`,
            search: axiosImportLine,
            replace: `${axiosImportLine}\nconst http = axios.create({ timeout: 10000 });`,
            note: `Replace axios.get/post/... with http.get/post/... in ${basename(relPath)}`,
          });
          continue;
        }
      }

      // Bare fetch(url) without signal → inject AbortSignal
      if (/fetch\s*\(\s*\w/.test(content) && !/AbortSignal|AbortController/.test(content)) {
        patches.push({
          file: relPath,
          description: `Wrap fetch calls with AbortSignal.timeout(10000) in ${basename(relPath)}`,
          search: "fetch(",
          replace: "fetch(",
          note: 'Manual: add `signal: AbortSignal.timeout(10_000)` to each fetch options object',
          manual: true,
        });
      }
    }

    if (lang === 'py') {
      // requests.get(url) without timeout=
      if (/requests\.(get|post|put|patch|delete)\s*\([^)]*\)/.test(content) && !/timeout\s*=/.test(content)) {
        const updated = content.replace(
          /requests\.(get|post|put|patch|delete)\s*\(([^)]+)\)/g,
          (m, method, args) => {
            if (args.includes('timeout')) return m;
            return `requests.${method}(${args.trimEnd()}, timeout=10)`;
          }
        );
        if (updated !== content) {
          patches.push({
            file: relPath,
            description: `Add timeout=10 to requests calls in ${basename(relPath)}`,
            directContent: updated,
          });
        }
      }
    }
  }

  return patches;
}

function patchRetryLogic(cloneDir, lang) {
  const patches = [];

  if (lang === 'ts' || lang === 'js') {
    let pkgPath = null;
    try {
      const raw = readFileSync(resolve(cloneDir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw);
      const hasPkg = pkg.dependencies?.['axios-retry'] || pkg.devDependencies?.['axios-retry'];
      pkgPath = resolve(cloneDir, 'package.json');

      // Find a file that imports axios (axios.create preferred, bare import accepted)
      const httpFiles = findHttpCallFiles(cloneDir, lang);
      const axiosFiles = httpFiles.filter(f => {
        try { return /import axios|require\(['"]axios/.test(readFileSync(resolve(cloneDir, f), 'utf8')); } catch { return false; }
      });

      const target = axiosFiles[0];
      if (target) {
        const content = readFileSync(resolve(cloneDir, target), 'utf8');
        if (!hasPkg) {
          // Add axios-retry to package.json
          patches.push({
            file: 'package.json',
            description: 'Add axios-retry dependency',
            search: '"dependencies": {',
            replace: '"dependencies": {\n    "axios-retry": "^4.5.0",',
          });
        }

        if (!/axiosRetry\s*\(/.test(content)) {
          // Find the axios import line exactly so we don't double-import
          const axiosImportLine = content.match(/^import axios.+$/m)?.[0];
          if (axiosImportLine) {
            patches.push({
              file: target,
              description: `Wire axios-retry to axios instance in ${basename(target)}`,
              search: axiosImportLine,
              replace:
`${axiosImportLine}
import axiosRetry from 'axios-retry';
axiosRetry(axios, { retries: 3, retryDelay: axiosRetry.exponentialDelay, retryCondition: axiosRetry.isNetworkOrIdempotentRequestError });`,
            });
          }
        }
      }
    } catch {}
  }

  if (lang === 'py') {
    // Add tenacity decorator to functions making external calls
    const files = findHttpCallFiles(cloneDir, lang).slice(0, 3);
    for (const relPath of files) {
      let content;
      try { content = readFileSync(resolve(cloneDir, relPath), 'utf8'); } catch { continue; }
      if (/from tenacity|import tenacity/.test(content)) continue;

      patches.push({
        file: relPath,
        description: `Add tenacity retry import and decorator hint in ${basename(relPath)}`,
        search: 'import requests',
        replace:
`from tenacity import retry, stop_after_attempt, wait_exponential
import requests`,
        note: 'Add @retry(stop=stop_after_attempt(3), wait=wait_exponential()) decorator to each function that calls requests.*',
      });
      break; // one file for now
    }
  }

  return patches;
}

function patchInputValidation(cloneDir, lang) {
  const patches = [];

  if (lang === 'ts' || lang === 'js') {
    const files = listFiles(cloneDir)
      .filter(f => /route|router|controller|handler/i.test(f) && /\.(ts|js)$/.test(f));
    const target = files[0];
    if (!target) return patches;

    const content = readFileSync(resolve(cloneDir, target), 'utf8');
    if (/validateBody|safeParse\s*\(\s*req/.test(content)) return patches;

    // Find last import line to inject helper after the import block
    const lastImportMatch = [...content.matchAll(/^import .+$/gm)].pop();
    if (!lastImportMatch) return patches;
    const anchor = lastImportMatch[0];

    patches.push({
      file: target,
      description: `Inject validateBody middleware factory in ${basename(target)}`,
      search: anchor,
      replace:
`${anchor}

// MACRC: validateBody middleware factory, enforces schema at route entry points
function validateBody(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return res.status(400).json({ error: result.error.errors });
    req.body = result.data;
    next();
  };
}`,
      note: 'Add validateBody(YourSchema) as middleware before each POST/PUT/PATCH handler',
    });
  }

  if (lang === 'py') {
    const main = findMainServerFile(cloneDir, lang);
    if (!main) return patches;
    const content = readFileSync(resolve(cloneDir, main), 'utf8');
    if (/BaseModel|pydantic/.test(content)) return patches;

    patches.push({
      file: main,
      description: 'Add Pydantic request model import and usage hint',
      search: 'from fastapi import',
      replace:
`from pydantic import BaseModel
from fastapi import`,
      note: 'Add `body: YourModel` parameter to POST/PUT/PATCH route functions to enforce validation',
    });
  }

  return patches;
}

function patchDistributedAssumptions(cloneDir, lang, notes) {
  const patches = [];
  const files = listFiles(cloneDir);
  const TEST_RE = /\.(test|spec)\.|__tests__|\/tests?\//;
  const LOCALHOST_RE = /https?:\/\/localhost:\d+|https?:\/\/127\.0\.0\.1:\d+/g;
  // Matches already-patched env-var expressions so we don't double-patch
  const ALREADY_PATCHED_RE = /process\.env\.SERVICE_URL_|os\.environ\[.SERVICE_URL_/;

  for (const relPath of files) {
    if (TEST_RE.test(relPath)) continue;
    if (!/\.(ts|js|mjs|py|go)$/.test(relPath)) continue;

    let content;
    try { content = readFileSync(resolve(cloneDir, relPath), 'utf8'); } catch { continue; }

    // Skip files that already have env-var replacements (idempotency guard)
    if (ALREADY_PATCHED_RE.test(content)) continue;

    const matches = content.match(LOCALHOST_RE);
    if (!matches) continue;

    // One search/replace patch per unique localhost URL so we compose safely with other patches
    const uniqueUrls = [...new Set(matches)];
    const envKeys = uniqueUrls.map(url => {
      const port = url.match(/:(\d+)/)?.[1] || '8080';
      return `SERVICE_URL_${port}`;
    });
    for (const url of uniqueUrls) {
      const port = url.match(/:(\d+)/)?.[1] || '8080';
      const envKey = `SERVICE_URL_${port}`;
      const replacement = lang === 'py' ? `os.environ["${envKey}"]` : `process.env.${envKey}`;
      // one patch per occurrence so all instances are replaced
      let remaining = content;
      let occurrenceCount = 0;
      while (remaining.includes(url)) { occurrenceCount++; remaining = remaining.replace(url, ''); }
      for (let i = 0; i < occurrenceCount; i++) {
        patches.push({
          file: relPath,
          description: `Replace hardcoded ${url} with process.env.${envKey} in ${basename(relPath)}`,
          search: url,
          replace: replacement,
          ...(i === 0 ? { note: `Set ${envKeys.join(', ')} env var(s) to the target service URLs in your .env file` } : {}),
        });
      }
    }
  }

  // Also create .env.example entries
  if (patches.length > 0) {
    const envPath = resolve(cloneDir, '.env.example');
    const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
    const newVars = patches.flatMap(p => p.note ? [p.note.replace('Add ', '').split(' to your')[0]] : []).join('\n');
    if (newVars && !existing.includes('SERVICE_URL_')) {
      patches.push({
        file: '.env.example',
        description: 'Add service URL env var placeholders to .env.example',
        directContent: existing + (existing.endsWith('\n') ? '' : '\n') + '# MACRC: service URLs for deployed environment\n' + newVars + '\n',
      });
    }
  }

  return patches;
}

function patchAuth(cloneDir, lang) {
  const patches = [];
  if (lang !== 'ts' && lang !== 'js') return patches;

  const files = listFiles(cloneDir)
    .filter(f => /route|router/i.test(f) && /\.(ts|js)$/.test(f));
  const target = files[0];
  if (!target) return patches;
  const content = readFileSync(resolve(cloneDir, target), 'utf8');
  if (/requireAuth|authenticate|verifyToken|passport/.test(content)) return patches;

  // Anchor after the last import line so the stub lands at module scope
  const lastImport = [...content.matchAll(/^import .+$/gm)].pop();
  if (!lastImport) return patches;
  const anchor = lastImport[0];

  patches.push({
    file: target,
    description: `Inject requireAuth middleware stub in ${basename(target)}`,
    search: anchor,
    replace:
`${anchor}

// MACRC: requireAuth stub, replace with your actual auth middleware
function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  // TODO: verify token with jwt.verify(token, process.env.JWT_SECRET)
  next();
}`,
    note: 'Wire it: router.use(requireAuth) on protected route groups',
  });

  return patches;
}

function patchStatelessness(cloneDir, lang) {
  const patches = [];
  if (lang !== 'ts' && lang !== 'js') return patches;

  const main = findMainServerFile(cloneDir, lang);
  if (!main) return patches;

  let content;
  try { content = readFileSync(resolve(cloneDir, main), 'utf8'); } catch { return patches; }

  // Only patch if express-session with no Redis store
  if (!/express-session|session\s*\(/.test(content)) return patches;
  if (/connect-redis|RedisStore/.test(content)) return patches;

  const isESM = /^import\s+/m.test(content);
  const sessionImportLine = content.match(
    isESM ? /^import session.+$/m : /^const session = require\(.+\).*$/m
  )?.[0];
  if (!sessionImportLine) return patches;

  if (isESM) {
    patches.push({
      file: main,
      description: 'Add connect-redis imports for stateless session store',
      note: 'npm install connect-redis ioredis, then apply this patch',
      search: sessionImportLine,
      replace:
`${sessionImportLine}
import connectRedis from 'connect-redis';
import { createClient } from 'ioredis';

const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
const RedisStore = connectRedis(session);`,
    });
  } else {
    patches.push({
      file: main,
      description: 'Replace in-memory session store with connect-redis for stateless scaling',
      note: 'npm install connect-redis ioredis, then apply this patch',
      search: sessionImportLine,
      replace:
`${sessionImportLine}
const connectRedis = require('connect-redis');
const { createClient } = require('ioredis');

const redisClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
const RedisStore = connectRedis(session);`,
    });
  }

  patches.push({
    file: main,
    description: 'Wire RedisStore into session middleware',
    search: 'app.use(session({',
    replace:
`app.use(session({
  store: new RedisStore({ client: redisClient }),`,
  });

  return patches;
}

function patchLoadBalancingAwareness(cloneDir, lang) {
  const patches = [...patchHealthChecks(cloneDir, lang, '')];

  // Also try docker-compose
  const composeFiles = ['docker-compose.yml', 'docker-compose.yaml'].filter(f =>
    existsSync(resolve(cloneDir, f))
  );
  for (const f of composeFiles) {
    const content = readFileSync(resolve(cloneDir, f), 'utf8');
    if (/replicas/.test(content)) continue;
    if (!/deploy:/.test(content)) {
      // Find service definition and add deploy block
      const serviceMatch = content.match(/^(\s{2})(\w+):\n(\s{4})image:/m);
      if (serviceMatch) {
        patches.push({
          file: f,
          description: `Add deploy.replicas: 2 to service in ${f}`,
          search: serviceMatch[0],
          replace: serviceMatch[0] + `${serviceMatch[1]}  deploy:\n${serviceMatch[1]}    replicas: 2\n`,
        });
      }
    }
  }

  return patches;
}

// ── Main patch builder ────────────────────────────────────────────────────────

const TIER1_BUILDERS = {
  health_checks:            (d, l, n) => patchHealthChecks(d, l, n),
  timeout_handling:         (d, l)    => patchTimeoutHandling(d, l),
  retry_logic:              (d, l)    => patchRetryLogic(d, l),
  input_validation:         (d, l)    => patchInputValidation(d, l),
  distributed_assumptions:  (d, l, n) => patchDistributedAssumptions(d, l, n),
  auth:                     (d, l)    => patchAuth(d, l),
  statelessness:            (d, l)    => patchStatelessness(d, l),
  load_balancing_awareness: (d, l)    => patchLoadBalancingAwareness(d, l),
};

export function buildPatches(auditResult, cloneDir) {
  const lang = detectLanguage(cloneDir);
  const patches = [];

  for (const [layer, dims] of Object.entries(auditResult.layers || {})) {
    for (const [dim, result] of Object.entries(dims)) {
      if (result.state !== 'absent' && result.state !== 'partial') continue;
      const builder = TIER1_BUILDERS[dim];
      if (!builder) continue;
      const dimPatches = builder(cloneDir, lang, result.notes || '');
      patches.push(...dimPatches.map(p => ({ ...p, _dim: dim, _state: result.state })));
    }
  }

  return patches;
}

// ── Patch application ─────────────────────────────────────────────────────────

export function applyPatches(patches, cloneDir, dryRun = false) {
  const report = { applied: [], skipped: [], errors: [], manual: [] };

  for (const patch of patches) {
    if (patch.manual) {
      report.manual.push(patch);
      continue;
    }

    const absPath = resolve(cloneDir, patch.file);
    try {
      if (patch.directContent !== undefined) {
        // Full-file replacement
        if (!dryRun) writeFileSync(absPath, patch.directContent, 'utf8');
        report.applied.push({ ...patch, action: dryRun ? 'would-apply' : 'applied' });
        continue;
      }

      let content;
      try { content = readFileSync(absPath, 'utf8'); } catch {
        // File doesn't exist yet (e.g. .env.example)
        if (!dryRun) writeFileSync(absPath, patch.replace || '', 'utf8');
        report.applied.push({ ...patch, action: dryRun ? 'would-create' : 'created' });
        continue;
      }

      if (!content.includes(patch.search)) {
        report.skipped.push({ ...patch, reason: 'search string not found' });
        continue;
      }

      const updated = content.replace(patch.search, patch.replace);
      if (!dryRun) writeFileSync(absPath, updated, 'utf8');
      report.applied.push({ ...patch, action: dryRun ? 'would-apply' : 'applied' });

    } catch (err) {
      report.errors.push({ ...patch, error: err.message });
    }
  }

  return report;
}

// ── Formatting ────────────────────────────────────────────────────────────────

export function formatPatchReport(report, { color = true } = {}) {
  const G = color ? '\x1b[32m' : '', R = color ? '\x1b[31m' : '',
        Y = color ? '\x1b[33m' : '', B = color ? '\x1b[2m' : '', X = color ? '\x1b[0m' : '';
  const lines = ['\nMARC Remediator patches\n' + '─'.repeat(50)];

  for (const p of report.applied) {
    lines.push(`${G}✓${X}  ${p._dim} → ${p.file}  ${B}(${p.action})${X}`);
    if (p.note) lines.push(`   ${Y}note:${X} ${p.note}`);
  }
  for (const p of report.manual) {
    lines.push(`${Y}⚐${X}  ${p._dim} → ${p.file}  ${B}(manual)${X}`);
    if (p.note) lines.push(`   ${Y}note:${X} ${p.note}`);
  }
  for (const p of report.skipped) {
    lines.push(`${B}-${X}  ${p._dim} -> ${p.file}  ${B}(skipped: ${p.reason})${X}`);
  }
  for (const p of report.errors) {
    lines.push(`${R}✗${X}  ${p._dim} → ${p.file}  ${R}ERROR: ${p.error}${X}`);
  }

  lines.push('─'.repeat(50));
  lines.push(`  ${report.applied.length} applied  ${report.manual.length} manual  ${report.skipped.length} skipped  ${report.errors.length} errors`);
  return lines.join('\n');
}
