import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ConfigService } from '../../../core/config/config.service';

/**
 * PrivacyDataLink (#706) — the quiet "Download or delete my data" entry to the
 * privacy self-service page. Lives in shared so pages outside the privacy
 * feature (the report) can link to it without a cross-feature import, and so
 * its styles stay out of the host page's component-style budget.
 * Label is config-owned (`copy.privacyData.entryLinkLabel`).
 */
@Component({
  selector: 'app-privacy-data-link',
  standalone: true,
  imports: [RouterLink],
  template: `<a routerLink="/privacy/my-data">{{ label }}</a>`,
  styles: `
    :host {
      display: block;
      margin: var(--space-6) 0 0;
      text-align: center;
      font-size: var(--type-body-sm);
    }
    a {
      display: inline-block;
      padding: var(--space-3) 0;
      color: var(--muted);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PrivacyDataLinkComponent {
  protected readonly label = inject(ConfigService).get('copy').privacyData.entryLinkLabel;
}
