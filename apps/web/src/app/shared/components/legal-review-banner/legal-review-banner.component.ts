import { Component, inject } from '@angular/core';
import { ConfigService } from '../../../core/config/config.service';

/**
 * Legal review banner (legal/01 AC3 — the LEGAL_REVIEW_PENDING mechanism).
 *
 * Renders the "draft — pending legal review" notice while
 * `legal.reviewPending` is true. Shown on the privacy/terms pages on
 * staging/dev so reviewers can see the draft status at a glance.
 * Production can never serve this banner: the HRD-05 legal gate
 * (`apps/web/tools/check-legal-gate.mjs`, wired into the prod deploy job
 * in cd.yml) blocks production deploys while the flag is true.
 */
@Component({
  selector: 'app-legal-review-banner',
  standalone: true,
  templateUrl: './legal-review-banner.component.html',
  styleUrl: './legal-review-banner.component.scss',
})
export class LegalReviewBannerComponent {
  private readonly config = inject(ConfigService);

  protected readonly reviewPending = this.config.get('legal').reviewPending;
  protected readonly copy = this.config.get('copy').legal;
}
