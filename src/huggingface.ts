/**
 * hey-data huggingface — prepares the Hugging Face copy of HEY's newest daily snapshot.
 *
 * The dataset huggingface.co/datasets/heyresearch/robinhood-chain-builders holds HEY's own CSVs (`projects.csv`,
 * `ships.csv`, `hooks.csv`) and `metadata.json`, as published at heyresearch.xyz/data. This command reads the newest
 * day, downloads those four files from that day's directory (which never changes), refuses any whose SHA256SUMS line
 * does not match, checks every CSV column against the allowlist, and writes them with a dataset card naming the day and
 * the counts. Uploading is the workflow's job (`.github/workflows/huggingface.yml`); nothing here holds a token.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  FORBIDDEN_FIELD,
  ForbiddenFieldError,
  HOOK_RECORD,
  PROJECT_RECORD,
  SHIP_RECORD,
  SchemaDriftError,
  specPaths,
  type Spec,
} from './allowlist.js';
import { assertChainId } from './chain.js';
import { HooksChecksumError, HooksFetchError, getHeyFile } from './hooks.js';
import { resolveBaseUrl } from './http.js';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The files the copy carries, each with the spec its columns must come from. */
export const HUGGING_FACE_FILES: readonly { file: string; spec?: Spec; count: string }[] = [
  { file: 'projects.csv', spec: PROJECT_RECORD, count: 'projects.ndjson' },
  { file: 'ships.csv', spec: SHIP_RECORD, count: 'ships.ndjson' },
  { file: 'hooks.csv', spec: HOOK_RECORD, count: 'hooks.ndjson' },
  { file: 'metadata.json', count: '' },
];

export type HuggingFaceMirrorOptions = {
  outDir: string;
  baseUrl?: string | undefined;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const n = (value: number) => value.toLocaleString('en-US');

/** Every column of a CSV header must be a path the file's spec allows, and no segment may look like a forbidden field. */
export function checkCsvColumns(csv: string, spec: Spec, file: string): string[] {
  const header = (csv.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '').split(',');
  const allowed = new Set(specPaths(spec));
  for (const column of header) {
    if (column.split('.').some((part) => FORBIDDEN_FIELD.test(part)))
      throw new ForbiddenFieldError(`${file}:${column}`);
    if (!allowed.has(column)) throw new ForbiddenFieldError(`${file}:${column}`);
  }
  return header;
}

/** The dataset card for one day (Hugging Face reads the YAML block for the licence and the three configs). */
export function datasetCard(
  day: string,
  counts: { projects: number; ships: number; hooks: number },
): string {
  return `---
license: cc-by-4.0
pretty_name: HEY Research Lab, Robinhood Chain builder records
language:
- en
tags:
- blockchain
- robinhood-chain
- uniswap-v4
- developer-activity
- tabular
size_categories:
- 1K<n<10K
configs:
- config_name: projects
  data_files: projects.csv
- config_name: ships
  data_files: ships.csv
- config_name: hooks
  data_files: hooks.csv
---

# HEY Research Lab: Robinhood Chain builder records

HEY Research Lab's public record of building on Robinhood Chain (chain id 4663): which projects are still building,
what they shipped, and the public source for each ship. This copy is the snapshot of ${day} (see \`metadata.json\`),
refreshed every week. A new snapshot is published every day at https://heyresearch.xyz/data, with checksums, and
\`https://heyresearch.xyz/data/latest/\` always holds the newest.

## Files

- \`projects.csv\` (${n(counts.projects)} rows): one row per published project: identity, kind, activity status,
  research level, narratives, the newest source-backed ship.
- \`ships.csv\` (${n(counts.ships)} rows): one row per ship (a release, a contract deployment, a code week and so on):
  type, dates and their precision, verification state, and the public source.
- \`hooks.csv\` (${n(counts.hooks)} rows): Uniswap v4 hooks on Robinhood Chain. A hook HEY ties to a project carries the
  project, the basis of the tie (on chain, the project's own contract list, a project-linked address, the project's
  factory, or HEY's review) and the receipt; hooks Uniswap's hooklist lists that HEY ties to no project are marked
  \`tied=false\`.
- \`metadata.json\`: what was read, when, the rule versions, the counts and what is left out.

## How it is made

HEY reads public sources: project websites, GitHub repositories and releases, changelogs, and Robinhood Chain
contract deployments. A ship counts only with a public source. Methodology: https://heyresearch.xyz/methodology.
How a hook is tied to its builder: https://heyresearch.xyz/integrations/uniswap/hooks#method.

## What it leaves out

- No prices, market figures, holder data or wallet data.
- A value HEY did not read is empty, never zero.
- The account that created a hook is never included, and neither are pool counts.
- A hook missing from \`hooks.csv\` is one HEY has not tied and the hooklist does not list on HEY's terms. It does not
  mean the hook has no builder.
- No safety, audit or quality verdicts of any kind, and nothing here is investment advice.

## Licence and citation

CC BY 4.0. Cite as:

> HEY Research Lab, https://heyresearch.xyz/data/${day}/, retrieved ${day}

This copy is made by https://github.com/hey-research-lab/hey-data (MIT), \`hey-data huggingface\`.
Contact: hi@heyresearch.xyz · https://x.com/HeyResearch
`;
}

export async function prepareHuggingFaceMirror(
  options: HuggingFaceMirrorOptions,
): Promise<{ day: string; counts: { projects: number; ships: number; hooks: number } }> {
  const base = resolveBaseUrl(options.baseUrl);
  const deps = {
    fetchImpl: options.fetchImpl ?? fetch,
    sleep:
      options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  };
  const log = options.log ?? (() => undefined);

  const latest = JSON.parse(text(await getHeyFile(`${base}/data/latest/metadata.json`, deps))) as {
    day?: unknown;
  };
  if (typeof latest.day !== 'string' || !DAY.test(latest.day))
    throw new SchemaDriftError('$.metadata.day', 'a UTC day', typeof latest.day);
  const day = latest.day;

  const sums = new Map(
    text(await getHeyFile(`${base}/data/${day}/SHA256SUMS`, deps))
      .split('\n')
      .map((line) => line.trim().split(/\s+/))
      .filter((parts): parts is [string, string] => parts.length === 2)
      .map(([sha, name]) => [name, sha] as const),
  );

  const bodies = new Map<string, Uint8Array>();
  for (const { file, spec } of HUGGING_FACE_FILES) {
    const expected = sums.get(file);
    if (!expected || !/^[0-9a-f]{64}$/.test(expected))
      throw new HooksFetchError(`HEY's snapshot of ${day} lists no ${file}.`, 404);
    const body = await getHeyFile(`${base}/data/${day}/${file}`, deps);
    const actual = createHash('sha256').update(body).digest('hex');
    if (actual !== expected)
      throw new HooksChecksumError(
        `${file} of ${day} does not match its SHA256SUMS line (${actual} ≠ ${expected}).`,
      );
    if (spec) checkCsvColumns(text(body), spec, file);
    bodies.set(file, body);
  }

  const metadata = JSON.parse(text(bodies.get('metadata.json')!)) as {
    day?: unknown;
    chainId?: unknown;
    recordCount?: Record<string, unknown>;
  };
  if (metadata.day !== day) throw new SchemaDriftError('$.metadata.day', day, String(metadata.day));
  assertChainId(metadata.chainId);
  const count = (key: string) => {
    const value = metadata.recordCount?.[key];
    if (!Number.isSafeInteger(value))
      throw new SchemaDriftError(`$.metadata.recordCount.${key}`, 'an integer', typeof value);
    return value as number;
  };
  const counts = {
    projects: count('projects.ndjson'),
    ships: count('ships.ndjson'),
    hooks: count('hooks.ndjson'),
  };

  await mkdir(options.outDir, { recursive: true });
  for (const [file, body] of bodies) await writeFile(path.join(options.outDir, file), body);
  await writeFile(path.join(options.outDir, 'README.md'), datasetCard(day, counts));
  log(
    `huggingface copy of ${day}: ${counts.projects} projects, ${counts.ships} ships, ${counts.hooks} hooks in ${options.outDir}`,
  );
  return { day, counts };
}
