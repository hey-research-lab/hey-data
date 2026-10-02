import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HeyApiError } from '@hey-research-lab/sdk';
import { describe, expect, it } from 'vitest';
import { FORBIDDEN_FIELD } from '../src/allowlist.js';
import { TotalsMismatchError, generate, type GenerateOptions } from '../src/generate.js';
import { WorkStateError } from '../src/work.js';
import { fakeClock, keyPaths, listFiles, readJson, readNdjson, tempOut } from './helpers.js';
import { buildWorld, mockApi, type MockHooks, type World } from './mock-api.js';

const FILES = [
  'changes.ndjson',
  'evidence.ndjson',
  'metadata.json',
  'projects.ndjson',
  'ships.ndjson',
];

async function run(world: World, extra: Partial<GenerateOptions> = {}, hooks: MockHooks = {}) {
  const api = mockApi(world, hooks);
  const clock = fakeClock();
  const outDir = extra.outDir ?? tempOut();
  const result = await generate({
    outDir,
    fetchImpl: api.fetch,
    baseUrl: 'http://localhost',
    delayMs: 0,
    now: clock.now,
    sleep: clock.sleep,
    ...extra,
  });
  return { api, clock, outDir, result };
}

const snapshotOf = (dir: string) =>
  Object.fromEntries(
    FILES.filter((f) => f.endsWith('.ndjson')).map((f) => [f, readFileSync(join(dir, f), 'utf8')]),
  );

describe('a full run over recorded fixtures', () => {
  it('writes the four files and metadata, and nothing else', async () => {
    const { outDir } = await run(buildWorld());
    expect(listFiles(outDir)).toEqual(FILES);
    expect(existsSync(join(outDir, 'builders.ndjson'))).toBe(false);
  });

  it('never writes a forbidden field, although the recorded answers carry market data', async () => {
    const world = buildWorld();
    const input = JSON.stringify(world, (_k, v: unknown) =>
      v instanceof Map ? [...v.values()] : v,
    );
    for (const marker of [
      'marketCap',
      'liquidity',
      'volume24h',
      'tokenMarket',
      'stillBuilding',
      'buildMomentum',
    ]) {
      expect(input, `fixtures should exercise ${marker}`).toContain(marker);
    }
    const { outDir } = await run(world);
    for (const file of FILES.filter((f) => f.endsWith('.ndjson'))) {
      const keys = readNdjson(outDir, file).flatMap((record) => keyPaths(record));
      const bad = keys.filter((path) =>
        path.split(/\.|\[\]/).some((k) => k && FORBIDDEN_FIELD.test(k)),
      );
      expect(bad, file).toEqual([]);
    }
  });

  it('partitions projects by status and records the totals check', async () => {
    const world = buildWorld();
    const { outDir, api } = await run(world);
    const projects = readNdjson(outDir, 'projects.ndjson');
    expect(projects).toHaveLength(world.projects.length);
    expect(projects.map((p) => p['slug'])).toEqual([...projects.map((p) => p['slug'])].sort());
    const meta = readJson(outDir, 'metadata.json');
    const check = (meta['checks'] as Record<string, Record<string, unknown>>)[
      'projectsByStatus'
    ] as Record<string, unknown>;
    expect(check['total']).toBe(world.projects.length);
    expect(check['sum']).toBe(world.projects.length);
    expect(check['passed']).toBe(true);
    for (const status of ['SHIPPING', 'ACTIVE', 'QUIET', 'DORMANT', 'RESUMED', 'UNKNOWN']) {
      expect(api.calls.some((c) => c.includes(`status=${status}`))).toBe(true);
    }
  });

  it('keeps identity, states, narratives, the newest ship and coverage states', async () => {
    const { outDir } = await run(buildWorld());
    const bySlug = new Map(readNdjson(outDir, 'projects.ndjson').map((p) => [p['slug'], p]));
    const priors = bySlug.get('priors-agents') as Record<string, unknown>;
    expect(priors['token']).toEqual({
      chainId: 4663,
      contractAddress: '0x7e7154eb9dd81084625a7a2e9e731cadfddb9ab7',
    });
    expect(priors['tokenVerification']).toEqual({ status: 'UNVERIFIED', reason: 'market_listing' });
    expect((priors['narratives'] as unknown[]).length).toBe(3);
    expect((priors['latestShip'] as Record<string, unknown>)['evidenceId']).toMatch(/^ship:/);
    expect(priors['scoringVersion']).toBe('hbm-v22');
    const coverage = priors['coverage'] as Record<string, Record<string, unknown>>;
    expect(coverage['identity']?.['state']).toBe('MEASURED');
    expect(coverage['marketCurrent']).toBeUndefined();
    expect(coverage['distribution']).toBeUndefined();
    expect(coverage['contractActivity']).toBeUndefined();
    expect(priors['detailRead']).toBe('read');
  });

  it('keeps unknown unknown: an absent fact is absent, never 0, false or null', async () => {
    const world = buildWorld();
    const target = world.projects.find((p) => p['lastShippedAt']) as Record<string, unknown>;
    delete target['lastShippedAt'];
    const { outDir } = await run(world);
    const record = readNdjson(outDir, 'projects.ndjson').find((p) => p['slug'] === target['slug']);
    expect(record).toBeDefined();
    expect(Object.hasOwn(record as object, 'lastShippedAt')).toBe(false);
    // A project with no dossier score has no scoring fields at all.
    const unscored = readNdjson(outDir, 'projects.ndjson').filter((p) => !('scoringVersion' in p));
    for (const p of unscored) expect(p).not.toHaveProperty('scoredAt');
  });

  it('writes ships with provenance and their code week, never the embedded project card', async () => {
    const world = buildWorld();
    const { outDir } = await run(world);
    const ships = readNdjson(outDir, 'ships.ndjson');
    expect(ships).toHaveLength(world.ships.length);
    for (const ship of ships) {
      expect(ship['evidenceId']).toMatch(/^ship:/);
      expect(ship['sourceUrl']).toMatch(/^https:\/\//);
      expect(Object.keys(ship['project'] as object).sort()).toEqual(['name', 'slug', 'url']);
    }
  });

  it('keeps builder change types, drops market ones, applies revisions and retractions', async () => {
    const world = buildWorld();
    const { outDir } = await run(world);
    const changes = readNdjson(outDir, 'changes.ndjson');
    expect(changes.some((c) => String(c['type']).startsWith('market'))).toBe(false);
    expect(changes.some((c) => c['op'] === 'retract')).toBe(false);
    const first = world.changes[0] as Record<string, unknown>;
    const second = world.changes[1] as Record<string, unknown>;
    const revised = changes.find((c) => c['id'] === first['id']);
    expect(revised?.['revision']).toBe(2);
    expect(String(revised?.['summary'])).toContain('(revised)');
    expect(changes.find((c) => c['id'] === second['id'])).toBeUndefined();
    expect(changes.some((c) => c['type'] === 'lock.unlock_due')).toBe(true);
    const meta = readJson(outDir, 'metadata.json');
    const ledger = meta['changes'] as Record<string, unknown>;
    expect((ledger['excludedTypes'] as Record<string, number>)['market.status_changed']).toBe(3);
    expect(ledger['retractionsApplied']).toBe(1);
  });

  it('fetches evidence only for referenced ids of allowed families, within the limit', async () => {
    const { outDir, api } = await run(buildWorld(), { evidenceLimit: 5 });
    const evidenceCalls = api.calls.filter((c) => c.startsWith('/api/evidence/'));
    expect(evidenceCalls).toHaveLength(5);
    expect(evidenceCalls.some((c) => /signal%3A|method%3A|integrity%3A/.test(c))).toBe(false);
    const meta = readJson(outDir, 'metadata.json')['evidence'] as Record<string, unknown>;
    expect(meta['planned']).toBe(5);
    expect(meta['truncated']).toBe(true);
    const evidence = readNdjson(outDir, 'evidence.ndjson');
    expect(evidence.length).toBeGreaterThan(0);
    for (const e of evidence) {
      expect(e).not.toHaveProperty('sources.0.evidenceRowId');
      const metadata = (e['metadata'] ?? {}) as Record<string, unknown>;
      expect(metadata).not.toHaveProperty('summary');
    }
  });

  it('writes the metadata the founder asked for, with the CC BY 4.0 data licence', async () => {
    const { outDir } = await run(buildWorld());
    const meta = readJson(outDir, 'metadata.json');
    expect(meta['schemaVersion']).toBe(1);
    expect(meta['chainId']).toBe(4663);
    expect(meta['source']).toBe('https://heyresearch.xyz');
    expect(meta['license']).toBe('CC-BY-4.0');
    expect(meta['attribution']).toBe('HEY Research Lab, https://heyresearch.xyz');
    expect(meta['codeLicense']).toBe('MIT');
    expect(meta['apiVersion']).toBe('1');
    expect(typeof meta['generatedAt']).toBe('string');
    expect(
      (meta['endpoints'] as string[]).every((e) =>
        e.startsWith('GET https://heyresearch.xyz/api/'),
      ),
    ).toBe(true);
    const counts = meta['recordCount'] as Record<string, number>;
    for (const file of FILES.filter((f) => f.endsWith('.ndjson'))) {
      expect(counts[file]).toBe(readNdjson(outDir, file).length);
    }
    expect((meta['limitations'] as string[]).length).toBeGreaterThan(3);
    expect(existsSync(join(outDir, '.work'))).toBe(false);
  });

  it('reads listing fields only with details off', async () => {
    const { outDir, api } = await run(buildWorld(), { details: false });
    expect(api.calls.some((c) => /^\/api\/projects\/[^?]/.test(c))).toBe(false);
    for (const p of readNdjson(outDir, 'projects.ndjson')) {
      expect(p['detailRead']).toBe('skipped');
      expect(p).not.toHaveProperty('coverage');
    }
  });
});

describe('totals', () => {
  it('fails loudly when the status partitions do not add up', async () => {
    const world = buildWorld();
    world.lieAboutTotal = (q) => (q.get('status') === 'QUIET' ? 999 : undefined);
    await expect(run(world, { listAttempts: 2 })).rejects.toThrow(TotalsMismatchError);
  });

  it('fails loudly when the unfiltered total disagrees with the partitions', async () => {
    const world = buildWorld();
    world.lieAboutTotal = (q) => (q.get('status') === null ? world.projects.length + 1 : undefined);
    const failure = await run(world, { listAttempts: 1 }).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(TotalsMismatchError);
    expect(String((failure as Error).message)).toMatch(
      /add up to \d+, the unfiltered listing says \d+/,
    );
  });

  it('walks again when a total moved during the walk, and passes once it holds', async () => {
    const world = buildWorld();
    let lies = 1;
    world.lieAboutTotal = (q) => (q.get('status') === 'ACTIVE' && lies-- > 0 ? 50 : undefined);
    const { outDir } = await run(world);
    const meta = readJson(outDir, 'metadata.json');
    const check = (meta['checks'] as Record<string, Record<string, unknown>>)[
      'projectsByStatus'
    ] as Record<string, unknown>;
    expect(check['attempts']).toBe(2);
  });
});

describe('resume', () => {
  it('continues a stopped run from its cursor and ends with the same snapshot', async () => {
    const clean = await run(buildWorld());
    const outDir = tempOut();
    const failAt = 14;
    const stopped = await run(
      buildWorld(),
      { outDir },
      {
        intercept: (_url, n) =>
          n === failAt ? Promise.reject(new TypeError('socket hang up')) : undefined,
      },
    ).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(HeyApiError);
    expect(existsSync(join(outDir, '.work', 'cursor.json'))).toBe(true);

    const resumed = await run(buildWorld(), { outDir });
    expect(resumed.result.resumed).toBe(true);
    expect(snapshotOf(outDir)).toEqual(snapshotOf(clean.outDir));
    // Only the failed request is repeated, and at most the one project read it belonged to.
    expect(resumed.api.calls.length).toBeGreaterThanOrEqual(clean.api.calls.length - (failAt - 1));
    expect(resumed.api.calls.length).toBeLessThanOrEqual(clean.api.calls.length - (failAt - 2));
  });

  it('truncates bytes written past the cursor before continuing', async () => {
    const outDir = tempOut();
    await run(
      buildWorld(),
      { outDir },
      { intercept: (_u, n) => (n === 20 ? Promise.reject(new TypeError('reset')) : undefined) },
    ).catch(() => undefined);
    const { appendFileSync } = await import('node:fs');
    appendFileSync(join(outDir, '.work', 'project-details.ndjson'), '{"slug":"half-written');
    const clean = await run(buildWorld());
    await run(buildWorld(), { outDir });
    expect(snapshotOf(outDir)).toEqual(snapshotOf(clean.outDir));
  });

  it('refuses to resume with different options, and --restart discards the partial run', async () => {
    const outDir = tempOut();
    await run(
      buildWorld(),
      { outDir },
      { intercept: (_u, n) => (n === 5 ? Promise.reject(new TypeError('x')) : undefined) },
    ).catch(() => undefined);
    await expect(run(buildWorld(), { outDir, evidenceLimit: 1 })).rejects.toThrow(WorkStateError);
    const restarted = await run(buildWorld(), { outDir, evidenceLimit: 1, restart: true });
    expect(restarted.result.resumed).toBe(false);
  });
});

describe('rate limits', () => {
  it("honours a 429's retry-after, then carries on", async () => {
    const world = buildWorld();
    let sent = false;
    const { clock, result } = await run(
      world,
      {},
      {
        intercept: () => {
          if (sent) return undefined;
          sent = true;
          return new Response(
            JSON.stringify({
              error: 'rate_limited',
              message: 'Too many requests.',
              requestId: 'r',
              retryable: true,
              retryAfterSeconds: 7,
            }),
            {
              status: 429,
              headers: { 'retry-after': '7' },
            },
          );
        },
      },
    );
    expect(clock.waits).toContain(7000);
    expect(result.stats.retries).toBe(1);
  });

  it('stops with rate_limited when the server keeps refusing past the retry budget', async () => {
    const failure = await run(
      buildWorld(),
      { maxRetries: 1 },
      {
        intercept: () =>
          new Response('{"error":"rate_limited","message":"Too many requests.","retryable":true}', {
            status: 429,
            headers: { 'retry-after': '2' },
          }),
      },
    ).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(HeyApiError);
    expect((failure as HeyApiError).code).toBe('rate_limited');
  });

  it('paces requests at the configured delay', async () => {
    const { clock, api } = await run(buildWorld(), { delayMs: 1100, evidenceLimit: 0 });
    expect(clock.waits.length).toBe(api.calls.length - 1);
    expect(clock.waits.every((w) => w === 1100)).toBe(true);
  });
});
