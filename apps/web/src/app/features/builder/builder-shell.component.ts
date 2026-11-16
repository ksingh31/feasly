import {
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  NavigationEnd,
  Router,
  RouterLink,
  RouterLinkActive,
  RouterOutlet,
} from '@angular/router';
import { filter } from 'rxjs';
import { Store } from '@ngxs/store';
import { SeoService } from '../../core/seo/seo.service';
import { BUILDER_COPY, provideBuilderCopy } from './builder-copy';
import { BrandMarkComponent } from '../../shared/components/brand-mark';
import { ViewAsBannerComponent } from '../../shared/view-as-banner';
import { BuilderPausedComponent } from './builder-paused.component';
import {
  DismissBuilderAccountPaused,
  ExitBuilderViewAs,
  LoadBuilderMemberships,
  LogoutBuilder,
} from './builder.actions';
import { BuilderState } from './builder.state';
import { BuilderBillingState } from './builder-billing.state';
import { injectCardModal } from './builder-card-modal.component';
import { LoadActionableInvoices } from './builder-invoices.actions';
import { BuilderInvoicesState } from './builder-invoices.state';

/** Builder routes that belong to the Money section (nav + sub-nav). */
const MONEY_PATHS = [
  '/builder/money',
  '/builder/invoices',
  '/builder/billing',
] as const;

/** A router URL without its query string or fragment. */
function urlPath(url: string): string {
  return url.split(/[?#]/)[0];
}

/** Whether a router URL sits inside the Money section. */
export function isMoneyUrl(url: string): boolean {
  const path = url.split(/[?#]/)[0];
  return MONEY_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Builder shell v2 (#502, docs/design/portal-ui-kit.md §4): layout for the
 * guarded `/builder` route group.
 *
 * - Slim top bar: brand · **Leads · Money · Team** (Money and Team are
 *   builder_admin only — members never see them) · account menu.
 * - Account menu trigger always shows the current org name; the menu holds
 *   the org switcher, the session email, and sign out.
 * - Below 768px the section nav moves to a fixed bottom tab bar.
 * - "Record contract" is not a nav item: it is recorded from a won lead's
 *   drawer (#529); the old page redirects there.
 * - A failed-card danger strip persists across every shell page (admins —
 *   billing is admin-only backend-side) until the failed invoice resolves.
 *
 * - #861: when the API refuses a call with 403 BUILDER_PAUSED, the page
 *   is swapped for the "Your account is paused" screen until the builder
 *   navigates to another page (e.g. invoices, which stay viewable).
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-builder-shell',
  standalone: true,
  imports: [
    BrandMarkComponent,
    BuilderPausedComponent,
    RouterLink,
    RouterLinkActive,
    RouterOutlet,
    ViewAsBannerComponent,
  ],
  providers: [provideBuilderCopy()],
  templateUrl: './builder-shell.component.html',
  styleUrls: ['./builder-shell.component.scss'],
  host: {
    '(document:keydown.escape)': 'onEscape()',
    '(document:click)': 'onDocumentClick($event)',
  },
})
export class BuilderShellComponent {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(BUILDER_COPY);

  protected readonly session = this.store.selectSignal(BuilderState.session);
  protected readonly activeOrgName = this.store.selectSignal(
    BuilderState.activeBuilderName,
  );
  protected readonly isBuilderAdmin = this.store.selectSignal(
    BuilderState.isBuilderAdmin,
  );

  /**
   * Builder-side view-as banner model (2026-09-30, Karan): null when the
   * session is not viewing-as. Rendered by the shared view-as banner.
   */
  protected readonly viewAsBanner = this.store.selectSignal(
    BuilderState.viewAsBanner,
  );

  /** #861: the org's account is paused (403 BUILDER_PAUSED seen). */
  protected readonly accountPaused = this.store.selectSignal(BuilderState.accountPaused);

  private readonly actionableInvoices = this.store.selectSignal(
    BuilderInvoicesState.actionableInvoices,
  );
  private readonly actionableStatus = this.store.selectSignal(
    BuilderInvoicesState.actionableStatus,
  );

  /** Failed-card strip CTA: the shared card modal (#534), on any page. */
  private readonly openCardModal = injectCardModal();

  protected openCard(): void {
    this.openCardModal(this.store.selectSnapshot(BuilderBillingState.card) ?? undefined);
  }

  /**
   * Failed-card danger strip: shown on every shell page while any of the
   * org's invoices has a failed charge. Admin-only (billing endpoints are
   * builder:billing). Data-driven — gone once the invoice leaves `failed`.
   */
  protected readonly hasFailedCharge = computed(
    () =>
      this.isBuilderAdmin() &&
      this.actionableStatus() === 'ready' &&
      this.actionableInvoices().some((inv) => inv.status === 'failed'),
  );

  /** Current router URL (updated on every NavigationEnd). */
  private readonly url = signal(this.router.url);

  /** Money section is active (top nav, tabs, sub-nav). */
  protected readonly inMoney = computed(() => isMoneyUrl(this.url()));

  /** Account menu open state. */
  protected readonly accountOpen = signal(false);

  private readonly accountRoot =
    viewChild<ElementRef<HTMLElement>>('accountRoot');
  private readonly accountTrigger =
    viewChild<ElementRef<HTMLButtonElement>>('accountTrigger');

  /** Account trigger accessible name (includes the current org). */
  protected readonly accountLabel = computed(() =>
    this.copy.shellAccountMenuLabel.replace(
      '{org}',
      this.activeOrgName() ?? this.session()?.email ?? '',
    ),
  );

  constructor() {
    this.seo.setPage({
      title: 'Builder portal — Feasly',
      description: 'Feasly builder lead pipeline.',
      path: '/builder',
    });
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        const next = (event as NavigationEnd).urlAfterRedirects;
        // #861: leaving the page leaves the paused screen. Query-only
        // changes (a drawer's ?open= closing) keep it up.
        if (urlPath(next) !== urlPath(this.url())) {
          this.store.dispatch(new DismissBuilderAccountPaused());
        }
        this.url.set(next);
        this.accountOpen.set(false);
      });
    // Current org always visible (AC1): `/me` has no org name, so after a
    // reload resolve it from the memberships list.
    if (!this.activeOrgName() && this.session()?.builderId) {
      this.store
        .dispatch(new LoadBuilderMemberships())
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe();
    }
    // Failed-card strip data: admin-only (builder:billing backend gate).
    if (this.isBuilderAdmin()) {
      this.store
        .dispatch(new LoadActionableInvoices())
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe();
    }
  }

  protected toggleAccount(): void {
    this.accountOpen.update((open) => !open);
  }

  /** Close the account menu; optionally return focus to its trigger. */
  protected closeAccount(returnFocus = false): void {
    if (!this.accountOpen()) return;
    this.accountOpen.set(false);
    if (returnFocus) {
      this.accountTrigger()?.nativeElement.focus();
    }
  }

  protected onEscape(): void {
    this.closeAccount(true);
  }

  protected onDocumentClick(event: Event): void {
    const root = this.accountRoot()?.nativeElement;
    if (root && event.target instanceof Node && !root.contains(event.target)) {
      this.closeAccount();
    }
  }

  protected exitViewAs(): void {
    this.store
      .dispatch(new ExitBuilderViewAs())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected signOut(): void {
    this.accountOpen.set(false);
    this.store
      .dispatch(new LogoutBuilder())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => {
        void this.router.navigate(['/builder/login']);
      });
  }
}
