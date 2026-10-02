import { describe, expect, it } from 'vitest';
import { BaseUrlError, BodyTooLargeError, politeFetch, resolveBaseUrl } from '../src/http.js';
import { fakeClock } from './helpers.js';

describe('resolveBaseUrl', () => {
  it('defaults to HEY and accepts https origins or http on localhost only', () => {
    expect(resolveBaseUrl(undefined)).toBe('https://heyresearch.xyz');
    expect(resolveBaseUrl('http://localhost:3100')).toBe('http://localhost:3100');
    expect(resolveBaseUrl('http://127.0.0.1')).toBe('http://127.0.0.1');
    for (const bad of [
      'http://example.org',
      'ftp://heyresearch.xyz',
      'https://user:pass@heyresearch.xyz',
      'https://heyresearch.xyz/api',
      'https://heyresearch.xyz/?x=1',
      'not a url',
      'http://169.254.169.254',
    ]) {
      expect(() => resolveBaseUrl(bad), bad).toThrow(BaseUrlError);
    }
  });
});

describe('politeFetch', () => {
  const ok = () =>
    new Response('{}', {
      status: 200,
      headers: { 'x-hey-api-version': '1', 'x-request-id': 'abc' },
    });

  it('never asks fetch to follow a redirect and records the API version', async () => {
    let seen: RequestInit | undefined;
    const clock = fakeClock();
    const polite = politeFetch({
      fetchImpl: async (_input, init) => {
        seen = init;
        return ok();
      },
      delayMs: 0,
      maxRetries: 0,
      sleep: clock.sleep,
      now: () => clock.now().getTime(),
    });
    await polite.fetch('http://localhost/api/projects', { redirect: 'follow' });
    expect(seen?.redirect).toBe('manual');
    expect(polite.stats.apiVersion).toBe('1');
    expect(polite.stats.lastRequestId).toBe('abc');
  });

  it('caps response bodies', async () => {
    const clock = fakeClock();
    const polite = politeFetch({
      fetchImpl: async () => new Response('x'.repeat(2048)),
      delayMs: 0,
      maxRetries: 0,
      maxBodyBytes: 1024,
      sleep: clock.sleep,
      now: () => clock.now().getTime(),
    });
    await expect(polite.fetch('http://localhost/x')).rejects.toThrow(BodyTooLargeError);
  });

  it('retries a 503 with its retry-after, and gives up on a wait longer than the ceiling', async () => {
    const clock = fakeClock();
    let calls = 0;
    const polite = politeFetch({
      fetchImpl: async () => {
        calls += 1;
        return calls === 1
          ? new Response('{}', { status: 503, headers: { 'retry-after': '4' } })
          : ok();
      },
      delayMs: 0,
      maxRetries: 1,
      sleep: clock.sleep,
      now: () => clock.now().getTime(),
    });
    expect((await polite.fetch('http://localhost/x')).status).toBe(200);
    expect(clock.waits).toContain(4000);

    const long = politeFetch({
      fetchImpl: async () =>
        new Response('{}', { status: 429, headers: { 'retry-after': '3600' } }),
      delayMs: 0,
      maxRetries: 3,
      maxRetryAfterSeconds: 900,
      sleep: clock.sleep,
      now: () => clock.now().getTime(),
    });
    expect((await long.fetch('http://localhost/x')).status).toBe(429);
    expect(long.stats.retries).toBe(0);
  });

  it('does not retry a 4xx that is not a rate limit', async () => {
    const clock = fakeClock();
    let calls = 0;
    const polite = politeFetch({
      fetchImpl: async () => {
        calls += 1;
        return new Response('{"error":"not_found"}', { status: 404 });
      },
      delayMs: 0,
      maxRetries: 5,
      sleep: clock.sleep,
      now: () => clock.now().getTime(),
    });
    expect((await polite.fetch('http://localhost/x')).status).toBe(404);
    expect(calls).toBe(1);
  });
});
