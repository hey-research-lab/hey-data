#!/usr/bin/env node
// Records a handful of read-only pages from HEY's public API into test/fixtures/recorded/.
// Maintainers only, by hand: HEY_LIVE=1 node scripts/record-fixtures.mjs
// Paced at one request every 1.2 s (well under the anonymous 120/min), GET only, no key.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

if (process.env.HEY_LIVE !== '1') {
  console.error('Set HEY_LIVE=1 to record fixtures from the live API. Tests never do this.');
  process.exit(2);
}

const BASE = 'https://heyresearch.xyz';
const OUT = join(process.cwd(), 'test', 'fixtures', 'recorded');
const DELAY_MS = 1200;
const STATUSES = ['SHIPPING', 'ACTIVE', 'QUIET', 'DORMANT', 'RESUMED', 'UNKNOWN'];

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let requests = 0;

async function get(path) {
  if (requests > 0) await sleep(DELAY_MS);
  requests += 1;
  const response = await fetch(`${BASE}${path}`, {
    headers: { accept: 'application/json', 'user-agent': 'hey-data/0.1.0 (fixture recorder)' },
    redirect: 'manual',
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return { path, recordedAt: new Date().toISOString(), body: await response.json() };
}

const save = (name, recording) =>
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(recording, null, 2)}\n`);

const listings = [];
for (const status of STATUSES) {
  const page = await get(`/api/projects?status=${status}&limit=2`);
  save(`projects-${status.toLowerCase()}`, page);
  listings.push(page);
}
const withToken = await get('/api/projects?has=token&limit=2');
save('projects-has-token', withToken);

const slugs = [
  listings[0]?.body.items[0]?.slug,
  withToken.body.items[0]?.slug,
  listings[3]?.body.items[0]?.slug,
  listings[5]?.body.items[0]?.slug,
].filter((slug, i, all) => typeof slug === 'string' && all.indexOf(slug) === i);
for (const slug of slugs) {
  save(`dossier-${slug}`, await get(`/api/projects/${encodeURIComponent(slug)}`));
  save(`coverage-${slug}`, await get(`/api/projects/${encodeURIComponent(slug)}/coverage`));
}

const ships = await get('/api/ships?sort=detected&limit=6');
save('ships', ships);

const changes = await get('/api/changes?after=c1.0&limit=12');
save('changes-sync', changes);
for (const domain of ['market', 'contract', 'token', 'research', 'lock']) {
  save(`changes-${domain}`, await get(`/api/changes?domain=${domain}&limit=3`));
}
save('changes-status', await get('/api/changes?type=build.status_changed&limit=2'));

const evidenceIds = [ships.body.items[0]?.evidenceId, changes.body.items[0]?.id].filter(
  (id) => typeof id === 'string',
);
for (const id of evidenceIds) {
  save(
    `evidence-${id.replace(/[^a-z0-9]+/gi, '-')}`,
    await get(`/api/evidence/${encodeURIComponent(id)}`),
  );
}

console.log(`recorded ${requests} responses into ${OUT}`);
