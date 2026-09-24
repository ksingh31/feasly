#!/usr/bin/env node
/**
 * SITE_URL build-time injection (SEO-01).
 *
 * Reads the `SITE_URL` environment variable and writes it into
 * `public/assets/config/app-config.json` -> `site.url`, so the served config
 * carries the canonical domain without a code change.
 *
 * - `SITE_URL` set   -> validated (`https://host`, no trailing slash) and written.
 * - `SITE_URL` unset -> `site.url` is reset to `""`, which means "use the
 *   request origin at runtime". On SWA staging/preview environments that is
 *   the default `*.azurestaticapps.net` hostname (SEO.md).
 *
 * The production domain is UNDECIDED (feasly.com unverified as of 2026-09-24):
 * leave SITE_URL unset until Karan confirms the domain, then set it on the
 * production build only.
 *
 * The edit is surgical (one regex on the `site.url` value) so the rest of the
 * file — including its `\uXXXX` escapes — is preserved byte-for-byte.
 *
 * Usage: node apps/web/tools/apply-site-url.mjs   (from the repo root;
 * paths resolve from the script location, so any cwd works). Wired into the
 * `@feasly/web` prebuild script.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = dirname(fileURLToPath(import.meta.url)); // apps/web/tools
const CONFIG_PATH = join(WEB_DIR, '..', 'public', 'assets', 'config', 'app-config.json');

const raw = (process.env['SITE_URL'] ?? '').trim().replace(/\/+$/, '');

if (raw !== '' && !/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d+)?$/i.test(raw)) {
  console.error(
    `apply-site-url: refusing invalid SITE_URL ${JSON.stringify(process.env['SITE_URL'])} ` +
      `(expected https://host, no path, no trailing slash)`,
  );
  process.exit(1);
}

const before = readFileSync(CONFIG_PATH, 'utf8');
// Matches `"url": "<anything>"` inside the top-level "site" block only.
const siteBlock = /("site"\s*:\s*\{[^}]*?"url"\s*:\s*")[^"]*(")/s;
if (!siteBlock.test(before)) {
  console.error('apply-site-url: could not locate site.url in app-config.json — aborting');
  process.exit(1);
}
const after = before.replace(siteBlock, `$1${raw}$2`);
if (after === before) {
  console.log(`apply-site-url: site.url already ${JSON.stringify(raw)} — no change`);
  process.exit(0);
}
writeFileSync(CONFIG_PATH, after);
console.log(`apply-site-url: site.url -> ${JSON.stringify(raw || '(empty: runtime origin fallback)')}`);
