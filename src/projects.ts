import * as core from '@actions/core';
import { logger } from './logger';

// ---------------------------------------------------------------------------
// Multi-repo allowlist matching for org-wide Wave runs (Issue #855)
//
// A reusable workflow invoked org-wide (`workflow_call` from every repo in an
// org) needs to decide, from the calling repository's `owner/repo` string
// alone, whether that repo is actually in scope for Wave automation. This is
// a pure string-matching decision — it does not call the GitHub API and does
// not know about renames or archival status beyond what `owner/repo` itself
// encodes (see `matchesRepoAllowlist`'s docstring for exactly what that does
// and does not cover).
// ---------------------------------------------------------------------------

/** One allowlist entry as configured by an operator (see {@link matchesRepoAllowlist}). */
export type RepoAllowlistPattern = string;

/** Why a pattern was never considered during matching. */
export type RejectedRepoAllowlistPatternReason =
  | 'empty'
  | 'ambiguous_glob'
  | 'multiple_slashes';

/** A configured pattern that was excluded from matching, and why. */
export interface RejectedRepoAllowlistPattern {
  pattern: RepoAllowlistPattern;
  reason: RejectedRepoAllowlistPatternReason;
}

export interface RepoAllowlistMatchResult {
  /** True when `repository` is covered by at least one valid pattern. */
  allowed: boolean;
  /** Human-readable, stable explanation — safe to log or surface in a dry-run message. */
  reason: string;
  /** The pattern that matched, when `allowed` is true. */
  matchedPattern?: RepoAllowlistPattern;
  /**
   * Configured patterns that were never evaluated because they look like an
   * ambiguous glob or are otherwise malformed. Fail-closed: a rejected
   * pattern can never grant access, even accidentally.
   */
  rejectedPatterns: RejectedRepoAllowlistPattern[];
}

const VALID_OWNER_REPO_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Classify why a configured pattern is not safe to match against, or `null`
 * when it is a well-formed `owner` or `owner/repo` (optionally `owner/*`)
 * pattern.
 *
 * Deliberately conservative: the only wildcard this accepts is a literal
 * `*` as the entire `repo` segment (`owner/*`), meaning "every repository
 * in this org". Anything else containing `*`, `?`, `**`, or more than one
 * `/` is rejected as an "ambiguous glob that could over-match" — exactly
 * the risk the issue calls out (an org-wide automation run must never
 * accidentally widen to arbitrary forks or unrelated repos because a glob
 * matched more than the operator intended).
 */
function classifyInvalidRepoAllowlistPattern(
  pattern: RepoAllowlistPattern,
): RejectedRepoAllowlistPatternReason | null {
  const trimmed = pattern.trim();
  if (!trimmed) return 'empty';

  const segments = trimmed.split('/');
  if (segments.length > 2) return 'multiple_slashes';

  if (segments.length === 1) {
    // Bare org pattern, e.g. "Stellar-TrustBridge" — no wildcard characters allowed.
    return VALID_OWNER_REPO_SEGMENT.test(segments[0]) ? null : 'ambiguous_glob';
  }

  const [owner, repo] = segments;
  if (!VALID_OWNER_REPO_SEGMENT.test(owner)) return 'ambiguous_glob';
  if (repo === '*') return null; // "owner/*" — every repo in that org.
  return VALID_OWNER_REPO_SEGMENT.test(repo) ? null : 'ambiguous_glob';
}

/**
 * Decide whether `repository` (a `"owner/repo"` string, as reported by
 * `github.context.repo` / `${{ github.repository }}`) is covered by
 * `patterns`.
 *
 * Supported pattern forms (one per allowlist entry):
 * - `"owner/repo"` — exact match.
 * - `"owner"` or `"owner/*"` — matches every repository under that org.
 *
 * Matching is **case-insensitive** on both the owner and repo segments
 * (GitHub treats `owner/repo` names as case-insensitive for routing), and
 * leading/trailing whitespace on each configured pattern is ignored.
 *
 * **Fail-closed design** (Issue #855 — "must not validate arbitrary forks
 * or unrelated private repos"):
 * - An **empty allowlist denies every repository**. This is the opposite of
 *   `filterRosterAddressMap`'s "empty allowlist means allow all" — that
 *   function is a defense-in-depth filter layered on an already-trusted
 *   roster, while this function is the *primary* boundary deciding whether
 *   org-wide automation may touch a repository at all. An operator who
 *   wants "allow everything" must say so explicitly (e.g. `"owner/*"` per
 *   org, or `"*"` is intentionally NOT a supported shortcut — see below).
 * - A pattern this function cannot interpret safely (see
 *   `classifyInvalidRepoAllowlistPattern`) is collected into
 *   `rejectedPatterns` and never matches — a malformed or overly broad
 *   pattern can only ever narrow access, never accidentally widen it.
 * - `repository` itself must be an exact `"owner/repo"` string; anything
 *   else (missing slash, extra slash, empty) never matches any pattern.
 *
 * **What this function does not do** (by design — it is a pure string
 * match, not a GitHub API call): it has no way to detect that a repository
 * was renamed (an allowlist entry for the old name simply fails closed,
 * exactly like any other non-matching name — there is no fuzzy or
 * historical matching) or that a repository is archived (archival status
 * is not encoded in `owner/repo`; a caller that needs to exclude archived
 * repos must check `github.context.payload.repository.archived` itself
 * before or after calling this function).
 */
export function matchesRepoAllowlist(
  repository: string,
  patterns: readonly RepoAllowlistPattern[],
): RepoAllowlistMatchResult {
  const rejectedPatterns: RejectedRepoAllowlistPattern[] = [];
  const validPatterns: RepoAllowlistPattern[] = [];

  for (const pattern of patterns) {
    const rejection = classifyInvalidRepoAllowlistPattern(pattern);
    if (rejection) {
      rejectedPatterns.push({ pattern, reason: rejection });
    } else {
      validPatterns.push(pattern.trim());
    }
  }

  if (validPatterns.length === 0) {
    return {
      allowed: false,
      reason: 'Repository allowlist is empty (or every configured pattern was rejected as invalid) — denying by default.',
      rejectedPatterns,
    };
  }

  const repoSegments = repository.trim().split('/');
  if (repoSegments.length !== 2 || !repoSegments[0] || !repoSegments[1]) {
    return {
      allowed: false,
      reason: `"${repository}" is not a well-formed "owner/repo" string.`,
      rejectedPatterns,
    };
  }
  const [repoOwner, repoName] = repoSegments.map((s) => s.toLowerCase());

  for (const pattern of validPatterns) {
    const segments = pattern.split('/');
    const patternOwner = segments[0].toLowerCase();
    if (patternOwner !== repoOwner) continue;

    if (segments.length === 1 || segments[1] === '*') {
      return {
        allowed: true,
        reason: `Matched org-wide pattern "${pattern}".`,
        matchedPattern: pattern,
        rejectedPatterns,
      };
    }

    if (segments[1].toLowerCase() === repoName) {
      return {
        allowed: true,
        reason: `Matched exact pattern "${pattern}".`,
        matchedPattern: pattern,
        rejectedPatterns,
      };
    }
  }

  return {
    allowed: false,
    reason: `"${repository}" does not match any of ${validPatterns.length} configured allowlist pattern(s).`,
    rejectedPatterns,
  };
}

export interface ProjectV2FieldOption {
  id: string;
  name: string;
}

export interface ProjectV2Field {
  id: string;
  name: string;
  options?: ProjectV2FieldOption[];
}

export interface ProjectV2Node {
  id: string;
  fields?: {
    nodes: ProjectV2Field[];
  };
}

export interface UpdateProjectV2StatusOptions {
  octokit: { graphql: <T = unknown>(query: string, parameters?: Record<string, unknown>) => Promise<T> };
  projectId: string;
  contentNodeId: string;
  statusFieldName?: string;
  targetStatusValue: string;
}

export interface UpdateProjectV2Result {
  updated: boolean;
  itemId?: string;
  error?: string;
}

/**
 * Update the status field of an item in a GitHub Projects v2 board.
 *
 * Opt-in only: when projectId or targetStatusValue is empty, does nothing.
 * Automatically adds the issue/PR to the project if not already present (idempotent).
 * Handles missing token scopes or rate limits with descriptive warnings without failing the workflow.
 */
export async function updateProjectV2Status(
  options: UpdateProjectV2StatusOptions,
): Promise<UpdateProjectV2Result> {
  const { octokit, projectId, contentNodeId, targetStatusValue } = options;
  const statusFieldName = (options.statusFieldName || 'Status').trim();

  if (!projectId || !projectId.trim()) {
    return { updated: false };
  }

  if (!targetStatusValue || !targetStatusValue.trim()) {
    return { updated: false };
  }

  if (!contentNodeId || !contentNodeId.trim()) {
    core.warning('[Projects v2] Cannot update project item status: contentNodeId is missing.');
    return { updated: false, error: 'Missing contentNodeId' };
  }

  const cleanProjectId = projectId.trim();
  const cleanTargetValue = targetStatusValue.trim();

  try {
    // 1. Fetch project fields
    const fieldsQuery = `
      query getProjectFields($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            id
            fields(first: 50) {
              nodes {
                ... on ProjectV2SingleSelectField {
                  id
                  name
                  options {
                    id
                    name
                  }
                }
                ... on ProjectV2Field {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `;

    const projectResponse = await octokit.graphql<{ node?: ProjectV2Node }>(fieldsQuery, {
      projectId: cleanProjectId,
    });

    const projectNode = projectResponse?.node;
    if (!projectNode || !projectNode.fields?.nodes) {
      const msg = `Project v2 with ID "${cleanProjectId}" not found or lacks readable fields. Check token scope and project_id.`;
      core.warning(`[Projects v2] ${msg}`);
      return { updated: false, error: msg };
    }

    const fieldNodes = projectNode.fields.nodes;
    const targetField = fieldNodes.find(
      (f) => f.name.trim().toLowerCase() === statusFieldName.toLowerCase(),
    );

    if (!targetField) {
      const availableFields = fieldNodes.map((f) => `"${f.name}"`).join(', ');
      const msg = `Status field "${statusFieldName}" not found in Project v2. Available fields: ${availableFields}`;
      core.warning(`[Projects v2] ${msg}`);
      return { updated: false, error: msg };
    }

    // 2. Add or find item in project (idempotent)
    const addItemMutation = `
      mutation addProjectItem($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
          item {
            id
          }
        }
      }
    `;

    const addResponse = await octokit.graphql<{
      addProjectV2ItemById?: { item?: { id: string } };
    }>(addItemMutation, {
      projectId: cleanProjectId,
      contentId: contentNodeId,
    });

    const itemId = addResponse?.addProjectV2ItemById?.item?.id;
    if (!itemId) {
      const msg = `Could not add or locate content ${contentNodeId} in Project v2.`;
      core.warning(`[Projects v2] ${msg}`);
      return { updated: false, error: msg };
    }

    // 3. Update field value
    if (targetField.options && targetField.options.length > 0) {
      // Single-select field
      const matchingOption = targetField.options.find(
        (opt) => opt.name.trim().toLowerCase() === cleanTargetValue.toLowerCase(),
      );

      if (!matchingOption) {
        const availableOptions = targetField.options.map((opt) => `"${opt.name}"`).join(', ');
        const msg = `Option "${cleanTargetValue}" not found for single-select field "${targetField.name}". Available options: ${availableOptions}`;
        core.warning(`[Projects v2] ${msg}`);
        return { updated: false, error: msg };
      }

      const updateMutation = `
        mutation updateSingleSelectValue($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: {
              singleSelectOptionId: $optionId
            }
          }) {
            projectV2Item {
              id
            }
          }
        }
      `;

      await octokit.graphql(updateMutation, {
        projectId: cleanProjectId,
        itemId,
        fieldId: targetField.id,
        optionId: matchingOption.id,
      });
    } else {
      // Text field
      const updateMutation = `
        mutation updateTextValue($projectId: ID!, $itemId: ID!, $fieldId: ID!, $text: String!) {
          updateProjectV2ItemFieldValue(input: {
            projectId: $projectId
            itemId: $itemId
            fieldId: $fieldId
            value: {
              text: $text
            }
          }) {
            projectV2Item {
              id
            }
          }
        }
      `;

      await octokit.graphql(updateMutation, {
        projectId: cleanProjectId,
        itemId,
        fieldId: targetField.id,
        text: cleanTargetValue,
      });
    }

    core.info(
      `[Projects v2] Updated item ${itemId} field "${targetField.name}" to "${cleanTargetValue}" in project ${cleanProjectId}.`,
    );
    return { updated: true, itemId };
  } catch (error) {
    const rawMsg = error instanceof Error ? error.message : String(error);
    let userMsg = rawMsg;
    if (
      rawMsg.includes('Resource not accessible') ||
      rawMsg.includes('FORBIDDEN') ||
      rawMsg.includes('scope') ||
      rawMsg.includes('Could not resolve to a node')
    ) {
      userMsg = `${rawMsg}. Ensure the token has the 'project' scope (or write:org / fine-grained Projects read & write permissions).`;
    }
    logger.warn(`Projects v2 status update error: ${userMsg}`, { component: 'projects' });
    core.warning(`[Projects v2] Failed to update project status (non-fatal): ${userMsg}`);
    return { updated: false, error: userMsg };
  }
}
