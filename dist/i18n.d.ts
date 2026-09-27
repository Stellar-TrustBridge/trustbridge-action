/**
 * Internationalization (i18n) template layer for TrustBridge issue comments.
 *
 * Provides locale-aware comment templates with fallback to English.
 * Strings that appear in Markdown issue comments are externalized here,
 * making it easy for consumers to add new locales or adjust copy.
 */
export type Locale = 'en' | 'es' | 'pt' | 'ja' | 'fr' | 'de';
/**
 * Every supported locale, in canonical order.
 *
 * Consumers that must recognise text produced by *any* locale (for example
 * `extractChecklistState` in `markdown.ts`, which must keep working after a
 * workflow switches `locale`) iterate this list.
 */
export declare const SUPPORTED_LOCALES: readonly Locale[];
export interface CommentStrings {
    heading: string;
    checkedAccount: string;
    horizon: string;
    asset: string;
    resultsHeading: string;
    validationGateHeading: string;
    readyToProceed: string;
    blockedBy: string;
    passedChecks: string;
    failedChecks: string;
    /** Label for the machine-readable `reason_code` bullet (Issue #450). */
    reasonCode: string;
    /** Label for the `ready` boolean bullet (Issue #450). */
    readyFlag: string;
    circuitBreakerHeading: string;
    circuitBreakerOpen: string;
    circuitBreakerRecoveryHint: string;
    circuitBreakerReasonCode: string;
    checklistHeading: string;
    checklistIntro: string;
    checklistFundAccountLabel: string;
    checklistFundAccountDetail: string;
    checklistTrustlineLabel(assetCode: string): string;
    checklistTrustlineDetail: string;
    checklistReserveLabel: string;
    checklistReserveDetail(minXlmReserve: string): string;
    balancesHeading: string;
    xlmBalance: string;
    minimumRequired: string;
    setupCostHeading: string;
    minimumAccountBalance: string;
    baseReservePerTrustline: string;
    typicalMinimumToFund: string;
    addTrustlineHeading: string;
    viewAccountOnLab: string;
    openTransactionBuilder: string;
    lobstrWallet: string;
    lobstrDescription: string;
    sepWalletActionsHeading: string;
    sepWalletActionsDescription: string;
    sendXlmToActivate: string;
    remediationHeading: string;
    configurationSummaryHeading: string;
    inputColumn: string;
    valueColumn: string;
    failOnMissingTrue: string;
    failOnMissingFalse: string;
    stickyCommentTrue: string;
    stickyCommentFalse: string;
    waitUntilFundedTrue: string;
    waitUntilFundedFalse: string;
    waitUntilFundedTimeoutMs: string;
    waitUntilFundedIntervalMs: string;
    outputsHeading: string;
    outputsDescription: string;
    outputColumn: string;
    valueRunColumn: string;
    descriptionColumn: string;
    accountFundedOutput: string;
    trustlineExistsOutput: string;
    xlmBalanceOutput: string;
    commentUrlOutput: string;
    metricsHeading: string;
    metricsDescription: string;
    accountFundedLabel: string;
    accountFundedPassDetail(address: string): string;
    accountFundedFailDetail(address: string): string;
    trustlineLabel(assetCode: string): string;
    trustlinePassDetail(assetCode: string, issuer: string): string;
    trustlineFailHasTrustlines(assetCode: string, issuer: string): string;
    trustlineFailNoTrustlines: string;
    xlmReserveLabel: string;
    xlmReservePassDetail(balance: string, required: string): string;
    xlmReserveFailDetail(balance: string, required: string): string;
    horizonAvailabilityLabel: string;
    remediationAddTrustline(assetCode: string): string;
    remediationSendXlm(amount: string, address: string): string;
    remediationActivateAccount(address: string, minBalance: string, assetCode: string): string;
    remediationAccountNotFound(assetCode: string): string;
    remediationEstimatedSetupCost(cost: string): string;
    remediationHorizonError: string;
    networkMismatchDetected: string;
    networkMismatchConfiguredNetwork: string;
    networkMismatchActiveNetwork: string;
    networkMismatchFix: string;
    networkMismatchUpdateUrl: string;
}
/**
 * Get comment strings for a given locale, with automatic fallback to English
 * if the locale is not available.
 */
export declare function getStrings(locale: Locale | string): CommentStrings;
/**
 * Validate that a locale string is supported.
 */
export declare function isValidLocale(locale: string | null | undefined): boolean;
/**
 * Parse and validate a locale input from action configuration.
 * Falls back to 'en' if the input is invalid or unset.
 */
export declare function parseLocaleInput(input: string | undefined): Locale;
