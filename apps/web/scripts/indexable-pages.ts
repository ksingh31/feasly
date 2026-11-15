/**
 * Loader for `src/app/core/seo/indexable-pages.json`, the shared manifest
 * of indexable, parameter-free public pages (docs/seo-page-standard.md).
 *
 * The sitemap (build-seo-artifacts), llms.txt (build-llms-txt) and the
 * prerender SEO check (tools/check-prerender-seo.mjs, which reads the JSON
 * directly) all take their route list from it, and
 * `indexable-pages.spec.ts` asserts it equals the non-noindex, param-free
 * patterns in `seo-routes.ts`. A new public page therefore cannot ship
 * without a sitemap entry, an llms.txt line and prerender-check coverage.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const INDEXABLE_PAGES_PATH = join(SCRIPT_DIR, '..', 'src', 'app', 'core', 'seo', 'indexable-pages.json');

export interface IndexablePage {
  /** seo-routes.ts pattern ('' = landing). */
  readonly pattern: string;
  /** Short human label (llms.txt link text). */
  readonly label: string;
  /** llms.txt section. */
  readonly section: 'pages' | 'guides';
  readonly changefreq: string;
  readonly priority: string;
  /** Structured data the prerender check validates. */
  readonly jsonLd: 'faq' | 'guide' | null;
}

/** Canonical path for a pattern: '/' for the landing page, else '/<pattern>/' (#707 trailing slash). */
export function canonicalPath(pattern: string): string {
  return pattern === '' ? '/' : `/${pattern}/`;
}

export function loadIndexablePages(path: string = INDEXABLE_PAGES_PATH): IndexablePage[] {
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as { pages?: unknown };
  if (!Array.isArray(raw.pages) || raw.pages.length === 0) {
    throw new Error(`indexable-pages: ${path} has no pages`);
  }
  const seen = new Set<string>();
  for (const p of raw.pages as IndexablePage[]) {
    if (typeof p.pattern !== 'string' || p.pattern.includes(':') || p.pattern.includes('*')) {
      throw new Error(`indexable-pages: invalid pattern ${JSON.stringify(p.pattern)}`);
    }
    if (seen.has(p.pattern)) throw new Error(`indexable-pages: duplicate pattern ${JSON.stringify(p.pattern)}`);
    seen.add(p.pattern);
    if (!p.label || (p.section !== 'pages' && p.section !== 'guides') || !p.changefreq || !p.priority) {
      throw new Error(`indexable-pages: incomplete entry for ${JSON.stringify(p.pattern)}`);
    }
  }
  return raw.pages as IndexablePage[];
}
