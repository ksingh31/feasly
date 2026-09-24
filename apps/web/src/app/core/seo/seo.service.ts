import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { inject, Injectable, PLATFORM_ID } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { DEFAULT_APP_CONFIG } from '../config/app-config.defaults';
import { ConfigService } from '../config/config.service';
import { findSeoRoute } from './seo-routes';

export interface PageSeo {
  /** Full document title, e.g. "Feasly — …". */
  title: string;
  /** Meta description / OG description. */
  description: string;
  /** Path under the site origin, e.g. "/estimate/scope". */
  path: string;
}

/** Build-time env (prerender/SSR in Node). Ambient — the app bundle has no node types. */
declare const process: { env: Record<string, string | undefined> } | undefined;

/**
 * Per-page SEO (SEO-01): route-driven `<title>`, meta description, canonical,
 * Open Graph and Twitter tags, plus `robots` handling.
 *
 * - `setForRoute(path)` is the primary API: it resolves `seo-routes.ts`,
 *   pulls title/description from config-owned `copy.seo`, and applies the
 *   full tag set — including `noindex,nofollow` where the route requires it.
 * - `setPage(page)` remains as the low-level primitive (kept for call sites
 *   that already compose their own copy).
 *
 * Canonicals always carry a trailing slash on indexable routes
 * (SEO.md "Trailing-slash policy"). Uses Angular's Title/Meta services
 * (SSR-safe — they render into the prerendered HTML). Static fallbacks for
 * `/` live in index.html; this service updates them idempotently per route.
 */
@Injectable({ providedIn: 'root' })
export class SeoService {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly document = inject(DOCUMENT);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly config = inject(ConfigService);

  /** Route-driven tags for a router path (e.g. 'estimate/scope' or '/privacy'). */
  setForRoute(path: string): void {
    const route = findSeoRoute(path);
    const seo = this.config.get('copy').seo;
    const normalized = path.replace(/^\/+/, '');
    const routePath = `/${normalized}`.replace(/\/+$/, '') || '/';
    this.setPage({
      title: seo[route.titleKey],
      description: seo[route.descriptionKey],
      path: routePath,
    });
    if (route.noindex) {
      this.meta.updateTag({ name: 'robots', content: 'noindex,nofollow' });
    } else {
      this.meta.removeTag('name="robots"');
    }
  }

  setPage(page: PageSeo): void {
    const siteUrl = this.resolveSiteUrl();
    const canonicalPath = withTrailingSlash(page.path);
    const url = `${siteUrl}${canonicalPath}`;
    const socialImage = `${siteUrl}${this.config.get('site').socialImage}`;
    this.title.setTitle(page.title);
    this.meta.updateTag({ name: 'description', content: page.description });
    this.meta.updateTag({ property: 'og:type', content: 'website' });
    this.meta.updateTag({ property: 'og:title', content: page.title });
    this.meta.updateTag({ property: 'og:description', content: page.description });
    this.meta.updateTag({ property: 'og:url', content: url });
    this.meta.updateTag({ property: 'og:image', content: socialImage });
    this.meta.updateTag({ name: 'twitter:card', content: 'summary_large_image' });
    this.meta.updateTag({ name: 'twitter:title', content: page.title });
    this.meta.updateTag({ name: 'twitter:description', content: page.description });
    this.meta.updateTag({ name: 'twitter:image', content: socialImage });
    let canonical = this.document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!canonical) {
      canonical = this.document.createElement('link');
      canonical.rel = 'canonical';
      this.document.head.appendChild(canonical);
    }
    canonical.href = url;
  }

  /**
   * Canonical origin for absolute tags, in priority order:
   * 1. `SITE_URL` build-time env var (present during prerender/SSR in Node),
   * 2. `site.url` from the served config (written by tools/apply-site-url.mjs),
   * 3. the request origin at runtime (SWA staging/preview hostname fallback),
   * 4. the compiled placeholder (prerender without SITE_URL — see SEO.md).
   */
  private resolveSiteUrl(): string {
    const fromEnv = process?.env['SITE_URL']?.trim().replace(/\/+$/, '') ?? '';
    if (fromEnv) return fromEnv;
    const configured = (this.config.get('site').url ?? '').trim().replace(/\/+$/, '');
    if (configured) return configured;
    if (isPlatformBrowser(this.platformId)) {
      return this.document.location.origin.replace(/\/+$/, '');
    }
    // Prerender/SSR with no SITE_URL and an empty served config: emit the
    // compiled placeholder so prerendered tags stay absolute. The SPA
    // corrects them to the request origin on bootstrap (SEO.md).
    return DEFAULT_APP_CONFIG.site.url.replace(/\/+$/, '');
  }
}

/** Ensures the trailing-slash canonical form ('/' stays '/'). */
export function withTrailingSlash(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return normalized.endsWith('/') ? normalized : `${normalized}/`;
}
