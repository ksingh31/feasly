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
 *   and /developers.
 * - Community pages: all slugs from community-aggregates.json
 *   (/communities/{slug}/).
 *
 * NOTE: /sample-report is deliberately EXCLUDED even though it is
 * prerendered — the route is noindex (trust page for visitors, not a search
 * landing page), and a noindex URL must never appear in the sitemap
 * (conflicting crawl signals). If the route ever becomes indexable, add it
 * to STATIC_ROUTES above — never via a prerender-routes.txt conditional.
 *
 * Each <url> carries <lastmod> = aggregates generatedAt, with per-route
 * changefreq/priority per SEO-02 AC2.
 *
 * Every <loc> uses the trailing-slash form the canonicals use (#707) — the
 * check in tools/check-prerender-seo.mjs asserts byte-equality per page.
 *
 * robots.txt: allows all, disallows wizard/report/API routes per SEO-02 AC4.
 * The Sitemap: line uses the absolute site URL.
 *
 * Non-production builds (#707): when `SITE_URL` is unset the build has no
 * confirmed production domain (dev, staging, PR previews), so it must never
 * be indexed. The generated `staticwebapp.config.json` in the output dir
 * gains `X-Robots-Tag: noindex, nofollow` on every response plus a
 * `/robots.txt` -> `/robots.noindex.txt` rewrite (`Disallow: /`). The
 * production-form robots.txt file stays on disk so the local Lighthouse
 * server (serve-dist.mjs, which ignores SWA routing) audits the same bytes a
 * production build ships. Builds with `SITE_URL` are unchanged.
 *
 * Config (env, all optional):
 *   SITE_URL         canonical site URL (default https://feasly.com placeholder);
 *                    unset => non-production (noindex) build
 *   SEO_OUTPUT_DIR   output directory (default dist/web/browser)
 *
 * Usage: tsx apps/web/scripts/build-seo-artifacts.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGGREGATES_PATH = join(SCRIPT_DIR, '..', 'src', 'content', 'data', 'community-aggregates.json');

/** Static routes with their changefreq/priority (SEO-02 AC2). */
const STATIC_ROUTES: ReadonlyArray<{ path: string; changefreq: string; priority: string }> = [
  { path: '/', changefreq: 'weekly', priority: '1.0' },
  { path: '/privacy/', changefreq: 'yearly', priority: '0.3' },
  { path: '/terms/', changefreq: 'yearly', priority: '0.3' },
  { path: '/how-it-works/', changefreq: 'monthly', priority: '0.8' },
  { path: '/faq/', changefreq: 'monthly', priority: '0.8' },
  { path: '/guides/cost-to-build-a-house-calgary/', changefreq: 'monthly', priority: '0.9' },
  { path: '/guides/calgary-zoning-explained/', changefreq: 'monthly', priority: '0.9' },
  { path: '/communities/', changefreq: 'weekly', priority: '0.9' },
  { path: '/developers/', changefreq: 'monthly', priority: '0.5' },
];

/** Response header every non-production response carries (#707). */
export const NOINDEX_HEADER = 'noindex, nofollow';
/** File the non-production SWA config rewrites /robots.txt to (#707). */
export const NOINDEX_ROBOTS_FILE = 'robots.noindex.txt';
/** SWA config file name in the build output. */
const SWA_CONFIG_FILE = 'staticwebapp.config.json';

/** Paths that must never appear in the sitemap (SEO-02 AC5). */
const EXCLUDED_PATTERNS = [/\/r\//, /\/estimate\//, /\/preview/, /\/check-email/, /\/analyzing/, /\/embed\//, /\/admin\//, /\/api\//];

/** robots.txt disallow list (SEO-02 AC4). */
const ROBOTS_DISALLOW = ['/r/', '/estimate/', '/preview', '/check-email', '/analyzing', '/embed/', '/admin/', '/api/'];

export interface SeoArtifactsConfig {
  readonly siteUrl: string;
  readonly outputDir: string;
  /** False for builds without a confirmed SITE_URL (dev, staging, previews). */
  readonly indexable: boolean;
}

export function loadConfig(): SeoArtifactsConfig {
  const configured = (process.env['SITE_URL'] ?? '').trim().replace(/\/+$/, '');
  const siteUrl = configured || 'https://feasly.com';
  const outputDir = (process.env['SEO_OUTPUT_DIR'] ?? join(SCRIPT_DIR, '..', 'dist', 'web', 'browser')).trim();
  return { siteUrl, outputDir, indexable: configured !== '' };
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

  // /sample-report is NEVER in the sitemap: the route is noindex (trust
  // page for visitors, not a search landing page). Emitting a noindex URL
  // in the sitemap sends conflicting signals to crawlers. If the route
  // ever becomes indexable, add it to STATIC_ROUTES — do not re-add a
  // prerender-routes.txt conditional here.

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

function buildNoindexRobotsTxt(): string {
  return ['# Non-production build (no SITE_URL): never index this host.', 'User-agent: *', 'Disallow: /', ''].join('\n');
}

interface SwaRoute {
  readonly route: string;
  readonly rewrite?: string;
  readonly [key: string]: unknown;
}
interface SwaConfig {
  globalHeaders?: Record<string, string>;
  routes?: SwaRoute[];
  [key: string]: unknown;
}

/**
 * Returns the SWA config with the non-production noindex rules applied
 * (#707). Pure and idempotent: re-applying yields the same object.
 */
export function applyNoindexToSwaConfig(config: SwaConfig): SwaConfig {
  const robotsRoute: SwaRoute = { route: '/robots.txt', rewrite: `/${NOINDEX_ROBOTS_FILE}` };
  const otherRoutes = (config.routes ?? []).filter((r) => r.route !== '/robots.txt');
  return {
    ...config,
    globalHeaders: { ...(config.globalHeaders ?? {}), 'X-Robots-Tag': NOINDEX_HEADER },
    // First so no other rule can shadow it.
    routes: [robotsRoute, ...otherRoutes],
  };
}

function writeNonProductionRules(outputDir: string): boolean {
  writeFileSync(join(outputDir, NOINDEX_ROBOTS_FILE), buildNoindexRobotsTxt());
  const swaPath = join(outputDir, SWA_CONFIG_FILE);
  if (!existsSync(swaPath)) return false;
  const swa = JSON.parse(readFileSync(swaPath, 'utf-8')) as SwaConfig;
  writeFileSync(swaPath, `${JSON.stringify(applyNoindexToSwaConfig(swa), null, 2)}\n`);
  return true;
}

export function buildSeoArtifacts(config: SeoArtifactsConfig = loadConfig()): {
  sitemapXml: string;
  robotsTxt: string;
  urlCount: number;
  /** True when the SWA config was patched with the noindex rules. */
  noindexApplied: boolean;
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

  const noindexApplied = config.indexable ? false : writeNonProductionRules(config.outputDir);

  return { sitemapXml, robotsTxt, urlCount: urls.length, noindexApplied };
}

// Run when executed directly (not when imported by the spec).
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const { urlCount, noindexApplied } = buildSeoArtifacts(config);
  console.log(`build-seo-artifacts: wrote sitemap.xml (${urlCount} URLs) and robots.txt`);
  if (!config.indexable) {
    if (!noindexApplied) {
      console.error(`build-seo-artifacts: non-production build but ${SWA_CONFIG_FILE} missing from ${config.outputDir}`);
      process.exit(1);
    }
    console.log('build-seo-artifacts: no SITE_URL — non-production build, X-Robots-Tag noindex + Disallow: / applied');
  }
}
