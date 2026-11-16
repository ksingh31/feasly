import { DOCUMENT } from '@angular/common';
import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { ReportState } from '../report/report.state';
import { ConfirmErasure, PRIVACY_CONFIRMED_STATE, ResetPrivacy } from './privacy.actions';
import { PrivacyState } from './privacy.state';

/**
 * Erasure confirmation landing (#706, noindex):
 * `/privacy/confirm/:requestId[#token=…]` — the contract the API's
 * confirmation email targets (#806).
 *
 * The Bearer token comes from the URL fragment (emailed link; never sent to
 * a server, stripped from the address bar on read) or the session
 * (ReportState). Arriving from an email the page waits for an explicit click
 * — link scanners that pre-open URLs must never delete anyone's data.
 * Arriving from the in-page confirm button (router state flag) it runs at
 * once. On success PrivacyState clears the local wizard, lead and report
 * state.
 */
@Component({
  selector: 'app-confirm-erase-page',
  standalone: true,
  imports: [RouterLink, SiteFooterComponent, SiteNavComponent],
  templateUrl: './confirm-erase-page.component.html',
  styleUrl: './privacy-pages.scss',
})
export class ConfirmErasePageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly config = inject(ConfigService);
  private readonly seo = inject(SeoService);

  protected readonly copy = this.config.get('copy').privacyData;
  protected readonly confirm = this.store.selectSignal(PrivacyState.confirm);
  /** No session token and no `#token=`: shown as the expired-link state. */
  protected readonly noCredential = signal(false);

  private requestId = '';
  private token = '';

  ngOnInit(): void {
    this.seo.setForRoute('privacy/confirm/:requestId');
    this.store.dispatch(new ResetPrivacy());
    const snapshot = this.route.snapshot;
    this.requestId = snapshot.paramMap.get('requestId')?.trim() ?? '';
    const fragmentToken = new URLSearchParams(snapshot.fragment ?? '').get('token')?.trim() ?? '';
    this.token = fragmentToken || this.store.selectSnapshot(ReportState.reportToken) || '';
    if (fragmentToken) {
      // Keep the credential out of history/bookmarks once read.
      void this.router.navigate([], { relativeTo: this.route, fragment: undefined, replaceUrl: true });
    }
    if (!this.token) {
      this.noCredential.set(true);
      return;
    }
    const history = this.document.defaultView?.history?.state as Record<string, unknown> | null | undefined;
    if (history?.[PRIVACY_CONFIRMED_STATE] === true) {
      this.run();
    }
  }

  /** The explicit confirm click (emailed link) and the retry button. */
  protected run(): void {
    if (!this.token || this.confirm() === 'working') {
      return;
    }
    this.store.dispatch(new ConfirmErasure(this.token, this.requestId));
  }
}
