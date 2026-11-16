#!/usr/bin/env node
/**
 * macrc: MACRC CLI
 *
 * Subcommands:
 *   audit <dir>          Run full heuristic audit + optional targeted LLM on Tier-1 dims
 *   gate  <dir>          Like audit, but exits non-zero on policy violations (for CI)
 *   diff  <audit1> <audit2>  Compare two audit JSON files
 *
 * Options:
 *   --format json|table|sarif   Output format (default: table)
 *   --llm                       Enable targeted LLM verification for Tier-1 dims
 *   --policy <dir>              Directory to search for .macrc.yml (default: <dir>)
 *   --stack-category <cat>      Explicit stack category override
 *   --model <id>                LLM model for targeted verification (default: claude-haiku-4-5)
 *   --out <file>                Write output to file instead of stdout
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import { runHeuristic, computeHeuristicSummary } from './lib/heuristic.mjs';
import { verifyDim }                              from './lib/targeted-llm.mjs';
import { loadPolicy, applyPolicy, formatPolicyReport } from './lib/policy.mjs';
import { formatJson, formatTable, formatSarif }   from './lib/output.mjs';
import { buildPatches, applyPatches, formatPatchReport } from './lib/remediator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const TIER1_DIMS = new Set([
  'input_validation','distributed_assumptions','auth','statelessness',
  'timeout_handling','health_checks','load_balancing_awareness','retry_logic',
]);

function usage() {
  console.log(`
macrc: MACRC audit CLI

Usage:
  macrc audit <dir>  [options]
  macrc gate  <dir>  [options]
  macrc fix   <dir>  [options]
  macrc diff  <audit1.json> <audit2.json>

Options:
  --format json|table|sarif   Output format for audit/gate (default: table)
  --llm                       Run targeted LLM verification on Tier-1 dims
  --no-verify                 Skip contextual grep verification (use raw regex counts)
  --policy <dir>              Policy file search root (default: <dir>)
  --stack-category <cat>      Override stack category (ai-web-app|api-proxy|mcp-server|
                                agent-framework|cli-tool|desktop-native|
                                plugin-extension|skills-config)
  --model <id>                LLM model for targeted verification
  --out <file>                Write output to file
  --no-color                  Disable ANSI color in table output

  fix-specific:
  --dry-run                   Show patches without applying them
  --dims <d1,d2,...>          Only patch specific dims (default: all absent/partial Tier-1)
  --from <audit.json>         Use existing audit file instead of re-running scan
`);
}

function parseArgs(argv) {
  const args = { cmd: null, positional: [], format: 'table', llm: false, color: true, verified: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h')     { usage(); process.exit(0); }
    if (a === '--format')                 { args.format = argv[++i]; continue; }
    if (a === '--llm')                    { args.llm = true; continue; }
    if (a === '--no-verify')              { args.verified = false; continue; }
    if (a === '--policy')                 { args.policyDir = argv[++i]; continue; }
    if (a === '--stack-category')         { args.stackCategory = argv[++i]; continue; }
    if (a === '--model')                  { args.model = argv[++i]; continue; }
    if (a === '--out')                    { args.out = argv[++i]; continue; }
    if (a === '--no-color')               { args.color = false; continue; }
    if (a === '--dry-run')                { args.dryRun = true; continue; }
    if (a === '--dims')                   { args.dims = new Set(argv[++i].split(',')); continue; }
    if (a === '--from')                   { args.fromAudit = argv[++i]; continue; }
    if (!a.startsWith('--')) {
      if (!args.cmd) args.cmd = a;
      else args.positional.push(a);
    }
  }
  return args;
}

function detectStackCategory(dir) {
  try {
    const pkg = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['@modelcontextprotocol/sdk'] || deps['@anthropic-ai/mcp']) return 'mcp-server';
    if (deps['next'] || deps['react'] || deps['vue'] || deps['nuxt']) return 'ai-web-app';
    if (deps['express'] || deps['fastify'] || deps['hono'] || deps['koa']) return 'api-proxy';
  } catch {}
  return '';
}

async function runAudit(dir, args) {
  if (!existsSync(dir)) {
    console.error(`ERROR: directory not found: ${dir}`);
    process.exit(1);
  }

  const stackCategory = args.stackCategory || detectStackCategory(dir);
  console.error(`[macrc] scanning ${dir}  stack=${stackCategory || '(auto)'}  verified=${args.verified}`);

  const heuristicLayers = runHeuristic(dir, stackCategory, { verified: args.verified });

  // Targeted LLM pass on Tier-1 dims where heuristic says partial or present
  if (args.llm) {
    const llmOpts = { model: args.model };
    for (const [layer, dims] of Object.entries(heuristicLayers)) {
      if (layer === 'secEnhancement') continue;
      for (const [dim, result] of Object.entries(dims)) {
        if (!TIER1_DIMS.has(dim)) continue;
        if (result.state !== 'partial' && result.state !== 'present') continue;
        try {
          console.error(`[macrc] targeted LLM: ${layer}.${dim} (heuristic=${result.state})`);
          const llmResult = await verifyDim(dir, dim, result, llmOpts);
          dims[dim] = llmResult;
        } catch (err) {
          console.error(`[macrc] LLM verification failed for ${dim}: ${err.message}`);
        }
      }
    }
  }

  // Build security layer from heuristic secEnhancement as baseline
  const security = {
    auth:               heuristicLayers.secEnhancement.auth               || { state: 'absent', severity: null, notes: 'no auth signals found', snippets: [] },
    input_validation:   heuristicLayers.secEnhancement.input_validation   || { state: 'absent', severity: null, notes: 'no validation signals found', snippets: [] },
    transport_security: heuristicLayers.secEnhancement.transport_security || { state: 'absent', severity: null, notes: 'no TLS config found', snippets: [] },
    dependency_hygiene: { state: 'pending', severity: null, notes: 'npm audit not run in standalone CLI mode', snippets: [] },
    secrets_management: { state: 'pending', severity: null, notes: 'TruffleHog not run in standalone CLI mode', snippets: [] },
  };

  const layers = {
    security,
    reliability:    heuristicLayers.reliability,
    observability:  heuristicLayers.observability,
    scale_contract: heuristicLayers.scale_contract,
  };

  const summary = computeHeuristicSummary(layers);

  return {
    schema_version: '1.0',
    repo_id:        dir,
    audited_at:     new Date().toISOString().split('T')[0],
    auditor:        args.llm ? 'macrc-two-pass' : 'macrc-heuristic',
    layers,
    summary,
  };
}

function diffAudits(path1, path2) {
  for (const p of [path1, path2]) {
    if (!existsSync(p)) {
      console.error(`ERROR: file not found: ${p}`);
      process.exit(1);
    }
  }
  const a1 = JSON.parse(readFileSync(path1, 'utf8'));
  const a2 = JSON.parse(readFileSync(path2, 'utf8'));

  const rows = [];
  for (const layer of ['security','reliability','observability','scale_contract']) {
    for (const [dim, d1] of Object.entries(a1.layers?.[layer] || {})) {
      const d2 = a2.layers?.[layer]?.[dim];
      if (!d2) continue;
      if (d1.state !== d2.state) {
        rows.push({ layer, dim, before: d1.state, after: d2.state });
      }
    }
  }

  if (rows.length === 0) {
    console.log('No dimension state changes between the two audits.');
    return;
  }

  console.log(`\nDiff: ${path1} → ${path2}\n`);
  for (const r of rows) {
    const arrow = r.before === 'absent' && r.after === 'present' ? '↑ IMPROVED' :
                  r.before === 'present' && r.after === 'absent' ? '↓ REGRESSED' : '→ changed';
    console.log(`  ${arrow}  ${r.layer}.${r.dim}  ${r.before} → ${r.after}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.cmd) { usage(); process.exit(1); }

  if (args.cmd === 'fix') {
    const dir = resolve(args.positional[0] || process.cwd());
    if (!existsSync(dir)) {
      console.error(`ERROR: directory not found: ${dir}`);
      process.exit(1);
    }

    let audit;
    if (args.fromAudit) {
      audit = JSON.parse(readFileSync(resolve(args.fromAudit), 'utf8'));
    } else {
      console.error('[macrc] running audit to build patch list...');
      audit = await runAudit(dir, { ...args, format: 'json' });
    }

    const allPatches = buildPatches(audit, dir);
    const patches = args.dims
      ? allPatches.filter(p => args.dims.has(p._dim))
      : allPatches;

    if (patches.length === 0) {
      console.log('No patches to apply, all Tier-1 dims are present or n/a.');
      return;
    }

    console.error(`[macrc] ${patches.length} patch(es) for dims: ${[...new Set(patches.map(p => p._dim))].join(', ')}`);
    if (args.dryRun) console.error('[macrc] dry-run, no files will be modified\n');

    const report = applyPatches(patches, dir, args.dryRun || false);
    const output = formatPatchReport(report, { color: args.color });

    if (args.out) {
      const outPath = resolve(args.out);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, output + '\n');
      console.error(`[macrc] written to ${args.out}`);
    } else {
      console.log(output);
    }
    return;
  }

  if (args.cmd === 'diff') {
    const [p1, p2] = [args.positional[0] || process.argv[3], args.positional[1] || process.argv[4]];
    if (!p1 || !p2) { console.error('Usage: macrc diff <audit1.json> <audit2.json>'); process.exit(1); }
    diffAudits(p1, p2);
    return;
  }

  if (args.cmd !== 'audit' && args.cmd !== 'gate') {
    console.error(`Unknown command: ${args.cmd}`);
    usage();
    process.exit(1);
  }

  const dir = args.positional[0] || process.cwd();
  const audit = await runAudit(dir, args);

  // Policy check
  const policyDir = args.policyDir || dir;
  const policy    = loadPolicy(policyDir);
  const pr        = applyPolicy(policy, audit.layers);

  // Format output
  let output = '';
  if (args.format === 'json')       output = formatJson(audit);
  else if (args.format === 'sarif') output = formatSarif(audit);
  else                              output = formatTable(audit, { color: args.color });

  if (args.format !== 'json' && args.format !== 'sarif') {
    output += '\n\nPolicy:\n' + formatPolicyReport(pr);
  }

  if (args.out) {
    const outPath = resolve(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, output + '\n');
    console.error(`[macrc] written to ${args.out}`);
  } else {
    console.log(output);
  }

  if (args.cmd === 'gate') {
    // Exit non-zero if any dims are explicitly blocked OR if there are warnings and no .macrc.yml
    // was found (default policy = any absent/partial dim fails the gate)
    const hasBlocks  = !pr.passed;
    const hasWarns   = pr.warnCount > 0;
    const noPolicy   = !loadPolicy(args.policyDir || dir)._hasFile;
    if (hasBlocks || (hasWarns && noPolicy)) {
      const msg = hasBlocks
        ? `gate BLOCKED: policy violations present`
        : `gate FAILED: ${pr.warnCount} absent dim(s) (add .macrc.yml to customise)`;
      console.error(`\n[macrc] ${msg}`);
      process.exit(1);
    }
    console.error('\n[macrc] gate PASSED');
  }
}

main().catch(err => {
  console.error('[macrc] FATAL:', err.message);
  process.exit(1);
});
