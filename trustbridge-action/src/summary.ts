import * as core from '@actions/core';
import { MilestoneGateResult } from './milestone-gate';

/**
 * Render the milestone-gate section of the job summary.
 *
 * Shows pass/fail and the reason so a stopped run is explainable from the
 * GitHub job summary alone.
 */
export function renderMilestoneGateSummary(gate: MilestoneGateResult): string {
  const status = gate.passed ? '✅ Passed' : '❌ Failed';
  const lines = [
    '## Milestone Gate',
    '',
    `**Status:** ${status}`,
    '',
    `**Reason:** ${gate.reason}`
  ];

  if (gate.milestone) {
    lines.push('', `**Milestone:** ${gate.milestone}`);
  }

  return lines.join('\n');
}

/**
 * Append the milestone-gate status to the GitHub job summary.
 */
export async function writeMilestoneGateSummary(gate: MilestoneGateResult): Promise<void> {
  await core.summary.addRaw(renderMilestoneGateSummary(gate)).write();
}
