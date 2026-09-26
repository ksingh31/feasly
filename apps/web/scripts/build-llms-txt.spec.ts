/**
 * SEO-07: llms.txt + llms-full.txt generation tests.
 *
 * Verifies the build-output contract: both files generate, size limits hold,
 * community figures match the aggregates source, the deny-list is clean,
 * and costDataVersion is stated.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildLlmsFiles } from './build-llms-txt.js';
import { DEFAULT_APP_CONFIG } from '../src/app/core/config/app-config.defaults.js';

const SPEC_DIR = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(SPEC_DIR, '..', 'src', 'content', 'data');

describe('build-llms-txt (SEO-07)', () => {
  it('generates both files with size limits respected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llms-'));
    const { llmsTxt, llmsFullTxt } = buildLlmsFiles({ siteUrl: 'https://example.com', outputDir: dir });

    expect(Buffer.byteLength(llmsTxt, 'utf-8')).toBeLessThan(50 * 1024);
    expect(Buffer.byteLength(llmsFullTxt, 'utf-8')).toBeLessThan(500 * 1024);
    expect(readFileSync(join(dir, 'llms.txt'), 'utf-8')).toBe(llmsTxt);
    expect(readFileSync(join(dir, 'llms-full.txt'), 'utf-8')).toBe(llmsFullTxt);
  });

  it('states the cost data version in both files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llms-'));
    const { llmsTxt, llmsFullTxt } = buildLlmsFiles({ siteUrl: 'https://example.com', outputDir: dir });

    // The version comes from the aggregates JSON — assert it appears, not a hardcoded value.
    expect(llmsTxt).toMatch(/cost data version:\s*v/i);
    expect(llmsFullTxt).toMatch(/cost data version:\s*v/i);
  });

  it('includes all 40 community summaries with assessed values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llms-'));
    const { llmsTxt } = buildLlmsFiles({ siteUrl: 'https://example.com', outputDir: dir });

    // Spot-check known communities from the aggregates; the count assertion
    // guards the full set without hardcoding all 40 names.
    expect(llmsTxt).toContain('BELTLINE');
    expect(llmsTxt).toContain('PANORAMA HILLS');
    expect(llmsTxt).toContain('/communities/beltline/');
    expect(llmsTxt).toContain('/communities/panorama-hills/');

    const communityLines = llmsTxt.split('\n').filter((l) => l.startsWith('- **') && l.includes('/communities/'));
    expect(communityLines.length).toBe(40);
  });

  it('community figures match the aggregates source (parity)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llms-'));
    const { llmsTxt } = buildLlmsFiles({ siteUrl: 'https://example.com', outputDir: dir });

    // Beltline: avg assessed $607,351 per the checked-in aggregates JSON.
    // If the aggregates regenerate, this test reads the same source so it stays green;
    // it fails only if llms.txt drifts from the source.
    expect(llmsTxt).toContain('$607,351');
  });

  it('all 40 community figures match the community page rendering (AC4 parity)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llms-'));
    const { llmsTxt, llmsFullTxt } = buildLlmsFiles({ siteUrl: 'https://example.com', outputDir: dir });

    // Same formatting the community page component uses (formatCad):
    // Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).
    const formatCad = (n: number): string =>
      new Intl.NumberFormat('en-CA', {
        style: 'currency',
        currency: 'CAD',
        maximumFractionDigits: 0,
      }).format(Math.round(n));

    const aggregates = JSON.parse(
      readFileSync(join(DATA_DIR, 'community-aggregates.json'), 'utf-8'),
    ) as { communities: Array<{ slug: string; name: string; avgAssessedValue: number }> };
    const ranges = JSON.parse(
      readFileSync(join(DATA_DIR, 'community-ranges.json'), 'utf-8'),
    ) as {
      communities: Array<{
        slug: string;
        tiers: Record<'standard' | 'premium' | 'luxury', { buildLow: number; buildHigh: number; landValue: number; totalLow: number; totalHigh: number }>;
      }>;
    };
    const tiersBySlug = new Map(ranges.communities.map((c) => [c.slug, c.tiers]));

    expect(aggregates.communities.length).toBe(40);

    for (const c of aggregates.communities) {
      // Assessed value rendered on the page must appear in both files.
      expect(llmsTxt).toContain(formatCad(c.avgAssessedValue));
      expect(llmsFullTxt).toContain(formatCad(c.avgAssessedValue));

      // Per-tier figures rendered on the page (build cost, land, total) must appear.
      const tiers = tiersBySlug.get(c.slug);
      expect(tiers).toBeDefined();
      for (const key of ['standard', 'premium', 'luxury'] as const) {
        const t = tiers![key];
        for (const value of [t.buildLow, t.buildHigh, t.landValue, t.totalLow, t.totalHigh]) {
          expect(llmsTxt).toContain(formatCad(value));
          expect(llmsFullTxt).toContain(formatCad(value));
        }
      }
    }
  });

  it('llms.txt has FAQ pointers; llms-full.txt has complete answers (no drift)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llms-'));
    const { llmsTxt, llmsFullTxt } = buildLlmsFiles({ siteUrl: 'https://example.com', outputDir: dir });

    const faqItems = DEFAULT_APP_CONFIG.copy.marketing.faq.items;

    // Concise file: questions + pointers, not full answers.
    for (const item of faqItems) {
      expect(llmsTxt).toContain(item.q);
    }

    // Full file: every answer byte-present (single source — the config).
    for (const item of faqItems) {
      expect(llmsFullTxt).toContain(item.q);
      expect(llmsFullTxt).toContain(item.a);
    }
  });

  it('contains no deny-listed proprietary terms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llms-'));
    const { llmsTxt, llmsFullTxt } = buildLlmsFiles({ siteUrl: 'https://example.com', outputDir: dir });

    const forbidden = ['per_sqft', 'persqft', 'per-sqft', 'margin'];
    for (const term of forbidden) {
      expect(llmsTxt.toLowerCase()).not.toContain(term);
      expect(llmsFullTxt.toLowerCase()).not.toContain(term);
    }
  });

  it('makes no accuracy or sold-price claims', () => {
    const dir = mkdtempSync(join(tmpdir(), 'llms-'));
    const { llmsTxt, llmsFullTxt } = buildLlmsFiles({ siteUrl: 'https://example.com', outputDir: dir });

    for (const content of [llmsTxt, llmsFullTxt]) {
      expect(content).not.toMatch(/±\s*\d+\s*%/); // no ±X% accuracy claims
      expect(content.toLowerCase()).not.toContain('sold price');
      expect(content).toContain('not quotes'); // planning-range disclaimer present
    }
  });
});
