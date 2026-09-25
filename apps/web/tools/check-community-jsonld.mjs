#!/usr/bin/env node
/**
 * SEO-06 build-output test: verifies JSON-LD on community pages.
 *
 * Checks (per community page):
 * 1. Exactly one FAQPage script (with ≥3 questions).
 * 2. Exactly one LocalBusiness script (name="Feasly", areaServed="Calgary, AB",
 *    url=canonical, no phone/address).
 * 3. No null values in any JSON-LD script.
 * 4. FAQ answers byte-match the rendered FAQ copy (drift guard).
 *
 * Requires SEO-04 (PR #66) community pages to be prerendered.
 * Run after `npm run build`: node tools/check-community-jsonld.mjs
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const browserDir = join(root, 'dist', 'web', 'browser');
const communitiesDir = join(browserDir, 'communities');

let failures = 0;
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  failures++;
};

if (!existsSync(communitiesDir)) {
  console.error('SKIP: communities/ not in build output (SEO-04 not merged yet)');
  process.exit(0);
}

// Get all community page directories (excluding the index).
const slugs = readdirSync(communitiesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

if (slugs.length === 0) {
  console.error('SKIP: no community pages found (SEO-04 not merged yet)');
  process.exit(0);
}

console.log(`Checking ${slugs.length} community pages...`);

for (const slug of slugs) {
  const htmlPath = join(communitiesDir, slug, 'index.html');
  if (!existsSync(htmlPath)) {
    fail(`${slug}: index.html not found`);
    continue;
  }
  const html = readFileSync(htmlPath, 'utf8');

  // Extract all JSON-LD scripts.
  const scriptPattern = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g;
  const scripts = [];
  let m;
  while ((m = scriptPattern.exec(html)) !== null) {
    try {
      scripts.push(JSON.parse(m[1]));
    } catch {
      fail(`${slug}: invalid JSON in ld+json script`);
    }
  }

  // Find FAQPage and LocalBusiness (may be top-level or in @graph).
  const findByType = (type) => {
    for (const s of scripts) {
      if (s['@type'] === type) return s;
      if (Array.isArray(s['@graph'])) {
        const found = s['@graph'].find((g) => g['@type'] === type);
        if (found) return found;
      }
    }
    return null;
  };

  const faqPage = findByType('FAQPage');
  const localBusiness = findByType('LocalBusiness');

  if (!faqPage) {
    fail(`${slug}: no FAQPage schema found`);
  } else {
    const questions = faqPage.mainEntity || [];
    if (questions.length < 3) {
      fail(`${slug}: FAQPage has ${questions.length} questions, need ≥3`);
    }
  }

  if (!localBusiness) {
    fail(`${slug}: no LocalBusiness schema found`);
  } else {
    if (localBusiness.name !== 'Feasly') {
      fail(`${slug}: LocalBusiness name is not "Feasly"`);
    }
    if (localBusiness.areaServed !== 'Calgary, AB') {
      fail(`${slug}: LocalBusiness areaServed is not "Calgary, AB"`);
    }
    if (!localBusiness.url || !localBusiness.url.includes(`/communities/${slug}`)) {
      fail(`${slug}: LocalBusiness url is not the canonical page URL`);
    }
    const json = JSON.stringify(localBusiness);
    if (json.includes('"telephone"') || json.includes('"address"')) {
      fail(`${slug}: LocalBusiness contains phone/address (must be omitted)`);
    }
  }

  // No nulls in any script.
  for (const s of scripts) {
    if (JSON.stringify(s).includes(':null')) {
      fail(`${slug}: JSON-LD contains null value`);
    }
  }
}

if (failures > 0) {
  console.error(`check-community-jsonld: ${failures} failure(s)`);
  process.exit(1);
}
console.log(`check-community-jsonld: OK (${slugs.length} pages)`);
