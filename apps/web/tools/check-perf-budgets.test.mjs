/**
 * check-perf-budgets.test.mjs — FE8-003: prove the perf-budget gate bites.
 *
 * Builds a tiny fixture dist/ in a temp dir and asserts the checker passes a
 * lean build and fails an overweight one. No network, no browser.
 *
 * Run: node --test apps/web/tools/check-perf-budgets.test.mjs
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  checkPerfBudgets,
  initialAssets,
  pageImages,
} from './check-perf-budgets.mjs';

const BUDGETS = {
  jsInitialGzipKB: 200,
  perPageImageWeightKB: 500,
  lcpSeconds: 2.5,
  inpMs: 200,
  cls: 0.1,
  heroTextVisibleSlow4GSeconds: 2,
};

let dist;
beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), 'perf-dist-'));
});

function writeDist({ jsKB = 10, imgKB = 0, fontSwap = true } = {}) {
  // Fake "gzippable" JS: highly compressible so gzip size stays small and
  // deterministic relative to raw size.
  const js = 'console.log("x");\n'.repeat(Math.ceil((jsKB * 1024) / 17));
  writeFileSync(join(dist, 'main-abc123.js'), js);
  const fontHref = fontSwap
    ? 'https://fonts.googleapis.com/css2?family=Manrope&display=swap'
    : 'https://fonts.googleapis.com/css2?family=Manrope';
  writeFileSync(
    join(dist, 'index.html'),
    `<html><head><script src="main-abc123.js" type="module"></script>` +
      `<link rel="stylesheet" href="${fontHref}"></head>` +
      `<body>${imgKB ? '<img src="hero.png">' : ''}</body></html>`,
  );
  if (imgKB) {
    writeFileSync(join(dist, 'hero.png'), randomBytes(imgKB * 1024));
  }
}

describe('initialAssets', () => {
  it('collects local scripts, skips remote URLs', () => {
    writeDist();
    const html =
      '<script src="main-abc123.js"></script><script src="https://cdn.example.com/x.js"></script>';
    const assets = initialAssets(html, dist);
    assert.equal(assets.size, 1);
    assert.ok([...assets][0].endsWith('main-abc123.js'));
  });
});

describe('pageImages', () => {
  it('finds <img> and og:image, skips remote and data: URLs', () => {
    writeDist({ imgKB: 1 });
    const html =
      '<img src="hero.png"><img src="https://cdn.example.com/a.png">' +
      '<img src="data:image/png;base64,AAA">' +
      '<meta property="og:image" content="hero.png">';
    const imgs = pageImages(html, dist);
    assert.equal(imgs.size, 1);
  });
});

describe('checkPerfBudgets', () => {
  it('passes a lean build with display=swap', () => {
    writeDist({ jsKB: 10, imgKB: 100 });
    const { failures } = checkPerfBudgets(BUDGETS, dist);
    assert.equal(failures.length, 0);
  });

  it('fails when initial JS exceeds the gzip budget', () => {
    // 400KB of compressible JS still gzips well under 200KB… so use
    // incompressible-ish content via the image path instead: put the weight
    // in a second script with random bytes.
    // 300KB of incompressible bytes -> gzips to ~300KB, over the 200KB budget.
    writeFileSync(join(dist, 'heavy.js'), randomBytes(300 * 1024));
    writeFileSync(
      join(dist, 'index.html'),
      '<html><head><script src="heavy.js" type="module"></script>' +
        '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope&display=swap">' +
        '</head><body></body></html>',
    );
    const { failures } = checkPerfBudgets(BUDGETS, dist);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /exceeds budget/);
  });

  it('fails when a page image weight exceeds the budget', () => {
    writeDist({ imgKB: 600 });
    const { failures } = checkPerfBudgets(BUDGETS, dist);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /image weight/);
  });

  it('fails when the font stylesheet lacks display=swap', () => {
    writeDist({ fontSwap: false });
    const { failures } = checkPerfBudgets(BUDGETS, dist);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /display=swap/);
  });

  it('passes inlined @font-face blocks with font-display: swap', () => {
    writeDist();
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    writeFileSync(
      join(dist, 'index.html'),
      html.replace(
        '</head>',
        '<style>@font-face{font-family:"X";font-display:swap;src:url(x.woff2);}</style></head>',
      ),
    );
    const { failures } = checkPerfBudgets(BUDGETS, dist);
    assert.equal(failures.length, 0);
  });

  it('fails inlined @font-face blocks without font-display: swap', () => {
    writeDist();
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    writeFileSync(
      join(dist, 'index.html'),
      html.replace(
        '</head>',
        '<style>@font-face{font-family:"X";src:url(x.woff2);}</style></head>',
      ),
    );
    const { failures } = checkPerfBudgets(BUDGETS, dist);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /@font-face/);
  });

  it('ignores preconnect links when checking display=swap', () => {
    writeDist();
    const html = readFileSync(join(dist, 'index.html'), 'utf8');
    writeFileSync(
      join(dist, 'index.html'),
      html.replace(
        '<head>',
        '<head><link rel="preconnect" href="https://fonts.googleapis.com">',
      ),
    );
    const { failures } = checkPerfBudgets(BUDGETS, dist);
    assert.equal(failures.length, 0);
  });
});
