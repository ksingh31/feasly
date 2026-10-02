/**
 * Route-driven SEO table (SEO-01).
 *
 * Single source of truth for per-route SEO: title/description come from
 * config-owned `copy.seo` keys (never literals here), `noindex` marks the
 * app-state and private routes crawlers must skip.
 *
 * Matching: exact path first, then `:param` segments, then `**` suffix
 * patterns. The final DEFAULT entry is the fallback for unknown paths —
 * `SeoService.setForRoute()` never throws.
 */
import type { AppConfig } from '../config/app-config';

type SeoCopyKey = keyof AppConfig['copy']['seo'];

export interface SeoRouteConfig {
  /** Path pattern without leading slash: '' | 'privacy' | 'r/:token' | 'embed/**'. */
  pattern: string;
  /** Key into config `copy.seo` for the document title. */
  titleKey: SeoCopyKey;
  /** Key into config `copy.seo` for the meta/OG description. */
  descriptionKey: SeoCopyKey;
  /**
   * Crawlers must skip this route (`noindex,nofollow`). Still emits a
   * self-referencing canonical so the tag set stays well-formed.
   */
  noindex?: boolean;
}

/** All current routes. Components call `seo.setForRoute('<pattern>')`. */
const ROUTES: SeoRouteConfig[] = [
  { pattern: '', titleKey: 'landingTitle', descriptionKey: 'landing' },
  { pattern: 'privacy', titleKey: 'privacyTitle', descriptionKey: 'privacy' },
  { pattern: 'terms', titleKey: 'termsTitle', descriptionKey: 'terms' },
  // Marketing pages (SEO-010): indexable — no `noindex`, so crawlers rank them.
  { pattern: 'how-it-works', titleKey: 'howItWorksTitle', descriptionKey: 'howItWorks' },
  { pattern: 'faq', titleKey: 'faqTitle', descriptionKey: 'faq' },
  // Pillar guide (SEO pillar): long-form "cost to build a house in Calgary"
  // guide — indexable like the other marketing pages.
  {
    pattern: 'guides/cost-to-build-a-house-calgary',
    titleKey: 'pillarGuideTitle',
    descriptionKey: 'pillarGuide',
  },
  // API docs (api-mcp/03): indexable like the marketing pages above.
  { pattern: 'developers', titleKey: 'developersTitle', descriptionKey: 'developers' },
  // Community index (SEO-05): indexable guide listing — no `noindex`.
  { pattern: 'communities', titleKey: 'communitiesTitle', descriptionKey: 'communities' },
  // NOTE: `communities/:slug` (SEO-04) is intentionally NOT in this table.
  // Those pages are data-driven, not route-driven: CommunityPageComponent
  // composes per-community title/description via SeoService.setPage() from
  // the titleTemplate/descriptionTemplate (unique per community) and injects
  // FAQPage + LocalBusiness JSON-LD. A static table entry could never carry
  // the per-community copy — do not add one.
  {
    pattern: 'estimate/scope',
    titleKey: 'scopeTitle',
    descriptionKey: 'scope',
    noindex: true,
  },
  {
    pattern: 'estimate/reno-scope',
    titleKey: 'renoScopeTitle',
    descriptionKey: 'renoScope',
    noindex: true,
  },
  {
    pattern: 'estimate/details',
    titleKey: 'detailsTitle',
    descriptionKey: 'details',
    noindex: true,
  },
  {
    pattern: 'estimate/report',
    titleKey: 'reportTitle',
    descriptionKey: 'report',
    noindex: true,
  },
  // Lead gate (FE-004): private funnel route — noindex.
  {
    pattern: 'estimate/gate',
    titleKey: 'gateTitle',
    descriptionKey: 'gate',
    noindex: true,
  },
  // Analyzing (FE-004): private funnel route — noindex.
  {
    pattern: 'estimate/analyzing',
    titleKey: 'analyzingTitle',
    descriptionKey: 'analyzing',
    noindex: true,
  },
  // Reno coming-soon (Karan 2026-09-27): private funnel route — noindex.
  {
    pattern: 'estimate/reno-coming-soon',
    titleKey: 'renoComingSoonTitle',
    descriptionKey: 'renoComingSoon',
    noindex: true,
  },
  // Preview (S5): private funnel route — noindex.
  {
    pattern: 'estimate/preview',
    titleKey: 'previewTitle',
    descriptionKey: 'preview',
    noindex: true,
  },
  // Neighbourhood comparison picker (NBH-04): private funnel route — noindex.
  {
    pattern: 'estimate/compare',
    titleKey: 'compareTitle',
    descriptionKey: 'compare',
    noindex: true,
  },
  { pattern: '404', titleKey: 'notFoundTitle', descriptionKey: 'notFound', noindex: true },
  // Branded error page (HRD-02): uncaught failures land here. noindexed —
  // it must never appear in search results.
  { pattern: 'error', titleKey: 'errorTitle', descriptionKey: 'error', noindex: true },
  // Unsubscribe center (email/03): token-authenticated private page.
  // noindex — it must never appear in search results.
  {
    pattern: 'unsubscribe/:token',
    titleKey: 'unsubscribeTitle',
    descriptionKey: 'unsubscribe',
    noindex: true,
  },
  // Magic-link redemption (consumer/02): /r/:token from the estimate email.
  // Private token URL — noindex, never in search results.
  {
    pattern: 'r/:token',
    titleKey: 'magicLinkTitle',
    descriptionKey: 'magicLink',
    noindex: true,
  },
  // Admin console (admin/07): every admin section gets its own title so
  // client-side nav between sections updates the document title — the
  // previous per-component setPage calls drifted (sections without one
  // inherited the last-visited section's title). All noindexed.
  // AdminShellComponent drives this table on every NavigationEnd; sections
  // must NOT set their own titles.
  { pattern: 'admin', titleKey: 'adminHomeTitle', descriptionKey: 'adminHome', noindex: true },
  { pattern: 'admin/leads', titleKey: 'adminLeadsTitle', descriptionKey: 'adminLeads', noindex: true },
  { pattern: 'admin/builders', titleKey: 'adminBuildersTitle', descriptionKey: 'adminBuilders', noindex: true },
  { pattern: 'admin/users', titleKey: 'adminUsersTitle', descriptionKey: 'adminUsers', noindex: true },
  { pattern: 'admin/disputes', titleKey: 'adminDisputesTitle', descriptionKey: 'adminDisputes', noindex: true },
  {
    pattern: 'admin/calibration',
    titleKey: 'adminCalibrationTitle',
    descriptionKey: 'adminCalibration',
    noindex: true,
  },
  { pattern: 'admin/billing', titleKey: 'adminBillingTitle', descriptionKey: 'adminBilling', noindex: true },
  { pattern: 'admin/ops/sheets', titleKey: 'adminSheetsTitle', descriptionKey: 'adminSheets', noindex: true },
  {
    pattern: 'admin/estimates',
    titleKey: 'adminEstimatesTitle',
    descriptionKey: 'adminEstimates',
    noindex: true,
  },
  {
    pattern: 'admin/estimates/:id',
    titleKey: 'adminEstimatesTitle',
    descriptionKey: 'adminEstimates',
    noindex: true,
  },
  { pattern: 'admin/api-keys', titleKey: 'adminApiKeysTitle', descriptionKey: 'adminApiKeys', noindex: true },
  { pattern: 'admin/funnels', titleKey: 'adminFunnelsTitle', descriptionKey: 'adminFunnels', noindex: true },
  { pattern: 'admin/login', titleKey: 'adminLoginTitle', descriptionKey: 'adminLogin', noindex: true },
  {
    pattern: 'admin/auth/callback',
    titleKey: 'adminCallbackTitle',
    descriptionKey: 'adminCallback',
    noindex: true,
  },
];

/**
 * Patterns for routes that do not exist yet (lead gate, analyzing, embed).
 * Declared now so they are noindexed from the day they ship — no
 * story may add one of these paths without this table covering it. Checked
 * by `seo.service.spec.ts`.
 *
 * The admin console's real routes live in ROUTES above (admin/07); the
 * `admin/**` entry stays as the noindex fallback for unknown admin
 * sub-paths, which render the generic admin title rather than the 404 page.
 */
const FUTURE_NOINDEX: SeoRouteConfig[] = [
  { pattern: 'preview', titleKey: 'notFoundTitle', descriptionKey: 'notFound', noindex: true },
  { pattern: 'check-email', titleKey: 'notFoundTitle', descriptionKey: 'notFound', noindex: true },
  { pattern: 'analyzing', titleKey: 'notFoundTitle', descriptionKey: 'notFound', noindex: true },
  { pattern: 'embed/**', titleKey: 'notFoundTitle', descriptionKey: 'notFound', noindex: true },
  { pattern: 'admin/**', titleKey: 'adminHomeTitle', descriptionKey: 'adminHome', noindex: true },
  { pattern: 'builder/**', titleKey: 'notFoundTitle', descriptionKey: 'notFound', noindex: true },
];

/** Fallback for unknown paths: renders the branded 404 (noindexed). */
const DEFAULT_ROUTE: SeoRouteConfig = {
  pattern: '**',
  titleKey: 'notFoundTitle',
  descriptionKey: 'notFound',
  noindex: true,
};

const TABLE: SeoRouteConfig[] = [...ROUTES, ...FUTURE_NOINDEX];

/** Normalizes a router URL or bare path to a matchable pattern form. */
export function normalizeSeoPath(path: string): string {
  return path.split('?')[0].split('#')[0].replace(/^\/+|\/+$/g, '');
}

function matches(pattern: string, path: string): boolean {
  if (pattern.endsWith('/**')) {
    const base = pattern.slice(0, -3);
    return path === base || path.startsWith(`${base}/`);
  }
  const patternParts = pattern.split('/');
  const pathParts = path.split('/');
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, i) => part.startsWith(':') || part === pathParts[i]);
}

/** Resolves the SEO config for a path; never throws — falls back to DEFAULT_ROUTE. */
export function findSeoRoute(path: string): SeoRouteConfig {
  const normalized = normalizeSeoPath(path);
  const exact = TABLE.find((entry) => entry.pattern === normalized);
  if (exact) return exact;
  return TABLE.find((entry) => matches(entry.pattern, normalized)) ?? DEFAULT_ROUTE;
}

/** The noindex route list the story requires, for tests and docs. */
export function noindexPatterns(): string[] {
  return [...TABLE.filter((entry) => entry.noindex).map((entry) => entry.pattern)];
}
