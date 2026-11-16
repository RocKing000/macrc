# MACRC: Multi-layer AI Component Readiness Checklist

**AI coding agents ship PRs without timeouts, circuit breakers, or input validation. By the time a human reviews it, the code is merged. MACRC catches it at the diff.**

MACRC audits any codebase across 20 structural dimensions in four layers (Security, Reliability, Observability, Scale Contract) and optionally generates patches to fix what's absent.

```
$ macrc audit ./my-service

MARC Audit: ./my-service  [macrc-heuristic]  2026-11-16
──────────────────────────────────────────────────────────────────────

Security
  ✗  auth                                    no auth signals found
  ✗  input_validation                        no validation signals found
  ✗  transport_security                      no TLS config found

Reliability
  ✗  retry_logic                  [high]     No retry logic found
  ✗  timeout_handling             [high]     No timeout handling found

Observability
  ✗  health_checks                [medium]   No health check endpoint found

Scale Contract
  ✗  statelessness                [high]     In-process session store, not horizontally scalable

──────────────────────────────────────────────────────────────────────
  0 present  1 partial  17 absent  0 n/a  (18 applicable)
  ⚠  Critical severity dimension(s) present
```

---

## Install

```bash
npm install -g macrc
# or run without installing:
npx macrc audit .
```

**Requirements:** Node.js ≥ 18

---

## Quick start

```bash
# 1. Audit: see what's missing
macrc audit ./my-api

# 2. Gate: block CI on policy violations (exits non-zero)
macrc gate ./my-api

# 3. Fix: preview patches
macrc fix ./my-api --dry-run

# 4. Fix: apply patches
macrc fix ./my-api

# 5. Diff: compare two audit snapshots
macrc diff before.json after.json
```

---

## Demo

The `demo/bad-express-app/` directory is an intentionally under-hardened Express app. Run it to see the full pipeline:

```bash
# Audit: 17 of 18 dims absent
macrc audit demo/bad-express-app --no-color

# Fix dry-run: 9 patches across 7 Tier-1 dims
macrc fix demo/bad-express-app --dry-run --no-color
```

**Fix output:**
```
MARC Remediator patches
──────────────────────────────────────────────────
✓  auth             → src/routes/users.js  (would-apply)
   note: Wire it: router.use(requireAuth) on protected route groups
✓  input_validation → src/routes/users.js  (would-apply)
   note: Add validateBody(YourSchema) as middleware before each POST/PUT/PATCH handler
✓  retry_logic      → package.json         (would-apply)
✓  retry_logic      → src/services/api.js  (would-apply)
✓  timeout_handling → src/services/api.js  (would-apply)
   note: Replace axios.get/post/... with http.get/post/... in api.js
✓  health_checks    → src/index.js         (would-apply)
✓  statelessness    → src/index.js         (would-apply)
   note: npm install connect-redis ioredis, then apply this patch
✓  statelessness    → src/index.js         (would-apply)
✓  load_balancing   → src/index.js         (would-apply)
──────────────────────────────────────────────────
  9 applied  0 manual  0 skipped  0 errors
```

---

## Subcommands

### `macrc audit <dir>`

Runs the full heuristic scan plus optional targeted LLM verification on Tier-1 dimensions.

```bash
macrc audit ./my-api
macrc audit ./my-api --format json > audit.json
macrc audit ./my-api --llm                        # targeted LLM on Tier-1 dims (needs ANTHROPIC_API_KEY)
macrc audit ./my-api --stack-category mcp-server  # explicit stack override
macrc audit ./my-api --no-verify                  # skip contextual grep (use raw regex counts)
```

### `macrc gate <dir>`

Like `audit` but exits non-zero if policy blocks. Use in CI to prevent merging absent Tier-1 dims.

```bash
macrc gate ./my-api --format sarif --out results.sarif
```

### `macrc fix <dir>`

Generates and applies deterministic patches for absent/partial Tier-1 dimensions. Language-aware (TypeScript, JavaScript, Python).

```bash
macrc fix ./my-api --dry-run                        # preview only
macrc fix ./my-api --dims timeout_handling,auth     # patch specific dims
macrc fix ./my-api --from audit.json                # skip re-scan, use saved audit
```

### `macrc diff <before.json> <after.json>`

Compares two audit JSON files and reports regressions and improvements.

```
↑ IMPROVED  reliability.retry_logic  absent → present
↓ REGRESSED security.auth  present → absent
```

---

## GitHub Code Scanning

MACRC outputs SARIF, which GitHub Code Scanning ingests natively:

```yaml
- name: MACRC audit
  run: npx @shubh000/macrc gate . --format sarif --out macrc.sarif || true

- name: Upload MACRC results
  uses: github/codeql-action/upload-sarif@v3
  with:
    sarif_file: macrc.sarif
    category: macrc
```

Results appear in the **Security → Code scanning** tab. Use `|| true` if you want findings without blocking the workflow, or drop it to block on absent Tier-1 dims.

---

## GitHub Action

```yaml
- name: MACRC gate
  uses: trinetra/macrc@v1
  with:
    directory: .
    fail-on-block: true
    llm: false          # set true + ANTHROPIC_API_KEY for Tier-1 LLM verification
```

Full inputs: `directory`, `format`, `policy-dir`, `stack-category`, `llm`, `sarif-upload`, `fail-on-block`.

---

## How it works

**Step 1: Heuristic pass (all 20 dims, deterministic)**

Three signal extractors run per repo. For 10 patterns with high false-positive risk (e.g. `zod_usage`, `bearer_auth`, `health_route`), hits go through a context-window pass: ±10 surrounding lines are checked with rule-based string analysis to confirm the signal is at a real call site, not a schema definition, test fixture, or comment. This is not an AST parser — no tree-sitter or Babel bindings. It is a fast, dependency-free signal verifier (`context-verifier.mjs`).

| Extractor | What it checks |
|---|---|
| `parseDeps` | 5 package-manager manifest formats |
| `grepSources` | 32 regex patterns across ≤400 source files |
| `scanConfigs` | 12 infra config file types (k8s, docker-compose, Dockerfile, nginx…) |

**Step 2: Targeted LLM pass (Tier-1 dims only, `--llm` flag)**

5 dimensions have ≥20pp divergence between heuristic and LLM scores on the 232-repo corpus (231 used in LLM calibration — 1 quarantined during ingest). For these, a structured prompt is sent to `claude-haiku-4-5` with the actual route/controller code as context, only when the heuristic says `partial` or `present`.

**Why verify `partial/present`, not `absent`?** The Tier-1 gap is a *false-negative* gap: the heuristic says a repo has `auth` or `input_validation` (partial or present) when the LLM finds it actually doesn't. The heuristic almost never calls a truly present dim absent — it errs on the side of optimism. So the false negatives sit entirely in the `partial/present` bucket. Sending the LLM only those repos cuts the verification cost by ~70% (roughly 30% of repos per Tier-1 dim have partial/present) while catching the cases that matter. Verifying `absent` repos would add cost with zero TPR gain.

**Step 3: Patch generation (`fix` subcommand)**

For each absent/partial Tier-1 dim, a language-aware patch builder generates a minimal scaffolding patch: injecting middleware stubs after the last import block, adding timeout config to HTTP client calls, replacing hardcoded `localhost` URLs with env var expressions, wiring a Redis session store.

**Scope note:** patches target straightforward Express/FastAPI apps. They are starter scaffolding, not universal codemods — complex TypeScript generics, custom axios wrappers, or monorepo structures will need manual adjustment after apply.

**AST query roadmap:** Current acorn queries cover JS/TS only. Python equivalent via `python3 -m ast` subprocess (stdlib, no install) is the planned next addition — relevant for the AI/ML backend ecosystem where most AI-native services are FastAPI or Flask.

---

## Divergence map: why Tier-1 matters

Running both the heuristic and LLM auditor on the same 231 repos reveals which dimensions the heuristic systematically underestimates:

| Dimension | LLM absent% | Heuristic (raw)% | Heuristic (verified)% | Gap (verified) | Tier |
|---|---|---|---|---|---|
| input_validation | 100% | 29% | 45% | +55pp | **1** |
| distributed_assumptions | 85% | 13% | 33% | +52pp | **1** |
| auth | 100% | 51% | 54% | +46pp | **1** |
| statelessness | 36% | 1% | 1% | +35pp | **1** |
| timeout_handling | 70% | 35% | 50% | +20pp | **1** |
| retry_logic | 92% | 66% | 80% | +12pp | 2 |
| logging | 53% | 35% | 35% | +18pp | 2 |
| health_checks | 89% | 33% | 86% | +3pp | 2 |
| load_balancing_awareness | 90% | 35% | 88% | +2pp | 2 |

Gap = LLM absent% minus verified heuristic absent%. Tier-1 (≥20pp gap) means the heuristic alone misses too many real absences to be reliable. Columns use verified mode (default). Raw mode is shown for reference.

Contextual verification closes large parts of the gap for health_checks (+56pp raw vs +3pp verified) and load_balancing_awareness (+55pp raw vs +2pp verified), confirming the verifier is doing real work. The remaining Tier-1 gaps reflect structural limits of static analysis.

The full calibration corpus (232 public AI-native repos across 8 stack categories, 231 in the LLM calibration subset) is documented at the [MACRC Corpus dashboard](https://trinetra.life).

---

## Stack categories and N/A classification

| Category | N/A dims | Count |
|---|---|---|
| `plugin-extension` | 8 (all network dims) | 25 repos |
| `skills-config` | 8 (all network dims) | 25 repos |
| `desktop-native` | 8 (all network dims) | 24 repos |
| `cli-tool` | 7 (network dims except distributed_assumptions) | 24 repos |

Dims classified N/A are excluded from the heuristic denominator. LLM mode scores all dims without N/A.

---

## Policy

Place a `.macrc.yml` in your repo root to customise gate behaviour:

```yaml
policy:
  security.auth: block        # fail gate if absent
  security.input_validation: block
  reliability.timeout_handling: warn
  observability.health_checks: warn
```

Default: all dims warn on absent, pass on partial or present.

---

## Tests

```bash
# Unit tests (fast, no network)
node --test tests/context-verifier.test.mjs tests/remediator.test.mjs tests/syntax-queries.test.mjs

# Integration tests (runs full pipeline on demo/bad-express-app)
node --test tests/integration.test.mjs

# All at once
node --test tests/*.test.mjs
# 43 tests, 0 failures
```

---

## License

MIT
