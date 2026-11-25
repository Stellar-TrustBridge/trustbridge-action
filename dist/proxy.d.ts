/** Proxy URL helpers. Error text from HTTP clients may include proxy URLs. */
/**
 * Mask URL userinfo in arbitrary error text while retaining the scheme and
 * proxy host. This intentionally works on malformed URLs too, since the
 * value commonly arrives inside a client error message rather than alone.
 */
export declare function redactProxyCredentials(value: string): string;
/** Normalize an unknown thrown value to safe, credential-redacted text. */
export declare function safeProxyErrorMessage(error: unknown): string;
