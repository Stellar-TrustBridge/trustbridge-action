import * as crypto from 'crypto';
import { AssigneeAddressMap } from './inputs';
import { validateSsrfSafeUrl } from './validation';

const MAX_ROSTER_SIZE_BYTES = 1024 * 1024; // 1 MB limit

export async function fetchDashboardRoster(
  url: string,
  secret: string,
  timeoutMs: number,
  fetchFn: typeof fetch = fetch
): Promise<AssigneeAddressMap> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error('Dashboard roster URL cannot be empty.');
  }

  const ssrfCheck = validateSsrfSafeUrl(trimmedUrl, 'dashboard_roster_url', { allowHttp: true });
  if (!ssrfCheck.valid) {
    throw new Error(`Dashboard roster URL failed security validation: ${ssrfCheck.errors.join(', ')}`);
  }

  const timestamp = Date.now().toString();
  const signature = secret
    ? crypto.createHmac('sha256', secret).update(timestamp).digest('hex')
    : '';

  const headers: Record<string, string> = {
    'Accept': 'application/json',
  };

  if (signature) {
    headers['X-TrustBridge-Timestamp'] = timestamp;
    headers['X-TrustBridge-Signature'] = `sha256=${signature}`;
  }

  let currentResponse: Response;
  let targetUrl = trimmedUrl;
  let redirects = 0;

  while (true) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      currentResponse = await fetchFn(targetUrl, {
        method: 'GET',
        headers,
        signal: controller.signal as AbortSignal,
        redirect: 'manual', // We handle redirects manually for SSRF validation
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to fetch dashboard roster: ${msg}`);
    } finally {
      clearTimeout(timeoutId);
    }

    if ([301, 302, 303, 307, 308].includes(currentResponse.status)) {
      if (redirects >= 5) throw new Error('Too many redirects');
      redirects++;
      const location = currentResponse.headers.get('location');
      if (!location) throw new Error('Redirect missing location');

      const redirectUrl = new URL(location, targetUrl).toString();
      const redirectSsrf = validateSsrfSafeUrl(redirectUrl, 'dashboard_roster_redirect', { allowHttp: true });
      if (!redirectSsrf.valid) {
        throw new Error(`Dashboard roster redirect failed security validation: ${redirectSsrf.errors.join(', ')}`);
      }

      targetUrl = redirectUrl;
      continue;
    }

    break;
  }

  if (!currentResponse.ok) {
    throw new Error(`Dashboard roster returned HTTP ${currentResponse.status}`);
  }

  if (!currentResponse.body) {
     throw new Error('Response body is empty');
  }

  // Stream body to enforce size limit safely
  const reader = (currentResponse.body as any).getReader();
  let receivedBytes = 0;
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        receivedBytes += value.length;
        if (receivedBytes > MAX_ROSTER_SIZE_BYTES) {
          throw new Error('Response exceeded size limit');
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const text = Buffer.concat(chunks).toString('utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Dashboard roster returned invalid JSON');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Dashboard roster JSON must be an object');
  }

  const result: AssigneeAddressMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
       throw new Error(`Dashboard roster entry for "${key}" must be a string Stellar G-address.`);
    }
    result[key.trim().toLowerCase()] = value.trim();
  }

  return result;
}
