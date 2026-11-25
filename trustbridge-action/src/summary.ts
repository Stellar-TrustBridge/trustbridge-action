import { Finding } from './types';

export interface TaxonomyCount {
  taxonomy: string;
  count: number;
}

export interface BatchSummary {
  total: number;
  bySeverity: Record<string, number>;
  byTaxonomy: TaxonomyCount[];
  taxonomyTotal: number;
}

/**
 * Build a summary of batch findings, including taxonomy rollups.
 * Empty batches still produce a valid summary with zeroed totals.
 */
export function summarizeBatch(findings: Finding[]): BatchSummary {
  const bySeverity: Record<string, number> = {};
  const taxonomyCounts = new Map<string, number>();

  for (const finding of findings) {
    const severity = finding.severity ?? 'unknown';
    bySeverity[severity] = (bySeverity[severity] ?? 0) + 1;

    const taxonomy = finding.taxonomy ?? 'unclassified';
    taxonomyCounts.set(taxonomy, (taxonomyCounts.get(taxonomy) ?? 0) + 1);
  }

  const byTaxonomy: TaxonomyCount[] = Array.from(taxonomyCounts.entries())
    .map(([taxonomy, count]) => ({ taxonomy, count }))
    .sort((a, b) => b.count - a.count || a.taxonomy.localeCompare(b.taxonomy));

  const taxonomyTotal = byTaxonomy.reduce((sum, entry) => sum + entry.count, 0);

  return {
    total: findings.length,
    bySeverity,
    byTaxonomy,
    taxonomyTotal,
  };
}

/**
 * Render a batch summary as human-readable job output lines.
 */
export function formatBatchSummary(summary: BatchSummary): string {
  const lines: string[] = [];
  lines.push(`Total findings: ${summary.total}`);

  const severities = Object.keys(summary.bySeverity).sort();
  if (severities.length > 0) {
    lines.push('By severity:');
    for (const severity of severities) {
      lines.push(`  ${severity}: ${summary.bySeverity[severity]}`);
    }
  }

  lines.push(`Taxonomy total: ${summary.taxonomyTotal}`);
  if (summary.byTaxonomy.length > 0) {
    lines.push('By taxonomy:');
    for (const entry of summary.byTaxonomy) {
      lines.push(`  ${entry.taxonomy}: ${entry.count}`);
    }
  }

  return lines.join('\n');
}
