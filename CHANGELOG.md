# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## 0.1.1 — 2026-10-02

- `pnpm generate -- --out …` works: the separator pnpm 9 passes through is dropped (it failed as `Unknown command`). The README no longer uses it.
- Ctrl-C prints "stopped. Run the same command again to resume."
- Examples run on a quick `--no-details` snapshot: `node.mjs` takes each project's newest ship from `ships.ndjson`, and the DuckDB coverage query reads raw JSON, so a snapshot with no coverage field says "not read in this snapshot" instead of failing.
- Issue templates (bug, idea) with private security reporting and HEY corrections linked.

## 0.1.0 — 2026-10-02

Initial release.

- `hey-data generate`: a resumable generator over HEY Research Lab's public API that writes
  `projects.ndjson`, `ships.ndjson`, `changes.ndjson`, `evidence.ndjson` and `metadata.json`
  (`schemaVersion` 1, `chainId` 4663).
- Field allowlists per file in code, a write gate that fails on any key outside them or on a
  market, holder, usage, integrity or Radar field name, and a type check that stops the run on
  schema drift instead of guessing.
- Projects partitioned by activity status, with the partitions checked against the unfiltered
  total (and the ship feed against its total); a mismatch walks again, then fails loudly.
- The change ledger read through its sync cursor from the start, market and usage types left out,
  revisions and retractions applied.
- Evidence fetched only for ids the snapshot references, by allowed family, up to a limit.
- Polite HTTP: a configurable delay (default 1,100 ms), `retry-after` honoured, bounded retries,
  no redirects, capped bodies.
- Resume from `<out>/.work` after any stop; atomic final writes.
- `ci.yml` (scan, lint, typecheck, offline tests, build) and a manual-only `snapshot.yml` that
  uploads the snapshot as an artifact and, when asked, attaches it to a GitHub Release.
- Data licensed CC BY 4.0 (attribution "HEY Research Lab, https://heyresearch.xyz"); code MIT.
- Examples for DuckDB, Python (pandas and DuckDB), Node.js and curl + jq.
