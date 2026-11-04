import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ForbiddenFieldError } from '../src/allowlist.js';
import { UnsupportedChainError } from '../src/chain.js';
import { HooksChecksumError, HooksFetchError, copyHooks } from '../src/hooks.js';
import { readJson, readNdjson, tempOut } from './helpers.js';

const BASE = 'https://heyresearch.xyz';
const DAY = '2026-11-05';
const HOOK = '0x0000000000000000000000000000000000bbc0c0';
const OTHER = '0x0000000000000000000000000000000000bb10c0';

const tiedHook = {
  evidenceId: `v4hook:4663:${HOOK}`,
  chainId: 4663,
  address: HOOK,
  explorerUrl: `https://robinhoodchain.blockscout.com/address/${HOOK}`,
  receiptUrl: `${BASE}/evidence/v4hook:4663:${HOOK}`,
  callbacks: 'beforeSwap,afterSwap',
  tied: true,
  project: { slug: 'hookteam', name: 'Hook Team', url: `${BASE}/project/hookteam` },
  basis: 'project',
  basisLabel: 'Listed by the project',
  tie: 'Listed by the project as its own contract',
  hooklist: {
    name: 'TeamHook',
    url: 'https://github.com/Uniswap/hooklist/blob/abc123/hooks/robinhood/x.json',
  },
  firstPoolBlock: 2,
};
const otherHook = {
  evidenceId: `v4hook:4663:${OTHER}`,
  chainId: 4663,
  address: OTHER,
  explorerUrl: `https://robinhoodchain.blockscout.com/address/${OTHER}`,
  receiptUrl: `${BASE}/evidence/v4hook:4663:${OTHER}`,
  callbacks: 'afterSwap',
  tied: false,
};

function site(
  lines: readonly object[],
  overrides: { sums?: string; status?: Record<string, number>; chainId?: number } = {},
) {
  const gz = gzipSync(Buffer.from(lines.map((line) => JSON.stringify(line)).join('\n') + '\n'));
  const sha = createHash('sha256').update(gz).digest('hex');
  const files: Record<string, Buffer> = {
    [`/data/latest/metadata.json`]: Buffer.from(
      JSON.stringify({ day: DAY, chainId: overrides.chainId ?? 4663 }),
    ),
    [`/data/${DAY}/SHA256SUMS`]: Buffer.from(
      overrides.sums ?? `${'0'.repeat(64)}  projects.ndjson.gz\n${sha}  hooks.ndjson.gz\n`,
    ),
    [`/data/${DAY}/hooks.ndjson.gz`]: gz,
  };
  const asked: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    asked.push(url.pathname);
    const status = overrides.status?.[url.pathname];
    if (status) return new Response('no', { status });
    const body = files[url.pathname];
    return body ? new Response(new Uint8Array(body)) : new Response('missing', { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, asked };
}

const run = (fetchImpl: typeof fetch, outDir = tempOut()) =>
  copyHooks({
    outDir,
    fetchImpl,
    sleep: async () => undefined,
    now: () => new Date('2026-11-05T02:00:00Z'),
  });

describe('hey-data hooks', () => {
  it('copies the newest day’s file through the allowlist and writes its own metadata', async () => {
    const out = tempOut();
    const { fetchImpl, asked } = site([tiedHook, otherHook]);
    const { metadata } = await run(fetchImpl, out);
    expect(asked).toEqual([
      '/data/latest/metadata.json',
      `/data/${DAY}/SHA256SUMS`,
      `/data/${DAY}/hooks.ndjson.gz`,
    ]);
    const records = readNdjson(out, 'hooks.ndjson');
    expect(records).toEqual([tiedHook, otherHook]);
    expect(metadata).toMatchObject({
      day: DAY,
      recordCount: 2,
      tied: 1,
      notTied: 1,
      license: 'CC-BY-4.0',
      citation: `HEY Research Lab, ${BASE}/data/${DAY}/, retrieved ${DAY}`,
    });
    expect(readJson(out, 'hooks.metadata.json')).toMatchObject({
      source: `${BASE}/data/${DAY}/hooks.ndjson.gz`,
    });
  });

  it('refuses a file whose checksum does not match, a key outside the allowlist and another chain', async () => {
    await expect(
      run(site([tiedHook], { sums: `${'f'.repeat(64)}  hooks.ndjson.gz\n` }).fetchImpl),
    ).rejects.toBeInstanceOf(HooksChecksumError);
    await expect(run(site([{ ...tiedHook, pools: 4 }]).fetchImpl)).rejects.toBeInstanceOf(
      ForbiddenFieldError,
    );
    await expect(run(site([{ ...tiedHook, marketCap: 1 }]).fetchImpl)).rejects.toBeInstanceOf(
      ForbiddenFieldError,
    );
    await expect(run(site([{ ...tiedHook, chainId: 1 }]).fetchImpl)).rejects.toBeInstanceOf(
      UnsupportedChainError,
    );
    await expect(run(site([tiedHook], { chainId: 8453 }).fetchImpl)).rejects.toBeInstanceOf(
      UnsupportedChainError,
    );
  });

  it('says plainly when a snapshot has no hooks file, and retries only an outage', async () => {
    const none = run(
      site([tiedHook], { sums: `${'0'.repeat(64)}  projects.ndjson.gz\n` }).fetchImpl,
    );
    await expect(none).rejects.toMatchObject({ status: 404 });
    const down = site([tiedHook], { status: { [`/data/${DAY}/hooks.ndjson.gz`]: 503 } });
    await expect(run(down.fetchImpl)).rejects.toBeInstanceOf(HooksFetchError);
    expect(down.asked.filter((p) => p.endsWith('hooks.ndjson.gz'))).toHaveLength(3);
    const gone = site([tiedHook], { status: { [`/data/${DAY}/hooks.ndjson.gz`]: 404 } });
    await expect(run(gone.fetchImpl)).rejects.toMatchObject({ status: 404 });
    expect(gone.asked.filter((p) => p.endsWith('hooks.ndjson.gz'))).toHaveLength(1);
  });
});
