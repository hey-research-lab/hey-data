import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { tempOut } from './helpers.js';

describe('cli', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['HEY_BASE_URL'];
  });

  const quiet = () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    return vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  };

  it('prints the version and help', async () => {
    quiet();
    expect(await main(['--version'])).toBe(0);
    expect(await main(['--help'])).toBe(0);
  });

  it('exits 2 on usage errors, before any request', async () => {
    quiet();
    expect(await main([])).toBe(2);
    expect(await main(['scrape'])).toBe(2);
    expect(await main(['generate', '--bogus'])).toBe(2);
    expect(await main(['generate', '--delay-ms', '100'])).toBe(2);
    // `pnpm generate -- --delay-ms 100` reaches the CLI with the separator: still the option, not a command.
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await main(['generate', '--', '--delay-ms', '100'])).toBe(2);
    expect(stderr.mock.calls.map(([line]) => String(line)).join('')).toMatch(/--delay-ms must be/);
    stderr.mockRestore();
    expect(await main(['generate', '--max-retries', '9'])).toBe(2);
    expect(await main(['generate', '--evidence-limit', '-1'])).toBe(2);
  });

  it('exits 2 for a base URL that is not https or localhost', async () => {
    quiet();
    process.env['HEY_BASE_URL'] = 'http://example.org';
    expect(await main(['generate', '--out', tempOut()])).toBe(2);
  });

  it('refuses to write through a symbolic link', async () => {
    const stderr = quiet();
    const dir = tempOut();
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(await main(['generate', '--out', join(dir, 'link'), '--quiet'])).toBe(1);
    expect(String(stderr.mock.calls.at(-1)?.[0])).toMatch(/symbolic link/);
  });
});
