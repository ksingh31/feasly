#!/usr/bin/env node
/**
 * Reduced-motion tripwire (FE8-003).
 *
 * Fails (exit 1) when:
 *   1. The global `prefers-reduced-motion` kill-switch is missing or malformed
 *      in apps/web/src/styles.scss. The kill-switch forces every animation
 *      and transition on the page to be instant for reduced-motion users, so
 *      no component (present or future) can animate without deliberately
 *      opting out.
 *   2. Any stylesheet re-enables motion inside a `prefers-reduced-motion:
 *      reduce` block (e.g. a non-zero animation/transition duration), which
 *      would defeat the kill-switch.
 *
 * Informational: prints the inventory of @keyframes / animation / transition
 * declarations found, all of which are covered by the global rule above.
 *
 * Usage: node apps/web/tools/check-reduced-motion.mjs   (from the repo root;
 *   paths resolve from the script location, so any cwd works)
 * Tests: node --test apps/web/tools/check-reduced-motion.test.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB_DIR = dirname(fileURLToPath(import.meta.url)); // apps/web/tools
const ROOT = join(WEB_DIR, '..', '..', '..'); // repo root
const SRC_DIR = join(ROOT, 'apps', 'web', 'src');

export const GLOBAL_STYLES = join(SRC_DIR, 'styles.scss');

/** Strip /* … *​/ comments so braces inside comments don't confuse parsing. */
export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Extract the bodies of all `@media (prefers-reduced-motion: reduce) { … }` blocks. */
export function reduceBlocks(src) {
  const blocks = [];
  const re = /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    blocks.push(src.slice(m.index + m[0].length, i - 1));
  }
  return blocks;
}

/** True when the block is the global kill-switch (* selectors, ~0 durations). */
export function isKillSwitch(block) {
  // Duration written as 0.01ms in source; CSS minifiers may shorten it to .01ms,
  // and may rewrite *::before as *:before.
  const dur = (prop) => new RegExp(`${prop}\\s*:\\s*0?\\.01ms\\s*!important`).test(block);
  return (
    /\*\s*,\s*\*\s*:{1,2}before\s*,\s*\*\s*:{1,2}after/.test(block) &&
    dur('animation-duration') &&
    dur('transition-duration')
  );
}

/**
 * Run the checks against in-memory sources.
 * @param {string} globalCss - contents of the global stylesheet
 * @param {Map<string,string>} files - relative path -> stylesheet contents
 * @param {string|null} builtCss - compiled CSS from dist (optional); when
 *   provided, asserts the kill-switch survived compilation.
 * @returns {{failures: string[], keyframes: number, animations: number, transitions: number}}
 */
export function checkReducedMotion(globalCss, files, builtCss = null) {
  const failures = [];
  const globalBlocks = reduceBlocks(stripComments(globalCss));
  if (!globalBlocks.some(isKillSwitch)) {
    failures.push(
      `global styles: missing the prefers-reduced-motion kill-switch ` +
        `(*, *::before, *::after with animation-duration/transition-duration forced to ~0).`,
    );
  }

  let keyframes = 0;
  let animations = 0;
  let transitions = 0;
  for (const [relPath, raw] of files) {
    const src = stripComments(raw);
    for (const block of reduceBlocks(src)) {
      const reanimated = [...block.matchAll(/(animation|transition)-duration\s*:\s*([^;!}]+)/g)]
        .map((mm) => mm[2].trim())
        .filter((v) => !/^0(\.0+)?(ms|s)?$/.test(v) && !/^0\.01ms$/.test(v));
      const reenabled = [...block.matchAll(/animation\s*:\s*([^;}!]+)/g)]
        .map((mm) => mm[1].trim())
        .filter((v) => v !== 'none');
      if (reanimated.length || reenabled.length) {
        failures.push(
          `${relPath}: re-enables motion inside prefers-reduced-motion: reduce ` +
            `(${[...reanimated, ...reenabled].join(', ')}) — the kill-switch must win.`,
        );
      }
    }
    keyframes += (src.match(/@keyframes\s+[\w-]+/g) || []).length;
    animations += (src.match(/(?<!-)animation\s*:/g) || []).length;
    transitions += (src.match(/(?<!-)transition\s*:/g) || []).length;
  }

  // Optional: prove the kill-switch survived SCSS compilation into dist.
  if (builtCss !== null) {
    const compiled = reduceBlocks(stripComments(builtCss)).some(isKillSwitch);
    if (!compiled) {
      failures.push(
        `built CSS: the prefers-reduced-motion kill-switch did not survive compilation — ` +
          `check the styles.scss output.`,
      );
    }
  }

  return { failures, keyframes, animations, transitions };
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(scss|css)$/.test(entry)) out.push(full);
  }
  return out;
}

function main() {
  const globalCss = readFileSync(GLOBAL_STYLES, 'utf8');
  const files = new Map();
  for (const file of walk(SRC_DIR)) {
    files.set(relative(ROOT, file), readFileSync(file, 'utf8'));
  }
  // When a production build exists, also verify the compiled CSS.
  let builtCss = null;
  const distCssDir = join(ROOT, 'apps', 'web', 'dist', 'web', 'browser');
  try {
    const cssFiles = readdirSync(distCssDir).filter((f) => f.endsWith('.css'));
    builtCss = cssFiles.map((f) => readFileSync(join(distCssDir, f), 'utf8')).join('\n');
  } catch {
    builtCss = null; // no dist yet — source check is sufficient
  }
  const { failures, keyframes, animations, transitions } = checkReducedMotion(
    globalCss,
    files,
    builtCss,
  );
  console.log(
    `reduced-motion: ${keyframes} @keyframes, ${animations} animation declarations, ` +
      `${transitions} transition declarations — all covered by the global kill-switch.`,
  );
  if (failures.length) {
    for (const f of failures) console.error(`::error::${f}`);
    process.exit(1);
  }
  console.log('reduced-motion: OK — animations are instant under prefers-reduced-motion.');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
