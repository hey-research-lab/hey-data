#!/usr/bin/env node
// Leak and attribution scan. Usage: node scripts/scan.mjs [dir] [--git]
// Tier 2 patterns: HEY_LEAKSCAN_EXTRA=<path to a JSON array of regex sources> (never committed).
import { readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

const SKIP_DIRS = new Set(['.git', 'node_modules', 'coverage', '.pnpm-store', 'test-results']);
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp4|mov|pdf|zip|gz|tgz)$/i;

// Generic secret shapes (from HEY's public manifest `forbidden`).
const SECRETS = [
  'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY',
  'ghp_[A-Za-z0-9]{20,}', 'github_pat_[A-Za-z0-9_]{20,}', 'gh[osu]_[A-Za-z0-9]{30,}',
  'sk-[A-Za-z0-9]{20,}', 'npm_[A-Za-z0-9]{30,}', '(?<![A-Za-z0-9_-])re_[A-Za-z0-9_-]{20,}',
  '\\d{8,10}:AA[\\w-]{30,}',                                   // Telegram bot token
  '(?<![A-Za-z0-9_-])heyp?_(?=[A-Za-z0-9_-]{0,42}[0-9])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])', // HEY keys
  '\\\\nMII[A-Za-z0-9+/]{40,}',
  'postgres(ql)?://(?![^\\s\'"]*(change|replace|example|password|<))[^\\s\'"]*:[^\\s\'"@]+@(?!localhost)',
  '(?:DATABASE_URL|BITQUERY_[A-Z_]*KEY|UNISWAP_API_KEY|TELEGRAM_BOT_TOKEN|GITHUB_TOKEN|NPM_TOKEN)\\s*=\\s*[^\\s#<$]{8,}',
  'proapi_[A-Za-z0-9]{8,}',
  '/Users/[A-Za-z0-9_.-]+/', '/home/[a-z0-9_.-]+/(?!runner/)', 'C:\\\\Users\\\\',
];
// Private HEY internals that must never be copied (table and module names, split so this file is clean).
const PRIVATE = [
  'telegram_lin[k]', 'telegram_message[s]', 'telegram_update[s]', 'alert_notification[s]', 'alert_rule[s]',
  'hey_api_(account|key|partner)[s_]', 'builder_candidate[s]', 'token_candidate[s_]', 'project_linked_addres[s]',
  'token_holder_(day|link|summar)', 'product_event[s_]', 'analytics_event[s]', 'moderation_flag[s]',
  'webhook_(subscription|deliverie)[s]', 'audit_lo[g]\\b', '@hey/(d[b]|domai[n]|worke[r])\\b',
  'apps/(we[b]|worke[r])/src', 'packages/(d[b]|domai[n])/src', '/api/admi[n]/', 'hey-research\\.gi[t]\\b',
  'docker-compose\\.pro[d]', 'hey-worke[r]\\b',
];
// AI-authorship attribution.
const ATTRIBUTION = [
  '\\bC[l]aude\\b', 'A[n]thropic', 'Co-Authored-B[y]', 'Generated (with|by) (C[l]aude|A[I]\\b)',
  '\\bA[I][- ]generated\\b', '\\bA[I][- ]assisted\\b', 'Created by A[I]\\b', '\\u{1F916}(?!x)',
];

const extra = process.env.HEY_LEAKSCAN_EXTRA && existsSync(process.env.HEY_LEAKSCAN_EXTRA)
  ? JSON.parse(readFileSync(process.env.HEY_LEAKSCAN_EXTRA, 'utf8')) : [];
const rules = [
  ...SECRETS.map((s) => ['secret', new RegExp(s, 'i')]),
  ...PRIVATE.map((s) => ['private', new RegExp(s, 'i')]),
  ...ATTRIBUTION.map((s) => ['attribution', new RegExp(s, 'iu')]),
  ...extra.map((s) => ['local', new RegExp(s, 'i')]),
];
// Any public IPv4 literal (catches a production address without naming it). Docs/private/loopback ranges allowed.
const IPV4 = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;
const publicIp = (a, b, c) => !(a === 10 || a === 127 || a === 0 || a >= 224 || (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) ||
  (a === 192 && b === 0 && c === 2) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));

const root = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : '.';
const allow = existsSync(join(root, '.leakscan-allow'))
  ? readFileSync(join(root, '.leakscan-allow'), 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
const hits = [];
const check = (label, text) => text.split('\n').forEach((line, i) => {
  for (const [kind, re] of rules) if (re.test(line)) hits.push(`${kind}: ${label}:${i + 1} (${re.source})`);
  for (const m of line.matchAll(IPV4)) {
    const [a, b, c, d] = m.slice(1, 5).map(Number);
    if ([a, b, c, d].every((n) => n <= 255) && publicIp(a, b, c)) hits.push(`ip: ${label}:${i + 1}`);
  }
});
const walk = (dir) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    const st = lstatSync(path);
    if (st.isSymbolicLink()) { hits.push(`symlink: ${relative(root, path)}`); continue; }
    if (st.isDirectory()) walk(path);
    else if (st.isFile() && !BINARY.test(entry) && st.size < 8 * 1024 * 1024) {
      const rel = relative(root, path);
      if (/(^|\/)\.env(\.(?!example$)[^/]*)?$/.test(rel)) hits.push(`env-file: ${rel}`);
      check(rel, readFileSync(path, 'utf8'));
    }
  }
};
walk(root);
if (process.argv.includes('--git')) {
  check('git-log', execFileSync('git', ['-C', root, 'log', '--all', '--format=fuller%n%B'], { encoding: 'utf8' }));
}
const reported = hits.filter((h) => !allow.some((a) => h.includes(a)));
if (reported.length) { for (const h of reported) console.error(h); process.exit(1); }
console.log(`scan clean: ${root}${extra.length ? ` (+${extra.length} local patterns)` : ''}`);
