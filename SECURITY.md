# Security policy

## Reporting a vulnerability

Please report privately through GitHub's "Report a vulnerability" (Security → Advisories) on this
repository, or email hi@heyresearch.xyz with "security" in the subject. Do not open a public issue.
We aim to acknowledge within 3 working days. There is no bug bounty for this repository.

## Scope

hey-data reads HEY Research Lab's public API and writes NDJSON files.

- **Network:** HTTPS GET requests to `https://heyresearch.xyz` only. `HEY_BASE_URL` (tests and
  local mocks) accepts an https origin, or http on `localhost` / `127.0.0.1`, with no credentials,
  path or query. Redirects are never followed; every response body is capped at 8 MB; requests are
  paced (one per `--delay-ms`, never under 600 ms from the CLI) and a server's `retry-after` is
  honoured. The generator never fetches a URL found inside a record — URLs in the data are data.
- **Untrusted input:** API answers are treated as untrusted. Page envelopes and the resume cursor
  are validated with zod; records are built from a fixed allowlist of keys read as own properties,
  so `__proto__`, `constructor` and `prototype` are never copied; a value of an unexpected type
  stops the run. Bidirectional-override and zero-width characters are removed from text.
- **Files:** only fixed file names are written, inside `--out`. A symbolic link at the output
  directory, the work directory or any target file is refused; every path is confined to the
  output root. Finished files are written to a temporary name and renamed.
- **Processes:** no child processes.

## Handling secrets

This project never needs HEY credentials and sends no API key. It reads no secrets from the
environment and logs none. Never commit a `.env` with values.

## Supported versions

The latest 0.x minor receives fixes.
