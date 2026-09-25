import { isPlatformBrowser } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { fromEvent } from 'rxjs';
import { filter } from 'rxjs/operators';
import type { EmbedPublicConfig, PropertyRecord } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { AddressAutocompleteComponent } from '../../shared/components/address-autocomplete';
import { EmbedConfigFailed, LoadEmbedConfig } from './embed.actions';
import { EmbedState } from './embed.state';
import { GoToStep, SelectProperty } from '../wizard/wizard.actions';

/** Parent → shell: live theme update (see contracts EmbedThemeMessage). */
interface ThemeInbound {
  readonly type: 'feasly:theme';
  readonly primaryColor?: unknown;
}

/** Shell → parent: lifecycle announcements and the lead handoff. */
interface ShellOutbound {
  readonly type: 'feasly:ready' | 'feasly:resize' | 'feasly:estimate-start';
  readonly height?: number;
  readonly addressKey?: string;
  readonly address?: string;
}

const THEME_MESSAGE = 'feasly:theme';
/** Strict 6-digit hex — anything else is ignored, never applied. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * White-label embed shell (EMB-01): the minimal widget a builder iframes on
 * their site. Resolves the tenant via `?key=` (or `:tenantKey`), applies the
 * builder's branding, and hosts the address → estimate entry point.
 *
 * Chrome-free by construction: no site nav, no marketing footer — just the
 * builder's brand, the address input, and the CTA. Invalid/missing keys show
 * the story-pinned fallback card, never a blank iframe.
 *
 * postMessage discipline: inbound messages are accepted only from origins
 * in the tenant's `allowed_origins` (a '*' entry never authorizes); the
 * shell announces `feasly:ready`/`feasly:resize` and hands the picked address
 * to the parent as `feasly:estimate-start`.
 */
@Component({
  selector: 'app-embed-shell',
  standalone: true,
  imports: [AddressAutocompleteComponent],
  templateUrl: './embed-shell.component.html',
  styleUrl: './embed-shell.component.scss',
})
export class EmbedShellComponent {
  private readonly store = inject(Store);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly config = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly copy = this.config.get('copy').embed;
  protected readonly status = this.store.selectSignal(EmbedState.status);
  protected readonly builderConfig = this.store.selectSignal(EmbedState.config);

  /** Property picked in the autocomplete; null until the user picks one. */
  readonly property = signal<PropertyRecord | null>(null);

  protected readonly phone = computed(() => this.builderConfig()?.fallback_phone?.trim() ?? '');
  protected readonly email = computed(() => this.builderConfig()?.fallback_email?.trim() ?? '');
  protected readonly hasContact = computed(() => this.phone() !== '' || this.email() !== '');

  constructor() {
    const key =
      this.route.snapshot.queryParamMap.get('key') ?? this.route.snapshot.paramMap.get('tenantKey');
    if (key !== null && key.trim() !== '') {
      this.store.dispatch(new LoadEmbedConfig(key.trim()));
    } else {
      this.store.dispatch(new EmbedConfigFailed('missing_key'));
    }

    // React to the loaded config: theme the shell, then announce readiness.
    effect(() => {
      const cfg = this.builderConfig();
      if (cfg !== null) {
        this.applyAccent(cfg.accent_color);
        this.postToParent({ type: 'feasly:ready' });
        this.postResize();
      }
    });

    if (this.isBrowser) {
      // Inbound: only the tenant's allowlisted origins may theme the shell.
      fromEvent<MessageEvent>(window, 'message')
        .pipe(
          takeUntilDestroyed(this.destroyRef),
          filter((ev) => this.isAllowedThemeMessage(ev)),
        )
        .subscribe((ev) => this.onThemeMessage(ev.data as ThemeInbound));

      // Keep the parent iframe sized to the content; disconnect with the component.
      const ro = new ResizeObserver(() => this.postResize());
      ro.observe(this.host.nativeElement);
      this.destroyRef.onDestroy(() => ro.disconnect());
    }
  }

  /** CTA: hand the picked address to the parent and start the estimate. */
  protected onCta(addressBox: AddressAutocompleteComponent): void {
    const picked = this.property();
    if (picked === null) {
      addressBox.nudgeIfEmpty();
      return;
    }
    this.store.dispatch([new SelectProperty(picked), new GoToStep(2)]);
    this.postToParent({
      type: 'feasly:estimate-start',
      addressKey: picked.addressKey,
      address: picked.address,
    });
    // Direct visits continue into the estimate flow. Inside a builder iframe
    // the parent owns what happens next (the snippet sandbox forbids
    // top-navigation anyway), so the shell stays put.
    if (this.isBrowser && window.self === window.top) {
      void this.router.navigate(['/estimate/scope']);
    }
  }

  /** Origin-gated: only `feasly:theme` from an allowlisted origin passes. */
  private isAllowedThemeMessage(ev: MessageEvent): boolean {
    const data = ev.data as { type?: unknown } | null;
    if (data === null || data.type !== THEME_MESSAGE) return false;
    const allowed = this.builderConfig()?.allowed_origins ?? [];
    return ev.origin !== '' && allowed.includes(ev.origin);
  }

  private onThemeMessage(msg: ThemeInbound): void {
    if (typeof msg.primaryColor === 'string') {
      this.applyAccent(msg.primaryColor);
    }
  }

  /** Applies a validated hex accent as `--embed-accent`; invalid values are ignored. */
  private applyAccent(color: string): void {
    if (this.isBrowser && HEX_COLOR.test(color)) {
      this.host.nativeElement.style.setProperty('--embed-accent', color);
    }
  }

  private postToParent(msg: ShellOutbound): void {
    if (!this.isBrowser) return;
    const target = this.parentTargetOrigin();
    if (target === undefined) return;
    window.parent.postMessage(msg, target);
  }

  /**
   * Outbound postMessage never broadcasts ('*'). In an iframe the target is
   * the embedding page's origin, but only when it appears in the builder's
   * allowlist; standalone, it's our own origin. Otherwise nothing is sent.
   * A wildcard in allowed_origins never authorizes anything.
   */
  private parentTargetOrigin(): string | undefined {
    try {
      const ref = document.referrer;
      if (ref !== '') {
        const origin = new URL(ref).origin;
        const allowed = this.builderConfig()?.allowed_origins ?? [];
        if (origin !== '*' && allowed.includes(origin)) return origin;
        return undefined;
      }
    } catch {
      // Malformed referrer — no safe target.
      return undefined;
    }
    // Standalone visit (no referrer): only ever talk to ourselves.
    return window.location.origin;
  }

  private postResize(): void {
    if (!this.isBrowser) return;
    const height = this.host.nativeElement.offsetHeight;
    if (height > 0) {
      this.postToParent({ type: 'feasly:resize', height });
    }
  }
}
