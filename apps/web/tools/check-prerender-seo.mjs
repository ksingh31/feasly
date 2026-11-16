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

// --- Route list: derived, never hand-written. ---
// Every indexable, parameter-free page comes from the shared manifest
// (src/app/core/seo/indexable-pages.json) — the same list the sitemap and
// llms.txt are built from, kept equal to the non-noindex patterns in
// seo-routes.ts by scripts/indexable-pages.spec.ts. A new public page
// therefore cannot skip this check.
const MANIFEST_PATH = join(ROOT, 'src', 'app', 'core', 'seo', 'indexable-pages.json');
let manifestPages = [];
try {
  manifestPages = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')).pages ?? [];
} catch {
  failures.push(`cannot read ${MANIFEST_PATH}`);
}
if (manifestPages.length === 0) failures.push('indexable-pages manifest lists no pages');
/** Route form used for file lookup ('/' or '/guides/x', no trailing slash). */
const routeOf = (pattern) => (pattern === '' ? '/' : `/${pattern}`);
const INDEXABLE = manifestPages.map((p) => routeOf(p.pattern));
const routesWithJsonLd = (kind) => manifestPages.filter((p) => p.jsonLd === kind).map((p) => routeOf(p.pattern));
notes.push(`indexable routes from manifest: ${INDEXABLE.length} (${INDEXABLE.join(', ')})`);

/** All application/ld+json payloads on a page, parsed (null entries = invalid JSON). */
function jsonLdBlocks(html) {
  return [...html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => {
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  });
}

// --- Indexable routes (+ the branded 404): full tag set + trailing-slash canonical. ---
for (const route of [...INDEXABLE, '/404']) {
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

// --- Unique titles and descriptions across indexable pages. ---
{
  const seenTitles = new Map();
  const seenDescriptions = new Map();
  for (const route of INDEXABLE) {
    const html = htmlFor(route);
    if (html === null) continue;
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '';
    const description =
      (html.match(/<meta[^>]*name="description"[^>]*>/i)?.[0] ?? '').match(/content="([^"]*)"/)?.[1] ?? '';
    if (seenTitles.has(title)) failures.push(`"${route}" title duplicates "${seenTitles.get(title)}": "${title}"`);
    if (seenDescriptions.has(description)) {
      failures.push(`"${route}" meta description duplicates "${seenDescriptions.get(description)}"`);
    }
    seenTitles.set(title, route);
    seenDescriptions.set(description, route);
  }
}

// --- Private routes: noindex,nofollow is applied at runtime by robotsGuard
// (which runs before any redirect guard) and by SeoService.setForRoute().
// They are intentionally NOT prerendered: /estimate/scope and /estimate/report
// redirect to / during prerender (no wizard state), so prerendering them
// would only bake the redirect placeholder. Covered by unit tests instead. ---

// --- #824: How it works prerenders the estimate's includes / not-included
// lists (static: generated from the engine line items + config). ---
{
  const html = htmlFor('/how-it-works');
  if (html !== null) {
    mustContain(html, '/how-it-works', 'What this estimate includes', 'estimate includes list');
    mustContain(html, '/how-it-works', 'Not included', 'estimate not-included list');
    // #827: transparency sections ship in the prerendered HTML.
    mustContain(html, '/how-it-works', 'The formula behind every estimate', 'formula section');
    mustContain(html, '/how-it-works', 'Where the data comes from', 'data sources section');
    mustContain(html, '/how-it-works', 'A worked example', 'worked example section');
    mustContain(html, '/how-it-works', 'class="example-table"', 'worked example table');
    mustContain(html, '/how-it-works', 'What happens after your estimate', 'next steps section');
  }
}

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
for (const route of INDEXABLE) {
  const html = htmlFor(route);
  mustNotMeta(html, route, [['name', 'robots'], ['content', 'noindex,nofollow']], 'robots noindex');
}

// --- FAQ JSON-LD (SEO-010): valid FAQPage schema mirroring the visible Q&A,
// on every manifest page marked jsonLd: "faq". ---
for (const route of routesWithJsonLd('faq')) {
  const html = htmlFor(route);
  if (html === null) continue;
  const blocks = jsonLdBlocks(html);
  if (blocks.length === 0) {
    failures.push(`"${route}" missing application/ld+json script`);
    continue;
  }
  const data = blocks[0];
  if (data === null) {
    failures.push(`"${route}" ld+json is not valid JSON`);
    continue;
  }
  if (data['@type'] !== 'FAQPage') {
    failures.push(`"${route}" ld+json @type is "${data['@type']}", must be FAQPage`);
  }
  const entities = data.mainEntity ?? [];
  if (!Array.isArray(entities) || entities.length === 0) {
    failures.push(`"${route}" ld+json mainEntity is empty`);
  }
  for (const entity of Array.isArray(entities) ? entities : []) {
    const q = entity?.name ?? '';
    const a = entity?.acceptedAnswer?.text ?? '';
    if (!q || !html.includes(q)) {
      failures.push(`"${route}" ld+json question not found in page text: "${String(q).slice(0, 50)}"`);
    }
    if (!a) {
      failures.push(`"${route}" ld+json answer missing for question: "${String(q).slice(0, 50)}"`);
    }
  }
}

// --- Guide JSON-LD (SEO pillar + zoning guide): @graph with Article +
// FAQPage, questions mirroring the visible FAQ, on every manifest page
// marked jsonLd: "guide". ---
for (const route of routesWithJsonLd('guide')) {
  const html = htmlFor(route);
  if (html === null) continue;
  const blocks = jsonLdBlocks(html);
  if (blocks.length === 0) {
    failures.push(`"${route}" missing application/ld+json script`);
    continue;
  }
  const data = blocks[0];
  if (data === null) {
    failures.push(`"${route}" ld+json is not valid JSON`);
    continue;
  }
  const graph = Array.isArray(data['@graph']) ? data['@graph'] : [];
  const article = graph.find((n) => n?.['@type'] === 'Article');
  if (!article) {
    failures.push(`"${route}" ld+json @graph missing Article`);
  } else {
    const headline = article.headline ?? '';
    if (!headline || !html.includes(headline)) {
      failures.push(`"${route}" ld+json Article headline not found in page text: "${String(headline).slice(0, 60)}"`);
    }
    const url = article.mainEntityOfPage?.['@id'] ?? article.mainEntityOfPage ?? article.url ?? '';
    if (typeof url === 'string' && url && !url.endsWith(`${route}/`)) {
      failures.push(`"${route}" ld+json Article URL "${url}" is not the page's canonical path`);
    }
  }
  const faqNode = graph.find((n) => n?.['@type'] === 'FAQPage');
  if (!faqNode) {
    failures.push(`"${route}" ld+json @graph missing FAQPage`);
  } else {
    const entities = faqNode.mainEntity ?? [];
    if (!Array.isArray(entities) || entities.length < 4) {
      failures.push(`"${route}" ld+json FAQPage mainEntity should have 4+ questions`);
    }
    for (const entity of Array.isArray(entities) ? entities : []) {
      const q = entity?.name ?? '';
      if (!q || !html.includes(q)) {
        failures.push(`"${route}" ld+json question not found in page text: "${String(q).slice(0, 50)}"`);
      }
      if (!entity?.acceptedAnswer?.text) {
        failures.push(`"${route}" ld+json answer missing for question: "${String(q).slice(0, 50)}"`);
      }
    }
  }
}

// --- Community pages (SEO-04): all 40 prerendered, full tag set, honest copy. ---
// Two page variants: build-guide (cost guide) and profile (property-values
// profile for condo/apartment-dominated communities). The H1/title patterns
// are type-aware — profile pages must NOT carry build-cost titles.
{
  const aggPath = join(ROOT, 'src', 'content', 'data', 'community-aggregates.json');
  const mixPath = join(ROOT, 'src', 'content', 'data', 'community-mix.json');
  let slugs = [];
  let typesBySlug = {};
  try {
    const agg = JSON.parse(readFileSync(aggPath, 'utf8'));
    slugs = agg.communities.map((c) => c.slug);
  } catch {
    failures.push('community SEO check: cannot read src/content/data/community-aggregates.json');
  }
  try {
    const mix = JSON.parse(readFileSync(mixPath, 'utf8'));
    for (const c of mix.communities) typesBySlug[c.slug] = c.communityType;
  } catch {
    failures.push('community SEO check: cannot read src/content/data/community-mix.json');
  }
  if (slugs.length === 0) {
    failures.push('community SEO check: no community slugs found');
  }
  const titles = new Set();
  const denyList = ['per_sqft', 'persqft', 'per-sqft', 'margin', 'param'];
  const bannedCopy = [/%\s*accurate/i, /guaranteed?\s+(estimate|price|cost)/i, /sold\s+for/i, /sold\s+price/i];
  for (const slug of slugs) {
    const route = `/communities/${slug}`;
    const html = htmlFor(route);
    if (html === null) continue;
    const isProfile = typesBySlug[slug] === 'profile';
    // Indexable tag set.
    mustContain(html, route, '<title>', 'document title');
    mustMeta(html, route, [['name', 'description']], 'meta description');
    mustMeta(html, route, [['property', 'og:title']], 'OG title');
    mustMeta(html, route, [['name', 'feasly:cost-data-version']], 'feasly:cost-data-version');
    {
      const tag = html.match(/<meta[^>]*name="feasly:cost-data-version"[^>]*>/i)?.[0] ?? '';
      const version = tag.match(/content="([^"]*)"/)?.[1] ?? '';
      if (!/^v\d+\.\d+\.\d+-[a-z0-9-]+$/.test(version) || /unclibrated/.test(version)) {
        failures.push(`"${route}" feasly:cost-data-version is empty or malformed: "${version}"`);
      }
    }
    mustNotMeta(html, route, [['name', 'robots'], ['content', 'noindex,nofollow']], 'robots noindex');
    mustCanonical(html, route, `${route}/`);
    // H1 pattern + unique titles (type-aware).
    const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]*>/g, '').trim() ?? '';
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '';
    if (isProfile) {
      if (/^How much does it cost to build a home in /.test(h1)) {
        failures.push(`"${route}" is a profile page but carries a build-cost H1: "${h1}"`);
      }
      if (!/, Calgary$/.test(h1)) {
        failures.push(`"${route}" profile H1 does not match the required pattern: "${h1}"`);
      }
      // P5 (consumer review 2026-11-13): site-wide "Feasly — …" title format.
      if (!/^Feasly — .+, Calgary property values &amp; assessed values$/.test(title)) {
        failures.push(`"${route}" profile title does not match the required pattern: "${title}"`);
      }
      if (/Cost to build a home in/i.test(title)) {
        failures.push(`"${route}" is a profile page but carries a build-cost title: "${title}"`);
      }
    } else {
      if (!/^How much does it cost to build a home in .+, Calgary\?$/.test(h1)) {
        failures.push(`"${route}" H1 does not match the required pattern: "${h1}"`);
      }
      if (!/^Feasly — Cost to build a home in .+, Calgary$/.test(title)) {
        failures.push(`"${route}" title does not match the required pattern: "${title}"`);
      }
    }
    if (titles.has(title)) failures.push(`duplicate community page title: "${title}"`);
    titles.add(title);
    // Honest assessed-value labeling: the figure must be qualified as not
    // market value. Build guides use the full "Average City-assessed value
    // (not market value)" stat label; profile pages use the compact honest
    // note ("Assessed value is for tax purposes — not market value").
    mustContain(html, route, 'not market value', 'assessed-value honesty label');
    // Deny-list: no proprietary cost-model terms in public HTML.
    // Strip <style> and <script> first — CSS "margin" properties and JS
    // are not cost-model terms.
    const contentOnly = html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ');
    const lowered = contentOnly.toLowerCase();
    for (const term of denyList) {
      if (lowered.includes(term)) failures.push(`"${route}" trips the deny-list: "${term}"`);
    }
    // Copy lint: no accuracy guarantees, no sold-price claims.
    const text = html.replace(/<[^>]*>/g, ' ');
    for (const pattern of bannedCopy) {
      const hit = text.match(pattern);
      if (hit) failures.push(`"${route}" copy trips the banned-phrase lint: "${hit[0]}"`);
    }
  }
  notes.push(`community pages checked: ${slugs.length}`);
}

// --- Marketing copy lint (SEO-010): no accuracy guarantees, no "free
// forever" claims on any indexable marketing page (legal pages excluded:
// they state what is NOT guaranteed).
{
  const banned = [/%\s*accurate/i, /guaranteed?\s+(estimate|price|cost)/i, /free\s+forever/i, /always\s+free/i];
  for (const route of INDEXABLE.filter((r) => !['/privacy', '/terms'].includes(r))) {
    const html = htmlFor(route);
    if (html === null) continue;
    const text = html.replace(/<[^>]*>/g, ' ');
    for (const pattern of banned) {
      const hit = text.match(pattern);
      if (hit) {
        failures.push(`"${route}" copy trips the banned-phrase lint: "${hit[0]}"`);
      }
    }
  }
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

// --- One URL form (#707): every sitemap <loc> is byte-equal to the canonical
// of the page it points to, and the non-slash form 301s to it. ---
{
  const sitemapPath = join(BROWSER, 'sitemap.xml');
  const swaPath = join(BROWSER, 'staticwebapp.config.json');
  let swa = null;
  try {
    swa = JSON.parse(readFileSync(swaPath, 'utf8'));
  } catch {
    failures.push(`cannot read ${swaPath}`);
  }
  if (!existsSync(sitemapPath)) {
    failures.push('missing sitemap.xml in build output');
  } else {
    const locs = [...readFileSync(sitemapPath, 'utf8').matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    if (locs.length === 0) failures.push('sitemap.xml has no <loc> entries');
    const redirects = new Map(
      (swa?.routes ?? []).filter((r) => r.redirect).map((r) => [r.route, { to: r.redirect, status: r.statusCode }]),
    );
    for (const loc of locs) {
      const path = new URL(loc).pathname;
      const html = htmlFor(path);
      if (html === null) continue;
      const tag = html.match(/<link[^>]*rel="canonical"[^>]*>/i)?.[0] ?? '';
      const canonical = tag.match(/href="([^"]*)"/)?.[1] ?? '';
      if (canonical !== loc) {
        failures.push(`sitemap <loc> "${loc}" is not byte-equal to its page canonical "${canonical}"`);
      }
      if (path !== '/') {
        const bare = path.replace(/\/$/, '');
        const r = redirects.get(bare);
        if (!r || r.to !== path || r.status !== 301) {
          failures.push(`"${bare}" must 301 to "${path}" in staticwebapp.config.json (one URL form)`);
        }
      }
    }
    notes.push(`sitemap URLs matched to canonicals: ${locs.length}`);
    // Every indexable page (manifest + community pages) is in the sitemap
    // and in llms.txt — docs/seo-page-standard.md.
    const locPaths = new Set(locs.map((loc) => new URL(loc).pathname));
    const llmsPath = join(BROWSER, 'llms.txt');
    const llmsPaths = existsSync(llmsPath)
      ? new Set(
          [...readFileSync(llmsPath, 'utf8').matchAll(/https?:\/\/[^\s)]+/g)].map((m) => {
            try {
              return new URL(m[0]).pathname;
            } catch {
              return '';
            }
          }),
        )
      : null;
    if (llmsPaths === null) failures.push('missing llms.txt in build output');
    let communitySlugs = [];
    try {
      communitySlugs = JSON.parse(
        readFileSync(join(ROOT, 'src', 'content', 'data', 'community-aggregates.json'), 'utf8'),
      ).communities.map((c) => c.slug);
    } catch {
      // Reported by the community block above.
    }
    const expected = [
      ...manifestPages.map((p) => (p.pattern === '' ? '/' : `/${p.pattern}/`)),
      ...communitySlugs.map((slug) => `/communities/${slug}/`),
    ];
    for (const path of expected) {
      if (!locPaths.has(path)) failures.push(`indexable page "${path}" missing from sitemap.xml`);
      if (llmsPaths !== null && !llmsPaths.has(path)) failures.push(`indexable page "${path}" missing from llms.txt`);
    }
    notes.push(`sitemap + llms.txt cover all ${expected.length} indexable pages`);
  }
  // #690: Static Web Apps rejects a config over 20 KB; every community page
  // adds an exact 301 rule, so the deployed (minified) file is budgeted.
  if (existsSync(swaPath)) {
    const bytes = statSync(swaPath).size;
    if (bytes > 20 * 1024) failures.push(`staticwebapp.config.json is ${bytes} bytes — over the 20 KB Static Web Apps limit`);
    notes.push(`staticwebapp.config.json: ${bytes} bytes (limit 20480)`);
  }

  // --- Non-production noindex (#707): a build without SITE_URL (empty
  // site.url in the shipped config) must carry X-Robots-Tag + Disallow: /;
  // a build with SITE_URL must carry neither. ---
  let siteUrl = null;
  try {
    siteUrl = JSON.parse(readFileSync(join(BROWSER, 'assets', 'config', 'app-config.json'), 'utf8')).site?.url ?? '';
  } catch {
    failures.push('cannot read assets/config/app-config.json in build output');
  }
  if (swa !== null && siteUrl !== null) {
    const robotsHeader = swa.globalHeaders?.['X-Robots-Tag'];
    const robotsRoute = (swa.routes ?? []).find((r) => r.route === '/robots.txt');
    const noindexRobotsPath = join(BROWSER, 'robots.noindex.txt');
    const before = failures.length;
    if (siteUrl === '') {
      if (robotsHeader !== 'noindex, nofollow') {
        failures.push(`non-production build: X-Robots-Tag must be "noindex, nofollow" (got ${JSON.stringify(robotsHeader)})`);
      }
      if (swa.routes?.[0]?.route !== '/robots.txt' || robotsRoute?.rewrite !== '/robots.noindex.txt') {
        failures.push('non-production build: first SWA route must rewrite /robots.txt to /robots.noindex.txt');
      }
      if (!existsSync(noindexRobotsPath) || !/^Disallow: \/$/m.test(readFileSync(noindexRobotsPath, 'utf8'))) {
        failures.push('non-production build: robots.noindex.txt missing or lacks "Disallow: /"');
      }
      if (failures.length === before) notes.push('non-production build: X-Robots-Tag noindex + Disallow: / present');
    } else {
      if (robotsHeader !== undefined) failures.push('production build (SITE_URL set) must not send X-Robots-Tag');
      if (robotsRoute) failures.push('production build (SITE_URL set) must not rewrite /robots.txt');
      if (existsSync(noindexRobotsPath)) failures.push('production build (SITE_URL set) must not ship robots.noindex.txt');
      if (failures.length === before) notes.push(`production build for ${siteUrl}: indexable`);
    }
  }

  // --- Shared report links (#707 AC5): /r/* is rewritten to a static shell
  // whose preview tags (title, description, og:*, twitter:*) are what a
  // message app shows. They must carry no dollar figure; the shell is static,
  // so it cannot carry a report's address or name. ---
  const shareTarget = (swa?.routes ?? []).find((r) => r.route === '/r/*')?.rewrite;
  if (!shareTarget) {
    failures.push('staticwebapp.config.json has no /r/* rewrite (shared report links)');
  } else {
    const shellPath = join(BROWSER, shareTarget.replace(/^\//, ''));
    if (!existsSync(shellPath)) {
      failures.push(`/r/* rewrite target ${shareTarget} missing from build output`);
    } else {
      const shell = readFileSync(shellPath, 'utf8');
      const previewTags = [
        ...(shell.match(/<title[^>]*>[\s\S]*?<\/title>/gi) ?? []),
        ...(shell.match(/<meta[^>]*(name="description"|property="og:[^"]*"|name="twitter:[^"]*")[^>]*>/gi) ?? []),
      ];
      for (const tag of previewTags) {
        if (/\$\s?\d/.test(tag)) failures.push(`/r/* share preview tag carries a dollar figure: ${tag}`);
      }
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
