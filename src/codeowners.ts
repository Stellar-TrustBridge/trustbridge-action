import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import * as github from '@actions/github';
import { logger } from './logger';

/** Standard locations where CODEOWNERS can reside in a repository. */
export const CODEOWNERS_STANDARD_PATHS = [
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'docs/CODEOWNERS',
];

/**
 * Parse the contents of a CODEOWNERS file into a normalized Set of owner handles.
 * Handles `@username`, `@org/team`, emails, and raw usernames.
 * Comments (`#`) and empty lines are ignored.
 */
export function parseCodeowners(content: string): Set<string> {
  const owners = new Set<string>();
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // A line format is: <pattern> <owner1> <owner2> ...
    // E.g. * @octocat @org/team
    const tokens = trimmed.split(/\s+/);
    // The first token is the file/directory pattern, the rest are owners
    const ownerTokens = tokens.slice(1);

    for (const token of ownerTokens) {
      if (token.startsWith('#')) {
        // Trailing inline comment starts here
        break;
      }
      const normalized = normalizeOwnerHandle(token);
      if (normalized) {
        owners.add(normalized);
      }
    }
  }

  return owners;
}

/**
 * Normalize an owner handle from CODEOWNERS or allowlist (lowercase, strip leading @).
 */
export function normalizeOwnerHandle(handle: string): string {
  const trimmed = handle.trim().toLowerCase();
  return trimmed.replace(/^@/, '');
}

export interface CodeownersRule {
  /** Raw pattern token from the CODEOWNERS line (e.g. `src/payments/**`). */
  pattern: string;
  /** Normalized owner handles for this rule. */
  owners: string[];
}

/**
 * Parse CODEOWNERS content into ordered rules (pattern + owners).
 * Comments and empty lines are ignored. Rules with no owners are skipped.
 */
export function parseCodeownersRules(content: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const tokens = trimmed.split(/\s+/);
    const pattern = tokens[0];
    const owners: string[] = [];

    for (const token of tokens.slice(1)) {
      if (token.startsWith('#')) {
        break;
      }
      const normalized = normalizeOwnerHandle(token);
      if (normalized) {
        owners.push(normalized);
      }
    }

    if (pattern && owners.length > 0) {
      rules.push({ pattern, owners });
    }
  }

  return rules;
}

/**
 * Convert a CODEOWNERS glob pattern into a RegExp anchored to the repo root.
 * Supports `*`, `**`, `?`, and character classes via a conservative translation.
 */
function codeownersPatternToRegExp(pattern: string): RegExp {
  let normalized = pattern.trim();
  // Patterns without a leading slash are treated as root-relative.
  if (normalized.startsWith('/')) {
    normalized = normalized.slice(1);
  }

  let regex = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i];
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // `**` matches across path separators
        regex += '.*';
        i++;
        // Collapse an optional following slash so `**/foo` matches `foo`
        if (normalized[i + 1] === '/') {
          i++;
        }
      } else {
        // `*` matches within a single path segment
        regex += '[^/]*';
      }
    } else if (ch === '?') {
      regex += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
  }

  return new RegExp(`^${regex}(/.*)?$`);
}

/**
 * Determine whether a given file path is covered by any CODEOWNERS rule.
 * Returns the matching rule (last match wins, per GitHub semantics) or null.
 */
export function findCoveringRule(
  filePath: string,
  rules: CodeownersRule[],
): CodeownersRule | null {
  const normalizedPath = filePath.replace(/^\.?\//, '');
  let match: CodeownersRule | null = null;

  for (const rule of rules) {
    if (codeownersPatternToRegExp(rule.pattern).test(normalizedPath)) {
      match = rule;
    }
  }

  return match;
}

export interface CodeownersCoverageResult {
  /** Paths that have at least one owner. */
  covered: string[];
  /** Paths with no matching CODEOWNERS rule (or a rule with no owners). */
  uncovered: string[];
  /** True when no CODEOWNERS rules were loaded at all. */
  missingCodeowners: boolean;
}

/**
 * Check reviewer coverage for a set of TrustBridge-touched paths against parsed
 * CODEOWNERS rules. Used by preflight to surface missing reviewer coverage.
 */
export function checkCodeownersCoverage(
  touchedPaths: string[],
  rules: CodeownersRule[],
): CodeownersCoverageResult {
  const covered: string[] = [];
  const uncovered: string[] = [];

  for (const filePath of touchedPaths) {
    const rule = findCoveringRule(filePath, rules);
    if (rule && rule.owners.length > 0) {
      covered.push(filePath);
    } else {
      uncovered.push(filePath);
    }
  }

  return {
    covered,
    uncovered,
    missingCodeowners: rules.length === 0,
  };
}

export interface LoadCodeownersOptions {
  workspaceRoot?: string;
  customPath?: string;
  githubToken?: string;
  octokit?: ReturnType<typeof github.getOctokit>;
  isForkPr?: boolean;
  baseRef?: string;
  owner?: string;
  repo?: string;
}

/**
 * Load CODEOWNERS content with strict Branch Safety guarantees:
 * - On pull requests from forks (or untrusted PR heads), NEVER reads from the local PR workspace.
 * - Instead, fetches the trusted CODEOWNERS file from the base branch / default branch via GitHub API.
 * - When running in a trusted context (push, default branch, or workflow_dispatch), reads from local workspace.
 */
export async function loadCodeowners(options: LoadCodeownersOptions = {}): Promise<Set<string>> {
  const workspaceRoot = options.workspaceRoot || process.env.GITHUB_WORKSPACE || process.cwd();
  const customPath = options.customPath?.trim();

  // Branch safety check: detect if running in a fork PR
  const payload = github.context.payload;
  const isPullRequest = github.context.eventName === 'pull_request' || payload.pull_request !== undefined;
  const isFork =
    options.isForkPr ??
    (isPullRequest && payload.pull_request?.head?.repo?.full_name !== payload.repository?.full_name);

  if (isFork) {
    logger.info('Branch safety: Fork PR detected. Fetching CODEOWNERS from base/default branch via API instead of PR workspace.', {
      component: 'codeowners',
    });

    const token = options.githubToken || process.env.GITHUB_TOKEN;
    if (token) {
      try {
        const octokit = options.octokit || github.getOctokit(token);
        const owner = options.owner || github.context.repo.owner;
        const repo = options.repo || github.context.repo.repo;
        const ref = options.baseRef || payload.pull_request?.base?.ref || payload.repository?.default_branch || 'main';

        const pathsToTry = customPath ? [customPath] : CODEOWNERS_STANDARD_PATHS;
        for (const filePath of pathsToTry) {
          try {
            const response = await octokit.rest.repos.getContent({
              owner,
              repo,
              path: filePath,
              ref,
            });

            if ('content' in response.data && typeof response.data.content === 'string') {
              const content = Buffer.from(response.data.content, 'base64').toString('utf8');
              logger.info(`Loaded trusted CODEOWNERS from ${filePath} @ ref ${ref}`, { component: 'codeowners' });
              return parseCodeowners(content);
            }
          } catch (err: unknown) {
            // Path not found on remote; continue to next standard location
            const status = (err as { status?: number })?.status;
            if (status !== 404) {
              logger.warn(`Failed to fetch CODEOWNERS from ${filePath}: ${err instanceof Error ? err.message : String(err)}`, {
                component: 'codeowners',
              });
            }
          }
        }
      } catch (apiError) {
        logger.warn(`API error while fetching trusted CODEOWNERS: ${apiError instanceof Error ? apiError.message : String(apiError)}`, {
          component: 'codeowners',
        });
      }
    } else {
      logger.warn('Branch safety: Fork PR detected but no GitHub token available to fetch trusted CODEOWNERS. Failing safe (no maintainer skip).', {
        component: 'codeowners',
      });
      return new Set();
    }
  }

  // Trusted local workspace read (push, default branch, workflow_dispatch)
  const candidatePaths = customPath ? [customPath] : CODEOWNERS_STANDARD_PATHS;
  for (const relativePath of candidatePaths) {
    const fullPath = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(workspaceRoot, relativePath);

    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        logger.info(`Loaded CODEOWNERS from local path: ${relativePath}`, { component: 'codeowners' });
        return parseCodeowners(content);
      } catch (err) {
        logger.warn(`Failed to read CODEOWNERS from ${relativePath}: ${err instanceof Error ? err.message : String(err)}`, {
          component: 'codeowners',
        });
      }
    }
  }

  return new Set();
}

/**
 * Load CODEOWNERS rules (pattern + owners) using the same branch-safety guarantees
 * as {@link loadCodeowners}. Returns an empty array when no CODEOWNERS file is found.
 */
export async function loadCodeownersRules(options: LoadCodeownersOptions = {}): Promise<CodeownersRule[]> {
  const workspaceRoot = options.workspaceRoot || process.env.GITHUB_WORKSPACE || process.cwd();
  const customPath = options.customPath?.trim();

  const payload = github.context.payload;
  const isPullRequest = github.context.eventName === 'pull_request' || payload.pull_request !== undefined;
  const isFork =
    options.isForkPr ??
    (isPullRequest && payload.pull_request?.head?.repo?.full_name !== payload.repository?.full_name);

  if (isFork) {
    const token = options.githubToken || process.env.GITHUB_TOKEN;
    if (!token) {
      logger.warn('Branch safety: Fork PR detected but no GitHub token available to fetch trusted CODEOWNERS rules.', {
        component: 'codeowners',
      });
      return [];
    }

    try {
      const octokit = options.octokit || github.getOctokit(token);
      const owner = options.owner || github.context.repo.owner;
      const repo = options.repo || github.context.repo.repo;
      const ref = options.baseRef || payload.pull_request?.base?.ref || payload.repository?.default_branch || 'main';

      const pathsToTry = customPath ? [customPath] : CODEOWNERS_STANDARD_PATHS;
      for (const filePath of pathsToTry) {
        try {
          const response = await octokit.rest.repos.getContent({ owner, repo, path: filePath, ref });
          if ('content' in response.data && typeof response.data.content === 'string') {
            const content = Buffer.from(response.data.content, 'base64').toString('utf8');
            return parseCodeownersRules(content);
          }
        } catch (err: unknown) {
          const status = (err as { status?: number })?.status;
          if (status !== 404) {
            logger.warn(`Failed to fetch CODEOWNERS rules from ${filePath}: ${err instanceof Error ? err.message : String(err)}`, {
              component: 'codeowners',
            });
          }
        }
      }
    } catch (apiError) {
      logger.warn(`API error while fetching trusted CODEOWNERS rules: ${apiError instanceof Error ? apiError.message : String(apiError)}`, {
        component: 'codeowners',
      });
    }

    return [];
  }

  const candidatePaths = customPath ? [customPath] : CODEOWNERS_STANDARD_PATHS;
  for (const relativePath of candidatePaths) {
    const fullPath = path.isAbsolute(relativePath)
      ? relativePath
      : path.join(workspaceRoot, relativePath);

    if (fs.existsSync(fullPath)) {
      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        return parseCodeownersRules(content);
      } catch (err) {
        logger.warn(`Failed to read CODEOWNERS rules from ${relativePath}: ${err instanceof Error ? err.message : String(err)}`, {
          component: 'codeowners',
        });
      }
    }
  }

  return [];
}

/**
 * Check if the given actor is a maintainer according to CODEOWNERS or an explicit maintainers list.
 */
export function isMaintainerActor(
  actor: string,
  codeowners: Set<string>,
  maintainersAllowlist: string[] = [],
): boolean {
  if (!actor || !actor.trim()) {
    return false;
  }

  const normalizedActor = normalizeOwnerHandle(actor);

  // Check CODEOWNERS entries (direct username match or team match)
  if (codeowners.has(normalizedActor)) {
    return true;
  }

  // Check team format entries in CODEOWNERS (e.g. org/team)
  for (const owner of codeowners) {
    if (owner.includes('/')) {
      const parts = owner.split('/');
      if (parts[1] && parts[1] === normalizedActor) {
        return true;
      }
    }
  }

  // Check explicit maintainers allowlist
  for (const item of maintainersAllowlist) {
    const normalizedItem = normalizeOwnerHandle(item);
    if (normalizedItem && normalizedItem === normalizedActor) {
      return true;
    }
  }

  return false;
}
