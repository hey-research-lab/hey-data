import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const tempOut = () => mkdtempSync(join(tmpdir(), 'hey-data-test-'));

export function fakeClock(start = '2026-10-02T12:00:00.000Z') {
  let t = Date.parse(start);
  const waits: number[] = [];
  return {
    now: () => new Date(t),
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    tick: (ms: number) => {
      t += ms;
    },
    waits,
  };
}

export const readNdjson = (dir: string, file: string): Record<string, unknown>[] =>
  readFileSync(join(dir, file), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

export const readJson = (dir: string, file: string) =>
  JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, unknown>;

export const listFiles = (dir: string) => readdirSync(dir).sort();

/** Every key at every depth of a JSON value, as `a.b` / `a[].b` paths. */
export function keyPaths(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.flatMap((v) => keyPaths(v, `${prefix}[]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => {
      const here = prefix ? `${prefix}.${k}` : k;
      return [here, ...keyPaths(v, here)];
    });
  }
  return [];
}
