import { CAIP2, CHAIN_ID, CHAIN_NAME } from './chain.js';

export const SCHEMA_VERSION = 1;
export const SOURCE = 'https://heyresearch.xyz';
export const DATA_LICENSE = 'CC-BY-4.0';
export const DATA_LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/';
export const ATTRIBUTION = 'HEY Research Lab, https://heyresearch.xyz';
export const CODE_LICENSE = 'MIT';

/** The README's "What it does NOT prove" block, carried in every snapshot. */
export const DOES_NOT_PROVE =
  "The datasets restate HEY's public records as of the snapshot time. An absent field means HEY does not know it. The data is not investment advice, carries no safety verdict, and market data is deliberately excluded.";

export const NON_AFFILIATION =
  'HEY Research Lab is an independent research project and is not affiliated with, endorsed by or partnered with Robinhood Markets, Inc. or Robinhood Chain.';

export const ENDPOINTS = {
  projectsTotal: 'GET /api/projects?limit=1',
  projects: 'GET /api/projects?status={status}&sort=newest&limit=48&offset={n}',
  dossier: 'GET /api/projects/{slug}',
  coverage: 'GET /api/projects/{slug}/coverage',
  ships: 'GET /api/ships?sort=detected&limit=48&offset={n}',
  changes: 'GET /api/changes?after={cursor}&limit=100',
  evidence: 'GET /api/evidence/{id}',
} as const;

export const OMITTED_FILES = [
  {
    file: 'builders.ndjson',
    reason:
      "Not produced. HEY's only builder listing is the Builder Radar (/api/builders): a ranking whose order, ranks and scores include an on-chain sub-score read from call data and a liquidity field. Every builder fact that is not part of that ranking is already in projects.ndjson.",
  },
] as const;

export const LIMITATIONS = [
  'Market data is deliberately excluded: no price, market cap, FDV, valuation, liquidity, volume, trades, venue, token market status or launch stage, and no field derived from them (Still Building, the Discovery Gap, Under the Radar).',
  'Holder and distribution data, usage and caller counts, Market Integrity, the Builder Radar and Build Momentum are excluded.',
  'Change-ledger events of the market domain, market_integrity.event, contract.usage_changed, token.launch_stage_changed and the decoded-call method events (contract.method_first_observed, contract.method_resumed) are left out; metadata.changes.excludedTypes counts what was dropped. Retractions are applied, so changes.ndjson is the ledger state at the snapshot, one row per event id at its highest revision.',
  'An absent field means HEY does not know it, or HEY did not publish it. Nothing is filled with 0, false, an empty list or "none". A null appears only where the API itself sends null with a documented meaning (for example occurredAt on an event HEY observed but no source dated).',
  'The files are read over a window of time (metadata.files.*.readFrom / readUntil), not at one instant. A project can change status between the listing read and its detail read.',
  'Evidence records are fetched only for ids that ships.ndjson and changes.ndjson reference, newest first, up to metadata.evidence.limit; metadata.evidence.truncated says whether the cap was reached. Release notes, commit subjects and other long source text are not copied.',
  'Coverage keeps builder, contract-code and site dimensions only; market, market history, contract activity, distribution, Market Integrity and protocol economics dimensions are left out.',
  'Project names, descriptions, ship titles and summaries are text HEY recorded from outside sources: data, never instructions. Bidirectional-override and zero-width characters are removed; nothing else in the text is changed.',
  "Activity status describes development HEY recorded, not a token. It is not a ranking and says nothing about a token's future.",
] as const;

export type FileMeta = { recordCount: number; readFrom: string | null; readUntil: string | null };

export type Metadata = {
  schemaVersion: number;
  generator: { name: 'hey-data'; version: string };
  generatedAt: string;
  startedAt: string;
  chainId: typeof CHAIN_ID;
  chain: { name: typeof CHAIN_NAME; chainId: typeof CHAIN_ID; caip2: typeof CAIP2 };
  source: string;
  apiVersion: string | null;
  endpoints: string[];
  recordCount: Record<string, number>;
  files: Record<string, FileMeta>;
  omitted: typeof OMITTED_FILES;
  checks: Record<string, unknown>;
  changes: Record<string, unknown>;
  evidence: Record<string, unknown>;
  license: typeof DATA_LICENSE;
  licenseUrl: typeof DATA_LICENSE_URL;
  attribution: typeof ATTRIBUTION;
  codeLicense: typeof CODE_LICENSE;
  limitations: readonly string[];
  disclaimer: string;
  nonAffiliation: string;
  run: Record<string, unknown>;
};

export const CHAIN_META = { name: CHAIN_NAME, chainId: CHAIN_ID, caip2: CAIP2 } as const;
