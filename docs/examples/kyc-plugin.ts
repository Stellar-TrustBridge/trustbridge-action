/**
 * @file docs/examples/kyc-plugin.ts
 *
 * Hardened KYC check plugin example for TrustBridge.
 *
 * Frozen contract:
 * - Place this file at `plugins/kyc.ts` in the workspace root.
 * - Read the API key from `process.env.KYC_API_KEY`.
 * - Register it via `trustbridge_plugins_path: plugins/kyc.ts`.
 *
 * This example is consumer logic, not a built-in check. The core TrustBridge
 * checks still run via `runAccountChecks`; this plugin is optional and only
 * runs when explicitly registered.
 */

import * as core from '@actions/core';
import { CheckPlugin, CheckPluginContext, CheckPluginResult } from '../../src/plugin';
import { escapeMarkdownInline, inlineCode } from '../../src/markdown';

export interface KycLookupFn {
  (stellarAddress: string, apiKey: string): KycStatus;
}

export interface KycStatus {
  status: 'approved' | 'pending' | 'rejected' | 'not_found';
  referenceToken?: string;
}

export interface KycPluginOptions {
  lookupFn: KycLookupFn;
  apiKey: string;
  kycUrl?: string;
}

export function createKycPlugin(options: KycPluginOptions): CheckPlugin {
  const kycUrl = options.kycUrl ?? 'https://kyc.example.com';

  return {
    id: 'consumer/kyc-check',
    label: 'KYC verified',

    run(ctx: CheckPluginContext): CheckPluginResult {
      const safeAddress = inlineCode(ctx.stellarAddress);

      let kycStatus: KycStatus;
      try {
        kycStatus = options.lookupFn(ctx.stellarAddress, options.apiKey);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        core.warning(`[kyc-plugin] KYC lookup failed: ${message}`);
        return {
          passed: false,
          detail: 'KYC check could not be completed due to a provider error.',
          remediation: `Retry later or contact support at ${escapeMarkdownInline(kycUrl)}.`,
        };
      }

      const safeToken = kycStatus.referenceToken
        ? ` (ref: ${inlineCode(escapeMarkdownInline(kycStatus.referenceToken))})`
        : '';

      core.info(`[kyc-plugin] KYC status=${kycStatus.status}`);

      switch (kycStatus.status) {
        case 'approved':
          return {
            passed: true,
            detail: `KYC verification approved for ${safeAddress}${safeToken}.`,
          };
        case 'pending':
          return {
            passed: false,
            detail: `KYC verification is in progress for ${safeAddress}${safeToken}.`,
            remediation: `Your KYC review is pending. Check ${escapeMarkdownInline(kycUrl)} and retry once approved.`,
          };
        case 'rejected':
          return {
            passed: false,
            detail: `KYC verification was not approved for ${safeAddress}${safeToken}.`,
            remediation: `Visit ${escapeMarkdownInline(kycUrl)} to review your verification status or appeal.`,
          };
        case 'not_found':
          return {
            passed: false,
            detail: `No KYC record found for ${safeAddress}${safeToken}.`,
            remediation: `Complete KYC at ${escapeMarkdownInline(kycUrl)} before requesting payout.`,
          };
      }
    },
  };
}

export function readKycApiKey(): string {
  return process.env.KYC_API_KEY ?? '';
}
