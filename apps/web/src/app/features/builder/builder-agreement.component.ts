import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import type { AgreementDocument } from '@feasly/contracts';
import {
  ErrorStateComponent,
  PageHeaderComponent,
  PageLayoutComponent,
  SkeletonComponent,
  UiButtonComponent,
} from '@app/shared/ui';
import { SeoService } from '../../core/seo/seo.service';
import { formatEdmontonMediumDate } from '../../shared/utils/edmonton';
import { BUILDER_COPY } from './builder-copy';
import { fill } from './builder-leads-view';
import { AcceptBuilderAgreement, LoadBuilderAgreement } from './builder-onboarding.actions';
import { BuilderOnboardingState } from './builder-onboarding.state';
import {
  AGREEMENT_PATH,
  AGREEMENT_RETURN_PARAM,
  safeAgreementReturnUrl,
} from './builder-agreement-gate';

/** Pixels of slack when deciding the reader reached the end (sub-pixel rounding). */
const SCROLL_END_SLACK_PX = 2;

/** Plain-text copy of the served agreement for the download (no transformation of terms). */
export function agreementPlainText(doc: AgreementDocument, versionLine: string, draftLine: string): string {
  const lines: string[] = [doc.title, versionLine];
  if (doc.status === 'draft-pending-lawyer') lines.push(draftLine);
  for (const section of doc.sections) {
    lines.push('', section.heading, '');
    lines.push(...section.paragraphs.flatMap((p, i) => (i === 0 ? [p] : ['', p])));
  }
  return lines.join('\n') + '\n';
}

/**
 * Platform agreement screen (#722) — `/builder/agreement`.
 *
 * Renders the served, versioned agreement text with a visible draft
 * notice while counsel review is pending, a downloadable plain-text copy,
 * and scroll-to-accept: Accept stays disabled (with the reason linked via
 * aria-describedby) until the reader scrolls to the end of the text, and
 * is enabled straight away when the text doesn't overflow. Only org admins
 * (`canAccept`) see the button; members are asked to have their admin
 * accept. After accepting, the builder returns to the money page that
 * sent them here (`?returnUrl=`, builder paths only).
 *
 * noindex via the builder shell route; never prerendered.
 */
@Component({
  selector: 'app-builder-agreement',
  standalone: true,
  imports: [
    PageLayoutComponent,
    PageHeaderComponent,
    ErrorStateComponent,
    SkeletonComponent,
    UiButtonComponent,
  ],
  templateUrl: './builder-agreement.component.html',
  styleUrl: './builder-agreement.component.scss',
  host: { '(window:resize)': 'measure()' },
})
export class BuilderAgreementComponent {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);

  protected readonly copy = inject(BUILDER_COPY);
  protected readonly t = this.copy.agreement;

  protected readonly agreement = this.store.selectSignal(BuilderOnboardingState.agreement);
  protected readonly status = this.store.selectSignal(BuilderOnboardingState.agreementStatus);
  protected readonly accepting = this.store.selectSignal(BuilderOnboardingState.accepting);
  private readonly acceptError = this.store.selectSignal(BuilderOnboardingState.acceptError);

  /** The reader scrolled to the end of the text (or it doesn't overflow). */
  protected readonly reachedEnd = signal(false);

  private readonly docEl = viewChild<ElementRef<HTMLElement>>('doc');
  private measuredVersion: string | null = null;

  private readonly returnUrl = safeAgreementReturnUrl(
    this.route.snapshot.queryParamMap.get(AGREEMENT_RETURN_PARAM),
  );

  protected readonly isDraft = computed(
    () => this.agreement()?.document.status === 'draft-pending-lawyer',
  );
  protected readonly versionLabel = computed(() =>
    fill(this.t.versionLabel, { version: this.agreement()?.version ?? '' }),
  );
  protected readonly acceptedLine = computed(() => {
    const a = this.agreement();
    if (!a?.current || !a.acceptedAt) return null;
    const by = a.acceptedBy;
    return fill(this.t.acceptedNotice, {
      date: formatEdmontonMediumDate(a.acceptedAt),
      name: by?.name || by?.email || this.t.acceptedByUnknown,
    });
  });
  protected readonly acceptErrorText = computed(() => {
    switch (this.acceptError()) {
      case 'versionChanged':
        return this.t.versionChanged;
      case 'adminRequired':
        return this.t.adminRequired;
      case 'failed':
        return this.t.acceptFailed;
      default:
        return null;
    }
  });

  constructor() {
    inject(SeoService).setPage({
      title: this.t.seoTitle,
      description: this.t.description,
      path: AGREEMENT_PATH,
    });
    // Always refetch: another admin may have accepted, or the version moved.
    this.store.dispatch(new LoadBuilderAgreement());

    // Re-measure whenever the text (version) renders: a new version resets
    // scroll-to-accept; text that fits without scrolling enables Accept now.
    afterRenderEffect(() => {
      const el = this.docEl()?.nativeElement;
      const version = this.agreement()?.version ?? null;
      if (!el) return;
      if (version !== this.measuredVersion) {
        this.measuredVersion = version;
        this.reachedEnd.set(false);
      }
      this.measure();
    });
  }

  /** Scroll / resize handler: flips `reachedEnd` once the end is visible. */
  protected measure(): void {
    const el = this.docEl()?.nativeElement;
    if (!el || this.reachedEnd()) return;
    if (el.scrollHeight - el.clientHeight - el.scrollTop <= SCROLL_END_SLACK_PX) {
      this.reachedEnd.set(true);
    }
  }

  protected retry(): void {
    this.store.dispatch(new LoadBuilderAgreement());
  }

  protected accept(): void {
    const a = this.agreement();
    if (!a || !a.canAccept || !this.reachedEnd() || this.accepting()) return;
    this.store
      .dispatch(new AcceptBuilderAgreement(a.version))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        if (this.returnUrl && this.store.selectSnapshot(BuilderOnboardingState.agreementCurrent)) {
          void this.router.navigateByUrl(this.returnUrl);
        }
      });
  }

  protected continue(): void {
    void this.router.navigateByUrl(this.returnUrl ?? '/builder');
  }

  /** Client-side plain-text copy of the served text (Blob download). */
  protected download(): void {
    const a = this.agreement();
    if (!a) return;
    const text = agreementPlainText(a.document, this.versionLabel(), this.t.downloadDraftLine);
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = this.document.createElement('a');
    link.href = url;
    link.download = fill(this.t.downloadFileName, { version: a.version });
    this.document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }
}
