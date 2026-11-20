// @ts-check
/**
 * HTTP for asset sources: global fetch with a timeout, retries with exponential backoff (network errors, 408,
 * 429, 5xx; honours Retry-After up to 30 s) and the factory User-Agent. Tokens are passed as headers by the caller
 * and never appear in error messages (SEC-01): errors name the URL without its query string.
 */
import { setTimeout as delay } from 'node:timers/promises';

export const USER_AGENT = 'game-factory-asset-index';

/** URL without query/fragment (query strings may carry keys). @param {string} url */
export function safeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '<invalid url>';
  }
}

/**
 * @param {string} url
 * @param {RequestInit & { timeoutMs?: number, retries?: number, backoffMs?: number }} [opts]
 * @returns {Promise<Response>}
 */
export async function httpFetch(url, opts = {}) {
  const { timeoutMs = 30000, retries = 3, backoffMs = 500, headers, ...init } = opts;
  const h = new Headers(/** @type {any} */ (headers) || {});
  if (!h.has('user-agent')) h.set('user-agent', USER_AGENT);
  let last = '';
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await delay(Math.min(30000, last.startsWith('retry-after:') ? Number(last.slice(12)) : backoffMs * 2 ** (attempt - 1)));
    let res;
    try {
      res = await fetch(url, { ...init, headers: h, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      last = `${/** @type {any} */ (e).name || 'Error'}: ${/** @type {any} */ (e).cause?.code || /** @type {any} */ (e).message}`;
      continue;
    }
    if (res.status === 408 || res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get('retry-after'));
      last = Number.isFinite(ra) && ra > 0 ? `retry-after:${ra * 1000}` : `HTTP ${res.status}`;
      await res.body?.cancel();
      continue;
    }
    return res;
  }
  throw new Error(`GET ${safeUrl(url)} failed after ${retries + 1} attempt(s): ${last.startsWith('retry-after:') ? 'rate limited' : last}`);
}
