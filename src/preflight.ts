/**
 * src/preflight.ts
 *
 * #145 — issues:write preflight check
 * #220 — extended to `pull_request` / `pull_request_target` events
 * #443 — optional Horizon fallback health probe
 *
 * Verifies that the supplied GitHub token has sufficient permission to post
 * issue/PR comments **before** any expensive Horizon calls are made.  Failing
 * fast here gives workflow authors a clear, actionable error instead of a
 * generic GitHub 403 that appears only after Horizon work has completed.
 *
 * ## Preflight sequence
 *
 * 1. **Issue/PR context check** — verify an issue or PR number can be
 *    resolved from the event payload (`payload.issue.number` for `issues`
 *    events, `payload.pull_request.number` for `pull_request`/
 *    `pull_request_target`). Comment posting is only possible in one of
 *    these contexts; `workflow_dispatch` and other events skip comment
 *    posting and therefore skip the preflight.
 * 2. **Permission probe** — call `GET /repos/{owner}/{repo}/issues/{number}/comments`
 *    with `per_page=1`.  A 403/401 response means the token lacks `issues: read`
 *    and certainly cannot write.  This is less aggressive than a dry-run
 *    `createComment` because it is read-only and will not clutter the issue.
 *    A 404 on the issue/PR itself is surfaced separately (closed/deleted).
 *    Note: this probe only proves *read* access — a `pull_request` (not
 *    `pull_request_target`) run on a **fork** PR gets a read-only
 *    `GITHUB_TOKEN` by default, so the probe can pass here and the later
 *    `createComment`/`updateComment` call can still 403. That failure is
 *    caught separately and logged as a non-fatal warning by the caller.
 * 3. **Optional Horizon health probe** (#443) — when enabled, HEAD (falling
 *    back to GET) the Horizon root on both the primary and fallback URLs so
 *    operators discover a bad secondary before a run fails mid-flight.
 *    Soft-warns by default; `horizon_probe_hard_fail: true` turns a failed
 *    probe into a hard failure.
 *
 * ## Failure modes
 *
 * | Situation | Code | `PreflightResult.skip` | Horizon called? |
 * |-----------|------|----------------------|-----------------|
 * | No issue/PR context | — | `true` | Yes (outputs still set) |
 * | Token lacks issues:read/write | 403/401 | `false` | No (run fails) |
 * | Issue/PR not found (404) | 404 | `false` | No (run fails) |
 * | Transient error (5xx) | 5xx | `false` | No (run fails fast) |
 * | Permission check passes | 200 | `false` | Yes |
 *
 * ## Design notes
 *
 * - When there is no issue/PR context the preflight returns `{ skip: true }`
 *   so the caller can proceed without posting a comment (same behaviour as
 *   today for `workflow_dispatch`).
 * - `preflight_only` input: when `true`, the action runs the preflight and
 *   exits immediately without calling Horizon.  Useful for diagnosing
 *   permission issues in new repositories without spending API quota.
 * - The Horizon health probe is opt-in (`horizon_probe: true`) and bounded by
 *   `horizon_probe_timeout_ms` (default 5000ms) per URL.  Worst case it adds
 *   `2 × timeout` to the preflight; keep the budget small on latency-sensitive
 *   workflows.
 */

import * as github from '@actions/github';
import { resolveIssueOrPullRequestNumber } from './comment';

type Octokit = ReturnType<typeof github.getOctokit>;

export interface PreflightResult {
  /**
   * `true` when there is no issue context and comment posting should simply
   * be skipped.  Horizon checks proceed normally; `postIssueComment` will
   * emit its existing "no issue context" warning.
   */
  skip: boolean;
  /** Human-readable summary of the preflight outcome for logging. */
  message: string;
  /** The resolved issue number, populated when `skip` is false. */
  issueNumber?: number;
}

export interface PreflightOptions {
  /**
   * When `true`, verify that an issue or PR context is present *and* that
   * the token has at minimum `issues:read`.  When `false` (an event with no
   * issue/PR context), return `{ skip: true }` immediately.
   */
  requireIssueContext?: boolean;
  /**
   * #443 — when `true`, run the optional Horizon health probe against the
   * primary and fallback URLs.  Defaults to `false` (opt-in).
   */
  horizonProbe?: boolean;
  /** Primary Horizon URL to probe (e.g. `horizon_url`). */
  horizonUrl?: string;
  /** Optional fallback Horizon URL to probe (e.g. `horizon_url_fallback`). */
  horizonUrlFallback?: string;
  /**
   * #443 — when `true`, a failed Horizon probe throws instead of warning.
   * Defaults to `false` (soft-warn).
   */
  horizonProbeHardFail?: boolean;
  /** Per-URL probe timeout in milliseconds.  Defaults to 5000. */
  horizonProbeTimeoutMs?: number;
  /** Injectable fetch for tests.  Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injectable logger for tests.  Defaults to `console.warn`. */
  warn?: (message: string) => void;
}

/**
 * Run the issues:write preflight sequence.
 *
 * @param token   The `github_token` input value (used to build Octokit).
 * @param options Optional flags controlling preflight behaviour.
 * @returns       A `PreflightResult` — inspect `.skip` to decide whether to
 *                skip comment posting, or throw on hard failures.
 *
 * @throws When the token demonstrably lacks the required permission (401/403)
 *         or the issue is not found (404).  Callers should let these propagate
 *         to `core.setFailed`.
 */
export async function runIssuesPreflight(
  token: string,
  options: PreflightOptions = {},
): Promise<PreflightResult> {
  const requireIssueContext = options.requireIssueContext === true;
  const context = github.context;
  const issueNumber = resolveIssueOrPullRequestNumber(context.payload);

  // ── 1. Issue/PR context check ─────────────────────────────────────────────
  if (!issueNumber) {
    if (requireIssueContext) {
      throw new Error(
        'issues:write preflight requires an issue or pull-request context ' +
          '(issues, pull_request, or pull_request_target event) but none was found.',
      );
    }
    return {
      skip: true,
      message:
        'No issue or pull request context found — comment posting will be skipped. ' +
        'This is normal for workflow_dispatch and push events. ' +
        'TrustBridge checks will still run and outputs will be set.',
    };
  }

  // ── 2. Permission probe ───────────────────────────────────────────────────
  const octokit: Octokit = github.getOctokit(token);
  const { owner, repo } = context.repo;

  try {
    await octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 1,
    });
  } catch (error: unknown) {
    const status = extractHttpStatus(error);

    if (status === 401) {
      throw new PreflightError(
        'GitHub token is not authorized (401). ' +
          'Ensure the token is valid and has not expired. ' +
          'For GITHUB_TOKEN, verify the workflow has `permissions: issues: write`.',
        401,
      );
    }

    if (status === 403) {
      const isForkPullRequest =
        context.eventName === 'pull_request' &&
        Boolean(
          (context.payload as { pull_request?: { head?: { repo?: { fork?: boolean } } } })
            .pull_request?.head?.repo?.fork,
        );
      const forkHint = isForkPullRequest
        ? '\n\nThis looks like a `pull_request` run on a fork PR: `GITHUB_TOKEN` is read-only ' +
          'by default in that case, which explains a passing read probe but a failing write. ' +
          'Switch the workflow trigger to `pull_request_target` (with care — see the GitHub docs ' +
          'on the security implications) if you need to comment on fork PRs.'
        : '';
      throw new PreflightError(
        'GitHub token lacks `issues: write` permission (403). ' +
          'Add `permissions: issues: write` to your workflow job, for example:\n\n' +
          '```yaml\npermissions:\n  issues: write\n  contents: read\n```\n\n' +
          'If you are using a PAT, ensure it has the `repo` scope (public repos) ' +
          'or `repo` + `issues` scopes (private repos).' +
          forkHint,
        403,
      );
    }

    if (status === 404) {
      throw new PreflightError(
        `Issue or pull request #${issueNumber} was not found (404). ` +
          'It may have been deleted, or the repository name in the event payload is incorrect.',
        404,
      );
    }

    // Transient / unexpected errors — fail fast rather than proceeding
    const message =
      error instanceof Error ? error.message : String(error);
    throw new PreflightError(
      `issues:write preflight failed with an unexpected error (HTTP ${status ?? 'unknown'}): ${message}. ` +
        'Retry the workflow or check your token permissions.',
      status ?? 0,
    );
  }

  // ── 3. Optional Horizon health probe (#443) ───────────────────────────────
  if (options.horizonProbe === true) {
    await runHorizonHealthProbe(options);
  }

  return {
    skip: false,
    message: `issues:write preflight passed — issue/PR #${issueNumber} is accessible.`,
    issueNumber,
  };
}

// ---------------------------------------------------------------------------
// Horizon health probe (#443)
// ---------------------------------------------------------------------------

/**
 * Probe the Horizon root on the primary and (when set) fallback URLs.
 *
 * Uses `HEAD` first and falls back to `GET` when the server rejects HEAD
 * (some Horizon deployments return 405).  A probe is considered healthy when
 * the response status is `< 400`.
 *
 * By default a failed probe only emits a warning; set
 * `options.horizonProbeHardFail` to throw a `PreflightError` instead.
 */
export async function runHorizonHealthProbe(
  options: PreflightOptions,
): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const timeoutMs = options.horizonProbeTimeoutMs ?? 5000;

  const targets: Array<{ label: string; url: string }> = [];
  if (options.horizonUrl) {
    targets.push({ label: 'primary', url: options.horizonUrl });
  }
  if (options.horizonUrlFallback) {
    targets.push({ label: 'fallback', url: options.horizonUrlFallback });
  }

  for (const target of targets) {
    const result = await probeHorizonUrl(target.url, fetchImpl, timeoutMs);
    if (result.ok) {
      continue;
    }

    const message =
      `Horizon ${target.label} URL health probe failed for ${target.url}: ${result.reason}. ` +
      'The run will continue, but fetch failures may fall back to this URL mid-run.';

    if (options.horizonProbeHardFail === true) {
      throw new PreflightError(message, result.status ?? 0);
    }
    warn(message);
  }
}

interface ProbeResult {
  ok: boolean;
  reason: string;
  status?: number;
}

async function probeHorizonUrl(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<ProbeResult> {
  const head = await fetchWithTimeout(fetchImpl, url, 'HEAD', timeoutMs);
  if (head.ok) {
    return { ok: true, reason: 'ok', status: head.status };
  }

  // Some servers reject HEAD (405/501) — retry with GET before giving up.
  if (head.status === 405 || head.status === 501) {
    const get = await fetchWithTimeout(fetchImpl, url, 'GET', timeoutMs);
    return get.ok
      ? { ok: true, reason: 'ok', status: get.status }
      : { ok: false, reason: get.reason, status: get.status };
  }

  return { ok: false, reason: head.reason, status: head.status };
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  method: 'HEAD' | 'GET',
  timeoutMs: number,
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method,
      signal: controller.signal,
      redirect: 'follow',
    });
    if (response.status < 400) {
      return { ok: true, reason: 'ok', status: response.status };
    }
    return {
      ok: false,
      reason: `HTTP ${response.status}`,
      status: response.status,
    };
  } catch (error: unknown) {
    const reason =
      error instanceof Error && error.name === 'AbortError'
        ? `timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// PreflightError
// ---------------------------------------------------------------------------

/**
 * Thrown by `runIssuesPreflight` when the token is missing permission or the
 * issue context is invalid.  Callers should surface this via `core.setFailed`.
 */
export class PreflightError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = 'PreflightError';
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Best-effort extraction of an HTTP status code from an Octokit error.
 * Returns `undefined` when the error does not carry a numeric `status`.
 */
function extractHttpStatus(error: unknown): number | undefined {
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') {
      return status;
    }
  }
  return undefined;
}
