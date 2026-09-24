import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ConfigService } from '../config/config.service';

export interface PageSeo {
  /** Full document title, e.g. "Feasly — …". */
  title: string;
  /** Meta description / OG description. */
  description: string;
  /** Path under the site origin, e.g. "/estimate/scope". */
  path: string;
}

/**
 * Per-page SEO (FE1-001): title, description, canonical, and Open Graph tags.
 * Uses Angular's Title/Meta services (SSR-safe — they render into the
 * prerendered HTML). Static fallbacks for `/` live in index.html; this
 * service updates them idempotently per route.
 */
@Injectable({ providedIn: 'root' })
export class SeoService {
  private readonly title = inject(Title);
  private readonly meta = inject(Meta);
  private readonly document = inject(DOCUMENT);
  private readonly config = inject(ConfigService);

  setPage(page: PageSeo): void {
    const site = this.config.get('site');
    const url = `${site.url}${page.path}`;
    const socialImage = `${site.url}${site.socialImage}`;
    this.title.setTitle(page.title);
    this.meta.updateTag({ name: 'description', content: page.description });
    this.meta.updateTag({ property: 'og:title', content: page.title });
    this.meta.updateTag({ property: 'og:description', content: page.description });
    this.meta.updateTag({ property: 'og:url', content: url });
    this.meta.updateTag({ property: 'og:image', content: socialImage });
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
}
