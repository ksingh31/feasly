import { Component, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent } from '../../shared/components/site-footer/site-footer.component';
import { SiteNavComponent } from '../../shared/components/site-nav/site-nav.component';

/**
 * Branded 404 (SEO-01).
 *
 * Rendered for `/404` and by the wildcard route for every unknown path.
 * Copy is verbatim from the story's acceptance criteria — it changes by
 * product decision, not deploy tuning, so it lives here (not in config).
 * Allowlisted from the no-hardcode tripwire; pinned by the component spec.
 * The page is noindexed via `SeoService.setForRoute('404')`.
 */
@Component({
  selector: 'app-not-found-page',
  standalone: true,
  imports: [RouterLink, SiteFooterComponent, SiteNavComponent],
  template: `
    <app-site-nav />
    <main class="not-found" id="main-content" tabindex="-1">
      <p class="code">404</p>
      <h1>That page doesn't exist.</h1>
      <p class="body">The page you're looking for moved or never existed.</p>
      <a class="cta" routerLink="/">Back to home →</a>
    </main>
    <app-site-footer />
  `,
  styleUrl: './not-found.scss',
})
export class NotFoundPageComponent implements OnInit {
  private readonly seo = inject(SeoService);

  ngOnInit(): void {
    this.seo.setForRoute('404');
  }
}
