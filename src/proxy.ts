/** Proxy URL helpers. Error text from HTTP clients may include proxy URLs. */

const PROXY_URL_WITH_USERINFO = /([a-z][a-z\d+.-]*:\/\/)([^\s/]+)@/gi;

/**
 * Mask URL userinfo in arbitrary error text while retaining the scheme and
 * proxy host. This intentionally works on malformed URLs too, since the
 * value commonly arrives inside a client error message rather than alone.
 */
export function redactProxyCredentials(value: string): string {
  if (!value) return value;
  return value.replace(PROXY_URL_WITH_USERINFO, '$1***@');
}

/** Normalize an unknown thrown value to safe, credential-redacted text. */
export function safeProxyErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactProxyCredentials(message);
}
