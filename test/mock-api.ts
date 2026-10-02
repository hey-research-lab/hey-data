/**
 * A small HEY API built from responses recorded read-only from
 * https://heyresearch.xyz on 2026-10-02 (test/fixtures/recorded, written by
 * scripts/record-fixtures.mjs). The records are real, with personal handles
 * replaced by neutral placeholders; the paging envelopes
 * (totals, offsets, cursors) are recomputed over the recorded set so a whole
 * walk fits in a test.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

type Json = Record<string, unknown>;
type Recording = { path: string; recordedAt: string; body: Json };

const DIR = join(import.meta.dirname, 'fixtures', 'recorded');
const load = (name: string): Recording =>
  JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as Recording;
const names = readdirSync(DIR).map((f) => f.replace(/\.json$/, ''));
const items = (rec: Recording) => rec.body['items'] as Json[];
const clone = <T>(v: T): T => structuredClone(v);

export type World = {
  projects: Json[];
  dossiers: Map<string, Json>;
  coverage: Map<string, Json>;
  ships: Json[];
  changes: Json[];
  evidence: Map<string, Json>;
  /** Override a listing's reported total: (query) => total | undefined. */
  lieAboutTotal?: (params: URLSearchParams) => number | undefined;
};

export function buildWorld(): World {
  const projects = new Map<string, Json>();
  for (const name of names.filter((n) => n.startsWith('projects-'))) {
    for (const item of items(load(name))) projects.set(String(item['slug']), item);
  }
  const dossiers = new Map<string, Json>();
  const coverage = new Map<string, Json>();
  for (const name of names) {
    if (name.startsWith('dossier-')) {
      const body = load(name).body;
      dossiers.set(String(body['slug']), body);
    }
    if (name.startsWith('coverage-')) {
      const body = load(name).body;
      coverage.set(String((body['project'] as Json)['slug']), body);
    }
  }
  const changes: Json[] = [];
  const seen = new Set<string>();
  const order = [
    'changes-sync',
    'changes-status',
    'changes-token',
    'changes-research',
    'changes-lock',
    'changes-market',
    'changes-contract',
  ];
  for (const name of order) {
    for (const item of items(load(name))) {
      const key = `${String(item['id'])}#${String(item['revision'])}`;
      if (!seen.has(key)) {
        seen.add(key);
        changes.push(item);
      }
    }
  }
  // Two ledger behaviours the recordings cannot show on their own: a later
  // revision of an event, and a retraction of an event the snapshot holds.
  const first = changes[0] as Json;
  changes.push({
    ...clone(first),
    revision: 2,
    summary: `${String(first['summary'])} (revised)`,
    recordedAt: '2026-10-02T12:00:00.000Z',
  });
  const second = changes[1] as Json;
  changes.push({
    id: second['id'],
    revision: Number(second['revision']) + 1,
    op: 'retract',
    recordedAt: '2026-10-02T12:05:00.000Z',
  });

  const evidence = new Map<string, Json>();
  for (const name of names.filter((n) => n.startsWith('evidence-'))) {
    const body = load(name).body;
    evidence.set(String(body['id']), body);
  }
  return {
    projects: [...projects.values()],
    dossiers,
    coverage,
    ships: items(load('ships')),
    changes,
    evidence,
  };
}

const encodeCursor = (seq: number) => Buffer.from(`c1.${seq}`).toString('base64url');
const decodeCursor = (cursor: string): number => {
  if (cursor === 'c1.0') return 0;
  const text = Buffer.from(cursor, 'base64url').toString('utf8');
  const match = /^c1\.(\d+)$/.exec(text);
  if (!match) throw new Error(`bad cursor ${cursor}`);
  return Number(match[1]);
};

const DISCLAIMER = 'Public, source-backed activity HEY recorded.';

export type MockHooks = {
  /** Return a Response to answer instead of the world (429s, failures); called before routing. */
  intercept?: (url: URL, n: number) => Response | Promise<Response> | undefined;
};

export type MockApi = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  calls: string[];
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'x-hey-api-version': '1',
      'x-request-id': `req-${Math.random().toString(16).slice(2, 10)}`,
      ...headers,
    },
  });

const notFound = () =>
  json({ error: 'not_found', message: 'Not found.', requestId: 'req-404', retryable: false }, 404);

function offsetPage(all: Json[], params: URLSearchParams, total = all.length) {
  const limit = Math.min(Number(params.get('limit') ?? 24), 48);
  const offset = Number(params.get('offset') ?? 0);
  const page = all.slice(offset, offset + limit);
  const next = offset + limit;
  return {
    total,
    items: page,
    ...(next < all.length ? { nextOffset: next } : {}),
    disclaimer: DISCLAIMER,
  };
}

export function mockApi(world: World, hooks: MockHooks = {}): MockApi {
  const calls: string[] = [];
  const route = (url: URL): Response => {
    const p = url.pathname;
    const q = url.searchParams;
    if (p === '/api/projects') {
      const status = q.get('status');
      const rows = status
        ? world.projects.filter((x) => x['activityStatus'] === status)
        : world.projects;
      const total = world.lieAboutTotal?.(q) ?? rows.length;
      return json({
        query: Object.fromEntries(q),
        ...offsetPage(rows, q, total),
        catalogue: { chainId: 4663 },
      });
    }
    const project = /^\/api\/projects\/([^/]+)(\/coverage)?$/.exec(p);
    if (project) {
      const slug = decodeURIComponent(project[1] as string);
      const listed = world.projects.find((x) => x['slug'] === slug);
      if (!listed) return notFound();
      if (project[2]) {
        const recorded = world.coverage.get(slug) ?? clone([...world.coverage.values()][0] as Json);
        return json({ ...recorded, project: { slug, name: listed['name'], url: listed['url'] } });
      }
      const dossier = world.dossiers.get(slug) ?? {
        ...listed,
        narratives: [],
        ships: [],
        disclaimer: DISCLAIMER,
      };
      return json(dossier);
    }
    if (p === '/api/ships')
      return json({ query: Object.fromEntries(q), ...offsetPage(world.ships, q) });
    if (p === '/api/changes') {
      const after = decodeCursor(q.get('after') ?? 'c1.0');
      const limit = Math.min(Number(q.get('limit') ?? 50), 100);
      const page = world.changes.slice(after, after + limit);
      const last = after + page.length;
      return json({
        query: { after: q.get('after'), mode: 'sync', limit },
        items: page,
        nextCursor: encodeCursor(page.length ? last : after),
        hasMore: last < world.changes.length,
        ledger: {
          collectionStart: '2026-09-26T11:35:57.227Z',
          newestRecordedAt: '2026-10-02T12:05:00.000Z',
        },
        disclaimer: DISCLAIMER,
      });
    }
    const evidence = /^\/api\/evidence\/(.+)$/.exec(p);
    if (evidence) {
      const id = decodeURIComponent(evidence[1] as string);
      if (!/^[a-z0-9]+:.+/.test(id))
        return json(
          {
            error: 'invalid_evidence_id',
            message: 'Malformed id.',
            requestId: 'req-400',
            retryable: false,
          },
          400,
        );
      const record = world.evidence.get(id);
      return record ? json(record) : notFound();
    }
    return notFound();
  };
  return {
    calls,
    fetch: async (input: string) => {
      const url = new URL(input);
      calls.push(`${url.pathname}${url.search}`);
      const intercepted = await hooks.intercept?.(url, calls.length);
      return intercepted ?? route(url);
    },
  };
}
