import { __decorate } from "tslib";
import { DOCUMENT } from '@angular/common';
import { inject, Injectable } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { ConfigService } from '../config/config.service';
/**
 * Per-page SEO (FE1-001): title, description, canonical, and Open Graph tags.
 * Uses Angular's Title/Meta services (SSR-safe — they render into the
 * prerendered HTML). Static fallbacks for `/` live in index.html; this
 * service updates them idempotently per route.
 */
let SeoService = class SeoService {
    title = inject(Title);
    meta = inject(Meta);
    document = inject(DOCUMENT);
    config = inject(ConfigService);
    setPage(page) {
        const url = `${this.config.get('site').url}${page.path}`;
        this.title.setTitle(page.title);
        this.meta.updateTag({ name: 'description', content: page.description });
        this.meta.updateTag({ property: 'og:title', content: page.title });
        this.meta.updateTag({ property: 'og:description', content: page.description });
        this.meta.updateTag({ property: 'og:url', content: url });
        this.meta.updateTag({ name: 'twitter:title', content: page.title });
        this.meta.updateTag({ name: 'twitter:description', content: page.description });
        let canonical = this.document.querySelector('link[rel="canonical"]');
        if (!canonical) {
            canonical = this.document.createElement('link');
            canonical.rel = 'canonical';
            this.document.head.appendChild(canonical);
        }
        canonical.href = url;
    }
};
SeoService = __decorate([
    Injectable({ providedIn: 'root' })
], SeoService);
export { SeoService };
