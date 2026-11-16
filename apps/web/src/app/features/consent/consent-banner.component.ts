import { Component, DestroyRef, effect, ElementRef, inject, PLATFORM_ID, viewChild } from '@angular/core';
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
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
 *
 * #832 (WCAG 2.2 SC 2.4.11 Focus Not Obscured): while visible, the banner
 * publishes its live height as `--consent-banner-h` on <html>. styles.scss
 * turns that into `scroll-padding-bottom` (focused fields scroll clear of
 * the bar) and matching body padding (the page end is reachable). Cleared
 * when the banner closes or the component is destroyed.
 */
/** CSS custom property carrying the visible banner's height (read in styles.scss). */
export const CONSENT_BANNER_HEIGHT_VAR = '--consent-banner-h';

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

  private readonly banner = viewChild<ElementRef<HTMLElement>>('banner');
  private readonly document = inject(DOCUMENT);
  private observer: ResizeObserver | undefined;

  constructor() {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) {
      return;
    }
    effect(() => this.reserveSpace(this.banner()?.nativeElement));
    inject(DestroyRef).onDestroy(() => this.reserveSpace(undefined));
  }

  accept(): void {
    this.store.dispatch(new AcknowledgeConsent(true));
  }

  decline(): void {
    this.store.dispatch(new AcknowledgeConsent(false));
  }

  /** Track the banner's height (it wraps at narrow widths) in `--consent-banner-h`. */
  private reserveSpace(el: HTMLElement | undefined): void {
    this.observer?.disconnect();
    this.observer = undefined;
    const root = this.document.documentElement;
    if (!el) {
      root.style.removeProperty(CONSENT_BANNER_HEIGHT_VAR);
      return;
    }
    const publish = (): void => root.style.setProperty(CONSENT_BANNER_HEIGHT_VAR, `${el.offsetHeight}px`);
    publish();
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(publish);
      this.observer.observe(el);
    }
  }
}
