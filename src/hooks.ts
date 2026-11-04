/**
 * hey-data hooks — copies HEY's daily hooks file into a snapshot directory as `hooks.ndjson`.
 *
 * HEY publishes every Uniswap v4 hook its hooks page shows as `/data/<day>/hooks.ndjson.gz`, with a checksum in
 * `/data/<day>/SHA256SUMS`. The public API answers at most 100 hooks a call and counts factory instances, so the file
 * is the complete record. This command reads the newest day's metadata, then that day's (immutable) checksum and file,
 * refuses a file whose checksum does not match, and gates every line through `HOOK_RECORD` exactly as the generator
 * gates its own files: an unknown or forbidden key, or a chain other than 4663, stops the copy.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { HOOK_RECORD, SchemaDriftError, assertConforms, pick } from './allowlist.js';
import { assertChainId } from './chain.js';
import { resolveBaseUrl } from './http.js';
import { ATTRIBUTION, DATA_LICENSE, DATA_LICENSE_URL } from './metadata.js';

/** The largest compressed file accepted: far above the ~600 hooks of 2026-11-05. */
export const MAX_HOOKS_BYTES = 50 * 1024 * 1024;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ATTEMPTS = 3;

export class HooksFetchError extends Error {
  readonly code = 'hooks_fetch';
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export class HooksChecksumError extends Error {
  readonly code = 'hooks_checksum';
}

export type CopyHooksOptions = {
  outDir: string;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: (line: string) => void;
};

export type HooksMetadata = {
  file: 'hooks.ndjson';
  source: string;
  day: string;
  retrievedAt: string;
  recordCount: number;
  tied: number;
  notTied: number;
  sourceSha256: string;
  license: string;
  licenseUrl: string;
  attribution: string;
  citation: string;
};

async function get(
  url: string,
  options: Required<Pick<CopyHooksOptions, 'fetchImpl' | 'sleep'>>,
): Promise<Uint8Array> {
  let last: HooksFetchError | undefined;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
    let response: Response;
    try {
      response = await options.fetchImpl(url, {
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      last = new HooksFetchError(
        `${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (attempt < ATTEMPTS) await options.sleep(2_000 * attempt);
      continue;
    }
    if (response.ok) {
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > MAX_HOOKS_BYTES)
        throw new HooksFetchError(`${url} is larger than ${MAX_HOOKS_BYTES} bytes.`);
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > MAX_HOOKS_BYTES)
        throw new HooksFetchError(`${url} is larger than ${MAX_HOOKS_BYTES} bytes.`);
      return body;
    }
    last = new HooksFetchError(`${url} answered ${response.status}.`, response.status);
    // A missing file is an answer, not an outage: no retry.
    if (response.status < 500 && response.status !== 429) throw last;
    if (attempt < ATTEMPTS) await options.sleep(2_000 * attempt);
  }
  throw last ?? new HooksFetchError(`${url} did not answer.`);
}

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

export async function copyHooks(
  options: CopyHooksOptions,
): Promise<{ outFile: string; metadata: HooksMetadata }> {
  const base = resolveBaseUrl(options.baseUrl);
  const deps = {
    fetchImpl: options.fetchImpl ?? fetch,
    sleep:
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  };
  const log = options.log ?? (() => undefined);

  const latest = JSON.parse(text(await get(`${base}/data/latest/metadata.json`, deps))) as {
    day?: unknown;
    chainId?: unknown;
  };
  if (typeof latest.day !== 'string' || !DAY.test(latest.day))
    throw new SchemaDriftError('$.metadata.day', 'a UTC day', typeof latest.day);
  assertChainId(latest.chainId);
  const day = latest.day;

  const sums = text(await get(`${base}/data/${day}/SHA256SUMS`, deps));
  const expected = sums
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .find((parts) => parts[1] === 'hooks.ndjson.gz')?.[0];
  if (!expected || !/^[0-9a-f]{64}$/.test(expected))
    throw new HooksFetchError(`HEY's snapshot of ${day} lists no hooks file.`, 404);

  const gz = await get(`${base}/data/${day}/hooks.ndjson.gz`, deps);
  const actual = createHash('sha256').update(gz).digest('hex');
  if (actual !== expected)
    throw new HooksChecksumError(
      `hooks.ndjson.gz of ${day} does not match its SHA256SUMS line (${actual} ≠ ${expected}).`,
    );

  const lines = text(gunzipSync(gz))
    .split('\n')
    .filter((line) => line.trim() !== '');
  let tied = 0;
  const out = lines.map((line, i) => {
    const at = `$.hooks[${i}]`;
    const raw: unknown = JSON.parse(line);
    assertConforms(raw, HOOK_RECORD, at);
    const record = pick(raw, HOOK_RECORD, at);
    if (!record) throw new SchemaDriftError(at, 'a hook record', 'an empty object');
    if (record['tied'] === true) tied += 1;
    return JSON.stringify(record);
  });

  await mkdir(options.outDir, { recursive: true });
  const outFile = path.join(options.outDir, 'hooks.ndjson');
  await writeFile(outFile, out.length > 0 ? `${out.join('\n')}\n` : '');
  const snapshotUrl = `${base}/data/${day}/`;
  const metadata: HooksMetadata = {
    file: 'hooks.ndjson',
    source: `${snapshotUrl}hooks.ndjson.gz`,
    day,
    retrievedAt: (options.now?.() ?? new Date()).toISOString(),
    recordCount: out.length,
    tied,
    notTied: out.length - tied,
    sourceSha256: actual,
    license: DATA_LICENSE,
    licenseUrl: DATA_LICENSE_URL,
    attribution: ATTRIBUTION,
    citation: `HEY Research Lab, ${snapshotUrl}, retrieved ${day}`,
  };
  await writeFile(
    path.join(options.outDir, 'hooks.metadata.json'),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  log(
    `hooks.ndjson: ${out.length} hooks (${tied} tied, ${out.length - tied} not tied) from HEY's snapshot of ${day}`,
  );
  return { outFile, metadata };
}
