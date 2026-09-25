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
   * Injects (or replaces) a `script[type="application/ld+json"]` tag in
   * `<head>` — used for per-page structured data such as FAQPage (SEO-010).
   * SSR-safe: renders into the prerendered HTML via DOCUMENT. Passing
   * `null` removes the tag (for routes that must not carry structured data).
   *
   * This manages the default (unkeyed) script. For pages needing multiple
   * scripts (SEO-06: community pages need FAQPage + LocalBusiness), use
   * `setJsonLdScript(id, data)` instead.
   */
  setJsonLd(data: Record<string, unknown> | null): void {
    this.setJsonLdScript('', data);
  }

  /**
   * Injects (or replaces) a keyed JSON-LD script in `<head>`. The `id`
   * becomes a `data-jsonld-id` attribute, so multiple schemas can coexist
   * (e.g. a community page's FAQPage + LocalBusiness). Passing `null`
   * removes the script with that id. An empty id targets the default
   * unkeyed script (same as `setJsonLd`).
   *
   * SSR-safe: renders into the prerendered HTML via DOCUMENT.
   */
  setJsonLdScript(id: string, data: Record<string, unknown> | null): void {
    const head = this.document.head;
    const selector = id
      ? `script[type="application/ld+json"][data-jsonld-id="${id}"]`
      : 'script[type="application/ld+json"]:not([data-jsonld-id])';
    const existing = head.querySelector(selector);
    if (data === null) {
      existing?.remove();
      return;
    }
    const script = this.document.createElement('script');
    script.type = 'application/ld+json';
    if (id) {
      script.setAttribute('data-jsonld-id', id);
    }
    script.textContent = JSON.stringify(data);
    if (existing) {
      existing.replaceWith(script);
    } else {
      head.appendChild(script);
    }
  }

  /**
   * Public accessor for the canonical site URL (SEO-06: used for JSON-LD
   * `url` fields). Resolves via the same priority order as the meta tags.
   */
  getSiteUrl(): string {
    return this.resolveSiteUrl();
  }

  /**
   * Canonical origin for absolute tags, in priority order:
   * 1. `SITE_URL` build-time env var (present during prerender/SSR in Node),
   * 2. `site.url` from the served config (written by tools/apply-site-url.mjs),
   * 3. the request origin at runtime (SWA staging/preview hostname fallback),
   * 4. the compiled placeholder (prerender without SITE_URL — see SEO.md).
   */
  private resolveSiteUrl(): string {
    // `process` exists only in Node (prerender/SSR). The ambient declaration
    // at the top of this file is type-only — it emits no runtime binding, so
    // a bare `process?.env` reference throws `ReferenceError: process is not
    // defined` in browsers (optional chaining does not guard undeclared
    // bindings). `typeof` is the only safe check here.
    const fromEnv =
      typeof process !== 'undefined'
        ? process.env['SITE_URL']?.trim().replace(/\/+$/, '') ?? ''
        : '';
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
