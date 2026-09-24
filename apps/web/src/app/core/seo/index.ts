/** @core/seo barrel. */
export { SeoService, withTrailingSlash } from './seo.service';
export type { PageSeo } from './seo.service';
export { findSeoRoute, noindexPatterns, normalizeSeoPath } from './seo-routes';
export type { SeoRouteConfig } from './seo-routes';
export { robotsGuard } from './robots.guard';
