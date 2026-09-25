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
import type {
  EmbedAuthOkMessage,
  EmbedPublicConfig,
  EmbedThemeMessage,
  PropertyRecord,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { AddressAutocompleteComponent } from '../../shared/components/address-autocomplete';
import {
  EmbedConfigFailed,
  ExchangeRelayCode,
  LoadEmbedConfig,
  RelaySessionEstablished,
} from './embed.actions';
import { EmbedState } from './embed.state';
import { EmbedBridgeService } from './embed-bridge.service';
import { GoToStep, SelectProperty } from '../wizard/wizard.actions';

/** Parent → shell: live theme update (see contracts EmbedThemeMessage). */
interface ThemeInbound {
  readonly type: 'feasly:theme';
  readonly primaryColor?: unknown;
}

/** Parent → shell: one-time relay code from `?feasly_rt=` (embed/06). */
interface RelayInbound {
  readonly type: 'feasly:relay';
  readonly code?: unknown;
}

/** Shell → parent: lifecycle announcements and the lead handoff. */
interface ShellOutbound {
  readonly type:
    | 'feasly:ready'
    | 'feasly:resize'
    | 'feasly:estimate-start'
    | 'feasly:relay-resend';
  readonly height?: number;
  readonly addressKey?: string;
  readonly address?: string;
}

const THEME_MESSAGE = 'feasly:theme';
const RELAY_MESSAGE = 'feasly:relay';
/** Strict 6-digit hex — anything else is ignored, never applied. */
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
/** 64 hex chars = the 32-byte relay code. Anything else is ignored. */
const RELAY_CODE = /^[0-9a-fA-F]{64}$/;

/**
 * White-label embed shell (EMB-01): the minimal widget a builder iframes on
 * their site. Resolves the tenant via `?key=` (or `:tenantKey`), applies the
 * builder's branding, and hosts the address → estimate entry point.
 *
 * Chrome-free by construction: no site nav, no marketing footer — just the
 * builder's brand, the address input, and the CTA. Invalid/missing keys show
 * the story-pinned fallback card, never a blank iframe.
 *
 * postMessage discipline: outbound messages go through EmbedBridgeService
 * (debounced resize, exactly-once lead events, never broadcast '*'); inbound
 * messages are accepted only from origins in the tenant's `allowed_origins`
 * (a '*' entry never authorizes). The shell announces `feasly:ready` /
 * `feasly:resize` and hands the picked address to the parent as
 * `feasly:estimate-start`.
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
  private readonly bridge = inject(EmbedBridgeService);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly copy = this.config.get('copy').embed;
  protected readonly status = this.store.selectSignal(EmbedState.status);
  protected readonly builderConfig = this.store.selectSignal(EmbedState.config);
  protected readonly relayStatus = this.store.selectSignal(EmbedState.relayStatus);
  /** Accepted once per boot — a second relay is ignored (AC1 single-use). */
  private relayAccepted = false;

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
        this.bridge.notifyReady();
        this.bridge.requestResize();
      }
    });

    // React to a completed relay exchange: tell the parent the auth
    // succeeded (AC6 — only estimateId + leadScore, never PII).
    effect(() => {
      const relay = this.relayStatus();
      if (relay === 'active') {
        const estimateId = this.store.selectSnapshot(EmbedState.sessionEstimateId) ?? '';
        const leadScore = this.store.selectSnapshot(EmbedState.sessionLeadScore) ?? 0;
        const msg: EmbedAuthOkMessage = { type: 'FEASLY_AUTH_OK', estimateId, leadScore };
        this.postToParent(msg as unknown as ShellOutbound);
      }
    });

    if (this.isBrowser) {
      // Inbound: only the tenant's allowlisted origins may theme the shell.
      // Spoofed origins are dropped and logged (embed/08 AC3).
      fromEvent<MessageEvent>(window, 'message')
        .pipe(
          takeUntilDestroyed(this.destroyRef),
          filter((ev) => this.isAllowedThemeMessage(ev)),
        )
        .subscribe((ev) => this.onThemeMessage(ev.data as EmbedThemeMessage));

      // Inbound: the one-time relay code (embed/06). Accepted only from an
      // allowlisted origin, only once per boot, and only in the 64-hex
      // shape — anything else is ignored, never exchanged.
      fromEvent<MessageEvent>(window, 'message')
        .pipe(
          takeUntilDestroyed(this.destroyRef),
          filter((ev) => this.isAllowedRelayMessage(ev)),
        )
        .subscribe((ev) => this.onRelayMessage(ev.data as RelayInbound));

      // Keep the parent iframe sized to the content; disconnect with the component.
      // The bridge debounces bursts so rapid changes collapse into one post.
      const ro = new ResizeObserver(() => this.bridge.requestResize());
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
    this.bridge.notifyEstimateStart(picked.addressKey, picked.address);
    // Direct visits continue into the estimate flow. Inside a builder iframe
    // the parent owns what happens next (the snippet sandbox forbids
    // top-navigation anyway), so the shell stays put.
    if (this.isBrowser && window.self === window.top) {
      void this.router.navigate(['/estimate/scope']);
    }
  }

  /**
   * "Email me a fresh link" (AC3 re-issue affordance). The parent owns the
   * re-issue flow — the shell asks for it via postMessage and the snippet
   * (or builder page) triggers a fresh magic-link email. The shell itself
   * never sees the homeowner's email address (no PII in the iframe).
   */
  protected onResendLink(): void {
    this.postToParent({ type: 'feasly:relay-resend' } as unknown as ShellOutbound);
  }

  /**
   * Origin-gated: only `feasly:theme` from an allowlisted origin passes.
   * Spoofed origins are dropped and logged (embed/08 AC3).
   */
  private isAllowedThemeMessage(ev: MessageEvent): boolean {
    const data = ev.data as { type?: unknown } | null;
    if (data === null || data.type !== THEME_MESSAGE) return false;
    if (!this.bridge.isAllowedInbound(ev.origin)) {
      // eslint-disable-next-line no-console
      console.warn('[feasly] embed: dropped msg from bad origin', ev.origin);
      return false;
    }
    return true;
  }

  private onThemeMessage(msg: EmbedThemeMessage): void {
    if (typeof msg.primaryColor === 'string') {
      this.applyAccent(msg.primaryColor);
    }
  }

  /**
   * Origin-gated relay (AC7): the `feasly:relay` code is accepted only from
   * an allowlisted origin, only once per boot, and only when it matches the
   * 64-hex shape. Spoofed origins, malformed codes, and re-posts are
   * silently ignored — the shell never exchanges a code it shouldn't.
   */
  private isAllowedRelayMessage(ev: MessageEvent): boolean {
    if (this.relayAccepted) return false;
    const data = ev.data as RelayInbound | null;
    if (data === null || data.type !== RELAY_MESSAGE) return false;
    if (typeof data.code !== 'string' || !RELAY_CODE.test(data.code)) return false;
    const allowed = this.builderConfig()?.allowed_origins ?? [];
    return ev.origin !== '' && allowed.includes(ev.origin);
  }

  private onRelayMessage(msg: RelayInbound): void {
    if (typeof msg.code !== 'string' || !RELAY_CODE.test(msg.code)) return;
    this.relayAccepted = true;
    this.store.dispatch(new ExchangeRelayCode(msg.code));
  }

  /** Applies a validated hex accent as `--embed-accent`; invalid values are ignored. */
  private applyAccent(color: string): void {
    if (this.isBrowser && HEX_COLOR.test(color)) {
      this.host.nativeElement.style.setProperty('--embed-accent', color);
    }
  }
}
