/**
 * Resumable state. A run keeps its partial files and a cursor in `<out>/.work`.
 * Every page is appended first and the cursor (with the new byte length of
 * each file) is written second, atomically; a run that stops between the two
 * leaves bytes past the cursor, which the next run truncates before it goes on.
 */
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import { z } from 'zod';

export const CURSOR_SCHEMA = 'hey-data.cursor/v1';
export const WORK_DIR = '.work';
const MAX_CURSOR_BYTES = 1024 * 1024;

const count = z.number().int().nonnegative();
const partition = z
  .object({
    status: z.string(),
    total: count.nullable(),
    lastTotal: count.nullable(),
    collected: count,
  })
  .strict();

export const PhaseStates = z
  .object({
    projectsList: z
      .object({
        attempt: count,
        unfilteredTotal: count.nullable(),
        partitionIndex: count,
        offset: count,
        partitions: z.array(partition),
      })
      .strict(),
    projectDetails: z.object({ index: count }).strict(),
    ships: z
      .object({
        attempt: count,
        offset: count,
        firstTotal: count.nullable(),
        lastTotal: count.nullable(),
      })
      .strict(),
    changes: z
      .object({
        after: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/),
        pages: count,
        upserts: count,
        retracts: count,
        excludedTypes: z.record(z.string(), count),
        ledger: z.record(z.string(), z.string()).optional(),
      })
      .strict(),
    evidence: z
      .object({
        index: count,
        fetched: count,
        withdrawn: count,
        notFound: count,
        invalid: count,
        excludedDomain: count,
      })
      .strict(),
  })
  .strict();
export type PhaseStates = z.infer<typeof PhaseStates>;
export type PhaseName = keyof PhaseStates;
export const PHASES: readonly PhaseName[] = [
  'projectsList',
  'projectDetails',
  'ships',
  'changes',
  'evidence',
];

const phaseRecord = <T extends z.ZodTypeAny>(state: T) =>
  z
    .object({
      done: z.boolean(),
      bytes: count,
      startedAt: z.string().nullable(),
      finishedAt: z.string().nullable(),
      state,
    })
    .strict();

export const CursorFile = z
  .object({
    schema: z.literal(CURSOR_SCHEMA),
    generatorVersion: z.string(),
    optionsKey: z.string(),
    startedAt: z.string(),
    updatedAt: z.string(),
    phases: z
      .object({
        projectsList: phaseRecord(PhaseStates.shape.projectsList),
        projectDetails: phaseRecord(PhaseStates.shape.projectDetails),
        ships: phaseRecord(PhaseStates.shape.ships),
        changes: phaseRecord(PhaseStates.shape.changes),
        evidence: phaseRecord(PhaseStates.shape.evidence),
      })
      .strict(),
  })
  .strict();
export type CursorFile = z.infer<typeof CursorFile>;

export const WORK_FILES: Record<PhaseName, string> = {
  projectsList: 'projects-list.ndjson',
  projectDetails: 'project-details.ndjson',
  ships: 'ships.ndjson',
  changes: 'changes-log.ndjson',
  evidence: 'evidence.ndjson',
};

export class WorkStateError extends Error {
  readonly code = 'work_state';
}

/** Refuses a symlinked output directory and keeps every path the run writes inside it. */
export function prepareOutDir(outDir: string): string {
  const root = resolve(outDir);
  if (existsSync(root) && lstatSync(root).isSymbolicLink()) {
    throw new WorkStateError(`Refusing to write through a symbolic link: ${outDir}`);
  }
  mkdirSync(join(root, WORK_DIR), { recursive: true });
  const work = join(root, WORK_DIR);
  if (lstatSync(work).isSymbolicLink()) throw new WorkStateError('The work directory is a link.');
  return root;
}

export function inside(root: string, name: string): string {
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new WorkStateError(`Path escapes ${root}`);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
    throw new WorkStateError(`Refusing to write through a symbolic link: ${name}`);
  }
  return target;
}

export function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, { mode: 0o644 });
  renameSync(tmp, path);
}

export function readCursor(root: string): CursorFile | undefined {
  const path = inside(root, join(WORK_DIR, 'cursor.json'));
  if (!existsSync(path)) return undefined;
  if (statSync(path).size > MAX_CURSOR_BYTES) throw new WorkStateError('cursor.json is too large.');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new WorkStateError('cursor.json is not JSON; rerun with --restart.');
  }
  const parsed = CursorFile.safeParse(raw);
  if (!parsed.success)
    throw new WorkStateError('cursor.json is not a hey-data cursor; rerun with --restart.');
  return parsed.data;
}

export function saveCursor(root: string, cursor: CursorFile): void {
  writeAtomic(inside(root, join(WORK_DIR, 'cursor.json')), `${JSON.stringify(cursor, null, 2)}\n`);
}

/** An append-only NDJSON file whose committed length lives in the cursor. */
export class WorkFile {
  readonly path: string;
  private size: number;

  constructor(root: string, phase: PhaseName, committedBytes: number) {
    this.path = inside(root, join(WORK_DIR, WORK_FILES[phase]));
    if (!existsSync(this.path)) {
      if (committedBytes > 0) {
        throw new WorkStateError(`${WORK_FILES[phase]} is missing; rerun with --restart.`);
      }
      writeFileSync(this.path, '');
    }
    const actual = statSync(this.path).size;
    if (actual < committedBytes) {
      throw new WorkStateError(
        `${WORK_FILES[phase]} is shorter than its cursor; rerun with --restart.`,
      );
    }
    if (actual > committedBytes) truncateSync(this.path, committedBytes);
    this.size = committedBytes;
  }

  get bytes(): number {
    return this.size;
  }

  append(records: readonly unknown[]): number {
    if (records.length === 0) return this.size;
    const chunk = records.map((r) => `${JSON.stringify(r)}\n`).join('');
    appendFileSync(this.path, chunk);
    this.size += Buffer.byteLength(chunk);
    return this.size;
  }

  reset(): void {
    truncateSync(this.path, 0);
    this.size = 0;
  }

  *read(): Generator<unknown> {
    const text = readFileSync(this.path).subarray(0, this.size).toString('utf8');
    for (const line of text.split('\n')) if (line) yield JSON.parse(line) as unknown;
  }
}

export function removeWork(root: string): void {
  rmSync(inside(root, WORK_DIR), { recursive: true, force: true });
}
