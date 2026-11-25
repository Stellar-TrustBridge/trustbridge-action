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
 * 7. Rendered output cap (Issue #905) — the *interpolated* partial must not
 *    exceed MAX_TEMPLATE_RENDERED_BYTES (16 KB) and the raw template may hold
 *    at most MAX_TEMPLATE_PLACEHOLDERS (200) placeholders. A small file that
 *    repeats a long `{{locale:KEY}}` or `{{horizon}}` thousands of times (an
 *    "expansion bomb") fails fast with a stable `TEMPLATE_OUTPUT_TOO_LARGE`
 *    / `TEMPLATE_TOO_MANY_PLACEHOLDERS` error instead of producing a body
 *    that exceeds GitHub's comment limit.
 */

import * as fs from 'fs';
import * as path from 'path';
import { escapeMarkdownInline } from './markdown';
import { getStrings } from './i18n';
import type { Locale } from './i18n';

/** Maximum allowed template file size in bytes. */
export const MAX_TEMPLATE_BYTES = 8 * 1024; // 8 KB

/**
 * Maximum allowed size of the rendered (interpolated) partial in UTF-8 bytes
 * (Issue #905). Leaves ample headroom under GitHub's 65,536-character comment
 * limit for the core TrustBridge sections.
 */
export const MAX_TEMPLATE_RENDERED_BYTES = 16 * 1024; // 16 KB

/** Maximum number of `{{…}}` placeholders allowed in one template (Issue #905). */
export const MAX_TEMPLATE_PLACEHOLDERS = 200;

/**
 * Stable error codes raised by template rendering limits (Issue #905).
 *
 * | Code | Meaning |
 * |---|---|
 * | `TEMPLATE_OUTPUT_TOO_LARGE` | Rendered partial exceeds `MAX_TEMPLATE_RENDERED_BYTES`. |
 * | `TEMPLATE_TOO_MANY_PLACEHOLDERS` | Template holds more than `MAX_TEMPLATE_PLACEHOLDERS` placeholders. |
 */
export type TemplateErrorCode = 'TEMPLATE_OUTPUT_TOO_LARGE' | 'TEMPLATE_TOO_MANY_PLACEHOLDERS';

/** Error thrown when a template breaches a rendering limit (Issue #905). */
export class TemplateRenderError extends Error {
  readonly code: TemplateErrorCode;

  constructor(code: TemplateErrorCode, message: string) {
    super(`[${code}] ${message}`);
    this.name = 'TemplateRenderError';
    this.code = code;
  }
}

/** Options for {@link interpolateTemplate}. */
export interface InterpolateOptions {
  /**
   * Maximum rendered size in UTF-8 bytes. Defaults to
   * {@link MAX_TEMPLATE_RENDERED_BYTES}; non-finite or non-positive values
   * fall back to the default.
   */
  maxOutputBytes?: number;
}

function resolveMaxOutputBytes(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : MAX_TEMPLATE_RENDERED_BYTES;
}

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
 * Resolve a single placeholder key to its (escaped) substitution value.
 */
function resolvePlaceholder(
  rawKey: string,
  ctx: TemplateContext,
  strings: ReturnType<typeof getStrings>,
): string {
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
}

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
 * - More than {@link MAX_TEMPLATE_PLACEHOLDERS} placeholders throws
 *   `TemplateRenderError` (`TEMPLATE_TOO_MANY_PLACEHOLDERS`) before any
 *   substitution (Issue #905).
 * - Rendering stops as soon as the output would exceed `maxOutputBytes`
 *   and throws `TemplateRenderError` (`TEMPLATE_OUTPUT_TOO_LARGE`), so an
 *   expansion bomb never materialises a huge string (Issue #905).
 *
 * @param template  Raw template content (already validated).
 * @param ctx       Interpolation context.
 * @param options   Rendering limits.
 * @returns         Interpolated template string.
 */
export function interpolateTemplate(
  template: string,
  ctx: TemplateContext,
  options: InterpolateOptions = {},
): string {
  const maxOutputBytes = resolveMaxOutputBytes(options.maxOutputBytes);
  const strings = getStrings(ctx.locale);
  const placeholderPattern = /\{\{([^{}]+?)\}\}/g;

  const placeholderCount = (template.match(placeholderPattern) ?? []).length;
  if (placeholderCount > MAX_TEMPLATE_PLACEHOLDERS) {
    throw new TemplateRenderError(
      'TEMPLATE_TOO_MANY_PLACEHOLDERS',
      `custom comment template contains ${placeholderCount} placeholders; ` +
        `the maximum is ${MAX_TEMPLATE_PLACEHOLDERS}.`,
    );
  }

  const parts: string[] = [];
  let renderedBytes = 0;
  const append = (segment: string): void => {
    if (segment === '') return;
    renderedBytes += Buffer.byteLength(segment, 'utf8');
    if (renderedBytes > maxOutputBytes) {
      throw new TemplateRenderError(
        'TEMPLATE_OUTPUT_TOO_LARGE',
        `custom comment template renders to more than ${maxOutputBytes} bytes. ` +
          'Reduce repeated placeholders or the amount of static text in the partial.',
      );
    }
    parts.push(segment);
  };

  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = placeholderPattern.exec(template)) !== null) {
    append(template.slice(lastIndex, match.index));
    append(resolvePlaceholder(match[1]!, ctx, strings));
    lastIndex = match.index + match[0].length;
  }
  append(template.slice(lastIndex));

  return parts.join('');
}

/**
 * Load, validate, and interpolate a custom comment template partial.
 *
 * Returns the rendered partial string on success, or `undefined` when:
 * - `templatePath` is empty or undefined (feature disabled).
 * - The file does not exist at the resolved path (non-fatal, emits a warning).
 *
 * Throws `Error` for all hard validation failures (path traversal, size
 * exceeded, forbidden content) so the action can surface them clearly, and
 * `TemplateRenderError` when the rendered output breaches a limit
 * (Issue #905: `TEMPLATE_OUTPUT_TOO_LARGE`, `TEMPLATE_TOO_MANY_PLACEHOLDERS`).
 *
 * @param templatePath  Workspace-relative or absolute path to the `.md` file.
 * @param ctx           Interpolation context for variable substitution.
 * @param workspaceRoot Workspace root directory.  Defaults to
 *                      `GITHUB_WORKSPACE` env variable or `process.cwd()`.
 */
export function loadCommentTemplate(
  templatePath: string | undefined | null,
  ctx: TemplateContext,
  workspaceRoot?: string,
  options: InterpolateOptions = {},
): string | undefined {
  if (!templatePath || templatePath.trim() === '') {
    return undefined;
  }

  const root = workspaceRoot ?? process.env['GITHUB_WORKSPACE'] ?? process.cwd();

  // 1. Path validation — must stay inside workspace.
  const resolvedPath = validateTemplatePath(templatePath.trim(), root);

  // 2. File existence — non-fatal, warn-only.
  if (!fs.existsSync(resolvedPath)) {
    // Caller is responsible for surfacing this as a core.warning.
    return undefined;
  }

  // 3. Size check — reject oversized files before reading content.
  const stat = fs.statSync(resolvedPath);
  if (stat.size > MAX_TEMPLATE_BYTES) {
    throw new Error(
      `custom_comment_template_path "${templatePath}" exceeds the maximum allowed size of ` +
        `${MAX_TEMPLATE_BYTES} bytes (file is ${stat.size} bytes). ` +
        'Keep template partials small to avoid hitting GitHub comment size limits.',
    );
  }

  const raw = fs.readFileSync(resolvedPath, 'utf8');

  // 4. Content security validation.
  validateTemplateContent(raw);

  // 5. Interpolate placeholders under the rendered-output cap (Issue #905).
  return interpolateTemplate(raw, ctx, options);
}

/**
 * Build a `TemplateContext` from comment-level values.
 *
 * Centralises the context construction so callers do not need to know
 * the full shape of `TemplateContext`.
 */
export function buildTemplateContext(params: {
  stellarAddress: string;
  assetCode: string;
  assetIssuer: string;
  horizonUrl: string;
  network: string;
  valid: boolean;
  locale: Locale | string;
}): TemplateContext {
  return {
    account: params.stellarAddress,
    asset: params.assetCode,
    issuer: params.assetIssuer,
    horizon: params.horizonUrl,
    network: params.network,
    status: params.valid ? '✅ ready' : '❌ blocked',
    locale: params.locale,
  };
}
