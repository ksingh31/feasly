import { Dialog, type DialogRef } from '@angular/cdk/dialog';
import { Overlay } from '@angular/cdk/overlay';
import {
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { BrandMarkComponent } from '../../shared/components/brand-mark';
import { ViewAsBannerComponent } from '../../shared/view-as-banner';
import { ExitViewAs, LogoutAdmin } from './admin-auth.actions';
import { AdminAuthState } from './admin-auth.state';
import { LoadAdminDisputes } from './admin-disputes.actions';
import { AdminDisputesState } from './admin-disputes.state';
import { AdminEntraAuthService } from './admin-entra-auth.service';
import {
  ADMIN_NAV,
  type AdminNavBadge,
  type AdminNavItemId,
  findAdminNavItem,
} from './admin-nav';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';
import { AdminCommandPaletteComponent } from './admin-command-palette.component';

/** One rendered sidebar link. */
interface ShellNavItem {
  id: AdminNavItemId;
  label: string;
  path: string;
  exact: boolean;
  badge: number;
}

/** One rendered sidebar group. */
interface ShellNavGroup {
  id: string;
  label: string;
  items: ShellNavItem[];
}

/**
 * Admin shell (#503, docs/design/portal-ui-kit.md §4): the frame for the
 * guarded `/admin` route group.
 *
 * - Left sidebar grouped Pipeline · Partners · Money · System, with queue
 *   badges. ≥1024px it is a 240px column that collapses to a 64px rail;
 *   below 1024px it is an off-canvas panel (scrim, Esc, focus in/out).
 * - 56px top bar: breadcrumbs, ⌘K search, env chip, user menu. ⌘K / Ctrl+K
 *   (and `/` on pages without a FilterBar) open the command palette (#538).
 * - Errors stay inside the shell: GlobalErrorHandler routes uncaught admin
 *   failures to the `/admin/error` child route (rendered in this outlet).
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-admin-shell',
  standalone: true,
  imports: [BrandMarkComponent, RouterLink, RouterLinkActive, RouterOutlet, ViewAsBannerComponent],
  templateUrl: './admin-shell.component.html',
  styleUrls: ['./admin-shell.component.scss'],
  host: {
    '(document:keydown)': 'onDocumentKeydown($event)',
    '(document:click)': 'onDocumentClick($event)',
  },
})
export class AdminShellComponent {
  private readonly store = inject(Store);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly entraAuth = inject(AdminEntraAuthService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly dialog = inject(Dialog);
  private readonly overlay = inject(Overlay);

  protected readonly copy = this.config.get('copy').admin.shell;
  protected readonly environmentLabel = this.config.get('admin').environmentLabel;

  /** Off-canvas sidebar open (below 1024px). */
  protected readonly menuOpen = signal(false);
  /** Sidebar collapsed to the 64px rail (1024px and up). */
  protected readonly collapsed = signal(false);
  /** User menu disclosure. */
  protected readonly userMenuOpen = signal(false);
  /** ⌘K command palette open. */
  protected readonly paletteOpen = signal(false);
  private paletteRef: DialogRef<void, AdminCommandPaletteComponent> | null = null;

  private readonly menuToggle = viewChild<ElementRef<HTMLButtonElement>>('menuToggle');
  private readonly sidebar = viewChild<ElementRef<HTMLElement>>('sidebar');
  private readonly userMenuButton = viewChild<ElementRef<HTMLButtonElement>>('userMenuButton');

  protected readonly email = this.store.selectSignal(AdminAuthState.email);
  protected readonly name = this.store.selectSignal(AdminAuthState.name);
  /** Single-letter avatar for the user-menu trigger. */
  protected readonly initial = computed(
    () => (this.name() || this.email() || this.copy.userMenuLabel).trim().charAt(0).toUpperCase(),
  );

  /** View-as banner model (null when the session is not viewing-as). */
  protected readonly viewAsBanner = this.store.selectSignal(AdminAuthState.viewAsBanner);

  private readonly canReadBilling = adminCan(this.store, ADMIN_PERMISSIONS.billingRead);
  private readonly permissions = this.store.selectSignal(AdminAuthState.permissions);
  private readonly disputes = this.store.selectSignal(AdminDisputesState.disputes);

  private readonly badgeCounts = computed<Record<AdminNavBadge, number>>(() => ({
    disputes: this.disputes()?.length ?? 0,
  }));

  /** The sidebar as rendered: labels from config, gated items removed. */
  protected readonly groups = computed<ShellNavGroup[]>(() => {
    const granted = this.permissions() ?? [];
    const counts = this.badgeCounts();
    return ADMIN_NAV.map((group) => ({
      id: group.id,
      label: this.copy.groups[group.id],
      items: group.items
        .filter((item) => !item.permission || granted.includes(item.permission))
        .map((item) => ({
          id: item.id,
          label: this.copy.nav[item.id],
          path: item.path,
          exact: item.exact ?? false,
          badge: item.badge ? counts[item.badge] : 0,
        })),
    })).filter((group) => group.items.length > 0);
  });

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map((event) => event.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** Top-bar breadcrumbs: group › section. Empty outside the nav (e.g. error). */
  protected readonly breadcrumbs = computed(() => {
    const match = findAdminNavItem(this.url());
    if (!match) return null;
    return {
      group: this.copy.groups[match.group.id],
      label: this.copy.nav[match.item.id],
      path: match.item.path,
    };
  });

  constructor() {
    // Admin console titles (admin/07) are driven centrally from the
    // seo-routes table on every completed navigation: section components
    // must NOT set their own titles. NavigationEnd fires after the
    // incoming section's component is created, so this always wins.
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((event) => {
        this.menuOpen.set(false);
        this.userMenuOpen.set(false);
        this.seo.setForRoute(event.urlAfterRedirects);
      });

    // Queue badges: load the open-disputes queue once permissions resolve.
    // Failures are swallowed here — the badge just stays hidden and the
    // disputes page reloads (and reports) on its own.
    let badgesRequested = false;
    effect(() => {
      if (badgesRequested || !this.canReadBilling()) return;
      badgesRequested = true;
      this.store
        .dispatch(new LoadAdminDisputes())
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe({ error: () => undefined });
    });
  }

  // ── Sidebar ──────────────────────────────────────────────────────────

  protected toggleMenu(): void {
    if (this.menuOpen()) {
      this.closeMenu(true);
      return;
    }
    this.menuOpen.set(true);
    // Move focus into the panel once it is rendered visible (a hidden
    // panel can't take focus), so keyboard users land in the nav.
    afterNextRender(() => this.navLinks()[0]?.focus(), { injector: this.injector });
  }

  protected closeMenu(returnFocus = false): void {
    if (!this.menuOpen()) return;
    this.menuOpen.set(false);
    if (returnFocus) this.menuToggle()?.nativeElement.focus();
  }

  protected toggleCollapsed(): void {
    this.collapsed.update((value) => !value);
  }

  /** Arrow keys / Home / End move between sidebar links (Tab still works). */
  protected onNavKeydown(event: KeyboardEvent): void {
    const links = this.navLinks();
    if (links.length === 0) return;
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
        next = index < 0 ? 0 : (index + 1) % links.length;
        break;
      case 'ArrowUp':
        next = index <= 0 ? links.length - 1 : index - 1;
        break;
      case 'Home':
        next = 0;
        break;
      case 'End':
        next = links.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    links[next].focus();
  }

  private navLinks(): HTMLAnchorElement[] {
    const root = this.sidebar()?.nativeElement;
    return root ? Array.from(root.querySelectorAll<HTMLAnchorElement>('a.admin-nav__link')) : [];
  }

  // ── Top bar ──────────────────────────────────────────────────────────

  /** Open the ⌘K command palette (CDK dialog: focus trap, Esc, focus return). */
  protected openPalette(): void {
    if (this.paletteRef) return;
    this.userMenuOpen.set(false);
    this.closeMenu();
    const ref = this.dialog.open<void, unknown, AdminCommandPaletteComponent>(
      AdminCommandPaletteComponent,
      {
        role: 'dialog',
        ariaModal: true,
        ariaLabelledBy: 'admin-palette-title',
        autoFocus: 'first-tabbable',
        restoreFocus: true,
        panelClass: 'admin-palette-pane',
        backdropClass: 'admin-palette-scrim',
        positionStrategy: this.overlay.position().global().centerHorizontally().top('12vh'),
        injector: this.injector,
      },
    );
    this.paletteRef = ref;
    this.paletteOpen.set(true);
    ref.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      this.paletteRef = null;
      this.paletteOpen.set(false);
    });
    this.destroyRef.onDestroy(() => ref.close());
  }

  protected closePalette(): void {
    this.paletteRef?.close();
  }

  protected toggleUserMenu(): void {
    this.userMenuOpen.update((open) => !open);
  }

  protected onDocumentKeydown(event: KeyboardEvent): void {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (this.paletteRef) this.closePalette();
      else this.openPalette();
      return;
    }
    // `/` is page search (portal-ui-kit §5): a page with a FilterBar
    // focuses its own search box; everywhere else it opens the palette.
    if (
      event.key === '/' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !this.paletteRef &&
      !isTextEntry(event.target) &&
      !this.host.nativeElement.querySelector('#admin-main ui-filter-bar')
    ) {
      event.preventDefault();
      this.openPalette();
      return;
    }
    // The palette dialog handles its own Esc.
    if (event.key !== 'Escape' || this.paletteRef) return;
    if (this.userMenuOpen()) {
      this.userMenuOpen.set(false);
      this.userMenuButton()?.nativeElement.focus();
    } else if (this.menuOpen()) {
      this.closeMenu(true);
    }
  }

  /** Clicking outside the user menu closes it. */
  protected onDocumentClick(event: MouseEvent): void {
    if (!this.userMenuOpen()) return;
    const menu = this.host.nativeElement.querySelector('.admin-topbar__user');
    if (menu && !menu.contains(event.target as Node)) this.userMenuOpen.set(false);
  }

  protected exitViewAs(): void {
    this.store
      .dispatch(new ExitViewAs())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected signOut(): void {
    this.userMenuOpen.set(false);
    this.store
      .dispatch(new LogoutAdmin())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          // When the Entra end-session redirect fired, the browser is
          // already leaving for the IdP (which redirects back to
          // /admin/login) — skip the in-app navigation.
          if (!this.entraAuth.consumeSignOutRedirect()) {
            void this.router.navigate(['/admin/login']);
          }
        },
        error: () => void this.router.navigate(['/admin/login']),
      });
  }
}

function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
}
