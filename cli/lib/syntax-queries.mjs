/**
 * Syntax-tree queries for Tier-1 dimensions with high grep false-positive rates.
 *
 * Uses acorn (pure-JS ES2022 parser, no native deps) for JS/TS files.
 * Returns null when the file is not parseable or has no relevant calls —
 * callers should fall back to the grep result in that case.
 *
 * Exported functions:
 *   queryTimeoutHandling(filePath)         → { state, callsFound, callsWithTimeout } | null
 *   queryDistributedAssumptions(filePath)  → { state, hardcodedUrls } | null
 */

import { readFileSync } from 'fs';
import { createRequire } from 'module';

// acorn is a CJS package — load via createRequire
const require = createRequire(import.meta.url);
const { parse } = require('acorn');

const PARSE_OPTS = { ecmaVersion: 2022, sourceType: 'module' };

// ── AST walker — depth-first ───────────────────────────────────────────────────

function walk(node, visit, parent = null) {
  if (!node || typeof node !== 'object' || !node.type) return;
  visit(node, parent);
  for (const key of Object.keys(node)) {
    const child = node[key];
    if (Array.isArray(child)) {
      child.forEach(c => walk(c, visit, node));
    } else if (child && typeof child === 'object' && child.type) {
      walk(child, visit, node);
    }
  }
}

// Return callee name as a string, e.g. "axios.get" or "fetch"
function getCalleeName(callee) {
  if (!callee) return '';
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression') {
    const obj  = getCalleeName(callee.object);
    const prop = callee.computed ? '' : (callee.property?.name ?? '');
    return prop ? `${obj}.${prop}` : obj;
  }
  return '';
}

// Known HTTP client call patterns that accept a config object with timeout/signal
const HTTP_CALLEE_RE = /^(axios\.(get|post|put|delete|patch|request)|fetch)$/;

// Keys that signal timeout configuration in an options object
const TIMEOUT_KEYS = new Set(['timeout', 'signal']);

function hasTimeoutOption(args) {
  return args.some(arg =>
    arg.type === 'ObjectExpression' &&
    arg.properties.some(p => {
      const key = p.key?.name ?? p.key?.value ?? '';
      return TIMEOUT_KEYS.has(key);
    })
  );
}

// ── queryTimeoutHandling ───────────────────────────────────────────────────────

/**
 * Parse a JS/TS file and check whether axios/fetch calls have timeout config.
 *
 * Returns:
 *   null                                     – file not parseable or no HTTP calls found
 *   { state: 'absent',  callsFound, callsWithTimeout }
 *   { state: 'partial', callsFound, callsWithTimeout }
 *   { state: 'present', callsFound, callsWithTimeout }
 */
export function queryTimeoutHandling(filePath) {
  let src;
  try { src = readFileSync(filePath, 'utf8'); } catch { return null; }

  let ast;
  try { ast = parse(src, PARSE_OPTS); } catch {
    // Try script mode as fallback (CJS files)
    try { ast = parse(src, { ...PARSE_OPTS, sourceType: 'script' }); } catch { return null; }
  }

  let callsFound = 0;
  let callsWithTimeout = 0;

  walk(ast, node => {
    if (node.type !== 'CallExpression') return;
    const name = getCalleeName(node.callee);
    if (!HTTP_CALLEE_RE.test(name)) return;
    callsFound++;
    if (hasTimeoutOption(node.arguments)) callsWithTimeout++;
  });

  if (callsFound === 0) return null;
  if (callsWithTimeout === 0) return { state: 'absent',  callsFound, callsWithTimeout };
  if (callsWithTimeout < callsFound) return { state: 'partial', callsFound, callsWithTimeout };
  return { state: 'present', callsFound, callsWithTimeout };
}

// ── queryDistributedAssumptions ────────────────────────────────────────────────

const LOCALHOST_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/;

// Test-block callee names that make a localhost string safe to ignore
const TEST_CALLEE_NAMES = new Set(['describe', 'it', 'test', 'beforeEach', 'afterEach', 'before', 'after', 'beforeAll', 'afterAll']);

/**
 * Parse a JS/TS file and check whether localhost string literals appear
 * as call arguments outside of test blocks.
 *
 * Returns:
 *   null                            – not parseable or no localhost in call args
 *   { state: 'absent', hardcodedUrls }
 */
export function queryDistributedAssumptions(filePath) {
  let src;
  try { src = readFileSync(filePath, 'utf8'); } catch { return null; }

  let ast;
  try { ast = parse(src, PARSE_OPTS); } catch {
    try { ast = parse(src, { ...PARSE_OPTS, sourceType: 'script' }); } catch { return null; }
  }

  // Build parent map so we can walk ancestors
  const parentMap = new Map();
  walk(ast, (node, parent) => { if (parent) parentMap.set(node, parent); });

  function isInsideTestBlock(node) {
    let cur = parentMap.get(node);
    while (cur) {
      if (cur.type === 'CallExpression') {
        const name = getCalleeName(cur.callee);
        if (TEST_CALLEE_NAMES.has(name)) return true;
      }
      cur = parentMap.get(cur);
    }
    return false;
  }

  function isCallArgument(node) {
    const parent = parentMap.get(node);
    if (!parent) return false;
    if (parent.type === 'CallExpression') {
      return parent.arguments.includes(node);
    }
    // Template literal expression inside a call
    if (parent.type === 'TemplateLiteral') {
      const grandparent = parentMap.get(parent);
      if (grandparent?.type === 'CallExpression' && grandparent.arguments.includes(parent)) return true;
    }
    return false;
  }

  const hardcodedUrls = [];

  walk(ast, node => {
    if (node.type !== 'Literal' || typeof node.value !== 'string') return;
    if (!LOCALHOST_RE.test(node.value)) return;
    if (isInsideTestBlock(node)) return;
    if (!isCallArgument(node)) return;
    hardcodedUrls.push(node.value);
  });

  if (hardcodedUrls.length === 0) return null;
  return { state: 'absent', hardcodedUrls };
}
