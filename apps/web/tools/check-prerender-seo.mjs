#!/usr/bin/env node
/**
 * Prerendered-SEO regression check (SEO-01).
 *
 * After `npm run build`, greps the prerendered route HTML for the required
 * SEO tags. Fails loudly on the first missing signal. Run from the workspace
 * root as `node tools/check-prerender-seo.mjs`.
 *
 * Route HTML locations follow Angular's default prerender output layout:
 * `dist/web/browser/<route>/index.html`, with `/` at `index.html`.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const BROWSER = join(ROOT, 'dist', 'web', 'browser');

const failures = [];
const notes = [];

function htmlFor(route) {
  const candidate = route === '/' ? join(BROWSER, 'index.html') : join(BROWSER, route, 'index.html');
  if (!existsSync(candidate)) {
    failures.push(`missing prerendered HTML for route "${route}" (looked for ${candidate})`);
    return null;
  }
  return readFileSync(candidate, 'utf8');
}

function mustContain(html, route, needle, why) {
  if (html === null) return;
  if (!html.includes(needle)) failures.push(`"${route}" missing ${why}: ${needle}`);
}

/** Matches a meta tag by attribute pair regardless of ordering/whitespace. */
function metaPresent(html, attrs) {
  if (html === null) return false;
  const metas = html.match(/<meta[^>]*>/gi) ?? [];
  return metas.some((tag) => attrs.every(([k, v]) => tag.includes(`${k}="${v}"`)));
}

function mustMeta(html, route, attrs, why) {
  if (html === null) return;
  if (!metaPresent(html, attrs)) {
    failures.push(`"${route}" missing meta tag ${why}: ${attrs.map(([k, v]) => `${k}="${v}"`).join(' ')}`);
  }
}

function mustNotMeta(html, route, attrs, why) {
  if (html === null) return;
  if (metaPresent(html, attrs)) {
    failures.push(`"${route}" must NOT carry ${why}: ${attrs.map(([k, v]) => `${k}="${v}"`).join(' ')}`);
  }
}

function mustCanonical(html, route, expectedPath) {
  if (html === null) return;
  const match = html.match(/<link[^>]*rel="canonical"[^>]*>/i);
  if (!match) {
    failures.push(`"${route}" missing link[rel=canonical]`);
    return;
  }
  const href = match[0].match(/href="([^"]*)"/)?.[1] ?? '';
  if (!href.endsWith(expectedPath)) {
    failures.push(`"${route}" canonical "${href}" does not end with "${expectedPath}"`);
  }
  if (expectedPath !== '/' && href.endsWith('//')) {
    failures.push(`"${route}" canonical "${href}" has a doubled trailing slash`);
  }
}

// --- Indexable routes: full tag set + trailing-slash canonical. ---
for (const route of ['/', '/privacy', '/terms', '/404']) {
  const html = htmlFor(route);
  const expectedPath = route === '/' ? '/' : `${route}/`;
  mustCanonical(html, route, expectedPath);
  mustContain(html, route, '<title>', 'document title');
  mustMeta(html, route, [['name', 'description']], 'meta description');
  mustMeta(html, route, [['property', 'og:title']], 'OG title');
  mustMeta(html, route, [['property', 'og:description']], 'OG description');
  mustMeta(html, route, [['property', 'og:url']], 'OG url');
  mustMeta(html, route, [['property', 'og:image']], 'OG image');
  mustMeta(html, route, [['property', 'og:type'], ['content', 'website']], 'og:type=website');
  mustMeta(
    html,
    route,
    [['name', 'twitter:card'], ['content', 'summary_large_image']],
    'twitter:card=summary_large_image',
  );
}

// --- Private routes: noindex,nofollow is applied at runtime by robotsGuard
// (which runs before any redirect guard) and by SeoService.setForRoute().
// They are intentionally NOT prerendered: /estimate/scope and /estimate/report
// redirect to / during prerender (no wizard state), so prerendering them
// would only bake the redirect placeholder. Covered by unit tests instead. ---

// --- 404 brand copy + noindex. ---
{
  const html = htmlFor('/404');
  mustContain(html, '/404', "That page doesn't exist.", 'branded 404 heading');
  mustContain(html, '/404', 'Back to home', 'branded 404 CTA');
  mustMeta(
    html,
    '/404',
    [['name', 'robots'], ['content', 'noindex,nofollow']],
    'robots noindex,nofollow',
  );
}

// --- Indexable routes must NOT be noindexed. ---
for (const route of ['/', '/privacy', '/terms']) {
  const html = htmlFor(route);
  mustNotMeta(html, route, [['name', 'robots'], ['content', 'noindex,nofollow']], 'robots noindex');
}

// --- OG image: checked-in 1200x630 asset (verified with `file`; PNG header
// read here so the check doesn't need imagemagick). ---
const ogPath = join(BROWSER, 'assets', 'og', 'og-default.png');
if (!existsSync(ogPath)) {
  failures.push('missing assets/og/og-default.png in build output');
} else {
  const png = readFileSync(ogPath);
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width !== 1200 || height !== 630) {
    failures.push(`og-default.png is ${width}x${height}, must be 1200x630`);
  } else {
    notes.push(`og-default.png present at 1200x630 (${(statSync(ogPath).size / 1024).toFixed(1)} kB)`);
  }
}

// --- Absolute og:image on the landing page. ---
{
  const html = htmlFor('/');
  if (html !== null) {
    const ogImage = html.match(/<meta[^>]*property="og:image"[^>]*>/i)?.[0] ?? '';
    const content = ogImage.match(/content="([^"]*)"/)?.[1] ?? '';
    if (!/^https?:\/\//.test(content)) {
      failures.push(`landing og:image is not absolute: "${content}"`);
    }
  }
}

if (notes.length > 0) {
  for (const note of notes) console.log(`  note: ${note}`);
}
if (failures.length > 0) {
  console.error('check-prerender-seo FAILED:');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('check-prerender-seo: all prerendered SEO signals present.');
