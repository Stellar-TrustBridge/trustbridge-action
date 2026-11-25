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
import type { Locale } from './i18n';
/** Maximum allowed template file size in bytes. */
export declare const MAX_TEMPLATE_BYTES: number;
/**
 * Maximum allowed size of the rendered (interpolated) partial in UTF-8 bytes
 * (Issue #905). Leaves ample headroom under GitHub's 65,536-character comment
 * limit for the core TrustBridge sections.
 */
export declare const MAX_TEMPLATE_RENDERED_BYTES: number;
/** Maximum number of `{{…}}` placeholders allowed in one template (Issue #905). */
export declare const MAX_TEMPLATE_PLACEHOLDERS = 200;
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
export declare class TemplateRenderError extends Error {
    readonly code: TemplateErrorCode;
    constructor(code: TemplateErrorCode, message: string);
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
/**
 * Validate that the given path resolves inside the workspace root.
 *
 * @param templatePath  Raw path from action input (relative or absolute).
 * @param workspaceRoot Absolute workspace root directory.
 * @throws `Error` if the resolved path escapes the workspace.
 */
export declare function validateTemplatePath(templatePath: string, workspaceRoot: string): string;
/**
 * Scan the raw template content for dangerous patterns and forbidden
 * prototype-chain placeholder names.
 *
 * @throws `Error` describing the first violation found.
 */
export declare function validateTemplateContent(raw: string): void;
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
export declare function interpolateTemplate(template: string, ctx: TemplateContext, options?: InterpolateOptions): string;
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
export declare function loadCommentTemplate(templatePath: string | undefined | null, ctx: TemplateContext, workspaceRoot?: string, options?: InterpolateOptions): string | undefined;
/**
 * Build a `TemplateContext` from comment-level values.
 *
 * Centralises the context construction so callers do not need to know
 * the full shape of `TemplateContext`.
 */
export declare function buildTemplateContext(params: {
    stellarAddress: string;
    assetCode: string;
    assetIssuer: string;
    horizonUrl: string;
    network: string;
    valid: boolean;
    locale: Locale | string;
}): TemplateContext;
