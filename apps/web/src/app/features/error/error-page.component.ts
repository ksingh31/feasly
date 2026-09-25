import { Component, inject, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ErrorRecoveryService } from '../../core/errors/error-recovery.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';

/**
 * Branded 500/error page (HRD-02).
 *
 * Uncaught client failures land here via the global error handler — never a
 * blank screen. Copy is verbatim from the story's acceptance criteria — it
 * changes by product decision, not deploy tuning, so it lives here (not in
 * config). Allowlisted from the no-hardcode tripwire; pinned by the
 * component spec.
 *
 * "Try again" re-fires the last failed action captured by
 * ErrorRecoveryService (e.g. the estimate POST that failed); with nothing
 * captured it falls back to reloading the page. The page renders static copy
 * ONLY — no error text, stack trace, or PII ever reaches the DOM.
 * Noindexed via `SeoService.setForRoute('error')`.
 */
@Component({
  selector: 'app-error-page',
  standalone: true,
  imports: [RouterLink, SiteFooterComponent, SiteNavComponent],
  template: `
    <app-site-nav />
    <main class="state-page" id="main-content" tabindex="-1">
      <p class="code">Error</p>
      <h1>Something went wrong on our end.</h1>
      <p class="body">Your estimate is safe — try again in a moment.</p>
      <div class="actions">
        <button type="button" class="cta" (click)="tryAgain()">Try again</button>
        <a class="link" routerLink="/">Back to home →</a>
      </div>
    </main>
    <app-site-footer />
  `,
  styleUrl: './state-page.scss',
})
export class ErrorPageComponent implements OnInit {
  private readonly seo = inject(SeoService);
  private readonly recovery = inject(ErrorRecoveryService);

  ngOnInit(): void {
    this.seo.setForRoute('error');
  }

  /** Re-fires the captured failed action; falls back to a page reload. */
  tryAgain(): void {
    if (!this.recovery.retry()) {
      window.location.reload();
    }
  }
}
