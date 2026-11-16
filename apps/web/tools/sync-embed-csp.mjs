#!/usr/bin/env node
/**
 * Per-tenant embed framing (#516, review B13).
 *
 * The builder widget is served at `/embed?key=<tenant>` (loader snippet) and
 * `/embed/<tenant>`. The global CSP sets `frame-ancestors 'none'`, so both
 * routes need their own CSP whose frame-ancestors lists exactly the origins
 * that tenants are allowed to frame the widget from.
 *
 * The allowed origins come from tenant config: the union of every
 * `allowed_origins` array in `config/builders/*.json` (same files the API
 * validates and bundles; see apps/api/tools/generate-builder-configs.ts).
 *
 * Origins on IANA-reserved placeholder domains (RFC 2606 / RFC 6761:
 * example.com/.net/.org and the .example, .test, .invalid, .localhost TLDs)
 * are left out of frame-ancestors (#796, route audit F-3). They can never be
 * a real tenant page, so they have no business in a shipped CSP — the demo
 * tenant keeps its placeholder origin in config for API/QA fixtures only.
 *
 * The embed CSP is the global CSP with only `frame-ancestors` swapped for
 * `'self' <origins…>`, so the two can never drift apart on any other
 * directive. Both the exact `/embed` rule (SWA matches the path without the
 * query string, so this is the one `/embed?key=…` hits) and the `/embed/*`
 * rule carry it.
 *
 * Usage (paths resolve from this file, so any cwd works):
 *   node apps/web/tools/sync-embed-csp.mjs          rewrite staticwebapp.config.json
 *   node apps/web/tools/sync-embed-csp.mjs --check  exit 1 if it is out of date (lint)
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SWA_CONFIG_PATH = join(WEB_DIR, 'public', 'staticwebapp.config.json');
export const BUILDERS_DIR = join(WEB_DIR, '..', '..', 'config', 'builders');

/** Routes that serve the embed shell (index.html) and must allow framing. */
export const EMBED_SHELL_ROUTES = ['/embed/*', '/embed'];

/** An origin safe to put in frame-ancestors: https, host (+ optional port), no path or wildcard. */
const ORIGIN_RE = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{1,5})?$/;

/** RFC 2606 / RFC 6761 reserved second-level domains and TLDs. */
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org'];
const RESERVED_TLDS = ['example', 'test', 'invalid', 'localhost'];

/** True when `origin` (already normalised) sits on an IANA-reserved placeholder domain. */
export function isReservedOrigin(origin) {
  const host = origin.replace(/^https:\/\//, '').replace(/:\d+$/, '');
  const tld = host.slice(host.lastIndexOf('.') + 1);
  return (
    RESERVED_TLDS.includes(tld) ||
    RESERVED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
  );
}

/**
 * Collects the sorted, de-duplicated union of tenant allowed origins.
 * Throws on anything that is not a plain https origin, so a bad tenant file
 * can never open framing to a wildcard or an http page. Reserved placeholder
 * origins (see isReservedOrigin) are validated, then skipped.
 */
export function collectAllowedOrigins(buildersDir = BUILDERS_DIR) {
  const files = readdirSync(buildersDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const origins = new Set();
  for (const file of files) {
    const tenant = JSON.parse(readFileSync(join(buildersDir, file), 'utf8'));
    const list = tenant.allowed_origins;
    if (!Array.isArray(list)) {
      throw new Error(`${file}: allowed_origins must be an array`);
    }
    for (const raw of list) {
      const origin = typeof raw === 'string' ? raw.trim().replace(/\/+$/, '').toLowerCase() : '';
      if (!ORIGIN_RE.test(origin)) {
        throw new Error(`${file}: allowed origin ${JSON.stringify(raw)} is not an https origin`);
      }
      if (!isReservedOrigin(origin)) origins.add(origin);
    }
  }
  return [...origins].sort();
}

/** Returns `csp` with its frame-ancestors directive set to `'self'` + `origins`. */
export function buildEmbedCsp(globalCsp, origins) {
  const value = ["frame-ancestors 'self'", ...origins].join(' ');
  const directives = globalCsp
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean);
  const idx = directives.findIndex((d) => d.split(/\s+/)[0] === 'frame-ancestors');
  if (idx === -1) directives.push(value);
  else directives[idx] = value;
  return directives.join('; ');
}

/**
 * Returns a copy of the SWA config whose embed shell routes carry the
 * per-tenant CSP. Throws if an embed shell route is missing.
 */
export function syncEmbedCsp(config, origins) {
  const globalCsp = config.globalHeaders?.['Content-Security-Policy'];
  if (!globalCsp) throw new Error('globalHeaders.Content-Security-Policy is missing');
  const embedCsp = buildEmbedCsp(globalCsp, origins);
  const next = structuredClone(config);
  for (const route of EMBED_SHELL_ROUTES) {
    const rule = (next.routes ?? []).find((r) => r.route === route);
    if (!rule) throw new Error(`staticwebapp.config.json has no ${route} route`);
    rule.headers = { ...rule.headers, 'Content-Security-Policy': embedCsp };
  }
  return next;
}

/** Serialises the config the way it is committed (2-space JSON, trailing newline). */
export function serialiseConfig(config) {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function main() {
  const check = process.argv.includes('--check');
  const before = readFileSync(SWA_CONFIG_PATH, 'utf8');
  const origins = collectAllowedOrigins();
  const after = serialiseConfig(syncEmbedCsp(JSON.parse(before), origins));
  if (before === after) {
    console.log(`sync-embed-csp: OK (${origins.length} tenant origin(s))`);
    return;
  }
  if (check) {
    console.error(
      'sync-embed-csp: staticwebapp.config.json embed CSP is out of date with config/builders. ' +
        'Run: node apps/web/tools/sync-embed-csp.mjs',
    );
    process.exit(1);
  }
  writeFileSync(SWA_CONFIG_PATH, after);
  console.log(`sync-embed-csp: wrote frame-ancestors for ${origins.join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`sync-embed-csp: ${e.message}`);
    process.exit(1);
  }
}
