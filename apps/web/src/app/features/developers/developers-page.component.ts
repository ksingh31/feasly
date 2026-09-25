import { Component, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SeoService } from '../../core/seo';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';

/**
 * Developers page (api-mcp/03): prerendered API documentation.
 *
 * Quickstart, auth, scopes, rate limits, error catalog, idempotency,
 * sandbox mode, changelog, and a link to the live OpenAPI spec at
 * `/api/v1/openapi.json`. API prose changes with the API (code review),
 * not by deploy tuning — allowlisted from the no-hardcode tripwire
 * (same category as the legal pages).
 *
 * Code samples are static and reviewed against the backend implementation;
 * the OpenAPI drift test (apps/api) guarantees the spec they describe
 * cannot go stale.
 */
@Component({
  selector: 'app-developers-page',
  standalone: true,
  imports: [RouterLink, SiteFooterComponent, SiteNavComponent],
  templateUrl: './developers-page.component.html',
  styleUrl: './developers.scss',
})
export class DevelopersPageComponent implements OnInit {
  private readonly seo = inject(SeoService);

  /** Production API base URL (SITE_URL default in apps/api config). */
  readonly apiBase = 'https://feasly.dev/api/v1';

  /** Sandbox API base URL (test keys only). */
  readonly sandboxBase = 'https://api.sandbox.feasly.dev';

  /** Live OpenAPI 3.1 spec (public, no auth). */
  readonly openapiUrl = 'https://feasly.dev/api/v1/openapi.json';

  ngOnInit(): void {
    this.seo.setForRoute('developers');
    this.seo.setJsonLd(null);
  }
}
