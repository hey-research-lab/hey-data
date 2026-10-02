/**
 * The generator: five resumable phases over HEY's public API, then one
 * atomic write of the snapshot.
 *
 *   projectsList   /api/projects, partitioned by activity status; the
 *                  partitions must add up to the unfiltered total
 *   projectDetails /api/projects/{slug} and /coverage, one project at a time
 *   ships          /api/ships, by detection time
 *   changes        /api/changes, the ledger's sync cursor from the start
 *   evidence       /api/evidence/{id}, only for ids the files above reference
 */
import { HeyApiError, HeyClient, type FetchLike } from '@hey-research-lab/sdk';
import { z } from 'zod';
import {
  CHANGE_RECORD,
  COVERAGE_INPUT,
  DOSSIER_INPUT,
  EVIDENCE_DOMAINS,
  EVIDENCE_FAMILIES,
  EVIDENCE_RECORD,
  INCLUDED_CHANGE_TYPES,
  LISTING_INPUT,
  OUTPUT_SPECS,
  PROJECT_RECORD,
  RETRACT_RECORD,
  SHIP_RECORD,
  SchemaDriftError,
  assertConforms,
  pick,
  type Spec,
} from './allowlist.js';
import {
  DEFAULT_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  politeFetch,
  realSleep,
  resolveBaseUrl,
  type RequestStats,
} from './http.js';
import {
  ATTRIBUTION,
  CHAIN_META,
  CODE_LICENSE,
  DATA_LICENSE,
  DATA_LICENSE_URL,
  DOES_NOT_PROVE,
  ENDPOINTS,
  LIMITATIONS,
  NON_AFFILIATION,
  OMITTED_FILES,
  SCHEMA_VERSION,
  SOURCE,
  type FileMeta,
  type Metadata,
} from './metadata.js';
import {
  CURSOR_SCHEMA,
  PHASES,
  WorkFile,
  WorkStateError,
  inside,
  prepareOutDir,
  readCursor,
  removeWork,
  saveCursor,
  writeAtomic,
  type CursorFile,
  type PhaseName,
  type PhaseStates,
} from './work.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const GENERATOR_VERSION = '0.1.0';
export const STATUSES = ['SHIPPING', 'ACTIVE', 'QUIET', 'DORMANT', 'RESUMED', 'UNKNOWN'] as const;
export const PAGE_LIMIT = 48;
export const CHANGES_LIMIT = 100;
export const DEFAULT_EVIDENCE_LIMIT = 500;
export const DEFAULT_LIST_ATTEMPTS = 3;
export const DEFAULT_MAX_RESUME_AGE_HOURS = 48;
const USER_AGENT = `hey-data/${GENERATOR_VERSION}`;

export type GenerateOptions = {
  outDir: string;
  /** The raw fetch; hey-data wraps it with pacing and retry rules. Defaults to the global fetch. */
  fetchImpl?: FetchLike;
  /** Tests and local mocks only (`HEY_BASE_URL`). */
  baseUrl?: string;
  delayMs?: number;
  maxRetries?: number;
  /** Read each project's dossier (narratives, newest ship, scoring version). Default true. */
  details?: boolean;
  /** Read each project's coverage states. Default true; needs `details`. */
  coverage?: boolean;
  evidenceLimit?: number;
  listAttempts?: number;
  restart?: boolean;
  keepWork?: boolean;
  maxResumeAgeHours?: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

export type GenerateResult = {
  outDir: string;
  resumed: boolean;
  metadata: Metadata;
  stats: RequestStats;
};

export class TotalsMismatchError extends Error {
  readonly code = 'totals_mismatch';
  constructor(
    readonly what: string,
    readonly problems: readonly string[],
  ) {
    super(`${what} did not add up after every allowed attempt:\n  - ${problems.join('\n  - ')}`);
  }
}

const count = z.number().int().nonnegative();
const OffsetPage = z.object({
  total: count,
  items: z.array(z.unknown()),
  nextOffset: count.optional(),
});
const LedgerPage = z.object({
  items: z.array(z.unknown()),
  nextCursor: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/),
  hasMore: z.boolean(),
  ledger: z.record(z.string(), z.unknown()).optional(),
});

function parsePage<T>(schema: z.ZodType<T>, body: unknown, path: string): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SchemaDriftError(
      `${path}.${issue?.path.join('.') ?? ''}`,
      issue?.message ?? 'a page',
      'something else',
    );
  }
  return parsed.data;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** Keys in the spec's order, so every line of a file reads the same way. */
function ordered(record: Record<string, unknown>, spec: Spec): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(spec)) if (record[key] !== undefined) out[key] = record[key];
  return out;
}

function freshCursor(optionsKey: string, at: string): CursorFile {
  const phase = <S>(state: S) => ({
    done: false,
    bytes: 0,
    startedAt: null,
    finishedAt: null,
    state,
  });
  return {
    schema: CURSOR_SCHEMA,
    generatorVersion: GENERATOR_VERSION,
    optionsKey,
    startedAt: at,
    updatedAt: at,
    phases: {
      projectsList: phase({
        attempt: 0,
        unfilteredTotal: null,
        partitionIndex: 0,
        offset: 0,
        partitions: [],
      }),
      projectDetails: phase({ index: 0 }),
      ships: phase({ attempt: 0, offset: 0, firstTotal: null, lastTotal: null }),
      changes: phase({ after: 'c1.0', pages: 0, upserts: 0, retracts: 0, excludedTypes: {} }),
      evidence: phase({
        index: 0,
        fetched: 0,
        withdrawn: 0,
        notFound: 0,
        invalid: 0,
        excludedDomain: 0,
      }),
    },
  };
}

class Run {
  readonly client: HeyClient;
  readonly stats: RequestStats;
  readonly log: (line: string) => void;
  readonly now: () => Date;
  constructor(
    readonly root: string,
    readonly cursor: CursorFile,
    readonly options: Required<
      Pick<GenerateOptions, 'details' | 'coverage' | 'evidenceLimit' | 'listAttempts'>
    >,
    deps: {
      fetchImpl: FetchLike;
      baseUrl: string;
      delayMs: number;
      maxRetries: number;
      now: () => Date;
      sleep: (ms: number) => Promise<void>;
      log: (line: string) => void;
    },
  ) {
    this.log = deps.log;
    this.now = deps.now;
    const polite = politeFetch({
      fetchImpl: deps.fetchImpl,
      delayMs: deps.delayMs,
      maxRetries: deps.maxRetries,
      sleep: deps.sleep,
      now: () => deps.now().getTime(),
      log: deps.log,
    });
    this.stats = polite.stats;
    this.client = new HeyClient({
      baseUrl: deps.baseUrl,
      fetchImpl: polite.fetch,
      userAgent: USER_AGENT,
      timeoutMs: 30_000,
    });
  }

  phase<P extends PhaseName>(name: P) {
    return this.cursor.phases[name] as CursorFile['phases'][P] & { state: PhaseStates[P] };
  }

  commit(name: PhaseName, file?: WorkFile): void {
    const phase = this.cursor.phases[name];
    if (file) phase.bytes = file.bytes;
    if (!phase.startedAt) phase.startedAt = this.now().toISOString();
    this.cursor.updatedAt = this.now().toISOString();
    saveCursor(this.root, this.cursor);
  }

  finish(name: PhaseName, file?: WorkFile): void {
    const phase = this.cursor.phases[name];
    phase.done = true;
    phase.finishedAt = this.now().toISOString();
    this.commit(name, file);
  }

  /** A GET whose 404 is an answer (a project unpublished since the listing), not a failure. */
  async getOrNotFound(path: string): Promise<unknown> {
    try {
      return await this.client.get<unknown>(path);
    } catch (error) {
      if (error instanceof HeyApiError && error.code === 'not_found') return undefined;
      throw error;
    }
  }
}

/* ── phase 1: the listing, partitioned by activity status ──────────────── */

type ListLine = { partition: string; record: Record<string, unknown> };

function verifyPartitions(file: WorkFile, s: PhaseStates['projectsList'], recheck: number) {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  const perPartition = new Map<string, Set<string>>();
  for (const raw of file.read()) {
    const line = raw as ListLine;
    const slug = String(line.record['slug']);
    const status = String(line.record['activityStatus']);
    if (status !== line.partition) {
      problems.push(`${slug} was listed under ${line.partition} but reads ${status}`);
    }
    const before = seen.get(slug);
    if (before !== undefined && before !== line.partition) {
      problems.push(`${slug} appeared in both ${before} and ${line.partition}`);
    }
    seen.set(slug, line.partition);
    const set = perPartition.get(line.partition) ?? new Set<string>();
    set.add(slug);
    perPartition.set(line.partition, set);
  }
  let sum = 0;
  const partitions: Record<string, number> = {};
  for (const status of STATUSES) {
    const p = s.partitions.find((x) => x.status === status);
    if (!p || p.total === null) {
      problems.push(`partition ${status} was not read`);
      continue;
    }
    const unique = perPartition.get(status)?.size ?? 0;
    partitions[status] = unique;
    sum += p.total;
    if (p.lastTotal !== p.total) {
      problems.push(
        `partition ${status} changed size during the walk (${p.total} → ${p.lastTotal})`,
      );
    }
    if (unique !== p.total || p.collected !== p.total) {
      problems.push(
        `partition ${status}: the API said ${p.total}, hey-data collected ${p.collected} rows (${unique} distinct)`,
      );
    }
  }
  if (s.unfilteredTotal === null) problems.push('the unfiltered total was not read');
  else {
    if (sum !== s.unfilteredTotal) {
      problems.push(
        `the status partitions add up to ${sum}, the unfiltered listing says ${s.unfilteredTotal}`,
      );
    }
    if (recheck !== s.unfilteredTotal) {
      problems.push(
        `the unfiltered total moved from ${s.unfilteredTotal} to ${recheck} during the walk`,
      );
    }
  }
  if (seen.size !== sum)
    problems.push(`${seen.size} distinct projects across partitions, expected ${sum}`);
  return { problems, partitions, total: s.unfilteredTotal ?? 0, sum };
}

async function runProjectsList(run: Run) {
  const phase = run.phase('projectsList');
  const file = new WorkFile(run.root, 'projectsList', phase.bytes);
  const s = phase.state;
  const listTotal = async () =>
    parsePage(OffsetPage, await run.client.get('/api/projects', { limit: 1 }), 'projects').total;

  for (;;) {
    if (s.unfilteredTotal === null) {
      s.unfilteredTotal = await listTotal();
      run.commit('projectsList', file);
    }
    while (s.partitionIndex < STATUSES.length) {
      const status = STATUSES[s.partitionIndex] as string;
      let part = s.partitions[s.partitionIndex];
      if (!part) {
        part = { status, total: null, lastTotal: null, collected: 0 };
        s.partitions[s.partitionIndex] = part;
      }
      const page = parsePage(
        OffsetPage,
        await run.client.get('/api/projects', {
          status,
          sort: 'newest',
          limit: PAGE_LIMIT,
          offset: s.offset,
        }),
        `projects[${status}]`,
      );
      if (part.total === null) part.total = page.total;
      part.lastTotal = page.total;
      const lines: ListLine[] = page.items.map((item, i) => {
        const path = `projects[${status}][${s.offset + i}]`;
        const record = pick(item, LISTING_INPUT, path);
        if (!record || typeof record['slug'] !== 'string') {
          throw new SchemaDriftError(`${path}.slug`, 'string', 'nothing');
        }
        return { partition: status, record };
      });
      file.append(lines);
      part.collected += lines.length;
      const next = page.nextOffset;
      if (next === undefined || page.items.length === 0) {
        s.partitionIndex += 1;
        s.offset = 0;
        run.log(`projects: ${status} read (${part.collected} of ${part.total})`);
      } else {
        if (next <= s.offset) {
          throw new SchemaDriftError(
            `projects[${status}].nextOffset`,
            `> ${s.offset}`,
            String(next),
          );
        }
        s.offset = next;
      }
      run.commit('projectsList', file);
    }

    const recheck = await listTotal();
    const result = verifyPartitions(file, s, recheck);
    if (result.problems.length === 0) {
      run.finish('projectsList', file);
      return result;
    }
    s.attempt += 1;
    if (s.attempt >= run.options.listAttempts) {
      throw new TotalsMismatchError('The project listing partitioned by status', result.problems);
    }
    run.log(
      `projects: partitions did not add up (${result.problems[0]}); walking again (attempt ${s.attempt + 1} of ${run.options.listAttempts})`,
    );
    file.reset();
    Object.assign(s, { unfilteredTotal: null, partitionIndex: 0, offset: 0, partitions: [] });
    run.commit('projectsList', file);
  }
}

/* ── phase 2: one project at a time ────────────────────────────────────── */

type DetailLine = {
  slug: string;
  detailRead: 'read' | 'dossier_only' | 'not_found';
  dossier?: Record<string, unknown>;
  coverage?: Record<string, unknown>;
};

function listedSlugs(run: Run): string[] {
  const file = new WorkFile(run.root, 'projectsList', run.phase('projectsList').bytes);
  const slugs = new Set<string>();
  for (const raw of file.read()) slugs.add(String((raw as ListLine).record['slug']));
  return [...slugs].sort();
}

async function runProjectDetails(run: Run) {
  const phase = run.phase('projectDetails');
  const file = new WorkFile(run.root, 'projectDetails', phase.bytes);
  if (!run.options.details) {
    run.finish('projectDetails', file);
    return;
  }
  const slugs = listedSlugs(run);
  const s = phase.state;
  for (let i = s.index; i < slugs.length; i++) {
    const slug = slugs[i] as string;
    const base = `/api/projects/${encodeURIComponent(slug)}`;
    const dossier = await run.getOrNotFound(base);
    let line: DetailLine;
    if (dossier === undefined) {
      line = { slug, detailRead: 'not_found' };
    } else {
      const picked = pick(dossier, DOSSIER_INPUT, `dossier[${slug}]`);
      let coverage: Record<string, unknown> | undefined;
      if (run.options.coverage) {
        const raw = await run.getOrNotFound(`${base}/coverage`);
        coverage = raw === undefined ? undefined : pick(raw, COVERAGE_INPUT, `coverage[${slug}]`);
      }
      line = {
        slug,
        detailRead: coverage ? 'read' : 'dossier_only',
        ...(picked ? { dossier: picked } : {}),
        ...(coverage ? { coverage } : {}),
      };
    }
    file.append([line]);
    s.index = i + 1;
    run.commit('projectDetails', file);
    if ((i + 1) % 100 === 0) run.log(`projects: ${i + 1} of ${slugs.length} detail reads`);
  }
  run.finish('projectDetails', file);
}

/* ── phase 3: ships ────────────────────────────────────────────────────── */

async function runShips(run: Run) {
  const phase = run.phase('ships');
  const file = new WorkFile(run.root, 'ships', phase.bytes);
  const s = phase.state;
  for (;;) {
    for (;;) {
      const page = parsePage(
        OffsetPage,
        await run.client.get('/api/ships', {
          sort: 'detected',
          limit: PAGE_LIMIT,
          offset: s.offset,
        }),
        'ships',
      );
      if (s.firstTotal === null) s.firstTotal = page.total;
      s.lastTotal = page.total;
      const records = page.items.map((item, i) => {
        const path = `ships[${s.offset + i}]`;
        const record = pick(item, SHIP_RECORD, path);
        if (!record || typeof record['evidenceId'] !== 'string') {
          throw new SchemaDriftError(`${path}.evidenceId`, 'string', 'nothing');
        }
        return record;
      });
      file.append(records);
      const next = page.nextOffset;
      const end = next === undefined || page.items.length === 0;
      if (!end && next <= s.offset) {
        throw new SchemaDriftError('ships.nextOffset', `> ${s.offset}`, String(next));
      }
      s.offset = end ? s.offset + page.items.length : next;
      run.commit('ships', file);
      if (end) break;
    }
    const ids = new Set<string>();
    let rows = 0;
    for (const raw of file.read()) {
      rows += 1;
      ids.add(String((raw as Record<string, unknown>)['evidenceId']));
    }
    const problems: string[] = [];
    if (s.lastTotal !== s.firstTotal) {
      problems.push(
        `the ship feed changed size during the walk (${s.firstTotal} → ${s.lastTotal})`,
      );
    }
    if (ids.size !== s.firstTotal || rows !== ids.size) {
      problems.push(
        `the API said ${s.firstTotal} ships, hey-data collected ${rows} rows (${ids.size} distinct)`,
      );
    }
    if (problems.length === 0) {
      run.finish('ships', file);
      return { total: s.firstTotal ?? 0 };
    }
    s.attempt += 1;
    if (s.attempt >= run.options.listAttempts)
      throw new TotalsMismatchError('The ship feed', problems);
    run.log(`ships: ${problems[0]}; walking again`);
    file.reset();
    Object.assign(s, { offset: 0, firstTotal: null, lastTotal: null });
    run.commit('ships', file);
  }
}

/* ── phase 4: the change ledger ────────────────────────────────────────── */

const TYPE_RE = /^[a-z_]{1,40}\.[a-z_]{1,60}$/;

async function runChanges(run: Run) {
  const phase = run.phase('changes');
  const file = new WorkFile(run.root, 'changes', phase.bytes);
  const s = phase.state;
  for (;;) {
    const page = parsePage(
      LedgerPage,
      await run.client.get('/api/changes', { after: s.after, limit: CHANGES_LIMIT }),
      'changes',
    );
    const lines: Record<string, unknown>[] = [];
    page.items.forEach((item, i) => {
      const path = `changes[${s.pages}][${i}]`;
      if (!isRecord(item)) throw new SchemaDriftError(path, 'object', typeof item);
      if (item['op'] === 'retract') {
        const record = pick(item, RETRACT_RECORD, path);
        if (record) lines.push(record);
        s.retracts += 1;
        return;
      }
      if (item['op'] !== 'upsert')
        throw new SchemaDriftError(`${path}.op`, 'upsert|retract', String(item['op']));
      const type = str(item['type']) ?? '';
      if (!INCLUDED_CHANGE_TYPES.has(type)) {
        const key = TYPE_RE.test(type) ? type : 'unrecognised';
        s.excludedTypes[key] = (s.excludedTypes[key] ?? 0) + 1;
        return;
      }
      const record = pick(item, CHANGE_RECORD, path);
      if (!record || typeof record['id'] !== 'string') {
        throw new SchemaDriftError(`${path}.id`, 'string', 'nothing');
      }
      lines.push(record);
      s.upserts += 1;
    });
    file.append(lines);
    s.pages += 1;
    if (page.ledger) {
      s.ledger = Object.fromEntries(
        Object.entries(page.ledger).filter((e): e is [string, string] => typeof e[1] === 'string'),
      );
    }
    s.after = page.nextCursor;
    run.commit('changes', file);
    if (s.pages % 50 === 0) run.log(`changes: ${s.pages} ledger pages read`);
    if (!page.hasMore) break;
    if (page.items.length === 0)
      throw new SchemaDriftError('changes.hasMore', 'false on an empty page', 'true');
  }
  run.finish('changes', file);
}

/** Ledger state at the snapshot: highest revision per id, retractions applied, ledger order. */
export function materialiseChanges(lines: Iterable<unknown>) {
  const state = new Map<string, Record<string, unknown>>();
  let retractionsApplied = 0;
  for (const raw of lines) {
    const line = raw as Record<string, unknown>;
    const id = String(line['id']);
    const revision = Number(line['revision'] ?? 0);
    const existing = state.get(id);
    if (line['op'] === 'retract') {
      if (existing && Number(existing['revision'] ?? 0) <= revision) {
        state.delete(id);
        retractionsApplied += 1;
      }
      continue;
    }
    if (!existing || revision >= Number(existing['revision'] ?? 0)) {
      state.delete(id);
      state.set(id, line);
    }
  }
  return { records: [...state.values()], retractionsApplied };
}

/* ── phase 5: evidence for ids already referenced ──────────────────────── */

const EVIDENCE_ID_RE = /^([a-z0-9]{2,20}):[A-Za-z0-9:._-]{1,300}$/;

function planEvidence(ships: Record<string, unknown>[], changes: Record<string, unknown>[]) {
  const ordered: string[] = [];
  const referenced = new Set<string>();
  const add = (id: unknown) => {
    if (typeof id !== 'string' || referenced.has(id)) return;
    referenced.add(id);
    const family = EVIDENCE_ID_RE.exec(id)?.[1];
    if (family && (EVIDENCE_FAMILIES as readonly string[]).includes(family)) ordered.push(id);
  };
  const newestFirst = [...ships].sort((a, b) =>
    String(b['detectedAt'] ?? '').localeCompare(String(a['detectedAt'] ?? '')),
  );
  for (const ship of newestFirst) add(ship['evidenceId']);
  for (const change of [...changes].reverse()) {
    const evidence = change['evidence'];
    if (Array.isArray(evidence)) for (const e of evidence) add(isRecord(e) ? e['id'] : undefined);
  }
  return { ordered, referenced: referenced.size };
}

const PLAN = 'evidence-plan.json';
const EvidencePlan = z
  .object({ ids: z.array(z.string().regex(EVIDENCE_ID_RE)), referenced: count, eligible: count })
  .strict();

async function runEvidence(
  run: Run,
  ships: Record<string, unknown>[],
  changes: Record<string, unknown>[],
) {
  const phase = run.phase('evidence');
  const file = new WorkFile(run.root, 'evidence', phase.bytes);
  const planPath = inside(run.root, join('.work', PLAN));
  let plan: z.infer<typeof EvidencePlan>;
  if (existsSync(planPath)) {
    plan = EvidencePlan.parse(JSON.parse(readFileSync(planPath, 'utf8')));
  } else {
    const { ordered, referenced } = planEvidence(ships, changes);
    plan = {
      ids: ordered.slice(0, run.options.evidenceLimit),
      referenced,
      eligible: ordered.length,
    };
    writeAtomic(planPath, JSON.stringify(plan));
  }
  const s = phase.state;
  for (let i = s.index; i < plan.ids.length; i++) {
    const id = plan.ids[i] as string;
    let body: unknown;
    try {
      body = await run.client.get<unknown>(`/api/evidence/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof HeyApiError && error.code === 'not_found') s.notFound += 1;
      else if (error instanceof HeyApiError && error.code === 'bad_request') s.invalid += 1;
      else throw error;
      body = undefined;
    }
    if (body !== undefined) {
      const record = pick(body, EVIDENCE_RECORD, `evidence[${id}]`);
      if (!record) throw new SchemaDriftError(`evidence[${id}]`, 'a record', 'nothing');
      if (record['withdrawn'] === true) {
        s.withdrawn += 1;
        const { id: rid, withdrawn, withdrawalReason, contextReason, project } = record;
        file.append([
          ordered(
            { id: rid, withdrawn, withdrawalReason, contextReason, project },
            EVIDENCE_RECORD,
          ),
        ]);
      } else if (!EVIDENCE_DOMAINS.has(String(record['domain']))) {
        s.excludedDomain += 1;
      } else {
        file.append([record]);
        s.fetched += 1;
      }
    }
    s.index = i + 1;
    run.commit('evidence', file);
    if ((i + 1) % 100 === 0) run.log(`evidence: ${i + 1} of ${plan.ids.length}`);
  }
  run.finish('evidence', file);
  return plan;
}

/* ── the snapshot ──────────────────────────────────────────────────────── */

function buildProjects(run: Run): Record<string, unknown>[] {
  const listing = new Map<string, Record<string, unknown>>();
  for (const raw of new WorkFile(
    run.root,
    'projectsList',
    run.phase('projectsList').bytes,
  ).read()) {
    const { record } = raw as ListLine;
    listing.set(String(record['slug']), record);
  }
  const details = new Map<string, DetailLine>();
  for (const raw of new WorkFile(
    run.root,
    'projectDetails',
    run.phase('projectDetails').bytes,
  ).read()) {
    const line = raw as DetailLine;
    details.set(line.slug, line);
  }
  return [...listing.keys()].sort().map((slug) => {
    const record: Record<string, unknown> = { ...listing.get(slug) };
    const detail = details.get(slug);
    const dossier = detail?.dossier;
    if (dossier) {
      record['narratives'] = dossier['narratives'];
      record['firstRecordedByHeyAt'] = dossier['firstRecordedByHeyAt'];
      const ships = dossier['ships'];
      if (Array.isArray(ships) && ships.length > 0) record['latestShip'] = ships[0];
      const score = dossier['score'];
      if (isRecord(score)) {
        record['scoringVersion'] = score['scoringVersion'];
        record['scoredAt'] = score['calculatedAt'];
      }
    }
    if (detail?.coverage) {
      record['coverage'] = detail.coverage['dimensions'];
      record['coverageComputedAt'] = detail.coverage['computedAt'];
    }
    record['detailRead'] = detail?.detailRead ?? 'skipped';
    return ordered(record, PROJECT_RECORD);
  });
}

function toNdjson(records: readonly Record<string, unknown>[], spec: Spec, file: string): string {
  return records
    .map((record, i) => {
      assertConforms(record, spec, `${file}[${i}]`);
      return `${JSON.stringify(record)}\n`;
    })
    .join('');
}

function window(run: Run, ...phases: PhaseName[]): Pick<FileMeta, 'readFrom' | 'readUntil'> {
  const starts = phases.map((p) => run.cursor.phases[p].startedAt).filter((v): v is string => !!v);
  const ends = phases.map((p) => run.cursor.phases[p].finishedAt).filter((v): v is string => !!v);
  return { readFrom: starts.sort()[0] ?? null, readUntil: ends.sort().at(-1) ?? null };
}

export async function generate(options: GenerateOptions): Promise<GenerateResult> {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => undefined);
  const baseUrl = resolveBaseUrl(options.baseUrl);
  const settings = {
    details: options.details ?? true,
    coverage: (options.details ?? true) && (options.coverage ?? true),
    evidenceLimit: Math.max(0, Math.floor(options.evidenceLimit ?? DEFAULT_EVIDENCE_LIMIT)),
    listAttempts: Math.max(1, Math.floor(options.listAttempts ?? DEFAULT_LIST_ATTEMPTS)),
  };
  const optionsKey = JSON.stringify({ v: GENERATOR_VERSION, baseUrl, ...settings });
  const root = prepareOutDir(options.outDir);

  let cursor = options.restart ? undefined : readCursor(root);
  let resumed = false;
  if (cursor) {
    const allDone = PHASES.every((p) => cursor?.phases[p].done);
    const ageHours = (now().getTime() - Date.parse(cursor.startedAt)) / 3_600_000;
    const maxAge = options.maxResumeAgeHours ?? DEFAULT_MAX_RESUME_AGE_HOURS;
    if (allDone) {
      cursor = undefined;
    } else if (cursor.optionsKey !== optionsKey) {
      throw new WorkStateError(
        'A partial run with different options is in the output directory. Rerun with the same options to resume it, or with --restart to discard it.',
      );
    } else if (!(ageHours <= maxAge)) {
      throw new WorkStateError(
        `The partial run in the output directory started ${Math.round(ageHours)} hours ago, more than ${maxAge}; rerun with --restart so the snapshot is not stitched from readings that far apart.`,
      );
    } else {
      resumed = true;
      log(`resuming the run started at ${cursor.startedAt}`);
    }
  }
  if (!cursor) {
    removeWork(root);
    prepareOutDir(root);
    cursor = freshCursor(optionsKey, now().toISOString());
    saveCursor(root, cursor);
  }

  const run = new Run(root, cursor, settings, {
    fetchImpl: options.fetchImpl ?? ((input, init) => fetch(input, init)),
    baseUrl,
    delayMs: options.delayMs ?? DEFAULT_DELAY_MS,
    maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
    now,
    sleep: options.sleep ?? realSleep,
    log,
  });

  // A phase only finishes once its totals check passed; a failed check throws.
  if (!run.phase('projectsList').done) await runProjectsList(run);
  if (!run.phase('projectDetails').done) await runProjectDetails(run);
  if (!run.phase('ships').done) await runShips(run);
  if (!run.phase('changes').done) await runChanges(run);

  const shipRecords = new Map<string, Record<string, unknown>>();
  for (const raw of new WorkFile(root, 'ships', run.phase('ships').bytes).read()) {
    const record = raw as Record<string, unknown>;
    const id = String(record['evidenceId']);
    if (!shipRecords.has(id)) shipRecords.set(id, record);
  }
  const ships = [...shipRecords.values()].sort(
    (a, b) =>
      String(b['detectedAt'] ?? '').localeCompare(String(a['detectedAt'] ?? '')) ||
      String(a['evidenceId']).localeCompare(String(b['evidenceId'])),
  );
  const { records: changes, retractionsApplied } = materialiseChanges(
    new WorkFile(root, 'changes', run.phase('changes').bytes).read(),
  );
  const plan = await runEvidence(run, ships, changes);
  const evidence = [
    ...new WorkFile(root, 'evidence', run.phase('evidence').bytes).read(),
  ] as Record<string, unknown>[];
  const projects = buildProjects(run);

  const listState = run.phase('projectsList').state;
  const partitions = Object.fromEntries(listState.partitions.map((p) => [p.status, p.total ?? 0]));
  const files: Record<string, readonly Record<string, unknown>[]> = {
    'projects.ndjson': projects,
    'ships.ndjson': ships,
    'changes.ndjson': changes,
    'evidence.ndjson': evidence,
  };
  const content = Object.fromEntries(
    Object.entries(files).map(([name, records]) => [
      name,
      toNdjson(records, OUTPUT_SPECS[name as keyof typeof OUTPUT_SPECS], name),
    ]),
  );

  const changesState = run.phase('changes').state;
  const evidenceState = run.phase('evidence').state;
  const generatedAt = now().toISOString();
  const metadata: Metadata = {
    schemaVersion: SCHEMA_VERSION,
    generator: { name: 'hey-data', version: GENERATOR_VERSION },
    generatedAt,
    startedAt: cursor.startedAt,
    chainId: CHAIN_META.chainId,
    chain: CHAIN_META,
    source: SOURCE,
    apiVersion: run.stats.apiVersion ?? null,
    endpoints: [
      ENDPOINTS.projectsTotal,
      ENDPOINTS.projects,
      ...(settings.details ? [ENDPOINTS.dossier] : []),
      ...(settings.coverage ? [ENDPOINTS.coverage] : []),
      ENDPOINTS.ships,
      ENDPOINTS.changes,
      ...(plan.ids.length > 0 ? [ENDPOINTS.evidence] : []),
    ].map((e) => e.replace('GET ', `GET ${SOURCE}`)),
    recordCount: Object.fromEntries(Object.entries(files).map(([n, r]) => [n, r.length])),
    files: {
      'projects.ndjson': {
        recordCount: projects.length,
        ...window(run, 'projectsList', 'projectDetails'),
      },
      'ships.ndjson': { recordCount: ships.length, ...window(run, 'ships') },
      'changes.ndjson': { recordCount: changes.length, ...window(run, 'changes') },
      'evidence.ndjson': { recordCount: evidence.length, ...window(run, 'evidence') },
    },
    omitted: OMITTED_FILES,
    checks: {
      projectsByStatus: {
        rule: 'Σ /api/projects?status=S total over every activity status = /api/projects total, each partition walked to its total, no project in two partitions',
        total: listState.unfilteredTotal,
        partitions,
        sum: Object.values(partitions).reduce((a, b) => a + b, 0),
        attempts: listState.attempt + 1,
        passed: true,
      },
      ships: {
        rule: 'distinct ships collected = /api/ships total, unchanged during the walk',
        total: run.phase('ships').state.firstTotal,
        collected: ships.length,
        attempts: run.phase('ships').state.attempt + 1,
        passed: true,
      },
    },
    changes: {
      cursor: changesState.after,
      pagesRead: changesState.pages,
      upsertsKept: changesState.upserts,
      retractionsSeen: changesState.retracts,
      retractionsApplied,
      excludedTypes: changesState.excludedTypes,
      ledger: changesState.ledger ?? null,
    },
    evidence: {
      referenced: plan.referenced,
      eligible: plan.eligible,
      limit: settings.evidenceLimit,
      planned: plan.ids.length,
      written: evidence.length,
      withdrawn: evidenceState.withdrawn,
      notFound: evidenceState.notFound,
      invalid: evidenceState.invalid,
      excludedDomain: evidenceState.excludedDomain,
      truncated: plan.eligible > plan.ids.length,
      families: EVIDENCE_FAMILIES,
    },
    license: DATA_LICENSE,
    licenseUrl: DATA_LICENSE_URL,
    attribution: ATTRIBUTION,
    codeLicense: CODE_LICENSE,
    limitations: LIMITATIONS,
    disclaimer: DOES_NOT_PROVE,
    nonAffiliation: NON_AFFILIATION,
    run: {
      resumed,
      requests: run.stats.requests,
      retries: run.stats.retries,
      details: settings.details,
      coverage: settings.coverage,
    },
  };

  for (const [name, text] of Object.entries(content)) writeAtomic(inside(root, name), text);
  writeAtomic(inside(root, 'metadata.json'), `${JSON.stringify(metadata, null, 2)}\n`);
  if (options.keepWork) {
    for (const p of PHASES) cursor.phases[p].done = true;
    saveCursor(root, cursor);
  } else {
    removeWork(root);
  }
  return { outDir: root, resumed, metadata, stats: run.stats };
}
