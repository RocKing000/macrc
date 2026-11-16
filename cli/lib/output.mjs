/**
 * Output formatters: JSON, table, SARIF.
 *
 * Exports: formatJson, formatTable, formatSarif
 */

const STATE_ICON = { present: '✓', partial: '~', absent: '✗', n_a: '—', pending: '?' };
const SEV_COLOR  = { critical: '\x1b[31m', high: '\x1b[33m', medium: '\x1b[36m', low: '\x1b[2m', null: '' };
const RESET      = '\x1b[0m';

export function formatJson(audit, { pretty = true } = {}) {
  return JSON.stringify(audit, null, pretty ? 2 : 0);
}

export function formatTable(audit, { color = true } = {}) {
  const lines = [];
  const repo  = audit.repo_id || '(unknown)';
  const mode  = audit.auditor || '?';
  const date  = audit.audited_at || '';

  lines.push(`\nMARC Audit: ${repo}  [${mode}]  ${date}`);
  lines.push('─'.repeat(70));

  const LAYER_LABEL = { security: 'Security', reliability: 'Reliability', observability: 'Observability', scale_contract: 'Scale Contract' };
  const DIM_ORDER   = {
    security:       ['auth','input_validation','transport_security','dependency_hygiene','secrets_management'],
    reliability:    ['error_handling','retry_logic','circuit_breaking','graceful_degradation','timeout_handling'],
    observability:  ['logging','metrics_emission','tracing','alerting','health_checks'],
    scale_contract: ['statelessness','load_balancing_awareness','distributed_assumptions','rate_limiting','caching_strategy'],
  };

  for (const [layer, dims] of Object.entries(DIM_ORDER)) {
    lines.push(`\n${LAYER_LABEL[layer]}`);
    for (const dim of dims) {
      const d     = audit.layers?.[layer]?.[dim];
      if (!d) continue;
      const icon  = STATE_ICON[d.state] || '?';
      const sev   = d.severity ? ` [${d.severity}]` : '';
      const note  = d.notes ? `  ${d.notes}` : '';
      const c     = color ? (SEV_COLOR[d.severity] || '') : '';
      const r     = color ? RESET : '';
      lines.push(`  ${c}${icon}  ${dim.padEnd(28)}${sev.padEnd(10)}${note}${r}`);
    }
  }

  const s = audit.summary;
  if (s) {
    lines.push('\n' + '─'.repeat(70));
    lines.push(`  ${s.present_count} present  ${s.partial_count} partial  ${s.absent_count} absent  ${s.na_count} n/a  (${s.applicable_dimensions} applicable)`);
    if (s.has_critical_severity) lines.push(`  ⚠  Critical severity dimension(s) present`);
  }

  return lines.join('\n');
}

export function formatSarif(audit) {
  const runs = [{
    tool: {
      driver: {
        name:    'macrc',
        version: '0.1.0',
        rules:   [],
      },
    },
    results: [],
  }];

  const DIM_ORDER = {
    security:       ['auth','input_validation','transport_security','dependency_hygiene','secrets_management'],
    reliability:    ['error_handling','retry_logic','circuit_breaking','graceful_degradation','timeout_handling'],
    observability:  ['logging','metrics_emission','tracing','alerting','health_checks'],
    scale_contract: ['statelessness','load_balancing_awareness','distributed_assumptions','rate_limiting','caching_strategy'],
  };

  const SEV_SARIF = { critical: 'error', high: 'error', medium: 'warning', low: 'note', null: 'note' };

  for (const [layer, dims] of Object.entries(DIM_ORDER)) {
    for (const dim of dims) {
      const d = audit.layers?.[layer]?.[dim];
      if (!d || d.state === 'present' || d.state === 'n_a' || d.state === 'pending') continue;

      const ruleId = `macrc/${layer}/${dim}`;
      runs[0].tool.driver.rules.push({
        id: ruleId,
        name: `${layer}.${dim}`,
        shortDescription: { text: `${layer} / ${dim}` },
        defaultConfiguration: { level: SEV_SARIF[d.severity] || 'warning' },
      });

      runs[0].results.push({
        ruleId,
        level: SEV_SARIF[d.severity] || 'warning',
        message: { text: d.notes || `${dim} is ${d.state}` },
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: audit.repo_id || '.' },
          },
        }],
        properties: { state: d.state, macrc_layer: layer },
      });
    }
  }

  return JSON.stringify({
    version: '2.1.0',
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/Documents/CommitteeSpecifications/2.1.0/sarif-schema-2.1.0.json',
    runs,
  }, null, 2);
}
