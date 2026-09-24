#!/usr/bin/env node
/**
 * Security-headers tripwire (HRD-01).
 *
 * Fails (exit 1) when apps/web/public/staticwebapp.config.json drifts from
 * the launch security posture:
 *   1. globalHeaders must carry all five headers: Content-Security-Policy,
 *      Strict-Transport-Security, X-Content-Type-Options, Referrer-Policy,
 *      Permissions-Policy.
 *   2. The global CSP must be strict: no 'unsafe-inline' in script-src
 *      ('unsafe-eval' IS allowed — NGXS compiles store selectors with
 *      `new Function(...)` (getStateGetter/makeRootSelector) and offers no
 *      configuration to avoid it; without it every page throws EvalError),
 *      no '*' anywhere, frame-ancestors 'none', the two known inline
 *      scripts allowlisted by sha256 hash (see INLINE_SCRIPT_HASHES), and
 *      it must allow exactly the browser's real external dependencies
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

/**
 * sha256 hashes of the only two inline <script> blocks the production build
 * emits (verified byte-identical in dist/web/browser/index.html and
 * index.csr.html). If either block's bytes change (index.html edit, Angular
 * upgrade changing the beasties loader), recompute from the production build
 * output and update BOTH CSP strings in staticwebapp.config.json:
 *   node -e "const {readFileSync,re}=require('fs'); ..."  — or see the
 *   hotfix commit that introduced these for the exact extraction snippet.
 */
const INLINE_SCRIPT_HASHES = [
  // <script type="application/ld+json"> LocalBusiness schema in src/index.html
  "'sha256-zAUlMTajbqjVdY8AYldT6VARsBxlta5saR1E7WUWGXc='",
  // Angular beasties/critters deferred-CSS loader (data-beasties-media)
  "'sha256-LMY6wYoFV9I4wWzxaq1N/dTpl4iurQktw706UCHK3vM='",
];

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
if (has('script-src', "'unsafe-inline'")) {
  fail("CSP script-src must not allow 'unsafe-inline' — inline scripts are allowlisted by hash");
}
// 'unsafe-eval' is required: NGXS compiles store selectors via `new Function(...)`
// (getStateGetter/makeRootSelector) and offers no configuration to avoid it.
// Without it, the store is dead at runtime (EvalError on every page).
if (!has('script-src', "'unsafe-eval'")) {
  fail("CSP script-src must allow 'unsafe-eval' (NGXS requires it — see comment above)");
}
for (const hash of INLINE_SCRIPT_HASHES) {
  if (!has('script-src', hash)) {
    fail(`CSP script-src must allowlist the known inline script ${hash} (recompute from dist if the block changed)`);
  }
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
    // The embed serves the same index.html, so it needs the same script-src
    // allowances (NGXS eval + the two hashed inline scripts).
    const embedHas = (token) => embedCsp.split(';').some((d) => {
      const [name, ...rest] = d.trim().split(/\s+/);
      return name === 'script-src' && rest.includes(token);
    });
    if (embedHas("'unsafe-inline'")) fail("/embed/* CSP script-src must not allow 'unsafe-inline'");
    if (!embedHas("'unsafe-eval'")) fail("/embed/* CSP script-src must allow 'unsafe-eval' (NGXS)");
    for (const hash of INLINE_SCRIPT_HASHES) {
      if (!embedHas(hash)) fail(`/embed/* CSP script-src must allowlist ${hash}`);
    }
  }
}

if (failures.length > 0) {
  console.error('security-headers: FAILED');
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('security-headers: OK');
