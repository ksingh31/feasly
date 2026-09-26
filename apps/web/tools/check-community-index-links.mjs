#!/usr/bin/env node
/**
 * SEO-05 link-integrity test: verifies the /communities/ index in build output.
 *
 * Checks:
 * 1. Index page contains exactly 40 community cards.
 * 2. Every card href matches /communities/{slug} for a slug in
 *    community-aggregates.json (these resolve to prerendered output once
 *    SEO-04's community pages land).
 * 3. Landing page HTML contains /communities/.
 *
 * Run after `npm run build`: node tools/check-community-index-links.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const browserDir = join(root, 'dist', 'web', 'browser');

let failures = 0;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failures++;
};

// 1. Load expected slugs from aggregates.
const aggregatesPath = join(root, 'src', 'content', 'data', 'community-aggregates.json');
const aggregates = JSON.parse(readFileSync(aggregatesPath, 'utf8'));
const expectedSlugs = new Set(aggregates.communities.map((c) => c.slug));
if (expectedSlugs.size !== 40) {
  fail(`expected 40 communities in aggregates, found ${expectedSlugs.size}`);
}

// 2. Parse index HTML.
const indexPath = join(browserDir, 'communities', 'index.html');
if (!existsSync(indexPath)) {
  fail('communities/index.html not found in build output');
  process.exit(1);
}
const indexHtml = readFileSync(indexPath, 'utf8');

// Count cards.
const cardMatches = indexHtml.match(/class="community-card"/g) || [];
if (cardMatches.length !== 40) {
  fail(`expected 40 community cards, found ${cardMatches.length}`);
}

// Extract hrefs.
const hrefPattern = /href="(\/communities\/[a-z0-9-]+)"/g;
const hrefs = new Set();
let m;
while ((m = hrefPattern.exec(indexHtml)) !== null) {
  hrefs.add(m[1]);
}
if (hrefs.size !== 40) {
  fail(`expected 40 unique community hrefs, found ${hrefs.size}`);
}

// Every href slug must be in aggregates.
for (const href of hrefs) {
  const slug = href.replace('/communities/', '');
  if (!expectedSlugs.has(slug)) {
    fail(`href ${href} has slug not in aggregates.json`);
  }
}

// Every aggregate slug must have a card.
for (const slug of expectedSlugs) {
  if (!hrefs.has(`/communities/${slug}`)) {
    fail(`slug ${slug} missing from index cards`);
  }
}

// H1 must be exact.
if (!indexHtml.includes('<h1') || !indexHtml.includes('Calgary Community Build-Cost Guides')) {
  fail('index H1 "Calgary Community Build-Cost Guides" not found');
}

// 3. Landing page must link to /communities/.
const landingPath = join(browserDir, 'index.html');
if (!existsSync(landingPath)) {
  fail('landing index.html not found in build output');
} else {
  const landingHtml = readFileSync(landingPath, 'utf8');
  if (!landingHtml.includes('href="/communities"')) {
    fail('landing page does not link to /communities/');
  }
}

if (failures > 0) {
  console.error(`check-community-index-links: ${failures} failure(s)`);
  process.exit(1);
}
console.log('check-community-index-links: OK (40 cards, 40 slugs, landing link present)');
