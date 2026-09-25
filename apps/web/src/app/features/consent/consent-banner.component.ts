import { Component, inject } from '@angular/core';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config/config.service';
import { AcknowledgeConsent } from './consent.actions';
import { ConsentState } from './consent.state';

/**
 * First-party analytics consent banner (story consumer/01).
 *
 * Renders only while the consent state is 'pending' — the choice persists
 * via the NGXS storage plugin, so returning visitors never see it again.
 * No dark patterns: accept and decline are equally weighted, and declining
 * fires zero analytics events (the analytics service gates on 'granted').
 * All copy is deploy-tunable via `copy.consent` — no hardcoded strings.
 */
@Component({
  imports: [],
  selector: 'app-consent-banner',
  templateUrl: './consent-banner.component.html',
  styleUrl: './consent-banner.component.scss',
})
export class ConsentBannerComponent {
  private readonly store = inject(Store);
  private readonly config = inject(ConfigService);

  readonly copy = this.config.get('copy').consent;
  readonly visible = this.store.selectSignal(ConsentState.bannerVisible);

  accept(): void {
    this.store.dispatch(new AcknowledgeConsent(true));
  }

  decline(): void {
    this.store.dispatch(new AcknowledgeConsent(false));
  }
}
