import { logger } from './logger';

/**
 * SEP-0010 (Stellar Web Authentication) link configuration.
 *
 * A SEP-0010 auth link is only safe when it points at an HTTPS endpoint.
 * Plain HTTP links, or links with no host, can leak the challenge/transaction
 * over the wire or produce broken auth links in comments.
 */
export interface Sep0010Config {
  /** Base URL of the SEP-0010 auth endpoint (e.g. https://auth.example.com). */
  authEndpoint?: string;
  /** Optional account used to build the challenge link. */
  account?: string;
}

/**
 * Validate a SEP-0010 link configuration and warn when it is insecure or
 * invalid. Returns the endpoint that should be used for link generation.
 *
 * Fallback behavior: when the configured endpoint is missing, malformed, or
 * not HTTPS, we log a warning and fall back to the provided `fallbackEndpoint`
 * (or `undefined` when none is available) so that no insecure link is emitted.
 */
export function resolveSep0010Endpoint(
  config: Sep0010Config | undefined,
  fallbackEndpoint?: string,
): string | undefined {
  const endpoint = config?.authEndpoint?.trim();

  if (!endpoint) {
    logger.warn(
      'SEP-0010 auth endpoint is not configured; falling back to default link behavior.',
    );
    return fallbackEndpoint;
  }

  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    logger.warn(
      `SEP-0010 auth endpoint "${endpoint}" is not a valid URL; falling back to default link behavior.`,
    );
    return fallbackEndpoint;
  }

  if (parsed.protocol !== 'https:') {
    logger.warn(
      `SEP-0010 auth endpoint "${endpoint}" is insecure (expected https); falling back to default link behavior.`,
    );
    return fallbackEndpoint;
  }

  if (!parsed.hostname) {
    logger.warn(
      `SEP-0010 auth endpoint "${endpoint}" is missing a host; falling back to default link behavior.`,
    );
    return fallbackEndpoint;
  }

  return endpoint;
}

/**
 * Build a SEP-0010 authentication link for use in comments.
 *
 * Uses {@link resolveSep0010Endpoint} so that insecure or invalid
 * configurations are warned about and never produce an unsafe link.
 */
export function buildSep0010Link(
  config: Sep0010Config | undefined,
  fallbackEndpoint?: string,
): string | undefined {
  const endpoint = resolveSep0010Endpoint(config, fallbackEndpoint);
  if (!endpoint) {
    return undefined;
  }

  const base = endpoint.replace(/\/+$/, '');
  const account = config?.account?.trim();
  return account ? `${base}?account=${encodeURIComponent(account)}` : base;
}
