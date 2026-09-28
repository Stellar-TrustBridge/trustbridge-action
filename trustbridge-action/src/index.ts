import * as core from '@actions/core';
import { Horizon } from '@stellar/stellar-sdk';
import { parseRetryAfter, sleep } from './resilience';

const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const server = new Horizon.Server(HORIZON_URL);

/**
 * Poll Horizon until the given account is funded, honoring Retry-After
 * headers from rate-limited (429) responses so we don't amplify 429s.
 */
export async function waitUntilFunded(
  publicKey: string,
  { timeoutMs = 60_000, intervalMs = 1_000 }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      await server.accounts().accountId(publicKey).call();
      return true;
    } catch (err: any) {
      const status = err?.response?.status ?? err?.status;
      const headers = err?.response?.headers ?? err?.headers ?? {};

      if (status === 429) {
        const retryAfter = parseRetryAfter(headers['retry-after'] ?? headers['Retry-After']);
        const delay = retryAfter ?? intervalMs;
        core.info(`Rate limited by Horizon; honoring Retry-After (${delay}ms) before next poll.`);
        await sleep(delay);
        continue;
      }

      // 404 means the account does not exist yet; keep polling.
      if (status === 404) {
        await sleep(intervalMs);
        continue;
      }

      throw err;
    }
  }

  return false;
}

async function run(): Promise<void> {
  try {
    const publicKey = core.getInput('public-key', { required: true });
    const timeoutMs = Number(core.getInput('timeout-ms') || '60000');

    const funded = await waitUntilFunded(publicKey, { timeoutMs });
    if (!funded) {
      core.setFailed(`Account ${publicKey} was not funded within ${timeoutMs}ms.`);
      return;
    }

    core.setOutput('funded', 'true');
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error));
  }
}

if (require.main === module) {
  void run();
}
