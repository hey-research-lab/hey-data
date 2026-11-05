import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ForbiddenFieldError } from '../src/allowlist.js';
import { HooksChecksumError } from '../src/hooks.js';
import { prepareHuggingFaceMirror } from '../src/huggingface.js';
import { tempOut } from './helpers.js';

const DAY = '2026-11-05';
const BOM = '﻿';

const baseFiles = (): Record<string, string> => ({
  'projects.csv': `${BOM}slug,name,url,activityStatus\r\nloom,Loom,https://heyresearch.xyz/project/loom,ACTIVE\r\n`,
  'ships.csv': `${BOM}evidenceId,eventType,title\r\nship:1,GITHUB_RELEASE,v1.0.0\r\n`,
  'hooks.csv': `${BOM}evidenceId,chainId,address,tied,project.slug\r\nv4hook:4663:0x1,4663,0x0000000000000000000000000000000000bbc0c0,true,loom\r\n`,
  'metadata.json': JSON.stringify({
    day: DAY,
    chainId: 4663,
    recordCount: {
      'projects.ndjson': 1,
      'ships.ndjson': 1,
      'changes.ndjson': 3,
      'hooks.ndjson': 1,
    },
  }),
});

function site(files: Record<string, string>, sumsOverride?: Record<string, string>) {
  const bodies: Record<string, Buffer> = Object.fromEntries(
    Object.entries(files).map(([name, body]) => [`/data/${DAY}/${name}`, Buffer.from(body)]),
  );
  const sums = Object.entries(files)
    .map(
      ([name, body]) =>
        `${sumsOverride?.[name] ?? createHash('sha256').update(body).digest('hex')}  ${name}`,
    )
    .join('\n');
  bodies[`/data/${DAY}/SHA256SUMS`] = Buffer.from(`${sums}\n`);
  bodies['/data/latest/metadata.json'] = Buffer.from(JSON.stringify({ day: DAY, chainId: 4663 }));
  return (async (input: string | URL | Request) => {
    const body = bodies[new URL(String(input)).pathname];
    return body ? new Response(new Uint8Array(body)) : new Response('missing', { status: 404 });
  }) as typeof fetch;
}

const run = (fetchImpl: typeof fetch, outDir = tempOut()) =>
  prepareHuggingFaceMirror({ outDir, fetchImpl, sleep: async () => undefined });

describe('hey-data huggingface', () => {
  it('writes the newest day’s four files unchanged and a card naming the day and the counts', async () => {
    const out = tempOut();
    const result = await run(site(baseFiles()), out);
    expect(result).toEqual({ day: DAY, counts: { projects: 1, ships: 1, hooks: 1 } });
    expect(readFileSync(join(out, 'hooks.csv'), 'utf8')).toBe(baseFiles()['hooks.csv']);
    const card = readFileSync(join(out, 'README.md'), 'utf8');
    expect(card).toMatch(/^---\nlicense: cc-by-4.0\n/);
    expect(card).toContain(`snapshot of ${DAY}`);
    expect(card).toContain('`hooks.csv` (1 rows)');
    expect(card).toContain(`https://heyresearch.xyz/data/${DAY}/, retrieved ${DAY}`);
  });

  it('refuses a file whose checksum does not match, and a column outside the allowlist', async () => {
    await expect(run(site(baseFiles(), { 'ships.csv': 'f'.repeat(64) }))).rejects.toBeInstanceOf(
      HooksChecksumError,
    );
    const market = { ...baseFiles(), 'projects.csv': `${BOM}slug,marketCapUsd\r\nloom,1\r\n` };
    await expect(run(site(market))).rejects.toBeInstanceOf(ForbiddenFieldError);
    const unknown = { ...baseFiles(), 'hooks.csv': `${BOM}address,creator\r\n0x1,0x2\r\n` };
    await expect(run(site(unknown))).rejects.toBeInstanceOf(ForbiddenFieldError);
  });

  it('says plainly when the day lists no hooks file', async () => {
    const { 'hooks.csv': _, ...rest } = baseFiles();
    await expect(run(site(rest))).rejects.toMatchObject({ status: 404 });
  });
});
