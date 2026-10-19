/**
 * Template loader for TrustBridge custom comment partials (#312).
 *
 * Allows repository owners to inject a Markdown "partial" into the TrustBridge
 * issue comment via a workspace file.  The partial is appended as a section
 * just before the footer so the i18n-driven core sections remain unchanged.
 *
 * Security model
 * ──────────────
 * 1. Path validation  — the resolved path must stay inside the workspace root;
 *    path traversal attempts (../../etc/passwd) fail immediately.
 * 2. Size cap         — files larger than MAX_TEMPLATE_BYTES (8 KB) are
 *    rejected to prevent comment-flooding attacks and GitHub size-limit hits.
 * 3. Dangerous pattern blocking — any `{{constructor}}`, `{{__proto__}}`,
 *    `{{prototype}}` placeholder or raw `<script`, `javascript:`, or `data:`
 *    URI content is rejected before interpolation.
 * 4. Interpolation escaping — every substituted value is run through
 *    `escapeMarkdownInline` so contributor-supplied strings (addresses, asset
 *    codes, issuer addresses, network names) cannot inject Markdown structures
 *    such as links, emphasis, headings, or code-spans into the partial.
 *    The lone exception is `{{status}}` which expands to a safe symbolic emoji.
 * 5. i18n integration — `{{locale:KEY}}` expands to the current locale string
 *    for KEY, making it safe to reference translated copy without bypassing i18n.
 * 6. Unknown placeholders are replaced with an empty string (never silently
 *    passed through) so unexpected `{{foo}}` tokens cannot leak raw data.
 */

import * as fs from 'fs';
import * as path from 'path';
import { escapeMarkdownInline } from './markdown';
import { getStrings } from './i18n';
import type { Locale } from './i18n';

/** Maximum allowed template file size in bytes. */
export const MAX_TEMPLATE_BYTES = 8 * 1024; // 8 KB

/**
 * Dangerous prototype-pollution / prototype-chain placeholder names.
 * Any template that uses these as `{{name}}` tokens is rejected outright.
 * All entries must be lowercase (comparison is done after toLowerCase()).
 */
const FORBIDDEN_PLACEHOLDER_NAMES = new Set([
  'constructor',
  '__proto__',
  'prototype',
  '__definegetter__',
  '__definesetter__',
  '__lookupgetter__',
  '__lookupsetter__',
]);

/**
 * Patterns in the raw template content that indicate active injection attempts.
 * Checked after path validation and size check, before interpolation.
 */
const FORBIDDEN_CONTENT_PATTERNS: RegExp[] = [
  /<script[\s>]/i,         // <script tags
  /javascript\s*:/i,       // javascript: URIs
  /data\s*:\s*text\s*\/\s*html/i, // data:text/html URIs
  /vbscript\s*:/i,         // vbscript: URIs
  /on\w+\s*=/i,            // inline event handlers (onclick=, etc.)
];

/**
 * Validate that the given path resolves inside the workspace root.
 *
 * @param templatePath  Raw path from action input (relative or absolute).
 * @param workspaceRoot Absolute workspace root directory.
 * @throws `Error` if the resolved path escapes the workspace.
 */
export function validateTemplatePath(templatePath: string, workspaceRoot: string): string {
  const resolvedRoot = path.resolve(workspaceRoot);

  const candidate = path.isAbsolute(templatePath)
    ? templatePath
    : path.join(resolvedRoot, templatePath);

  const resolved = path.resolve(candidate);

  // The resolved path must be the workspace root itself OR a descendant of it.
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new Error(
      `custom_comment_template_path resolves outside the workspace root: "${templatePath}". ` +
        'Only paths inside the workspace are allowed.',
    );
  }

  return resolved;
}

/**
 * Scan the raw template content for dangerous patterns and forbidden
 * prototype-chain placeholder names.
 *
 * @throws `Error` describing the first violation found.
 */
export function validateTemplateContent(raw: string): void {
  // Check for dangerous content patterns (XSS / HTML injection).
  for (const pattern of FORBIDDEN_CONTENT_PATTERNS) {
    if (pattern.test(raw)) {
      throw new Error(
        `custom_comment_template contains a disallowed pattern (${pattern.source}). ` +
          'Template content must be plain Markdown without HTML scripts, event handlers, or javascript:/vbscript: URIs.',
      );
    }
  }

  // Check for forbidden prototype-chain placeholders.
  const placeholderPattern = /\{\{([^{}]+?)\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = placeholderPattern.exec(raw)) !== null) {
    // locale:KEY form — only validate the prefix
    const name = match[1]!.trim().toLowerCase();
    // For dotted names (e.g. constructor.prototype.isAdmin), check the first segment.
    const baseName = name.startsWith('locale:')
      ? 'locale'
      : name.split(/[\s.[\]()'"`]/)[0]!;
    if (FORBIDDEN_PLACEHOLDER_NAMES.has(baseName)) {
      throw new Error(
        `custom_comment_template uses a forbidden placeholder name: "{{${match[1]}}}". ` +
          'Prototype-chain keys are not allowed as template variables.',
      );
    }
  }
}

/** Context values made available to template interpolation. */
export interface TemplateContext {
  /** Stellar account address (already-redacted/display form). */
  account: string;
  /** Asset code (e.g. "USDC"). */
  asset: string;
  /** Asset issuer address. */
  issuer: string;
  /** Inferred Stellar network ("mainnet" | "testnet" | "unknown"). */
  network: string;
  /** Horizon base URL. */
  horizon: string;
  /** Validation status ("✅ ready" | "❌ blocked"). */
  status: string;
  /** Active locale for {{locale:KEY}} lookups. */
  locale: Locale | string;
}

/**
 * Supported named variables for `{{variable}}` interpolation.
 *
 * Every value is escaped with `escapeMarkdownInline` before substitution,
 * preventing contributor-supplied strings from injecting Markdown structures.
 * `status` is the one exception — it is always a safe symbolic emoji string
 * produced internally by this module, not sourced from external input.
 */
const SUPPORTED_VARIABLES = new Set([
  'account',
  'asset',
  'issuer',
  'network',
  'horizon',
  'status',
]);

/**
 * Interpolate `{{variable}}` and `{{locale:KEY}}` placeholders in a template
 * string.
 *
 * Rules:
 * - Known variables are replaced with their escaped context value.
 * - `{{locale:KEY}}` resolves the locale string for KEY from `getStrings()`.
 *   Only string-typed fields of `CommentStrings` are supported; function
 *   fields are excluded and resolve to an empty string.
 * - Unknown placeholders are replaced with an empty string (never echoed back).
 *
 * @param template  Raw template content (already validated).
 * @param ctx       Interpolation context.
 * @returns         Interpolated template string.
 */
export function interpolateTemplate(template: string, ctx: TemplateContext): string {
  const strings = getStrings(ctx.locale);

  return template.replace(/\{\{([^{}]+?)\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim();

    // Handle {{locale:KEY}} for i18n string lookups.
    if (key.toLowerCase().startsWith('locale:')) {
      const i18nKey = key.slice('locale:'.length).trim();
      const value = (strings as unknown as Record<string, unknown>)[i18nKey];
      // Only allow string-typed fields (not function-typed check helpers).
      if (typeof value === 'string') {
        return escapeMarkdownInline(value);
      }
      return '';
    }

    const lowerKey = key.toLowerCase();

    // Unknown or unsupported variable → empty string (safe default).
    if (!SUPPORTED_VARIABLES.has(lowerKey)) {
      return '';
    }

    // status is safe symbolic text, no escaping needed.
    if (lowerKey === 'status') {
      return ctx.status;
    }

    const raw = (ctx as unknown as Record<string, string>)[lowerKey] ?? '';
    return escapeMarkdownInline(raw);
  });
}

/**
 * Load, validate, and interpolate a custom comment template partial.
 *
 * Returns the rendered partial string on success, or `undefined` when the
 * template path is not configured.  Throws on validation failures so the
 * caller can surface a clear, stable error message.
 *
 * @param templatePath  Raw path from action input (may be empty/undefined).
 * @param workspaceRoot Absolute workspace root directory.
 * @param ctx           Interpolation context.
 * @returns             Rendered partial, or `undefined` when not configured.
 */
export function loadCustomTemplate(
  templatePath: string | undefined,
  workspaceRoot: string,
  ctx: TemplateContext,
): string | undefined {
  if (!templatePath || templatePath.trim() === '') {
    return undefined;
  }

  const resolved = validateTemplatePath(templatePath, workspaceRoot);

  let raw: string;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (err) {
    throw new Error(
      `custom_comment_template could not be read at "${templatePath}": ${(err as Error).message}`,
    );
  }

  if (Buffer.byteLength(raw, 'utf8') > MAX_TEMPLATE_BYTES) {
    throw new Error(
      `custom_comment_template exceeds the maximum size of ${MAX_TEMPLATE_BYTES} bytes.`,
    );
  }

  validateTemplateContent(raw);

  return interpolateTemplate(raw, ctx);
}
