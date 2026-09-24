#!/usr/bin/env node
/**
 * Security-headers tripwire (HRD-01).
 *
 * Fails (exit 1) when apps/web/public/staticwebapp.config.json drifts from
 * the launch security posture:
 *   1. globalHeaders must carry all five headers: Content-Security-Policy,
 *      Strict-Transport-Security, X-Content-Type-Options, Referrer-Policy,
 *      Permissions-Policy.
 *   2. The global CSP must be strict: no 'unsafe-inline'/'unsafe-eval' in
 *      script-src, no '*' anywhere, frame-ancestors 'none', and it must
 *      allow exactly the browser's real external dependencies
 *      (Google Fonts + the City of Calgary Socrata API) — nothing else.
 *   3. HSTS must pin max-age >= 1 year with includeSubDomains + preload.
 *   4. The /embed/* route must override frame-ancestors (the embed track
 *      needs framing) WITHOUT opening a wildcard.
 *   5. No `$schema` key — swa-cli 1.1.10 crashes on it (see TOOLS.md).
 *
 * Usage: node apps/web/tools/check-security-headers.mjs (paths resolve
 * from the script location, so any cwd works).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = join(WEB_DIR, '..', 'public', 'staticwebapp.config.json');

const failures = [];
const fail = (msg) => failures.push(msg);

let config;
try {
  config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
} catch (e) {
  console.error(`security-headers: cannot parse ${CONFIG_PATH}: ${e.message}`);
  process.exit(1);
}

if ('$schema' in config) {
  fail('top-level $schema key present — swa-cli 1.1.10 crashes on it');
}

const headers = config.globalHeaders ?? {};
const REQUIRED = [
  'Content-Security-Policy',
  'Strict-Transport-Security',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Permissions-Policy',
];
for (const name of REQUIRED) {
  if (!headers[name]) fail(`globalHeaders missing ${name}`);
}

const csp = headers['Content-Security-Policy'] ?? '';
const directives = new Map(
  csp
    .split(';')
    .map((d) => d.trim())
    .filter(Boolean)
    .map((d) => {
      const [name, ...rest] = d.split(/\s+/);
      return [name, rest];
    }),
);
const has = (directive, token) => (directives.get(directive) ?? []).includes(token);

if (csp.includes('*') && !csp.includes('https://')) {
  // A bare '*' token anywhere is a wildcard source — never allowed.
  if (/(^|\s)\*(;|$|\s)/.test(csp)) fail("CSP contains a wildcard '*' source");
}
if (has('script-src', "'unsafe-inline'") || has('script-src', "'unsafe-eval'")) {
  fail('CSP script-src must not allow unsafe-inline/unsafe-eval');
}
if (!has('frame-ancestors', "'none'")) {
  fail("global CSP must set frame-ancestors 'none'");
}
for (const [directive, token] of [
  ['style-src', 'https://fonts.googleapis.com'],
  ['font-src', 'https://fonts.gstatic.com'],
  ['connect-src', 'https://data.calgary.ca'],
  ['form-action', "'self'"],
  ['base-uri', "'self'"],
  ['object-src', "'none'"],
]) {
  if (!has(directive, token)) fail(`CSP ${directive} must include ${token}`);
}

const hsts = headers['Strict-Transport-Security'] ?? '';
const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0);
if (maxAge < 31_536_000) fail('HSTS max-age must be at least 31536000 (1 year)');
if (!hsts.includes('includeSubDomains')) fail('HSTS must include includeSubDomains');
if (!hsts.includes('preload')) fail('HSTS must include preload');

if ((headers['X-Content-Type-Options'] ?? '').toLowerCase() !== 'nosniff') {
  fail('X-Content-Type-Options must be nosniff');
}
if (headers['Referrer-Policy'] !== 'strict-origin-when-cross-origin') {
  fail('Referrer-Policy must be strict-origin-when-cross-origin');
}
for (const feature of ['camera=()', 'microphone=()', 'geolocation=()']) {
  if (!(headers['Permissions-Policy'] ?? '').includes(feature)) {
    fail(`Permissions-Policy must deny ${feature.split('=')[0]}`);
  }
}

const embedRoute = (config.routes ?? []).find((r) => r.route === '/embed/*');
if (!embedRoute) {
  fail('missing /embed/* route overriding frame-ancestors for the embed track');
} else {
  const embedCsp = embedRoute.headers?.['Content-Security-Policy'] ?? '';
  if (!embedCsp) {
    fail('/embed/* route must set its own Content-Security-Policy');
  } else {
    if (embedCsp.includes("'none'") && /frame-ancestors[^;]*'none'/.test(embedCsp)) {
      fail('/embed/* CSP must NOT set frame-ancestors none — the embed needs framing');
    }
    if (/(^|\s)\*(;|$|\s)/.test(embedCsp)) {
      fail("/embed/* CSP contains a wildcard '*' source");
    }
    if (!/frame-ancestors/.test(embedCsp)) fail('/embed/* CSP must declare frame-ancestors');
  }
}

if (failures.length > 0) {
  console.error('security-headers: FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('security-headers: OK');
