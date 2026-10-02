/**
 * hey-data generate — writes projects.ndjson, ships.ndjson, changes.ndjson,
 * evidence.ndjson and metadata.json from HEY's public API.
 *
 * Exit codes (ecosystem conventions): 0 done · 1 a totals check or the schema
 * failed · 2 usage · 3 HEY refused · 4 not found · 5 rate limited · 6 network
 * or HEY 5xx (rerun the same command to resume).
 */
import { parseArgs } from 'node:util';
import { HeyApiError } from '@hey-research-lab/sdk';
import { ForbiddenFieldError, SchemaDriftError } from './allowlist.js';
import { UnsupportedChainError } from './chain.js';
import {
  DEFAULT_EVIDENCE_LIMIT,
  DEFAULT_LIST_ATTEMPTS,
  DEFAULT_MAX_RESUME_AGE_HOURS,
  GENERATOR_VERSION,
  TotalsMismatchError,
  generate,
} from './generate.js';
import {
  BaseUrlError,
  BodyTooLargeError,
  DEFAULT_DELAY_MS,
  DEFAULT_MAX_RETRIES,
  MAX_RETRIES_CAP,
  MIN_CLI_DELAY_MS,
} from './http.js';
import { WorkStateError } from './work.js';

const HELP = `hey-data ${GENERATOR_VERSION} — research snapshots of HEY's public builder records (Robinhood Chain 4663)

Usage:
  hey-data generate [options]

Options:
  --out <dir>             output directory (default ./snapshot)
  --delay-ms <n>          pause between requests, at least ${MIN_CLI_DELAY_MS} (default ${DEFAULT_DELAY_MS})
  --max-retries <n>       retries of a 429/5xx with the server's delay, 0-${MAX_RETRIES_CAP} (default ${DEFAULT_MAX_RETRIES})
  --evidence-limit <n>    evidence records to fetch, 0 for none (default ${DEFAULT_EVIDENCE_LIMIT})
  --no-details            listing fields only: no per-project dossier or coverage reads
  --no-coverage           skip per-project coverage reads
  --list-attempts <n>     walks of a listing before a totals mismatch fails the run (default ${DEFAULT_LIST_ATTEMPTS})
  --max-resume-age <h>    refuse to resume a partial run older than this many hours (default ${DEFAULT_MAX_RESUME_AGE_HOURS})
  --restart               discard a partial run in the output directory
  --keep-work             keep the .work directory after a finished run
  --quiet                 no progress lines on stderr
  -h, --help              this help
  -v, --version           the version

A stopped run resumes when the same command is run again.
Exit codes: 0 done, 1 check failed, 2 usage, 3 refused, 4 not found, 5 rate limited, 6 network/5xx.`;

class UsageError extends Error {}

function int(value: string | undefined, name: string, min: number, max: number, fallback: number) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) throw new UsageError(`${name} must be a whole number.`);
  const n = Number(value);
  if (n < min || n > max) throw new UsageError(`${name} must be between ${min} and ${max}.`);
  return n;
}

function exitCodeFor(error: unknown): number {
  if (error instanceof UsageError || error instanceof BaseUrlError) return 2;
  if (error instanceof UnsupportedChainError) return 1;
  if (error instanceof TotalsMismatchError || error instanceof SchemaDriftError) return 1;
  if (error instanceof ForbiddenFieldError || error instanceof WorkStateError) return 1;
  if (error instanceof BodyTooLargeError) return 6;
  if (error instanceof HeyApiError) {
    if (error.code === 'not_found') return 4;
    if (error.code === 'rate_limited' || error.code === 'quota') return 5;
    if (['network', 'timeout', 'unavailable'].includes(error.code)) return 6;
    if (error.status !== undefined && error.status >= 500) return 6;
    return 3;
  }
  return 6;
}

function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  if (error instanceof HeyApiError) {
    const body = error.body as { requestId?: unknown } | undefined;
    if (typeof body?.requestId === 'string') parts.push(`requestId: ${body.requestId}`);
    if (error.retryAfterSeconds !== undefined)
      parts.push(`retry after ${error.retryAfterSeconds}s`);
  }
  return parts.join(' — ');
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: 'string' },
        'delay-ms': { type: 'string' },
        'max-retries': { type: 'string' },
        'evidence-limit': { type: 'string' },
        'no-details': { type: 'boolean' },
        'no-coverage': { type: 'boolean' },
        'list-attempts': { type: 'string' },
        'max-resume-age': { type: 'string' },
        restart: { type: 'boolean' },
        'keep-work': { type: 'boolean' },
        quiet: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.version) {
    process.stdout.write(`${GENERATOR_VERSION}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(`${HELP}\n`);
    return positionals.length === 0 && !values.help ? 2 : 0;
  }
  if (positionals[0] !== 'generate' || positionals.length > 1) {
    process.stderr.write(`Unknown command: ${positionals.join(' ')}\n\n${HELP}\n`);
    return 2;
  }
  const log = values.quiet ? () => undefined : (line: string) => process.stderr.write(`${line}\n`);
  try {
    const result = await generate({
      outDir: values.out ?? 'snapshot',
      baseUrl: process.env['HEY_BASE_URL'] || undefined,
      delayMs: int(values['delay-ms'], '--delay-ms', MIN_CLI_DELAY_MS, 60_000, DEFAULT_DELAY_MS),
      maxRetries: int(
        values['max-retries'],
        '--max-retries',
        0,
        MAX_RETRIES_CAP,
        DEFAULT_MAX_RETRIES,
      ),
      evidenceLimit: int(
        values['evidence-limit'],
        '--evidence-limit',
        0,
        20_000,
        DEFAULT_EVIDENCE_LIMIT,
      ),
      details: !values['no-details'],
      coverage: !values['no-coverage'],
      listAttempts: int(values['list-attempts'], '--list-attempts', 1, 10, DEFAULT_LIST_ATTEMPTS),
      maxResumeAgeHours: int(
        values['max-resume-age'],
        '--max-resume-age',
        1,
        720,
        DEFAULT_MAX_RESUME_AGE_HOURS,
      ),
      restart: values.restart ?? false,
      keepWork: values['keep-work'] ?? false,
      log,
    });
    const counts = Object.entries(result.metadata.recordCount)
      .map(([file, n]) => `${file} ${n}`)
      .join(', ');
    log(`snapshot written to ${result.outDir}: ${counts} (${result.stats.requests} requests)`);
    return 0;
  } catch (error) {
    process.stderr.write(`hey-data: ${describe(error)}\n`);
    return exitCodeFor(error);
  }
}
