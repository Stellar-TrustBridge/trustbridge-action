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
import type { Locale } from './i18n';
/** Maximum allowed template file size in bytes. */
export declare const MAX_TEMPLATE_BYTES: number;
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
 *
 * @param template  Raw template content (already validated).
 * @param ctx       Interpolation context.
 * @returns         Interpolated template string.
 */
export declare function interpolateTemplate(template: string, ctx: TemplateContext): string;
/**
 * Load, validate, and interpolate a custom comment template partial.
 *
 * Returns the rendered partial string on success, or `undefined` when:
 * - `templatePath` is empty or undefined (feature disabled).
 * - The file does not exist at the resolved path (non-fatal, emits a warning).
 *
 * Throws `Error` for all hard validation failures (path traversal, size
 * exceeded, forbidden content) so the action can surface them clearly.
 *
 * @param templatePath  Workspace-relative or absolute path to the `.md` file.
 * @param ctx           Interpolation context for variable substitution.
 * @param workspaceRoot Workspace root directory.  Defaults to
 *                      `GITHUB_WORKSPACE` env variable or `process.cwd()`.
 */
export declare function loadCommentTemplate(templatePath: string | undefined | null, ctx: TemplateContext, workspaceRoot?: string): string | undefined;
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
