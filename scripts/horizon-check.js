#!/usr/bin/env node
/**
 * scripts/horizon-check.js
 *
 * CLI entry point for the Horizon preflight probe.
 * Reads HORIZON_URL from environment or argv and runs the probe.
 *
 * Usage:
 *   HORIZON_URL=https://horizon.stellar.org npm run horizon:check
 *   HORIZON_URL=https://horizon.stellar.org HORIZON_TIMEOUT_MS=3000 npm run horizon:check
 *   npm run horizon:check -- --url=https://horizon.stellar.org --timeout=3000
 *
 * Exit codes:
 *   0 — probe succeeded
 *   1 — probe failed (connection error, HTTP error, timeout)
 *   2 — invalid usage / missing required arguments
 */

'use strict';

const path = require('path');

let preflightModule, loggerModule;
try {
  preflightModule = require('../dist/preflight.js');
  loggerModule = require('../dist/logger.js');
} catch (err) {
  console.error('Error: Built distribution not found. Run `npm run build` first.');
  console.error('Hint: If you are developing, ensure `npm run build` has been run.');
  process.exit(2);
}

const { probeHorizonUrl } = preflightModule;
const { redactHorizonUrl } = loggerModule;

async function getFetch() {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch;
  }
  const fetchModule = await import('node-fetch');
  return fetchModule.default;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    url: process.env.HORIZON_URL || '',
    timeoutMs: parseInt(process.env.HORIZON_TIMEOUT_MS || '5000', 10),
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--url=')) {
      options.url = arg.split('=')[1];
    } else if (arg === '--url' || arg === '-u') {
      if (i + 1 < args.length) {
        options.url = args[++i];
      }
    } else if (arg.startsWith('--timeout=')) {
      options.timeoutMs = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--timeout' || arg === '-t') {
      if (i + 1 < args.length) {
        options.timeoutMs = parseInt(args[++i], 10);
      }
    } else if (arg === '--verbose' || arg === '-v') {
      options.verbose = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }
  }

  return options;
}

function printUsage() {
  console.log(`
Horizon Preflight Probe

Usage:
  npm run horizon:check [options]
  HORIZON_URL=<url> [HORIZON_TIMEOUT_MS=<ms>] npm run horizon:check

Options:
  --url, -u <url>          Horizon URL to probe (required, or set HORIZON_URL env)
  --timeout, -t <ms>       Probe timeout in milliseconds (default: 5000, or HORIZON_TIMEOUT_MS env)
  --verbose, -v            Verbose output
  --help, -h               Show this help

Environment variables:
  HORIZON_URL              Horizon endpoint to probe
  HORIZON_TIMEOUT_MS       Probe timeout in milliseconds (default: 5000)

Exit codes:
  0  Probe succeeded (HTTP < 400)
  1  Probe failed (connection error, HTTP >= 400, timeout)
  2  Invalid usage (missing URL or build output)
`);
}

async function main() {
  const options = parseArgs();

  if (!options.url) {
    console.error('Error: Horizon URL is required. Use --url or set HORIZON_URL environment variable.');
    console.error('Run with --help for usage.');
    process.exit(2);
  }

  if (isNaN(options.timeoutMs) || options.timeoutMs <= 0) {
    console.error('Error: Timeout must be a positive number.');
    process.exit(2);
  }

  const safeUrl = redactHorizonUrl(options.url);

  if (options.verbose) {
    console.log(`Probing Horizon: ${safeUrl} (timeout: ${options.timeoutMs}ms)`);
  }

  try {
    const fetchImpl = await getFetch();
    const result = await probeHorizonUrl(options.url, fetchImpl, options.timeoutMs);

    if (result.ok) {
      if (options.verbose || process.env.CI) {
        console.log(`✅ Probe succeeded: ${safeUrl} — HTTP ${result.status}`);
      }
      process.exit(0);
    } else {
      console.error(`❌ Probe failed: ${safeUrl} — ${result.reason}${result.status ? ` (HTTP ${result.status})` : ''}`);
      process.exit(1);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Probe error: ${safeUrl} — ${message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});