/**
 * Field allowlists, one per output file. Nothing reaches a dataset that is not
 * named here: records are built by walking these specs over the API's JSON,
 * never by copying the API's objects. A field the API adds tomorrow stays out
 * until someone adds it to a spec, and the forbidden-name guard below stops a
 * market, holder, usage, integrity or Radar field from being added by mistake.
 */
import { assertChainId } from './chain.js';
import { normalizeAddress } from './evm.js';
import { cleanText } from './text.js';

/** How one allowed value is read. A value of another type is schema drift: the run fails loudly. */
export type Leaf =
  | 'string'
  | 'text'
  | 'url'
  | 'datetime'
  | 'datetime|null'
  | 'integer'
  | 'integer|null'
  | 'boolean'
  | 'address'
  | 'chainId'
  | 'primitive'
  | 'primitive|null';

export type Spec = { readonly [key: string]: Leaf | Spec | readonly [Spec] };

/**
 * A field name that can never appear in any dataset, at any depth. Market
 * figures (price, valuation, liquidity, volume, trades, venue), holder and
 * distribution data, usage and caller counts, Market Integrity, the Builder
 * Radar and its ranks, and scores derived from markets stay out by name.
 */
export const FORBIDDEN_FIELD =
  /price|market|fdv|valuation|liquidity|volume|trades|venue|launchstage|holder|distribution|concentration|usage|caller|onchainactivity|integrity|radar|rank|momentum|discoverygap|undertheradar|stillbuilding|wallet|pnl|whale|smartmoney/i;

export class SchemaDriftError extends Error {
  readonly code = 'schema_drift';
  constructor(
    readonly path: string,
    readonly expected: string,
    readonly received: string,
  ) {
    super(
      `HEY's API sent ${received} at ${path}, where hey-data expects ${expected}. ` +
        'The run stops rather than guess; update the allowlist after reading the API change.',
    );
  }
}

export class ForbiddenFieldError extends Error {
  readonly code = 'forbidden_field';
  constructor(readonly path: string) {
    super(`Refusing to write ${path}: the field is outside hey-data's allowlist.`);
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/;
const URL_RE = /^https?:\/\/[^\s]+$/;

const typeName = (value: unknown): string =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readLeaf(leaf: Leaf, value: unknown, path: string): unknown {
  const fail = (): never => {
    throw new SchemaDriftError(path, leaf, typeName(value));
  };
  if (value === null) return leaf.endsWith('|null') ? null : fail();
  switch (leaf) {
    case 'string':
      return typeof value === 'string' && value.length <= 2_000 ? value : fail();
    case 'text':
      return typeof value === 'string' ? cleanText(value) : fail();
    case 'url':
      return typeof value === 'string' && URL_RE.test(value) && value.length <= 2_000
        ? value
        : fail();
    case 'datetime':
    case 'datetime|null':
      return typeof value === 'string' && ISO.test(value) ? value : fail();
    case 'integer':
    case 'integer|null':
      return Number.isSafeInteger(value) ? value : fail();
    case 'boolean':
      return typeof value === 'boolean' ? value : fail();
    case 'address':
      return typeof value === 'string' ? normalizeAddress(value) : fail();
    case 'chainId':
      assertChainId(value);
      return value;
    case 'primitive':
    case 'primitive|null':
      if (typeof value === 'string') return cleanText(value);
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
        return value;
      return fail();
  }
}

/**
 * Walks `spec` over `source`. Only keys the spec names are read (own
 * properties only, so `__proto__` and friends can never be copied); absent
 * stays absent, and an object that keeps no allowed field is left out rather
 * than written as `{}`.
 */
export function pick(source: unknown, spec: Spec, path = '$'): Record<string, unknown> | undefined {
  if (!isRecord(source)) throw new SchemaDriftError(path, 'object', typeName(source));
  const out: Record<string, unknown> = {};
  for (const [key, rule] of Object.entries(spec)) {
    if (!Object.hasOwn(source, key)) continue;
    const value = source[key];
    const at = `${path}.${key}`;
    if (typeof rule === 'string') {
      out[key] = readLeaf(rule as Leaf, value, at);
    } else if (Array.isArray(rule)) {
      if (!Array.isArray(value)) throw new SchemaDriftError(at, 'array', typeName(value));
      const [inner] = rule as readonly [Spec];
      out[key] = value.flatMap((item, i) => pick(item, inner, `${at}[${i}]`) ?? []);
    } else {
      const nested = pick(value, rule as Spec, at);
      if (nested) out[key] = nested;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * The last gate before a line is written: every key, at every depth, must be
 * named by the file's spec and must not look like a forbidden field.
 */
export function assertConforms(record: unknown, spec: Spec, path = '$'): void {
  if (!isRecord(record)) throw new SchemaDriftError(path, 'object', typeName(record));
  for (const [key, value] of Object.entries(record)) {
    const at = `${path}.${key}`;
    if (FORBIDDEN_FIELD.test(key)) throw new ForbiddenFieldError(at);
    const rule = spec[key];
    if (rule === undefined) throw new ForbiddenFieldError(at);
    if (typeof rule === 'string') {
      if (isRecord(value) || Array.isArray(value)) throw new ForbiddenFieldError(at);
    } else if (Array.isArray(rule)) {
      if (!Array.isArray(value)) throw new ForbiddenFieldError(at);
      const [inner] = rule as readonly [Spec];
      value.forEach((item, i) => assertConforms(item, inner, `${at}[${i}]`));
    } else {
      assertConforms(value, rule as Spec, at);
    }
  }
}

/** Every key path a spec allows, for tests and documentation (`a.b`, `list[].c`). */
export function specPaths(spec: Spec, prefix = ''): string[] {
  return Object.entries(spec).flatMap(([key, rule]) => {
    const here = prefix ? `${prefix}.${key}` : key;
    if (typeof rule === 'string') return [here];
    if (Array.isArray(rule)) return [here, ...specPaths((rule as readonly [Spec])[0], `${here}[]`)];
    return [here, ...specPaths(rule as Spec, here)];
  });
}

/* ── inputs: what is read from each API answer ─────────────────────────── */

const PROJECT_REF: Spec = { slug: 'string', name: 'text', url: 'url' };
const CHAIN_REF: Spec = { chainId: 'chainId', address: 'address' };

/** `GET /api/projects` items: identity, kind, states. No market field is named. */
export const LISTING_INPUT: Spec = {
  slug: 'string',
  name: 'text',
  url: 'url',
  symbol: 'text',
  shortDescription: 'text',
  projectKind: 'string',
  activityStatus: 'string',
  researchLevel: 'string',
  catalogStatus: 'string',
  lastShippedAt: 'datetime',
  primaryNarrative: { slug: 'string', name: 'text' },
  token: { chainId: 'chainId', contractAddress: 'address' },
  tokenVerification: { status: 'string', reason: 'string' },
  websiteUrl: 'url',
  officialX: { handle: 'text', url: 'url' },
  logoUrl: 'url',
  hasBuilderSource: 'boolean',
};

/** `GET /api/projects/{slug}`: narratives, HEY's first record, the newest ship, the scoring version. */
export const DOSSIER_INPUT: Spec = {
  narratives: [{ slug: 'string', name: 'text', isPrimary: 'boolean' }],
  firstRecordedByHeyAt: 'datetime',
  ships: [
    {
      evidenceId: 'string',
      eventType: 'string',
      publishedAt: 'datetime',
      detectedAt: 'datetime',
      precision: 'string',
      verification: 'string',
    },
  ],
  score: { scoringVersion: 'string', calculatedAt: 'datetime' },
};

/**
 * Coverage dimensions kept: builder, contract-code and site dimensions.
 * Left out: marketCurrent, marketHistory, contractActivity (usage),
 * distribution (holders), marketIntegrity, protocolEconomics (third-party fees).
 */
export const COVERAGE_DIMENSIONS = [
  'identity',
  'builderEvidence',
  'repositories',
  'releases',
  'timeline',
  'contractDeployment',
  'contractSource',
  'contractInterface',
  'locks',
  'officialDocs',
  'apiDocs',
  'sourceChanges',
  'gitHost',
  'package',
  'securityContext',
] as const;

const COVERAGE_ENTRY: Spec = {
  state: 'string',
  reason: 'string',
  since: 'datetime',
  asOf: 'datetime',
};

export const COVERAGE_INPUT: Spec = {
  dimensions: Object.fromEntries(COVERAGE_DIMENSIONS.map((d) => [d, COVERAGE_ENTRY])),
  computedAt: 'datetime',
};

/* ── outputs: one spec per file ────────────────────────────────────────── */

export const PROJECT_RECORD: Spec = {
  ...LISTING_INPUT,
  narratives: [{ slug: 'string', name: 'text', isPrimary: 'boolean' }],
  firstRecordedByHeyAt: 'datetime',
  latestShip: {
    evidenceId: 'string',
    eventType: 'string',
    publishedAt: 'datetime',
    detectedAt: 'datetime',
    precision: 'string',
    verification: 'string',
  },
  scoringVersion: 'string',
  scoredAt: 'datetime',
  coverage: COVERAGE_INPUT['dimensions'] as Spec,
  coverageComputedAt: 'datetime',
  detailRead: 'string',
};

/**
 * `GET /api/ships` items. The embedded project card is read for its identity
 * only; a ship's `summary` (release notes for a release) and a code week's
 * commit highlights are long source text and are not copied.
 */
export const SHIP_RECORD: Spec = {
  evidenceId: 'string',
  eventType: 'string',
  title: 'text',
  publishedAt: 'datetime',
  detectedAt: 'datetime',
  precision: 'string',
  verification: 'string',
  sourceUrl: 'url',
  url: 'url',
  project: PROJECT_REF,
  codeWeek: {
    isoWeek: 'string',
    start: 'datetime',
    end: 'datetime',
    repository: 'text',
    commits: 'integer|null',
    commitsAtLeast: 'boolean',
    commitsUrl: 'url',
  },
  codeSubstance: { verdict: 'string', classifierVersion: 'string', countsAsBuilding: 'boolean' },
};

/**
 * Change-ledger types kept. Everything else is left out by name — market.*,
 * market_integrity.event, contract.usage_changed, the decoded-call method
 * events (contract.method_*), which are read from call data, and
 * token.launch_stage_changed, which follows where the token trades.
 */
export const INCLUDED_CHANGE_TYPES = new Set([
  'build.release',
  'build.ship',
  'build.code_activity',
  'build.status_changed',
  'build.dormant',
  'build.resumed',
  'build.accelerating',
  'build.slowing',
  'contract.deployed',
  'contract.followup_deployed',
  'contract.implementation_changed',
  'contract.source_verified',
  'contract.source_unverified',
  'contract.interface_changed',
  'token.verification_changed',
  'research.published',
  'research.builder_verified',
  'research.owner_verified',
  'research.source_added',
  'research.source_unavailable',
  'research.source_restored',
  'research.source_changed',
  'research.narrative_assigned',
  'lock.unlock_due',
  'lock.observed',
  'lock.withdrawn',
]);

/** The plain facts the kept types carry (ships, transitions, ABI counts, locks, site changes). */
export const CHANGE_FACT_KEYS = [
  'eventType',
  'verification',
  'releaseVersion',
  'prerelease',
  'codeSubstance',
  'codeSubstanceVersion',
  'commitsListed',
  'commitsRead',
  'commitsChangedCode',
  'commitsDocumentationOrMaintenance',
  'commitsSubstanceUnknown',
  'commitsNotRead',
  'contractKind',
  'hookPermissions',
  'kind',
  'unit',
  'changePct',
  'detail',
  'key',
  'scoringVersion',
  'functionsAdded',
  'functionsRemoved',
  'eventsAdded',
  'eventsRemoved',
  'eventName',
  'beacon',
  'block',
  'method',
  'sourceType',
  'narrative',
  'primary',
  'lockId',
  'assetKind',
  'unlockAt',
  'added',
  'removed',
  'file',
  'present',
  'previousReadAt',
] as const;

export const CHANGE_RECORD: Spec = {
  id: 'string',
  revision: 'integer',
  op: 'string',
  type: 'string',
  domain: 'string',
  origin: 'string',
  project: PROJECT_REF,
  contract: CHAIN_REF,
  token: CHAIN_REF,
  occurredAt: 'datetime|null',
  occurredUntil: 'datetime',
  precision: 'string',
  detectedAt: 'datetime',
  recordedAt: 'datetime',
  summary: 'text',
  before: 'primitive|null',
  after: 'primitive|null',
  evidence: [{ id: 'string', url: 'url', label: 'text' }],
  source: 'string',
  countsAsBuilding: 'boolean',
  facts: Object.fromEntries(CHANGE_FACT_KEYS.map((k) => [k, 'primitive' as const])),
  links: { project: 'url', evidence: 'url', timeline: 'url' },
};

/** A retraction carries only these (machine rule 3: it never names a project). */
export const RETRACT_RECORD: Spec = {
  id: 'string',
  revision: 'integer',
  op: 'string',
  recordedAt: 'datetime',
};

/** Evidence families fetched. `signal:`, `method:` and `integrity:` are never read. */
export const EVIDENCE_FAMILIES = [
  'ship',
  'abi',
  'impl',
  'lock',
  'source',
  'claim',
  'state',
  'narrative',
  'sourcechange',
  'security',
  'v4hook',
] as const;

export const EVIDENCE_DOMAINS = new Set(['build', 'contract', 'token', 'research', 'lock']);

export const EVIDENCE_RECORD: Spec = {
  id: 'string',
  withdrawn: 'boolean',
  withdrawalReason: 'string',
  contextReason: 'string',
  project: PROJECT_REF,
  domain: 'string',
  claimType: 'string',
  summary: 'text',
  sourceType: 'string',
  sourceUrl: 'url',
  publishedAt: 'datetime|null',
  detectedAt: 'datetime',
  precision: 'string',
  verification: 'primitive|null',
  countsAsBuilding: 'boolean',
  recordedAt: 'datetime',
  metadata: {
    releaseVersion: 'primitive',
    prerelease: 'primitive',
    kind: 'primitive',
    added: 'primitive',
    removed: 'primitive',
    file: 'primitive',
    present: 'primitive',
  },
  sources: [{ sourceType: 'string', sourceUrl: 'url', observedAt: 'datetime' }],
};

export const OUTPUT_SPECS = {
  'projects.ndjson': PROJECT_RECORD,
  'ships.ndjson': SHIP_RECORD,
  'changes.ndjson': CHANGE_RECORD,
  'evidence.ndjson': EVIDENCE_RECORD,
} as const;
