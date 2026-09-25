#!/usr/bin/env tsx
/**
 * SEO-02: sitemap.xml + robots.txt generation.
 *
 * Generates both files post-build from the static route list and the
 * community aggregates JSON (SEO-03). Written to the SWA output root.
 *
 * Sitemap sources (no hardcoded URL total — the parity test asserts
 * set-equality):
 * - Static routes: /, /privacy, /terms, /how-it-works, /faq, /communities/,
 *   /developers, and /sample-report (only if present in prerender-routes.txt).
 * - Community pages: all slugs from community-aggregates.json
 *   (/communities/{slug}/).
 *
 * Each <url> carries <lastmod> = aggregates generatedAt, with per-route
 * changefreq/priority per SEO-02 AC2.
 *
 * robots.txt: allows all, disallows wizard/report/API routes per SEO-02 AC4.
 * The Sitemap: line uses the absolute site URL.
 *
 * Config (env, all optional):
 *   SITE_URL         canonical site URL (default https://feasly.com placeholder)
 *   SEO_OUTPUT_DIR   output directory (default dist/web/browser)
 *
 * Usage: tsx apps/web/scripts/build-seo-artifacts.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGGREGATES_PATH = join(SCRIPT_DIR, '..', 'src', 'content', 'data', 'community-aggregates.json');
const PRERENDER_ROUTES_PATH = join(SCRIPT_DIR, '..', 'prerender-routes.txt');

/** Static routes with their changefreq/priority (SEO-02 AC2). */
const STATIC_ROUTES: ReadonlyArray<{ path: string; changefreq: string; priority: string }> = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/privacy', changefreq: 'yearly', priority: '0.3' },
  { path: '/terms', changefreq: 'yearly', priority: '0.3' },
  { path: '/how-it-works', changefreq: 'monthly', priority: '0.8' },
  { path: '/faq', changefreq: 'monthly', priority: '0.8' },
  { path: '/communities/', changefreq: 'weekly', priority: '0.9' },
  { path: '/developers', changefreq: 'monthly', priority: '0.5' },
];

/** Paths that must never appear in the sitemap (SEO-02 AC5). */
const EXCLUDED_PATTERNS = [/\/r\//, /\/estimate\//, /\/preview/, /\/check-email/, /\/analyzing/, /\/embed\//, /\/admin\//, /\/api\//];

/** robots.txt disallow list (SEO-02 AC4). */
const ROBOTS_DISALLOW = ['/r/', '/estimate/', '/preview', '/check-email', '/analyzing', '/embed/', '/admin/', '/api/'];

export interface SeoArtifactsConfig {
  readonly siteUrl: string;
  readonly outputDir: string;
}

export function loadConfig(): SeoArtifactsConfig {
  const siteUrl = (process.env['SITE_URL'] ?? 'https://feasly.com').trim().replace(/\/+$/, '');
  const outputDir = (process.env['SEO_OUTPUT_DIR'] ?? join(SCRIPT_DIR, '..', 'dist', 'web', 'browser')).trim();
  return { siteUrl, outputDir };
}

interface SitemapUrl {
  readonly loc: string;
  readonly lastmod: string;
  readonly changefreq: string;
  readonly priority: string;
}

function loadSitemapUrls(siteUrl: string): SitemapUrl[] {
  const aggregatesRaw = JSON.parse(readFileSync(AGGREGATES_PATH, 'utf-8')) as {
    generatedAt: string;
    communities: Array<{ slug: string }>;
  };
  const lastmod = aggregatesRaw.generatedAt.split('T')[0]; // YYYY-MM-DD

  const urls: SitemapUrl[] = STATIC_ROUTES.map((r) => ({
    loc: `${siteUrl}${r.path}`,
    lastmod,
    changefreq: r.changefreq,
    priority: r.priority,
  }));

  // /sample-report is included only if the story shipped (present in prerender routes).
  if (existsSync(PRERENDER_ROUTES_PATH)) {
    const prerendered = readFileSync(PRERENDER_ROUTES_PATH, 'utf-8').split('\n').map((l) => l.trim());
    if (prerendered.includes('/sample-report')) {
      urls.push({ loc: `${siteUrl}/sample-report`, lastmod, changefreq: 'monthly', priority: '0.6' });
    }
  }

  // Community pages from the aggregates (source of truth for the 40 slugs).
  for (const c of aggregatesRaw.communities) {
    urls.push({
      loc: `${siteUrl}/communities/${c.slug}/`,
      lastmod,
      changefreq: 'monthly',
      priority: '0.8',
    });
  }

  // Safety: never emit excluded patterns (SEO-02 AC5).
  for (const u of urls) {
    for (const pattern of EXCLUDED_PATTERNS) {
      if (pattern.test(u.loc)) {
        throw new Error(`build-seo-artifacts: excluded pattern ${pattern} matched sitemap URL ${u.loc}`);
      }
    }
  }

  return urls;
}

function buildSitemapXml(urls: SitemapUrl[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ];
  for (const u of urls) {
    lines.push('  <url>');
    lines.push(`    <loc>${u.loc}</loc>`);
    lines.push(`    <lastmod>${u.lastmod}</lastmod>`);
    lines.push(`    <changefreq>${u.changefreq}</changefreq>`);
    lines.push(`    <priority>${u.priority}</priority>`);
    lines.push('  </url>');
  }
  lines.push('</urlset>', '');
  return lines.join('\n');
}

function buildRobotsTxt(siteUrl: string): string {
  const lines = ['User-agent: *', 'Allow: /', ''];
  for (const path of ROBOTS_DISALLOW) {
    lines.push(`Disallow: ${path}`);
  }
  lines.push('', `Sitemap: ${siteUrl}/sitemap.xml`, '');
  return lines.join('\n');
}

export function buildSeoArtifacts(config: SeoArtifactsConfig = loadConfig()): {
  sitemapXml: string;
  robotsTxt: string;
  urlCount: number;
} {
  const urls = loadSitemapUrls(config.siteUrl);
  const sitemapXml = buildSitemapXml(urls);
  const robotsTxt = buildRobotsTxt(config.siteUrl);

  // Validate the sitemap is well-formed XML (basic check — must parse).
  if (!sitemapXml.includes('<urlset') || !sitemapXml.includes('</urlset>')) {
    throw new Error('build-seo-artifacts: generated sitemap.xml is malformed');
  }

  mkdirSync(config.outputDir, { recursive: true });
  writeFileSync(join(config.outputDir, 'sitemap.xml'), sitemapXml);
  writeFileSync(join(config.outputDir, 'robots.txt'), robotsTxt);

  return { sitemapXml, robotsTxt, urlCount: urls.length };
}

// Run when executed directly (not when imported by the spec).
if (import.meta.url === `file://${process.argv[1]}`) {
  const { urlCount } = buildSeoArtifacts();
  console.log(`build-seo-artifacts: wrote sitemap.xml (${urlCount} URLs) and robots.txt`);
}
