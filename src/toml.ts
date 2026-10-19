import * as crypto from 'crypto';
import { fetchSSRFSafe } from './ssrf';
import { defaultCache } from './cache';
import { logger } from './logger';

export type HashPin = string;

export interface ParsedHashPin {
  algorithm: 'sha256' | 'sha512';
  expectedHex: string;
}

export interface TomlFetchResult {
  ok: true;
  content: string;
  hash?: string;
  cachedAt: number;
  fetched: boolean;
}

export interface TomlFetchError {
  ok: false;
  error: string;
  cachedAt: number;
}

export type TomlFetchOutcome = TomlFetchResult | TomlFetchError;

export function parseHashPin(pin: string): ParsedHashPin | undefined {
  if (!pin || typeof pin !== 'string') return undefined;
  const parts = pin.trim().split(':');
  if (parts.length !== 2) return undefined;
  const [algorithm, expectedHex] = parts;
  const normalized = algorithm.toLowerCase();
  if (normalized !== 'sha256' && normalized !== 'sha512') return undefined;
  const expectedLen = normalized === 'sha256' ? 64 : 128;
  if (!new RegExp(`^[0-9a-fA-F]{${expectedLen}}$`).test(expectedHex)) return undefined;
  return { algorithm: normalized, expectedHex: expectedHex.toLowerCase() };
}

export function computeHash(content: string, algorithm: 'sha256' | 'sha512'): string {
  return crypto.createHash(algorithm).update(content, 'utf8').digest('hex');
}

export function validateTomlHash(
  content: string,
  pin: string | undefined,
): { valid: true; hash: string } | { valid: false; error: string } {
  if (!pin) return { valid: true, hash: '' };
  const parsed = parseHashPin(pin);
  if (!parsed) return { valid: false, error: 'Invalid hash pin format.' };
  const computed = computeHash(content, parsed.algorithm);
  return computed === parsed.expectedHex
    ? { valid: true, hash: computed }
    : { valid: false, error: `TOML hash mismatch: got ${computed}, expected ${parsed.expectedHex}` };
}

export function buildTomlCacheKey(domain: string): string {
  return `toml:${domain.trim().toLowerCase()}`;
}

interface CachedTomlEntry {
  content: string;
  fetchedAt: number;
  hash?: string;
}

export async function fetchTomlWithCache(
  domain: string,
  options: { cacheTtlMs?: number; hashPin?: string; maxBodyBytes?: number } = {},
): Promise<TomlFetchOutcome> {
  const startTime = Date.now();
  const cacheTtlMs = options.cacheTtlMs ?? 3600000;
  const domainNorm = domain.trim().toLowerCase();
  if (!domainNorm) return { ok: false, error: 'Domain is empty', cachedAt: startTime };

  const cacheKey = buildTomlCacheKey(domainNorm);
  const cached = defaultCache.get<CachedTomlEntry>(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < cacheTtlMs) {
    if (options.hashPin) {
      const validation = validateTomlHash(cached.content, options.hashPin);
      if (!validation.valid) return { ok: false, error: 'error' in validation ? validation.error : 'Invalid TOML hash', cachedAt: cached.fetchedAt };
    }
    return { ok: true, content: cached.content, hash: cached.hash, cachedAt: cached.fetchedAt, fetched: false };
  }

  const fetchResult = await fetchSSRFSafe(`https://${domainNorm}/.well-known/stellar.toml`, {
    maxBodyBytes: options.maxBodyBytes ?? 256 * 1024,
    timeoutMs: 10000,
    followRedirects: false,
  });
  if (!fetchResult.ok) {
    const error = 'error' in fetchResult ? fetchResult.error : 'Unknown TOML fetch error';
    logger.warn(`Failed to fetch stellar.toml from ${domainNorm}: ${error}`, { component: 'toml', domain: domainNorm });
    return { ok: false, error, cachedAt: startTime };
  }

  const content = await fetchResult.text();
  const validation = validateTomlHash(content, options.hashPin);
  if (!validation.valid) return { ok: false, error: 'error' in validation ? validation.error : 'Invalid TOML hash', cachedAt: startTime };
  const hash = validation.hash || computeHash(content, 'sha256');
  defaultCache.set<CachedTomlEntry>(cacheKey, { content, fetchedAt: startTime, hash }, cacheTtlMs);
  return { ok: true, content, hash, cachedAt: startTime, fetched: true };
}
