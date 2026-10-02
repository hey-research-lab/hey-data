/**
 * The one door to the network. HEY's anonymous limit is 120 requests a minute
 * per client; hey-data paces itself far below it (one request per `delayMs`,
 * 1,100 ms by default, about 55 a minute), honours `retry-after` on a 429 or a
 * 503, and retries a retryable answer a bounded number of times with the
 * server's delay. It never follows a redirect and caps every body.
 */
import { retryAfterSeconds, type FetchLike } from '@hey-research-lab/sdk';

export const DEFAULT_BASE_URL = 'https://heyresearch.xyz';
export const DEFAULT_DELAY_MS = 1_100;
export const MIN_CLI_DELAY_MS = 600;
export const DEFAULT_MAX_RETRIES = 1;
export const MAX_RETRIES_CAP = 5;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const DEFAULT_BACKOFF_SECONDS = { 429: 60, other: 30 } as const;

export class BaseUrlError extends Error {
  readonly code = 'invalid_base_url';
}

/**
 * HEY's API lives at https://heyresearch.xyz. `HEY_BASE_URL` exists for tests
 * and local mocks only: an https origin, or http on localhost / 127.0.0.1.
 */
export function resolveBaseUrl(override: string | undefined): string {
  if (!override) return DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new BaseUrlError('HEY_BASE_URL is not a URL.');
  }
  const local = url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname);
  if (!(url.protocol === 'https:' || local) || url.username || url.password) {
    throw new BaseUrlError('HEY_BASE_URL must be https, or http on localhost / 127.0.0.1.');
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new BaseUrlError('HEY_BASE_URL must be an origin with no path, query or fragment.');
  }
  return url.origin;
}

export type RequestStats = {
  requests: number;
  retries: number;
  waitedForServerMs: number;
  apiVersion?: string;
  lastRequestId?: string;
};

export type PoliteFetchOptions = {
  fetchImpl: FetchLike;
  delayMs: number;
  maxRetries: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** A server asking for a longer wait than this ends the run instead (resume later). */
  maxRetryAfterSeconds?: number;
  maxBodyBytes?: number;
  /** Per attempt, in milliseconds (default 30 000). */
  timeoutMs?: number;
  log?: (line: string) => void;
};

export const realSleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export class BodyTooLargeError extends Error {
  readonly code = 'payload_too_large';
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new BodyTooLargeError(`Response body exceeds ${maxBytes} bytes.`);
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new BodyTooLargeError(`Response body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A `fetch` for the SDK that paces, retries within bounds, records headers and caps bodies. */
export function politeFetch(options: PoliteFetchOptions): {
  fetch: FetchLike;
  stats: RequestStats;
} {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const maxRetries = Math.min(Math.max(0, Math.floor(options.maxRetries)), MAX_RETRIES_CAP);
  const maxRetryAfter = options.maxRetryAfterSeconds ?? 900;
  const maxBody = options.maxBodyBytes ?? 8 * 1024 * 1024;
  const stats: RequestStats = { requests: 0, retries: 0, waitedForServerMs: 0 };
  let nextSlot = 0;

  const timeoutMs = options.timeoutMs ?? 30_000;

  /**
   * One attempt under its own timeout. The caller's signal is not forwarded:
   * the SDK's timer would also run through hey-data's pacing and retry-after
   * waits, so each attempt carries its own instead.
   */
  const attempt = async (input: string, init: RequestInit | undefined, mayRetry: boolean) => {
    const wait = nextSlot - now();
    if (wait > 0) await sleep(wait);
    nextSlot = now() + options.delayMs;
    stats.requests += 1;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { signal: _ignored, ...rest } = init ?? {};
      const response = await options.fetchImpl(input, {
        ...rest,
        signal: controller.signal,
        redirect: 'manual',
      });
      const version = response.headers.get('x-hey-api-version');
      if (version) stats.apiVersion = version;
      const requestId = response.headers.get('x-request-id');
      if (requestId) stats.lastRequestId = requestId;
      if (mayRetry && RETRYABLE.has(response.status)) {
        await response.body?.cancel().catch(() => undefined);
        return { response, body: undefined };
      }
      return { response, body: await readCapped(response, maxBody) };
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`HEY did not answer within ${timeoutMs} ms.`, { cause: error });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };

  const fetchImpl: FetchLike = async (input, init) => {
    let retries = 0;
    for (;;) {
      const { response, body } = await attempt(input, init, retries < maxRetries);
      if (body === undefined) {
        const told = retryAfterSeconds(response.headers.get('retry-after'));
        const seconds =
          told ??
          (response.status === 429 ? DEFAULT_BACKOFF_SECONDS[429] : DEFAULT_BACKOFF_SECONDS.other);
        if (seconds <= maxRetryAfter) {
          retries += 1;
          stats.retries += 1;
          stats.waitedForServerMs += seconds * 1000;
          options.log?.(
            `HEY answered ${response.status}; waiting ${seconds}s as asked, then retrying (retry ${retries} of ${maxRetries}).`,
          );
          await sleep(seconds * 1000);
          nextSlot = now() + options.delayMs;
          continue;
        }
      }
      const nullBody = body === undefined || [101, 204, 205, 304].includes(response.status);
      return new Response(nullBody ? null : body, {
        status: response.status,
        headers: response.headers,
      });
    }
  };

  return { fetch: fetchImpl, stats };
}
