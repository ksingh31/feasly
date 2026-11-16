import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import { ReportState } from '../report/report.state';
import {
  CancelErasure,
  DownloadMyData,
  PRIVACY_CONFIRMED_STATE,
  RequestErasure,
  ResetPrivacy,
  SendPrivacyLink,
} from './privacy.actions';
import { PrivacyState } from './privacy.state';

/**
 * `/privacy/my-data` (#706, noindex): self-service export + erasure.
 *
 * With the magic-link token in session (ReportState, memory-only) the user
 * can download their data and start an erasure request. Without a token —
 * or once it is expired — an email field asks the existing reissue endpoint
 * for a fresh link; the on-screen answer is identical for known and unknown
 * emails. The token and email are never rendered, logged, or sent to
 * analytics.
 *
 * Erasure is two-step, exactly as the API works: the request returns the
 * consequences, then the user confirms on `/privacy/confirm/:id`.
 */
@Component({
  selector: 'app-my-data-page',
  standalone: true,
  imports: [ReactiveFormsModule, SiteFooterComponent, SiteNavComponent],
  templateUrl: './my-data-page.component.html',
  styleUrl: './privacy-pages.scss',
})
export class MyDataPageComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly config = inject(ConfigService);
  private readonly seo = inject(SeoService);

  protected readonly copy = this.config.get('copy').privacyData;
  /** #706/#806: in-page confirm until the API emails the confirmation link. */
  protected readonly confirmInPage = this.config.get('features').privacyEraseConfirmInPage;
  protected readonly token = this.store.selectSignal(ReportState.reportToken);
  protected readonly download = this.store.selectSignal(PrivacyState.download);
  protected readonly erase = this.store.selectSignal(PrivacyState.erase);
  protected readonly requestId = this.store.selectSignal(PrivacyState.eraseRequestId);
  protected readonly consequences = this.store.selectSignal(PrivacyState.consequences);
  protected readonly link = this.store.selectSignal(PrivacyState.link);

  /** An expired/revoked token behaves like no token: offer a fresh link. */
  protected readonly linkExpired = computed(
    () => this.download() === 'expired' || this.erase() === 'expired',
  );
  protected readonly hasUsableToken = computed(() => !!this.token() && !this.linkExpired());
  protected readonly rateLimited = computed(
    () => this.download() === 'rate-limited' || this.erase() === 'rate-limited',
  );
  protected readonly failed = computed(
    () => this.download() === 'error' || this.erase() === 'error',
  );

  protected readonly email = new FormControl('', {
    nonNullable: true,
    validators: [Validators.required, Validators.email],
  });
  protected readonly submittedEmail = signal(false);
  /** Touched tracking isn't a signal, so read it in a method (template re-evaluates). */
  protected showEmailError(): boolean {
    return this.email.invalid && (this.email.touched || this.submittedEmail());
  }

  ngOnInit(): void {
    this.seo.setForRoute('privacy/my-data');
    this.store.dispatch(new ResetPrivacy());
  }

  protected downloadData(): void {
    const token = this.token();
    if (token && this.download() !== 'working') {
      this.store.dispatch(new DownloadMyData(token));
    }
  }

  protected startErasure(): void {
    const token = this.token();
    if (token && this.erase() !== 'working') {
      this.store.dispatch(new RequestErasure(token));
    }
  }

  protected confirmErasure(): void {
    const id = this.requestId();
    if (id) {
      void this.router.navigate(['/privacy/confirm', id], {
        state: { [PRIVACY_CONFIRMED_STATE]: true },
      });
    }
  }

  protected cancelErasure(): void {
    this.store.dispatch(new CancelErasure());
  }

  protected sendLink(): void {
    this.submittedEmail.set(true);
    if (this.email.invalid || this.link() === 'working') {
      this.email.markAsTouched();
      return;
    }
    this.store.dispatch(new SendPrivacyLink(this.email.value.trim()));
  }

  protected retry(): void {
    this.store.dispatch(new ResetPrivacy());
  }
}
