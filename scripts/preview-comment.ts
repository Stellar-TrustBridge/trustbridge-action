import * as fs from 'fs';
import * as path from 'path';
import { runAccountChecks } from '../src/checks';
import { formatCommentBody, CommentConfig } from '../src/comment';
import { normalizeAssetConfig } from '../src/assets';

async function main() {
  const args = process.argv.slice(2);
  const fixtureArg = args[0] || 'fixtures/account-funded.json';
  const fixturePath = path.resolve(process.cwd(), fixtureArg);

  if (!fs.existsSync(fixturePath)) {
    console.error(`Error: Fixture file not found at ${fixturePath}`);
    console.error(`Usage: npm run preview-comment [path/to/fixture.json] [output.md]`);
    process.exit(1);
  }

  console.error(`Loading fixture: ${fixtureArg}`);
  const fixtureRaw = fs.readFileSync(fixturePath, 'utf8');
  const account = JSON.parse(fixtureRaw);

  const assetConfig = normalizeAssetConfig({
    assetCode: process.env.INPUT_ASSET_CODE || 'USDC',
    assetIssuer: process.env.INPUT_ASSET_ISSUER || 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
  });

  const checkConfig = {
    ...assetConfig,
    minXlmReserve: Number(process.env.INPUT_MIN_XLM_RESERVE || 1.5),
    horizonUrl: process.env.INPUT_HORIZON_URL || 'https://horizon.stellar.org',
    homeDomainCheckEnabled: false,
    homeDomainCheckMode: 'warn' as const,
    checkLedgerFreshness: false,
    maxLedgerLagSeconds: 60,
    ledgerFreshnessFailOnStale: false,
    claimableBalancePolicy: 'ignore' as const,
    unauthorizedTrustlinePolicy: 'warn' as const,
    clawbackStrictMode: false
  };

  const result = await runAccountChecks(account, checkConfig);

  const commentConfig: CommentConfig = {
    ...checkConfig,
    stellarAddress: account.id || 'GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
    horizonUrl: checkConfig.horizonUrl,
    failOnMissing: true,
    stickyComment: true,
    waitUntilFunded: false,
    onboardingChecklist: true,
    sep0007DeepLinks: false,
    debugMode: true,
    locale: 'en'
  };

  const markdown = formatCommentBody(result, commentConfig);
  
  const outPath = args[1];
  if (outPath) {
    fs.writeFileSync(path.resolve(process.cwd(), outPath), markdown, 'utf8');
    console.error(`Markdown written to ${outPath}`);
  } else {
    console.log(markdown);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
