# hey-data

A resumable generator that turns HEY Research Lab's public API into research-friendly NDJSON
snapshots of HEY's own builder records on Robinhood Chain: projects, ships, changes and evidence.

[![CI](https://github.com/hey-research-lab/hey-data/actions/workflows/ci.yml/badge.svg)](https://github.com/hey-research-lab/hey-data/actions/workflows/ci.yml)
![Code licence: MIT](https://img.shields.io/badge/code-MIT-blue)
![Data licence: CC BY 4.0](https://img.shields.io/badge/data-CC%20BY%204.0-blue)
![Node >= 22](https://img.shields.io/badge/node-%3E%3D22-informational)
![Robinhood Chain 4663](https://img.shields.io/badge/Robinhood%20Chain-4663-informational)

## Why it exists

HEY's public API answers one project or one page at a time, which is right for an app and slow for
research. A notebook that asks "which projects shipped a release in September, and what did HEY
record about them?" wants the whole record in a file. hey-data walks the public API politely,
keeps only HEY's own builder facts with their provenance, and writes them as NDJSON with a
`metadata.json` that says what was read, when, and what was left out.

## Why Robinhood Chain only

HEY researches Robinhood Chain (chain id `4663`, CAIP-2 `eip155:4663`) and nothing else. Every
snapshot declares `chainId: 4663`; a record that names any other chain stops the run with
`unsupported_chain` rather than being written.

## Install

hey-data is a repository, not an npm package.

```sh
git clone https://github.com/hey-research-lab/hey-data.git
cd hey-data
corepack enable
pnpm install
pnpm build
```

Node 22 or newer. Runtime dependencies: `@hey-research-lab/sdk` (HEY's typed API client) and `zod`
(validates page envelopes and the resume cursor).

## Smallest working example

A quick snapshot without per-project detail reads (about 800 requests, roughly 15 minutes at the
default pace):

```sh
pnpm generate --out snapshot --no-details --evidence-limit 0
head -n 1 snapshot/projects.ndjson
```

The full snapshot reads each project's dossier and coverage too (about two requests per project;
roughly three and a half hours for ~5,000 projects). Stop it at any time; the same command resumes.

```sh
pnpm generate --out snapshot
```

The test suite runs offline over recorded API answers: `pnpm test`.

## Files

| File              | One line per                                                      | Read from                                                                                                    |
| ----------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `projects.ndjson` | published project                                                 | `GET /api/projects` (partitioned by status), `GET /api/projects/{slug}`, `GET /api/projects/{slug}/coverage` |
| `ships.ndjson`    | ship (release, code week, product ship)                           | `GET /api/ships?sort=detected`                                                                               |
| `changes.ndjson`  | change-ledger event, at its highest revision, retractions applied | `GET /api/changes?after=` from the start of the ledger                                                       |
| `evidence.ndjson` | evidence record referenced by a ship or change (bounded)          | `GET /api/evidence/{id}`                                                                                     |
| `metadata.json`   | the snapshot                                                      | —                                                                                                            |

`builders.ndjson` is **not produced**: HEY's only builder listing is the Builder Radar, a ranking
whose scores include an on-chain sub-score and a liquidity field. The builder facts outside that
ranking are already in `projects.ndjson`.

### Fields

Every file has a field **allowlist in code** (`src/allowlist.ts`). Records are built by reading
those named fields from the API's JSON; nothing is passed through, so a field HEY adds later stays
out until someone adds it on purpose. Every line passes a final gate that fails the run if any key,
at any depth, is outside the allowlist or looks like a market, holder, usage, integrity or Radar
field. Field names and state words are the API's own.

- **projects** — `slug`, `name`, `url`, `symbol`, `shortDescription`, `projectKind`,
  `activityStatus`, `researchLevel`, `catalogStatus`, `lastShippedAt`, `primaryNarrative`,
  `narratives[]`, `token {chainId, contractAddress}`, `tokenVerification {status, reason}`,
  `websiteUrl`, `officialX`, `logoUrl`, `hasBuilderSource`, `firstRecordedByHeyAt`,
  `latestShip {evidenceId, eventType, publishedAt, detectedAt, precision, verification}` (the newest
  meaningful ship HEY lists), `scoringVersion`, `scoredAt`, `coverage {<dimension>: {state, reason,
since, asOf}}`, `coverageComputedAt`, and `detailRead` (`read`, `dossier_only`, `not_found` when
  the project was unpublished between the listing and its detail read, or `skipped` with
  `--no-details`).
  Coverage dimensions kept: identity, builderEvidence, repositories, releases, timeline,
  contractDeployment, contractSource, contractInterface, locks, officialDocs, apiDocs,
  sourceChanges, gitHost, package, securityContext.
- **ships** — `evidenceId`, `eventType`, `title`, `publishedAt`, `detectedAt`, `precision`,
  `verification`, `sourceUrl`, `url`, `project {slug, name, url}`, `codeWeek` (a code week's
  fixed ISO week, repository and commit count) and `codeSubstance {verdict, classifierVersion,
countsAsBuilding}`.
- **changes** — `id`, `revision`, `op`, `type`, `domain`, `origin`, `project`, `contract`, `token`,
  `occurredAt`, `occurredUntil`, `precision`, `detectedAt`, `recordedAt`, `summary`, `before`,
  `after`, `evidence[] {id, url, label}`, `source`, `countsAsBuilding`, `facts` (an allowlist of
  plain facts: ship type and verification, code-week counts, transition key and scoring version,
  ABI change counts, lock id and kind, site-change counts) and `links`.
  Types kept: `build.*`, `contract.deployed`, `contract.followup_deployed`,
  `contract.implementation_changed`, `contract.source_verified`, `contract.source_unverified`,
  `contract.interface_changed`, `token.verification_changed`, `research.*`, `lock.*`.
  Left out (and counted in `metadata.changes.excludedTypes`): every `market.*` type,
  `market_integrity.event`, `contract.usage_changed`, `contract.method_first_observed`,
  `contract.method_resumed` and `token.launch_stage_changed`.
- **evidence** — `id`, `withdrawn`, `withdrawalReason`, `contextReason`, `project`, `domain`,
  `claimType`, `summary`, `sourceType`, `sourceUrl`, `publishedAt`, `detectedAt`, `precision`,
  `verification`, `countsAsBuilding`, `recordedAt`, `metadata` (release version, site-change
  counts) and `sources[] {sourceType, sourceUrl, observedAt}`. Only the families `ship`, `abi`,
  `impl`, `lock`, `source`, `claim`, `state`, `narrative`, `sourcechange`, `security` and `v4hook`
  are fetched, newest referenced first, up to `--evidence-limit` (default 500).

### What is never in a snapshot

Price, market cap, FDV, valuation, liquidity, volume, trades, venue, token market status and
launch stage; anything derived from them (Still Building, the Discovery Gap, Under the Radar);
holder or distribution data; usage and caller counts; Market Integrity; the Builder Radar and Build
Momentum; release notes and commit messages; anything keyed, partner-only or account-bound.

### Unknown stays unknown

An absent field means HEY does not know it, or does not publish it. hey-data never fills a gap with
`0`, `false`, `[]`, `""` or "none". A `null` appears only where the API itself sends one with a
documented meaning (`occurredAt: null` with `precision: "OBSERVED"` for a change HEY observed but no
source dated). Coverage states (`MEASURED`, `NO_SOURCE`, `NOT_ENOUGH_YET`, `STALE`,
`SOURCE_UNAVAILABLE`, `NOT_APPLICABLE`, `NOT_RESEARCHED`, `ERROR`, `WITHHELD`) and activity states
(`SHIPPING`, `ACTIVE`, `QUIET`, `DORMANT`, `RESUMED`, `UNKNOWN`) are copied as the API words them.

### metadata.json

`schemaVersion`, `generatedAt`, `startedAt`, `chainId` (4663) and `chain`, `source`
(`https://heyresearch.xyz`), `apiVersion`, `endpoints` (every route read), `recordCount` per file,
`files.*.readFrom`/`readUntil` (a snapshot is read over a window, not at one instant), `omitted`,
`checks` (the totals checks below), `changes` (ledger cursor, excluded types, retractions applied),
`evidence` (referenced, eligible, limit, truncated), `license` (`CC-BY-4.0`), `licenseUrl`,
`attribution`, `codeLicense`, `limitations[]`, `disclaimer` and `nonAffiliation`.

## Usage

```
hey-data generate [options]

  --out <dir>             output directory (default ./snapshot)
  --delay-ms <n>          pause between requests, at least 600 (default 1100)
  --max-retries <n>       retries of a 429/5xx with the server's delay, 0-5 (default 1)
  --evidence-limit <n>    evidence records to fetch, 0 for none (default 500)
  --no-details            listing fields only: no per-project dossier or coverage reads
  --no-coverage           skip per-project coverage reads
  --list-attempts <n>     walks of a listing before a totals mismatch fails the run (default 3)
  --max-resume-age <h>    refuse to resume a partial run older than this (default 48)
  --restart               discard a partial run in the output directory
  --keep-work             keep the .work directory after a finished run
  --quiet                 no progress lines on stderr
```

| Exit | Meaning                                                                           |
| ---- | --------------------------------------------------------------------------------- |
| 0    | snapshot written                                                                  |
| 1    | a totals check, the schema gate or the work state failed (nothing new is written) |
| 2    | usage error                                                                       |
| 3    | HEY refused a request (4xx)                                                       |
| 4    | an unexpected not-found                                                           |
| 5    | rate limited past the retry budget — rerun the same command later to resume       |
| 6    | network failure, timeout or HEY 5xx — rerun the same command to resume            |

### Rate limits

HEY's anonymous limit is 120 requests a minute per client. hey-data sends one request every
`--delay-ms` (1,100 ms by default, about 55 a minute; the CLI refuses less than 600 ms), honours
`retry-after` on a 429 or 503, retries a retryable answer at most `--max-retries` times with the
server's delay, never follows a redirect and caps every response body at 8 MB. It sends no key.

### Resume

Partial files and a cursor live in `<out>/.work`. Every page is appended before the cursor records
its new length, so a run stopped at any point resumes from its last whole page; bytes written past
the cursor are truncated first. A partial run older than `--max-resume-age` hours, or one started
with different options, is refused rather than stitched together. The finished files are written
atomically (temporary file, then rename) and `.work` is removed.

### Totals checks (the run fails loudly when they do not hold)

- **Projects by status.** The catalogue is walked once per activity status. Each partition must be
  walked to the total the API reported for it, the total must not move during the walk, no project
  may appear in two partitions, and the partitions must add up to the unfiltered total read before
  and after the walk. A mismatch walks again, up to `--list-attempts`; then the run exits 1 and
  names each discrepancy. A new status word from HEY, or a partition past the listing's offset cap,
  fails the same way instead of producing a short file.
- **Ships.** Distinct ships collected must equal the feed's total, unchanged during the walk.

## GitHub Actions

- `ci.yml` — on push and pull request: leak scan, lint, typecheck, tests (offline), build.
- `snapshot.yml` — **manual only** (`workflow_dispatch`, no schedule). It builds a snapshot and
  uploads it as a workflow artifact with `LICENSE-DATA`. With the `release` input set, a separate
  job (the only one with `contents: write`) attaches the snapshot to a GitHub Release tagged
  `data-<date>-<run id>`. A stopped run uploads its `.work` as `hey-data-partial`; pass that run's
  id as `resume_from_run` to continue it.

Snapshots are never committed to this repository.

## Examples

- [`examples/duckdb.sql`](examples/duckdb.sql) — DuckDB SQL over the NDJSON files.
- [`examples/pandas_duckdb.py`](examples/pandas_duckdb.py) — Python with pandas and DuckDB.
- [`examples/node.mjs`](examples/node.mjs) — Node.js, no dependencies.
- [`examples/curl-jq.sh`](examples/curl-jq.sh) — jq over the files, and curl for the same public
  routes.

## How it relates to HEY Research Lab

hey-data reads only HEY's public, keyless read API at `https://heyresearch.xyz` (documented at
https://heyresearch.xyz/docs/public-api) through `@hey-research-lab/sdk`. It writes nothing to HEY,
calls no other host, and never calls a provider. A snapshot restates HEY's records; HEY's own
pages and API stay the authoritative, current source, and every record carries the HEY `url` or
evidence id it came from.

## What it does NOT prove

The datasets restate HEY's public records as of the snapshot time. An absent field means HEY does
not know it. The data is not investment advice, carries no safety verdict, and market data is
deliberately excluded.

HEY Research Lab is an independent research project and is not affiliated with, endorsed by or
partnered with Robinhood Markets, Inc. or Robinhood Chain.

## Security

See [SECURITY.md](SECURITY.md). hey-data makes HTTPS GET requests to `https://heyresearch.xyz`
only (`HEY_BASE_URL` exists for local tests: an https origin, or http on localhost), never follows
redirects, caps response bodies, treats every API text as data (bidirectional-override and
zero-width characters are removed; links are kept exactly as HEY recorded them, so check a
link's scheme before rendering it), reads only allowlisted keys (so `__proto__` and friends are
never copied), and writes only fixed file names inside `--out`, refusing symbolic links.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`
and `pnpm scan` must pass; tests never touch the network. Adding a field to an allowlist is a
product decision, not a refactor.

## Licence

- **Code:** MIT — see [LICENSE](LICENSE).
- **Data** (snapshot files produced by this generator): Creative Commons Attribution 4.0
  International (CC BY 4.0) — see [LICENSE-DATA](LICENSE-DATA). Attribution: **HEY Research Lab,
  https://heyresearch.xyz**.

### How to cite

> HEY Research Lab, https://heyresearch.xyz. _HEY data snapshot_ (generated &lt;generatedAt from
> metadata.json&gt;). Licensed under CC BY 4.0.

Keep the snapshot's `generatedAt`, link `https://heyresearch.xyz`, say whether you changed the
data, and keep each record's HEY `url` or evidence id with anything you republish from it.
