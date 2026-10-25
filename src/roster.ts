import * as crypto from 'crypto';
import { AssigneeAddressMap } from './inputs';
import { validateSsrfSafeUrl } from './validation';

const MAX_ROSTER_SIZE_BYTES = 1024 * 1024; // 1 MB limit

export interface RosterFilterOptions {
  allowlist?: string[];
  denylist?: string[];
}

function normalizeRosterAddress(address: string): string {
  return address.trim().toLowerCase();
}

/**
 * Filter a batch assignee address map against roster allowlist/denylist entries.
 *
 * - Allowlist: when non-empty, only entries whose address is in the allowlist are kept.
 * - Denylist: entries whose address is in the denylist are always removed.
 * - Denylist takes precedence over allowlist.
 * - Empty allowlist means "allow all" (subject to denylist).
 * - Empty map returns an empty map.
 * - Matching is case-insensitive and whitespace-trimmed.
 */
export function filterRosterAddressMap(
  addressMap: AssigneeAddressMap,
  options: RosterFilterOptions = {}
): AssigneeAddressMap {
  const allowlist = new Set((options.allowlist ?? []).map(normalizeRosterAddress).filter(Boolean));
  const denylist = new Set((options.denylist ?? []).map(normalizeRosterAddress).filter(Boolean));

  const result: AssigneeAddressMap = {};
  for (const [key, value] of Object.entries(addressMap)) {
    const normalized = normalizeRosterAddress(value);
    if (denylist.has(normalized)) continue;
    if (allowlist.size > 0 && !allowlist.has(normalized)) continue;
    result[key] = value;
  }
  return result;
}

export async function fetchDashboardRoster(
  url: string,
  secret: string,
  timeoutMs: number,
  allowHttp: boolean = false,
  fetchFn: typeof fetch = fetch
): Promise<AssigneeAddressMap> {
  const trimmedUrl = url.trim();
  if (!trimmedUrl) {
    throw new Error('Dashboard roster URL cannot be empty.');
  }

  const ssrfCheck = validateSsrfSafeUrl(trimmedUrl, 'dashboard_roster_url', { allowHttp });
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
      const redirectSsrf = validateSsrfSafeUrl(redirectUrl, 'dashboard_roster_redirect', { allowHttp });
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
  const body = currentResponse.body;
  let receivedBytes = 0;
  const chunks: Uint8Array[] = [];

  if (body && typeof body.getReader === 'function') {
    // Web Streams API
    const reader = body.getReader();
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
  } else if (body && typeof (body as unknown as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    // Node streams or other AsyncIterables
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      const data = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      receivedBytes += data.length;
      if (receivedBytes > MAX_ROSTER_SIZE_BYTES) {
        throw new Error('Response exceeded size limit');
      }
      chunks.push(data);
    }
  } else {
    // Fallback to arrayBuffer if no streaming is available
    const buffer = await currentResponse.arrayBuffer();
    if (buffer.byteLength > MAX_ROSTER_SIZE_BYTES) {
      throw new Error('Response exceeded size limit');
    }
    chunks.push(new Uint8Array(buffer));
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
