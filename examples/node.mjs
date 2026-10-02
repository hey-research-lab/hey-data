// Read a hey-data snapshot with Node.js (no dependencies).
//   node examples/node.mjs snapshot
import { createReadStream, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = process.argv[2] ?? 'snapshot';

async function* records(file) {
  const lines = createInterface({ input: createReadStream(join(root, file)), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line);
}

const meta = JSON.parse(readFileSync(join(root, 'metadata.json'), 'utf8'));
console.log(`snapshot ${meta.generatedAt}, chain ${meta.chainId}, licence ${meta.license}`);

// Each project's newest ship in ships.ndjson: present in every snapshot, including a quick
// --no-details one, where projects carry no latestShip.
const newest = new Map();
for await (const s of records('ships.ndjson')) {
  const slug = s.project?.slug;
  if (slug && (!newest.has(slug) || s.publishedAt > newest.get(slug).publishedAt))
    newest.set(slug, s);
}

// Verified builders whose newest ship HEY lists is a GitHub release.
// A project with no ship in the snapshot is skipped: absent means unknown, not "never shipped".
for await (const p of records('projects.ndjson')) {
  const latest = p.latestShip ?? newest.get(p.slug);
  if (p.researchLevel === 'VERIFIED_BUILDER' && latest?.eventType === 'GITHUB_RELEASE') {
    console.log(`${p.slug}\t${p.activityStatus}\t${latest.publishedAt}\t${p.url}`);
  }
}

// Change types in the snapshot's ledger state.
const byType = new Map();
for await (const c of records('changes.ndjson')) byType.set(c.type, (byType.get(c.type) ?? 0) + 1);
console.table([...byType].sort((a, b) => b[1] - a[1]));
