# Contributing

Thanks for helping. hey-data restates HEY Research Lab's public records; changes are judged by
whether they keep the snapshot honest: HEY's own facts only, with provenance, and unknown left
unknown.

## Setup

```sh
corepack enable
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm scan
```

Node 22 or newer, pnpm 9.15.1.

## Tests

- Tests never touch the network: `vitest.setup.ts` replaces `fetch` with one that throws, and the
  generator is driven through an injected `fetchImpl` over `test/mock-api.ts`.
- `test/fixtures/recorded/` holds answers recorded read-only from `https://heyresearch.xyz`.
  The mock API serves those records and recomputes the paging envelopes (totals, offsets,
  cursors) over them so a whole walk fits in a test.
- To re-record (maintainers, rarely): `HEY_LIVE=1 pnpm record-fixtures`. It sends about 25 GET
  requests, one every 1.2 seconds, with no key. Review the diff before committing it, and run
  `pnpm scan`.

## Allowlists are product decisions

`src/allowlist.ts` names every field each file may hold. Adding a field, a coverage dimension, a
change type or an evidence family is a decision about what HEY redistributes, not a refactor: open
an issue first. Market figures, anything derived from markets, holder and distribution data,
usage and caller counts, Market Integrity and the Builder Radar stay out; the forbidden-name test
fails the build if one is added.

## Style

TypeScript strict, ESLint and Prettier as configured, small conventional commits (`feat:`,
`fix:`, `test:`, `docs:`, `ci:`, `chore:`). No secrets, no `.env` with values.

## Maintainers: parity

hey-data copies no production code. Its vocabularies, field names and route behaviour follow HEY
Research Lab's public API contract (`/api/projects`, `/api/projects/{slug}`, `/coverage`,
`/api/ships`, `/api/changes`, `/api/evidence/{id}`) as of production commit
`21775391f6c0fb4494575e0b4463df535c65cb96` and `@hey-research-lab/sdk` 0.1.1; `src/chain.ts` and
`src/evm.ts` are the ecosystem's shared constants, verbatim. When the API adds a field, nothing
changes here until the allowlist is updated on purpose.
