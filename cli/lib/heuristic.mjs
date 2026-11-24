/**
 * Shared heuristic scan engine, used by both the pipeline (02-static-scan.mjs)
 * and the CLI (macrc audit / macrc gate).
 *
 * Exports: parseDeps, grepSources, scanConfigs, heuristicScore,
 *          computeHeuristicSummary, isNA, NA_BY_CATEGORY,
 *          PENDING_DIM, ABSENT_DIM, NA_DIM
 */

import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { execSync } from 'child_process';
import { grepSourcesVerified } from './context-verifier.mjs';
import { queryTimeoutHandling, queryDistributedAssumptions } from './syntax-queries.mjs';

export const PENDING_DIM = { state: 'pending',  severity: null, notes: '', snippets: [] };
export const ABSENT_DIM  = { state: 'absent',   severity: null, notes: '', snippets: [] };
export const NA_DIM      = { state: 'n_a',      severity: null, notes: 'not applicable for this stack category', snippets: [] };

// ── N/A table ─────────────────────────────────────────────────────────────────
export const NA_BY_CATEGORY = {
  'plugin-extension': new Set(['circuit_breaking','health_checks','metrics_emission','tracing','alerting','statelessness','load_balancing_awareness','distributed_assumptions','payload_size_gate','query_fan_out','isolate_cache_scope','sequential_db_calls']),
  'skills-config':    new Set(['circuit_breaking','health_checks','metrics_emission','tracing','alerting','statelessness','load_balancing_awareness','distributed_assumptions','payload_size_gate','query_fan_out','isolate_cache_scope','sequential_db_calls']),
  'desktop-native':   new Set(['circuit_breaking','health_checks','metrics_emission','tracing','alerting','statelessness','load_balancing_awareness','distributed_assumptions','payload_size_gate','query_fan_out','isolate_cache_scope','sequential_db_calls']),
  'cli-tool':         new Set(['circuit_breaking','health_checks','metrics_emission','tracing','alerting','statelessness','load_balancing_awareness','payload_size_gate','query_fan_out','isolate_cache_scope','sequential_db_calls']),
};

export function isNA(stackCategory, dim) {
  return NA_BY_CATEGORY[stackCategory]?.has(dim) ?? false;
}

// ── Grep patterns ─────────────────────────────────────────────────────────────
export const GREP_PATTERNS = {
  try_catch:           /\btry\s*\{/g,
  dot_catch:           /\.catch\s*\(/g,
  on_error:            /\.on\s*\(\s*['"`]error['"`]/g,
  express_error_mw:    /\(\s*err\s*,\s*req\s*,\s*res\s*,\s*next\s*\)/g,
  py_except:           /\bexcept\s+\w/g,
  go_err_nil:          /\berr\s*!=\s*nil\b/g,
  rust_result:         /\bResult\s*<|\bOption\s*<|\bunwrap\(\)|\.expect\(/g,

  retry_pattern:       /\bretryCount\b|\bmaxRetries\b|\bretries\s*:\s*\d|\bexponential.*backoff/gi,

  circuit_pattern:     /\bCircuitBreaker\b|\bcircuit.*open\b|\bhalfOpen\b/gi,

  fallback_pattern:    /\bfallback\b|\bdegraded\b|\bisAvailable\b/gi,
  feature_flag:        /\bfeatureFlag\b|\bfeature_flag\b|\bisEnabled\s*\(/gi,

  abort_controller:    /\bAbortController\b|\bAbortSignal\.timeout\b/g,
  timeout_config:      /\btimeout\s*:\s*\d+/g,
  py_timeout:          /\btimeout\s*=\s*\d+/g,
  go_timeout:          /\bcontext\.WithTimeout\b|\bcontext\.WithDeadline\b/g,
  rust_timeout:        /\.timeout\s*\(\s*Duration/g,

  console_log:         /\bconsole\.(log|warn|error|debug|info)\s*\(/g,
  logger_structured:   /\blogger\.(info|warn|error|debug|fatal)\s*\(/g,
  py_logging:          /\blogging\.(info|warning|error|debug|critical)\s*\(|\blog\.(info|warning|error|debug)\s*\(/g,
  rust_log:            /\btracing::(info|warn|error|debug)!|\blog::(info|warn|error|debug)!/g,

  counter_gauge:       /\bnew\s+(Counter|Histogram|Gauge|Summary)\s*\(|register\.(metrics|registerMetric)\b|collectDefaultMetrics\s*\(/g,

  otel_span:           /\bstartSpan\s*\(|\btracer\.start\w*\s*\(|\btrace\.getTracer\s*\(/g,

  alerting_pattern:    /[Pp]ager[Dd]uty|[Oo]ps[Gg]enie/g,

  health_route:        /['"`]\/(health|healthz|ping|status)['"`]/g,

  session_middleware:  /\bapp\.use\s*\(\s*session\s*\(|\bsession_start\s*\(|flask\.session\b/g,
  jwt_usage:           /\bjwt\.sign\s*\(|\bjwt\.verify\s*\(|\bverifyToken\s*\(/g,

  // skip test files for this key (enforced in grepSources)
  localhost_hardcoded: /https?:\/\/localhost:\d+|https?:\/\/127\.0\.0\.1/g,
  env_service_url:     /process\.env\.\w+_(URL|HOST|ENDPOINT|BASE)|os\.environ\.get\s*\(\s*['"`]\w+_(URL|HOST|ENDPOINT)/g,

  rate_limit_code:     /\brateLimit\s*\(|\bRateLimiter\b|\brate_limit\b|\blimiter\.(middleware|handle)\b/g,

  cache_ops:           /\bcache\.(get|set|del|mget|mset)\s*\(|\bclient\.(get|set|hget|hset)\s*\(/g,
  lru_cache_py:        /@lru_cache\b|@cache\b|\bfunctools\.(lru_cache|cache)\b/g,
  cache_control:       /Cache-Control|max-age=|s-maxage=/g,

  bearer_auth:         /\bBearer\s+\S|\bAuthorization.*Bearer/gi,
  verify_token:        /\bverifyToken\b|\brequireAuth\b|\bisAuthenticated\b|\b@login_required\b|\bDepends\s*\(\s*get_current_user/g,

  body_size_limit:     /express\.json\s*\(\s*\{[^}]*limit|MAX_CONTENT_LENGTH\s*=|max_body_size\b|maxBodySize\b|req\.headers\[['"`]content-length['"`]\]|\.byteLength\s*>\s*\d/gi,
  promise_all_map:     /Promise\.all\s*\(\s*\w[\w.]*\.map\s*\(/g,
  module_cache_null:   /\blet\s+(?:cache|memo|_cache|_memo)\s*=\s*null\b/g,
  await_db_call:       /\bawait\b[^;\n]{0,100}(?:\.from\s*\(|\.query\s*\(|\.findOne\s*\(|\.find\s*\(|\.execute\s*\()/g,
  promise_all:         /\bPromise\.all\s*\(/g,

  zod_usage:           /\bz\.(string|number|object|array|boolean|enum)\s*\(|\b\.parse\s*\(|\b\.safeParse\s*\(/g,
  joi_usage:           /\bJoi\.(object|string|number|array)\s*\(|\b\.validate\s*\({/g,
  pydantic_usage:      /\bBaseModel\b|\b@validator\b|\b@model_validator\b/g,
  class_validator:     /\b@IsString\b|\b@IsNumber\b|\b@IsEmail\b|\b@IsNotEmpty\b/g,

  tls_code:            /\bhttps\.createServer\b|\btls\.createServer\b|force_https|redirect_to_https/gi,
};

const SOURCE_EXTS_RE = /\.(js|ts|jsx|tsx|mjs|cjs|py|go|rs|rb|java|cs|php)$/;
const TEST_PATH_RE   = /\.(test|spec)\.|__tests__|\/tests?\/|test_[\w]+\.py$|_test\.go$/;

// ── Signal extractors ─────────────────────────────────────────────────────────

export function parseDeps(cloneDir) {
  const deps = new Set();

  try {
    const pkg = JSON.parse(readFileSync(resolve(cloneDir, 'package.json'), 'utf8'));
    for (const d of Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) })) {
      deps.add(d.toLowerCase());
    }
  } catch {}

  try {
    readFileSync(resolve(cloneDir, 'requirements.txt'), 'utf8').split('\n').forEach(l => {
      const n = l.trim().split(/[>=<\[!\s#;]/)[0].trim().toLowerCase();
      if (n && !n.startsWith('#') && n.length > 0) {
        deps.add(n);
        deps.add(n.replace(/-/g, '_'));
      }
    });
  } catch {}

  try {
    readFileSync(resolve(cloneDir, 'pyproject.toml'), 'utf8').split('\n').forEach(l => {
      const m = l.match(/^\s*["']?([\w-]+)["']?\s*[>=]/);
      if (m) { deps.add(m[1].toLowerCase()); deps.add(m[1].toLowerCase().replace(/-/g, '_')); }
    });
  } catch {}

  try {
    readFileSync(resolve(cloneDir, 'Cargo.toml'), 'utf8').split('\n').forEach(l => {
      const m = l.match(/^([\w-]+)\s*=/);
      if (m) deps.add(m[1].toLowerCase());
    });
  } catch {}

  try {
    readFileSync(resolve(cloneDir, 'go.mod'), 'utf8').split('\n').forEach(l => {
      const m = l.match(/^\t([\S]+)\s+v\d/);
      if (m) deps.add(m[1].toLowerCase());
    });
  } catch {}

  return deps;
}

export function grepSources(cloneDir) {
  const H = {};
  let files = [];
  try {
    files = execSync('git ls-files', { cwd: cloneDir, timeout: 10000 })
      .toString().split('\n').filter(f => f && SOURCE_EXTS_RE.test(f));
  } catch { return H; }

  for (const relPath of files.slice(0, 400)) {
    const isTest = TEST_PATH_RE.test(relPath);
    let content = '';
    try { content = readFileSync(resolve(cloneDir, relPath), 'utf8').replace(/\0/g, ''); } catch { continue; }

    for (const [key, pattern] of Object.entries(GREP_PATTERNS)) {
      if (key === 'localhost_hardcoded' && isTest) continue;
      const matches = content.match(pattern);
      if (matches) H[key] = (H[key] || 0) + matches.length;
    }
  }
  return H;
}

export function scanConfigs(cloneDir) {
  function read(filename) {
    const p = resolve(cloneDir, filename);
    return existsSync(p) ? { exists: true, content: readFileSync(p, 'utf8') } : { exists: false, content: '' };
  }
  const cfg = {
    dockerfile:        read('Dockerfile'),
    dockerCompose:     read('docker-compose.yml'),
    dockerComposeYaml: read('docker-compose.yaml'),
    flyToml:           read('fly.toml'),
    nginxConf:         read('nginx.conf'),
    caddyfile:         read('Caddyfile'),
    netlifyToml:       read('netlify.toml'),
    vercelJson:        read('vercel.json'),
    k8sDeployment:     read('deployment.yaml'),
    alertsYml:         read('alerts.yml'),
    alertmanagerYml:   read('alertmanager.yml'),
    alertRulesYml:     read('alert_rules.yml'),
  };
  const composeContent = cfg.dockerCompose.content + cfg.dockerComposeYaml.content;
  cfg.hasHealthcheck     = cfg.dockerfile.exists && /^HEALTHCHECK\s/m.test(cfg.dockerfile.content);
  cfg.hasDockerHealth    = /^\s+healthcheck\s*:/m.test(composeContent);
  cfg.hasK8sHealthcheck  = /livenessProbe|readinessProbe/.test(cfg.k8sDeployment.content);
  cfg.hasReplicas        = /\breplicas\s*:\s*[2-9]\d*/.test(composeContent + cfg.k8sDeployment.content);
  cfg.hasNginxUpstream   = /\bupstream\s+\w+\s*\{/.test(cfg.nginxConf.content);
  cfg.hasNginxRateLimit  = /limit_req/.test(cfg.nginxConf.content);
  cfg.hasTlsConfig       = cfg.flyToml.exists || cfg.vercelJson.exists || cfg.netlifyToml.exists || cfg.caddyfile.exists;
  cfg.hasAlertConfig     = cfg.alertsYml.exists || cfg.alertmanagerYml.exists || cfg.alertRulesYml.exists;
  return cfg;
}

// ── Heuristic dimension scorer ────────────────────────────────────────────────

export function heuristicScore(deps, hits, configs, stackCategory) {
  function h(state, severity, notes) {
    return { state, severity: state === 'present' ? null : severity, notes, snippets: [] };
  }
  function naOr(dimName, fn) {
    return isNA(stackCategory, dimName) ? { ...NA_DIM } : fn();
  }
  function hasDep(...names) { return names.some(n => deps.has(n.toLowerCase())); }

  // ── Security enhancement signals ─────────────────────────────────────────
  const secEnhancement = {};

  const authPkgs = ['passport','jsonwebtoken','next-auth','@clerk/clerk-sdk-node','@supabase/auth-helpers-nextjs','express-jwt','flask_login','flask-jwt-extended','fastapi-users','django.contrib.auth'];
  const authHits = (hits.bearer_auth || 0) + (hits.verify_token || 0);
  if (hasDep(...authPkgs) && authHits > 0) {
    secEnhancement.auth = h('present', null, 'Auth library in deps with token verification patterns');
  } else if (hasDep(...authPkgs) || authHits > 1) {
    secEnhancement.auth = h('partial', 'high', 'Auth signals found but incomplete implementation');
  }

  const valPkgs = ['zod','joi','yup','express-validator','class-validator','ajv','marshmallow','pydantic','cerberus','voluptuous','wtforms'];
  const valHits = (hits.zod_usage || 0) + (hits.joi_usage || 0) + (hits.pydantic_usage || 0) + (hits.class_validator || 0);
  if (hasDep(...valPkgs) && valHits > 0) {
    secEnhancement.input_validation = h('present', null, 'Validation library in deps with active usage found');
  } else if (hasDep(...valPkgs) || valHits > 0) {
    secEnhancement.input_validation = h('partial', 'high', 'Validation signals found but incomplete coverage');
  }

  if ((hits.tls_code || 0) > 0) {
    secEnhancement.transport_security = h('present', null, 'TLS server or force-HTTPS code found');
  } else if (configs.hasTlsConfig) {
    secEnhancement.transport_security = h('partial', null, 'Platform TLS config found (fly.toml/vercel.json/netlify.toml)');
  }

  if (!isNA(stackCategory, 'payload_size_gate')) {
    if ((hits.body_size_limit || 0) > 0) {
      secEnhancement.payload_size_gate = h('present', null, 'Body size limit or content-length guard found');
    } else {
      secEnhancement.payload_size_gate = h('absent', 'medium', 'No body size limit before deserialization; oversized payloads are unguarded');
    }
  }

  // ── Reliability ───────────────────────────────────────────────────────────
  const totalErrHits = (hits.try_catch || 0) + (hits.dot_catch || 0) + (hits.on_error || 0) +
                       (hits.py_except || 0) + (hits.go_err_nil || 0) + (hits.rust_result || 0);
  const hasGlobalHandler = (hits.express_error_mw || 0) > 0;
  const retryPkgs = ['axios-retry','p-retry','retry','@lifeomic/attempt','cockatiel','tenacity','backoff','stamina','retrying'];
  const cbPkgs    = ['opossum','brakes','pycircuitbreaker','circuitbreaker','gobreaker'];
  const timeoutHits = (hits.abort_controller || 0) + (hits.timeout_config || 0) + (hits.py_timeout || 0) +
                      (hits.go_timeout || 0) + (hits.rust_timeout || 0);

  const reliability = {
    error_handling: (() => {
      if (totalErrHits >= 5 && hasGlobalHandler) return h('present', null, `${totalErrHits} error handling instances with global handler`);
      if (totalErrHits >= 2) return h('partial', 'high', `${totalErrHits} error handling instances but no global handler`);
      return h('absent', 'critical', 'No error handling patterns found');
    })(),
    retry_logic: (() => {
      if (hasDep(...retryPkgs)) return h('present', null, 'Retry library in dependencies');
      if ((hits.retry_pattern || 0) > 0) return h('partial', 'high', 'Manual retry pattern in code, no retry library');
      return h('absent', 'high', 'No retry logic found');
    })(),
    circuit_breaking: naOr('circuit_breaking', () => {
      if (hasDep(...cbPkgs)) return h('present', null, 'Circuit breaker library in dependencies');
      if ((hits.circuit_pattern || 0) > 0) return h('partial', 'high', 'Circuit breaker pattern in code, no library');
      return h('absent', 'high', 'No circuit breaker found');
    }),
    graceful_degradation: (() => {
      const signals = (hits.fallback_pattern || 0) + (hits.feature_flag || 0);
      if (signals >= 2) return h('partial', 'medium', `${signals} fallback/feature-flag patterns found`);
      return h('absent', 'medium', 'No graceful degradation patterns found');
    })(),
    timeout_handling: (() => {
      if (timeoutHits >= 2) return h('present', null, `Timeout patterns on ${timeoutHits} call sites`);
      if (timeoutHits === 1) return h('partial', 'high', 'Timeout found in 1 place, not systematic');
      return h('absent', 'high', 'No timeout handling found');
    })(),
    sequential_db_calls: naOr('sequential_db_calls', () => {
      const dbCalls    = hits.await_db_call || 0;
      const hasAllMap  = (hits.promise_all_map || 0) + (hits.promise_all || 0);
      if (dbCalls === 0) return { ...NA_DIM, notes: 'No DB await calls detected' };
      if (dbCalls >= 3 && hasAllMap === 0) return h('absent', 'medium', `${dbCalls} sequential DB awaits with no Promise.all coalescing found`);
      if (dbCalls >= 3 && hasAllMap > 0)  return h('partial', 'low',    `${dbCalls} DB awaits with some Promise.all usage; verify hot-path calls are parallel`);
      return h('present', null, 'DB call count is low or Promise.all coalescing is present');
    }),
  };

  // ── Observability ─────────────────────────────────────────────────────────
  const logStructPkgs = ['winston','pino','bunyan','morgan','log4js','tslog','structlog','loguru','logrus','zap','slog'];
  const metricsPkgs   = ['prom-client','dd-trace','newrelic','hot-shots','prometheus_client','statsd','@opentelemetry/sdk-node','datadog-lambda'];
  const tracingPkgs   = ['@opentelemetry/api','@opentelemetry/sdk-node','dd-trace','jaeger-client','zipkin','opentelemetry_api','opentelemetry_sdk','opentelemetry-api','opentelemetry-sdk'];
  const alertingPkgs  = ['@pagerduty/pdjs','node-pagerduty','pdpyras','opsgenie-sdk'];
  const structuredLogHits = (hits.logger_structured || 0) + (hits.py_logging || 0) + (hits.rust_log || 0);

  const observability = {
    logging: (() => {
      if ((hasDep(...logStructPkgs) || structuredLogHits > 0) && structuredLogHits > 0) return h('present', null, 'Structured logging library/logger in use');
      if (hasDep(...logStructPkgs)) return h('partial', null, 'Structured logging library in deps, usage not confirmed');
      if ((hits.console_log || 0) > 0) return h('partial', 'high', `Only console.log statements (${hits.console_log} instances)`);
      return h('absent', 'high', 'No logging found');
    })(),
    metrics_emission: naOr('metrics_emission', () => {
      if (hasDep(...metricsPkgs) && (hits.counter_gauge || 0) > 0) return h('present', null, 'Metrics library with metric definitions found');
      if (hasDep(...metricsPkgs)) return h('partial', 'medium', 'Metrics library in deps but no metric definitions found');
      return h('absent', 'medium', 'No metrics emission found');
    }),
    tracing: naOr('tracing', () => {
      // No outbound HTTP client = single-process app; tracing is structurally N/A
      const httpClientPkgs = ['axios','node-fetch','got','undici','superagent','ky',
                              'requests','httpx','aiohttp','urllib3',
                              '@grpc/grpc-js','grpcio','grpc'];
      if (!hasDep(...httpClientPkgs)) {
        return { ...NA_DIM, notes: 'No outbound HTTP/RPC client found — single-process, tracing N/A' };
      }
      if (hasDep(...tracingPkgs) && (hits.otel_span || 0) > 0) return h('present', null, 'Tracing library with span creation found');
      if (hasDep(...tracingPkgs)) return h('partial', 'medium', 'Tracing library in deps but no spans found');
      return h('absent', 'medium', 'No distributed tracing found');
    }),
    alerting: naOr('alerting', () => {
      if (hasDep(...alertingPkgs)) return h('present', null, 'Alerting library in dependencies');
      if (configs.hasAlertConfig) return h('partial', 'medium', 'Alert config file found');
      if ((hits.alerting_pattern || 0) > 0) return h('partial', 'medium', 'PagerDuty/OpsGenie pattern in code');
      return h('absent', 'medium', 'No alerting found');
    }),
    health_checks: naOr('health_checks', () => {
      const hasEndpoint = (hits.health_route || 0) > 0;
      const hasConfig   = configs.hasHealthcheck || configs.hasDockerHealth || configs.hasK8sHealthcheck;
      if (hasEndpoint || hasConfig) return h('present', null, 'Health endpoint or health check config found');
      return h('absent', 'medium', 'No health check endpoint or config found');
    }),
  };

  // ── Scale Contract ────────────────────────────────────────────────────────
  const rlPkgs    = ['express-rate-limit','rate-limiter-flexible','bottleneck','slow-down','limiter','slowapi','flask-limiter','limits','aiohttp-ratelimit','throttle'];
  const redisPkgs = ['ioredis','redis','memcached','aiocache','diskcache','go-cache','ristretto'];
  const inMemPkgs = ['lru-cache','node-cache','cache-manager','cachetools'];
  const cacheHits = (hits.cache_ops || 0) + (hits.lru_cache_py || 0) + (hits.cache_control || 0);

  const scale_contract = {
    statelessness: naOr('statelessness', () => {
      const hasSessionPkg  = hasDep('express-session', 'cookie-session');
      const hasSessionCode = (hits.session_middleware || 0) > 0;
      const hasRedis       = hasDep('connect-redis', 'ioredis', 'redis');
      const hasJwt         = hasDep('jsonwebtoken') || (hits.jwt_usage || 0) > 0;
      if ((hasSessionPkg || hasSessionCode) && hasRedis) return h('partial', 'high', 'Session middleware with external Redis store (mitigated)');
      if (hasSessionPkg || hasSessionCode) return h('absent', 'high', 'Session middleware with in-process store, stateful');
      if (hasJwt) return h('present', null, 'JWT auth, no session middleware, stateless');
      return h('present', null, 'No session middleware found, assumed stateless');
    }),
    load_balancing_awareness: naOr('load_balancing_awareness', () => {
      const hasHealthEndpoint = (hits.health_route || 0) > 0 || configs.hasHealthcheck;
      if ((configs.hasReplicas || configs.hasNginxUpstream) && hasHealthEndpoint) return h('present', null, 'Multi-replica config and health endpoint found');
      if (hasHealthEndpoint) return h('partial', 'medium', 'Health endpoint present but no multi-replica deployment config');
      return h('absent', 'medium', 'No load balancer awareness found');
    }),
    distributed_assumptions: naOr('distributed_assumptions', () => {
      const hardcoded = (hits.localhost_hardcoded || 0);
      const envUrls   = (hits.env_service_url || 0);
      if (hardcoded === 0 && envUrls > 0) return h('present', null, 'Service URLs via env vars, no hardcoded localhost');
      if (hardcoded > 0 && envUrls > 0) return h('partial', 'high', `Mix of env vars and ${hardcoded} hardcoded localhost URL(s)`);
      if (hardcoded > 0) return h('absent', 'high', `${hardcoded} hardcoded localhost service URL(s) in production code`);
      return h('present', null, 'No hardcoded service URLs detected');
    }),
    rate_limiting: (() => {
      if (hasDep(...rlPkgs) && (hits.rate_limit_code || 0) > 0) return h('present', null, 'Rate limiting library applied to routes');
      if (configs.hasNginxRateLimit) return h('present', null, 'Nginx rate limiting configured');
      if (hasDep(...rlPkgs)) return h('partial', 'high', 'Rate limiting library in deps but not wired to routes');
      if ((hits.rate_limit_code || 0) > 0) return h('partial', 'high', 'Rate limiting pattern in code, no library');
      return h('absent', 'high', 'No rate limiting found');
    })(),
    caching_strategy: (() => {
      if (hasDep(...redisPkgs) && (hits.cache_ops || 0) > 0) return h('present', null, 'Distributed cache (Redis/Memcached) with cache operations found');
      if (hasDep(...inMemPkgs) || (hits.lru_cache_py || 0) > 0) return h('partial', 'low', 'In-memory/LRU cache only (single-node)');
      if (cacheHits > 0) return h('partial', 'low', 'Cache operations or HTTP cache headers found');
      return h('absent', 'low', 'No caching strategy found');
    })(),
    query_fan_out: naOr('query_fan_out', () => {
      const fanOut = hits.promise_all_map || 0;
      const dbCalls = hits.await_db_call || 0;
      if (fanOut === 0 && dbCalls === 0) return { ...NA_DIM, notes: 'No DB calls detected' };
      if (fanOut > 0 && dbCalls === 0)   return h('present', null, 'Promise.all fan-out with no sequential DB calls found');
      if (fanOut > 0)                    return h('partial', 'low',    `Promise.all fan-out present but ${dbCalls} DB await(s) also found; verify none fan out proportionally to a list`);
      return h('absent', 'medium', `${dbCalls} DB await(s) with no Promise.all fan-out; N-query expansion is likely if any loop iterates over a dynamic list`);
    }),
    isolate_cache_scope: naOr('isolate_cache_scope', () => {
      const moduleCacheVars = hits.module_cache_null || 0;
      const hasDistributed  = hasDep(...redisPkgs) && (hits.cache_ops || 0) > 0;
      if (moduleCacheVars === 0) return h('present', null, 'No module-level cache variables detected');
      if (hasDistributed)        return h('partial', 'low',    `${moduleCacheVars} module-level cache var(s) found but distributed cache also present; verify hot data is not isolate-scoped only`);
      return h('absent', 'medium', `${moduleCacheVars} module-level cache var(s) reset on every cold start; under concurrent cold starts each isolate hits the upstream independently`);
    }),
  };

  return { secEnhancement, reliability, observability, scale_contract };
}

export function computeHeuristicSummary(layers) {
  let absent = 0, partial = 0, present = 0, na_count = 0;
  const absentByLayer = { security: 0, reliability: 0, observability: 0, scale_contract: 0 };
  let hasCritical = false;

  for (const [layer, dims] of Object.entries(layers)) {
    for (const dim of Object.values(dims)) {
      if (dim.state === 'n_a') { na_count++; continue; }
      if (dim.state === 'absent')       { absent++; absentByLayer[layer]++; }
      else if (dim.state === 'partial') { partial++; }
      else if (dim.state === 'present') { present++; }
      if (dim.severity === 'critical')  { hasCritical = true; }
    }
  }

  const applicable = absent + partial + present;
  return {
    total_dimensions: 24,
    applicable_dimensions: applicable,
    na_count,
    absent_count: absent,
    partial_count: partial,
    present_count: present,
    absent_by_layer: absentByLayer,
    has_critical_severity: hasCritical,
  };
}

/**
 * Run the full heuristic scan on a local directory and return structured results.
 * stackCategory: one of ai-web-app, api-proxy, mcp-server, agent-framework,
 *               cli-tool, desktop-native, plugin-extension, skills-config, or ''
 */
const JS_TS_RE = /\.(js|ts|mjs|cjs|jsx|tsx)$/;

export function runHeuristic(cloneDir, stackCategory = '', { verified = true } = {}) {
  const deps    = parseDeps(cloneDir);
  // verified=true uses context-window analysis for HIGH-FP patterns,
  // reducing false positives on import-only checks (zod/pydantic/bearer_auth etc.)
  const hits    = verified
    ? grepSourcesVerified(cloneDir, GREP_PATTERNS)
    : grepSources(cloneDir);
  const configs = scanConfigs(cloneDir);
  const layers  = heuristicScore(deps, hits, configs, stackCategory);

  // AST refinement: run acorn syntax queries on JS/TS files for the two
  // dimensions with the largest verified-heuristic gap (+52pp / +20pp).
  // Only runs when verified=true; replaces the grep result when non-null.
  if (verified) {
    let sourceFiles = [];
    try {
      sourceFiles = execSync('git ls-files', { cwd: cloneDir, timeout: 10000 })
        .toString().split('\n')
        .filter(f => f && JS_TS_RE.test(f))
        .map(f => resolve(cloneDir, f));
    } catch {}

    // timeout_handling — merge per-file AST results
    const timeoutResults = sourceFiles.map(f => queryTimeoutHandling(f)).filter(Boolean);
    if (timeoutResults.length > 0) {
      const totalCalls   = timeoutResults.reduce((s, r) => s + r.callsFound, 0);
      const timedOutCalls = timeoutResults.reduce((s, r) => s + r.callsWithTimeout, 0);
      if (timedOutCalls === 0) {
        layers.reliability.timeout_handling = { state: 'absent',  severity: 'high',   notes: `AST: ${totalCalls} HTTP call(s) with no timeout config`, snippets: [] };
      } else if (timedOutCalls < totalCalls) {
        layers.reliability.timeout_handling = { state: 'partial', severity: 'high',   notes: `AST: ${timedOutCalls}/${totalCalls} HTTP calls have timeout config`, snippets: [] };
      } else {
        layers.reliability.timeout_handling = { state: 'present', severity: null,     notes: `AST: all ${totalCalls} HTTP call(s) have timeout config`, snippets: [] };
      }
    }

    // distributed_assumptions — absent if any file has hardcoded localhost in a call arg
    if (!isNA(stackCategory, 'distributed_assumptions')) {
      const distResults = sourceFiles.map(f => queryDistributedAssumptions(f)).filter(Boolean);
      if (distResults.length > 0) {
        const urls = distResults.flatMap(r => r.hardcodedUrls);
        layers.scale_contract.distributed_assumptions = {
          state: 'absent', severity: 'high',
          notes: `AST: hardcoded localhost URL(s) in call arguments: ${[...new Set(urls)].slice(0, 3).join(', ')}`,
          snippets: [],
        };
      }
    }
  }

  return layers;
}
