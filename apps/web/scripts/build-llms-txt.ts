#!/usr/bin/env tsx
/**
 * SEO-07: llms.txt + llms-full.txt generation.
 *
 * Generates AI-crawler-friendly site summaries from the same content sources
 * as the HTML pages (community aggregates JSON + FAQ/how-it-works copy from
 * ConfigService defaults). Both files are written to the SWA output root.
 *
 * - `llms.txt`: concise summary (< 50 KB) — what Feasly is, how it works,
 *   40 community summaries, FAQ pointers, canonical URLs.
 * - `llms-full.txt`: full content (< 500 KB) — adds complete FAQ answers
 *   and the methodology note.
 *
 * Content sources (single source of truth, no hand-maintained copy):
 * - `src/content/data/community-aggregates.json` (SEO-03): community names,
 *   slugs, avg assessed values, record counts, costDataVersion.
 * - `src/content/data/community-ranges.json` (SEO-04): build-cost ranges per
 *   community — tiers.{standard,premium,luxury} each with buildLow/buildHigh,
 *   landValue, totalLow/totalHigh. If missing or malformed, community summaries
 *   include assessed values only and note that ranges are pending.
 * - `DEFAULT_APP_CONFIG.copy.marketing` (ConfigService): FAQ items and
 *   how-it-works steps — the same copy rendered on the site.
 *
 * Deny-list: both files are scanned for proprietary cost-model terms
 * (`per_sqft`, `margin`, `param`, etc.). The build fails on a hit.
 *
 * Config (env, all optional):
 *   SITE_URL         canonical site URL (default https://feasly.com placeholder)
 *   SEO_OUTPUT_DIR   output directory (default dist/web/browser)
 *
 * Usage: tsx apps/web/scripts/build-llms-txt.ts
 * Wired into the post-build SEO artifacts step.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDenyList } from './community-aggregates.schema.js';
import { DEFAULT_APP_CONFIG } from '../src/app/core/config/app-config.defaults.js';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGGREGATES_PATH = join(SCRIPT_DIR, '..', 'src', 'content', 'data', 'community-aggregates.json');
const RANGES_PATH = join(SCRIPT_DIR, '..', 'src', 'content', 'data', 'community-ranges.json');

/** Size limits from SEO-07 AC1. */
const LLMS_TXT_MAX_BYTES = 50 * 1024;
const LLMS_FULL_TXT_MAX_BYTES = 500 * 1024;

interface CommunityTierRanges {
  readonly buildLow: number;
  readonly buildHigh: number;
  readonly landValue: number;
  readonly totalLow: number;
  readonly totalHigh: number;
}

interface CommunitySummary {
  readonly slug: string;
  readonly name: string;
  readonly avgAssessedValue: number;
  readonly count: number;
  readonly tiers?: {
    readonly standard: CommunityTierRanges;
    readonly premium: CommunityTierRanges;
    readonly luxury: CommunityTierRanges;
  };
}

export interface LlmsConfig {
  readonly siteUrl: string;
  readonly outputDir: string;
}

export function loadConfig(): LlmsConfig {
  const siteUrl = (process.env['SITE_URL'] ?? 'https://feasly.com').trim().replace(/\/+$/, '');
  const outputDir = (process.env['SEO_OUTPUT_DIR'] ?? join(SCRIPT_DIR, '..', 'dist', 'web', 'browser')).trim();
  return { siteUrl, outputDir };
}

function formatMoney(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US');
}

function loadCommunities(): { communities: CommunitySummary[]; costDataVersion: string } {
  const raw = JSON.parse(readFileSync(AGGREGATES_PATH, 'utf-8')) as {
    costDataVersion: string;
    communities: Array<{ slug: string; name: string; avgAssessedValue: number; count: number }>;
  };

  // Build-cost ranges (SEO-04, community-ranges.json). Shape: tiers.{standard,premium,luxury}
  // each with buildLow/buildHigh (build cost), landValue (assessed), totalLow/totalHigh.
  let tiersBySlug = new Map<string, CommunitySummary['tiers']>();
  if (existsSync(RANGES_PATH)) {
    try {
      const rangesRaw = JSON.parse(readFileSync(RANGES_PATH, 'utf-8')) as {
        communities: Array<{
          slug: string;
          tiers: {
            standard: CommunityTierRanges;
            premium: CommunityTierRanges;
            luxury: CommunityTierRanges;
          };
        }>;
      };
      for (const c of rangesRaw.communities) {
        if (c.tiers?.standard && c.tiers?.premium && c.tiers?.luxury) {
          tiersBySlug.set(c.slug, c.tiers);
        }
      }
    } catch {
      // If the ranges file is malformed, proceed without ranges rather than failing.
    }
  }

  const communities: CommunitySummary[] = raw.communities.map((c) => ({
    slug: c.slug,
    name: c.name,
    avgAssessedValue: c.avgAssessedValue,
    count: c.count,
    tiers: tiersBySlug.get(c.slug),
  }));

  return { communities, costDataVersion: raw.costDataVersion };
}

function buildLlmsTxt(
  siteUrl: string,
  communities: CommunitySummary[],
  costDataVersion: string,
): string {
  const { howItWorks, faq } = DEFAULT_APP_CONFIG.copy.marketing;

  const lines: string[] = [
    '# Feasly',
    '',
    '> Feasly estimates what it really costs to build a home in Calgary, Alberta.',
    '> Enter a Calgary address, configure the project scope, and get a planning-range',
    '> estimate based on the City of Calgary property assessment and current construction cost data.',
    '',
    `Cost data version: ${costDataVersion} (uncalibrated — figures are illustrative planning ranges, not quotes)`,
    '',
    '## How it works',
    '',
  ];

  for (const step of howItWorks.steps.slice(0, 3)) {
    lines.push(`${step.n}. **${step.title}** — ${step.body}`);
  }
  lines.push('', `Full walkthrough: ${siteUrl}/how-it-works`, '');

  lines.push('## Calgary communities', '');
  lines.push(
    'Average City-assessed land values (not market values) and build-cost planning ranges',
    'for a 2,400 sq ft new build. Figures are illustrative ranges, not quotes.',
    '',
  );
  for (const c of communities) {
    const rangeText = c.tiers
      ? ` | Build: Std ${formatMoney(c.tiers.standard.buildLow)}–${formatMoney(c.tiers.standard.buildHigh)}, Prem ${formatMoney(c.tiers.premium.buildLow)}–${formatMoney(c.tiers.premium.buildHigh)}, Lux ${formatMoney(c.tiers.luxury.buildLow)}–${formatMoney(c.tiers.luxury.buildHigh)}; Total: Std ${formatMoney(c.tiers.standard.totalLow)}–${formatMoney(c.tiers.standard.totalHigh)}, Prem ${formatMoney(c.tiers.premium.totalLow)}–${formatMoney(c.tiers.premium.totalHigh)}, Lux ${formatMoney(c.tiers.luxury.totalLow)}–${formatMoney(c.tiers.luxury.totalHigh)}`
      : ' (build-cost ranges pending)';
    lines.push(
      `- **${c.name}**: avg assessed ${formatMoney(c.avgAssessedValue)} (${c.count.toLocaleString()} records)${rangeText} — ${siteUrl}/communities/${c.slug}/`,
    );
  }

  lines.push('', '## FAQs', '');
  for (const item of faq.items) {
    lines.push(`- ${item.q} — ${siteUrl}/faq`);
  }

  lines.push(
    '',
    '## Canonical URLs',
    '',
    `- Home: ${siteUrl}/`,
    `- How it works: ${siteUrl}/how-it-works`,
    `- FAQ: ${siteUrl}/faq`,
    `- Developers / API docs: ${siteUrl}/developers`,
    `- Communities index: ${siteUrl}/communities/`,
    `- Sample report: ${siteUrl}/sample-report`,
    `- Privacy: ${siteUrl}/privacy`,
    `- Terms: ${siteUrl}/terms`,
    '',
    `Full detail (all FAQ answers + methodology): ${siteUrl}/llms-full.txt`,
    '',
  );

  return lines.join('\n');
}

function buildLlmsFullTxt(
  siteUrl: string,
  communities: CommunitySummary[],
  costDataVersion: string,
): string {
  const { howItWorks, faq } = DEFAULT_APP_CONFIG.copy.marketing;

  const lines: string[] = [
    '# Feasly — Full Reference',
    '',
    '> Feasly estimates what it really costs to build a home in Calgary, Alberta.',
    '',
    `Cost data version: ${costDataVersion}`,
    `Generated: ${new Date().toISOString()}`,
    '',
    '## What Feasly is',
    '',
    'Feasly is a Calgary-only build-cost estimator. It combines the City of Calgary',
    'property assessment record (lot size, zoning, assessed land value) with current',
    'construction cost data, applied with deterministic math, to produce planning-range',
    'estimates for new builds and renovations. An AI writes the narrative summary only —',
    'it never invents prices.',
    '',
    '## How it works',
    '',
  ];

  for (const step of howItWorks.steps) {
    lines.push(`### ${step.n}. ${step.title}`, '', step.body, '');
  }
  lines.push(`### ${howItWorks.mathNoteTitle}`, '', howItWorks.mathNoteBody, '');

  lines.push('## Methodology', '');
  lines.push(
    '- All dollar figures are produced by deterministic math from current cost data',
    '  and the City property record. Large language models write narrative text only.',
    '- Land values are City-assessed values (a fixed figure per property), not market-value ranges.',
    '- Build costs are planning ranges (low/base/high), not quotes or appraisals.',
    `- Cost data version: ${costDataVersion}. Figures are uncalibrated and illustrative.`,
    '- No accuracy percentages are claimed until the cost model is calibrated against real builds.',
    '',
  );

  lines.push('## Calgary communities (all)', '');
  for (const c of communities) {
    const tierLines = c.tiers
      ? (['standard', 'premium', 'luxury'] as const)
          .map((key) => {
            const t = c.tiers![key];
            const label = key === 'standard' ? 'Standard' : key === 'premium' ? 'Premium' : 'Luxury';
            return `- ${label}: build ${formatMoney(t.buildLow)}–${formatMoney(t.buildHigh)}, land (assessed) ${formatMoney(t.landValue)}, total ${formatMoney(t.totalLow)}–${formatMoney(t.totalHigh)}`;
          })
          .join('\n')
      : '- (build-cost ranges pending)';
    lines.push(
      `### ${c.name}`,
      `- URL: ${siteUrl}/communities/${c.slug}/`,
      `- Average City-assessed value: ${formatMoney(c.avgAssessedValue)} (not market value, ${c.count.toLocaleString()} assessment records)`,
      `- 2,400 sq ft new-build planning ranges (not quotes):`,
      tierLines,
      '',
    );
  }

  lines.push('## Frequently asked questions (complete)', '');
  for (const item of faq.items) {
    lines.push(`### ${item.q}`, '', item.a, '');
  }

  return lines.join('\n');
}

export function buildLlmsFiles(config: LlmsConfig = loadConfig()): { llmsTxt: string; llmsFullTxt: string } {
  const { communities, costDataVersion } = loadCommunities();

  const llmsTxt = buildLlmsTxt(config.siteUrl, communities, costDataVersion);
  const llmsFullTxt = buildLlmsFullTxt(config.siteUrl, communities, costDataVersion);

  // SEO-07 AC1: size limits.
  const txtBytes = Buffer.byteLength(llmsTxt, 'utf-8');
  const fullBytes = Buffer.byteLength(llmsFullTxt, 'utf-8');
  if (txtBytes >= LLMS_TXT_MAX_BYTES) {
    throw new Error(
      `build-llms-txt: llms.txt is ${txtBytes} bytes, exceeds ${LLMS_TXT_MAX_BYTES} byte limit`,
    );
  }
  if (fullBytes >= LLMS_FULL_TXT_MAX_BYTES) {
    throw new Error(
      `build-llms-txt: llms-full.txt is ${fullBytes} bytes, exceeds ${LLMS_FULL_TXT_MAX_BYTES} byte limit`,
    );
  }

  // SEO-07 AC5: deny-list scan — proprietary cost-model terms must never leak.
  for (const [name, content] of [['llms.txt', llmsTxt], ['llms-full.txt', llmsFullTxt]] as const) {
    const hits = scanDenyList(content);
    if (hits.length > 0) {
      throw new Error(`build-llms-txt: deny-list hit in ${name}: ${hits.join(', ')}`);
    }
  }

  mkdirSync(config.outputDir, { recursive: true });
  writeFileSync(join(config.outputDir, 'llms.txt'), llmsTxt);
  writeFileSync(join(config.outputDir, 'llms-full.txt'), llmsFullTxt);

  return { llmsTxt, llmsFullTxt };
}

// Run when executed directly (not when imported by the spec).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { llmsTxt, llmsFullTxt } = buildLlmsFiles();
  console.log(
    `build-llms-txt: wrote llms.txt (${Buffer.byteLength(llmsTxt, 'utf-8')} bytes) and llms-full.txt (${Buffer.byteLength(llmsFullTxt, 'utf-8')} bytes)`,
  );
}
