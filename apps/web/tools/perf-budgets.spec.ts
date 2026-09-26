/**
 * SEO-08 spec: performance-budget gate (perf-budgets.mjs).
 *
 * Proves the gate bites: a deliberately oversized image fails the
 * image-weight budget, an oversized initial bundle fails the JS budget, and
 * the buy-back notice fires on > 5 KB gzipped growth versus baseline.
 */
import { describe, expect, it } from 'vitest';
import {
  checkBudgets,
  extractImageUrls,
  extractScriptSrcs,
  loadBudgets,
} from './perf-budgets.mjs';

const baseBudgets = {
  assets: { jsInitialGzipKb: 200, imageWeightPerPageKb: 500 },
  webVitals: { lcpMs: 2500, inpMs: 200, cls: 0.1, tbtMs: 200 },
  lighthouseCategories: { performance: 90, accessibility: 95, bestPractices: 90, seo: 100 },
  buyback: { noteThresholdKb: 5, baselineJsInitialGzipKb: 150 },
};

const compliant = {
  jsInitialGzipKb: 150,
  pages: [
    { route: '/', imageWeightKb: 120 },
    { route: '/communities/beltline', imageWeightKb: 300 },
  ],
};

describe('checkBudgets', () => {
  it('passes a compliant measurement with no violations and no buy-back notice', () => {
    const r = checkBudgets(baseBudgets, compliant);
    expect(r.violations).toEqual([]);
    expect(r.buybackNotice).toBe(false);
  });

  it('fails when initial JS exceeds the 200 KB gzip budget', () => {
    const r = checkBudgets(baseBudgets, { ...compliant, jsInitialGzipKb: 240.5 });
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].metric).toBe('js-initial-gzip');
    expect(r.violations[0].actual).toBe(240.5);
    expect(r.violations[0].budget).toBe(200);
  });

  it('fails when a page carries a deliberately oversized image', () => {
    const r = checkBudgets(baseBudgets, {
      ...compliant,
      pages: [{ route: '/communities/beltline', imageWeightKb: 2048 }],
    });
    expect(r.violations).toHaveLength(1);
    expect(r.violations[0].metric).toBe('image-weight:/communities/beltline');
    expect(r.violations[0].actual).toBe(2048);
    expect(r.violations[0].budget).toBe(500);
  });

  it('fires the buy-back notice when JS grows more than 5 KB over baseline', () => {
    const r = checkBudgets(baseBudgets, { ...compliant, jsInitialGzipKb: 156 });
    expect(r.violations).toEqual([]);
    expect(r.buybackNotice).toBe(true);
    expect(r.buybackGrowthKb).toBe(6);
  });

  it('stays silent on buy-back when growth is within 5 KB', () => {
    const r = checkBudgets(baseBudgets, { ...compliant, jsInitialGzipKb: 154.9 });
    expect(r.buybackNotice).toBe(false);
  });

  it('does not fire buy-back when no baseline is recorded yet', () => {
    const noBaseline = { ...baseBudgets, buyback: { ...baseBudgets.buyback, baselineJsInitialGzipKb: 0 } };
    const r = checkBudgets(noBaseline, compliant);
    expect(r.buybackNotice).toBe(false);
  });
});

describe('extractScriptSrcs', () => {
  it('collects script srcs', () => {
    const html = '<script src="main-abc.js" type="module"></script><script>console.log(1)</script>';
    expect(extractScriptSrcs(html)).toEqual(['main-abc.js']);
  });
});

describe('extractImageUrls', () => {
  it('collects img src and srcset candidates', () => {
    const html =
      '<img src="/assets/hero.jpg"><img srcset="/assets/a-480.jpg 480w, /assets/a-800.jpg 800w" src="/assets/a-800.jpg">';
    const urls = extractImageUrls(html);
    expect(urls).toContain('/assets/hero.jpg');
    expect(urls).toContain('/assets/a-480.jpg');
    expect(urls).toContain('/assets/a-800.jpg');
  });

  it('ignores external and data URLs at resolve time (no crash on odd input)', () => {
    expect(extractImageUrls('<img src="https://cdn.example/x.jpg"><img src="data:image/png;base64,xx">')).toHaveLength(2);
  });
});

describe('loadBudgets', () => {
  it('parses the real budgets.json', () => {
    const b = loadBudgets();
    expect(b.assets.jsInitialGzipKb).toBe(205);
    expect(b.assets.imageWeightPerPageKb).toBe(500);
    expect(b.webVitals.lcpMs).toBe(2500);
    expect(b.lighthouseCategories.seo).toBe(100);
    expect(b.buyback.noteThresholdKb).toBe(5);
  });
});
