# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## Unreleased

- `hey-data hooks` copies HEY's daily hooks file (every Uniswap v4 hook HEY's hooks page shows: the project HEY ties
  it to, the basis and the receipt, or not tied) into `hooks.ndjson` with `hooks.metadata.json`, checked against the
  day's `SHA256SUMS` and the new `HOOK_RECORD` allowlist. The weekly Snapshot workflow runs it and attaches both to
  the release; a HEY snapshot without the file leaves that week without one, with a warning (2026-11-05).
- The weekly snapshot failed on 2026-10-19 (one 520) and 2026-11-02 (two minutes of timeouts and a 503, three
  minutes into the dossier reads). A server error, network failure or timeout now backs off exponentially
  (30 s doubling to 300 s; a short `retry-after` on a 5xx waits at least the backoff); the workflow passes
  `--max-retries 5`, resumes from its own partial work twice after 15 minutes when HEY is still
  unreachable, runs at 02:17 instead of on the hour, and a scheduled run that still fails opens or
  comments on one issue.
- Security: `zod` moves from `^3.24.1` to `^4.6.7` (GHSA-mrhx-c7xc-m3w5; no 3.x release is fixed).
- Development: vitest 4.1.12; CI actions pinned to commit SHAs, kept current by Dependabot.
- A 520–524 answer (what the CDN in front of HEY returns when the origin errs or times out), a network failure and a timeout are now retried like a 502, within `--max-retries`; an oversized body still is not. The weekly Snapshot workflow passes `--max-retries 3`. Its first scheduled run (2026-10-19) stopped after 26 minutes on a single 520.
- The Snapshot workflow runs weekly (Mondays 02:00 UTC) and attaches the full snapshot to a GitHub Release, so a wholesale dataset exists at a stable URL without a manual run; `workflow_dispatch` stays for a run by hand (2026-10-14).
- README: HEY's own daily snapshots at heyresearch.xyz/data, under the same licence and allowlist, and how they differ from this generator's files.
- Depends on `@hey-research-lab/sdk` `^0.2.0` (published 2026-10-09), which types the API's additive fields since 0.1.2; a caret on 0.x does not cross a minor, so `^0.1.1` kept the older SDK.
- Development: vitest 4.1.11 / tsup 8.5.1, with esbuild held at ^0.28.1 by a pnpm override; clears dev-only advisories in the test and build toolchain. No runtime change.

## 0.2.0 — 2026-10-09

Kept in step with HEY's public API as of 2026-10-09.

### Added

- `projects.ndjson`: each kept coverage dimension also carries HEY's additive `stateDetail` (`MAPPING_BLOCKED` under `NO_SOURCE`, `PARTIAL` under `MEASURED`) and `cause` (`own_source_unreachable`, `provider_unavailable`, `budget_deferred`) when HEY sends them. `state` keeps its nine values and its meaning. `schemaVersion` stays 1: the change is additive.

### Changed

- Test fixtures re-recorded from production on 2026-10-09 (current code-week titles, scoring version, coverage details), with personal handles replaced by neutral placeholders as before.

Checked against the 2026-10-09 contract and unchanged: the change-ledger types kept and left out (HEY now refuses an unknown `type` or `domain` filter; hey-data sends neither), the change fact keys, the evidence `contextReason` values (`launch_window` passes through as HEY words it), and the sync cursor walk.

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
