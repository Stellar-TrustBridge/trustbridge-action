import * as core from '@actions/core';
import * as github from '@actions/github';
import { writeSummary } from './summary';
import { evaluateMilestoneGate } from './milestone-gate';

async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token', { required: true });
    const octokit = github.getOctokit(token);

    const milestoneGateEnabled = core.getBooleanInput('milestone-gate-enabled');
    const milestoneGateInputs = {
      enabled: milestoneGateEnabled,
      requiredMilestone: core.getInput('milestone-gate-required-milestone'),
      allowOpenIssues: core.getBooleanInput('milestone-gate-allow-open-issues')
    };

    const gateResult = await evaluateMilestoneGate(octokit, github.context, milestoneGateInputs);

    core.setOutput('milestone-gate-passed', gateResult.passed);
    core.setOutput('milestone-gate-reason', gateResult.reason);

    await writeSummary({
      milestoneGate: {
        enabled: milestoneGateInputs.enabled,
        passed: gateResult.passed,
        reason: gateResult.reason
      }
    });

    if (milestoneGateInputs.enabled && !gateResult.passed) {
      core.setFailed(`Milestone gate failed: ${gateResult.reason}`);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

run();
