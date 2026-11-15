import {
  Component,
  DestroyRef,
  Injector,
  OnInit,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import type { Builder } from '@feasly/contracts';
import {
  DataTableComponent,
  type DataTableColumn,
  PageHeaderComponent,
  StatusChipComponent,
  UI_DRAWER_URL_PARAM,
  UiButtonComponent,
  UiCellDirective,
  UiDrawerService,
  UiRowActionsDirective,
  injectDrawerParam,
} from '@app/shared/ui';
import { initials } from '../../shared/utils/initials';
import { LoadBuilders } from './admin-builders.actions';
import { AdminBuildersState } from './admin-builders.state';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';
import { AdminBuilderDrawerComponent, type AdminBuilderDrawerData } from './admin-builder-drawer.component';
import { methodShortLabel, planShortLabel, rateLabel } from './admin-builders-view';

/**
 * Admin Builders (#541, review S7) — `/admin/builders`.
 *
 * A narrow kit DataTable (Builder name + slug · Status · Plan · Rate ·
 * Payment method · Email) that becomes a card list on phones. A row (or
 * "Edit") opens the builder drawer (`?open=<id>`, so Back closes it and
 * deep links work); "Add builder" opens the same drawer blank. Read-only
 * staff see the table without the write affordances.
 */
@Component({
  selector: 'app-admin-builders',
  standalone: true,
  imports: [
    PageHeaderComponent,
    DataTableComponent,
    UiCellDirective,
    UiRowActionsDirective,
    UiButtonComponent,
    StatusChipComponent,
  ],
  templateUrl: './admin-builders.component.html',
  styleUrl: './admin-builders.component.scss',
})
export class AdminBuildersComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly drawers = inject(UiDrawerService);

  protected readonly builders = this.store.selectSignal(AdminBuildersState.builders);
  protected readonly listStatus = this.store.selectSignal(AdminBuildersState.listStatus);
  protected readonly listError = this.store.selectSignal(AdminBuildersState.listError);

  /** `builders:manage` writes — viewers get the table only. */
  protected readonly canManageBuilders = adminCan(this.store, ADMIN_PERMISSIONS.buildersManage);

  /** `?open=<id>` — the builder whose drawer is open. */
  protected readonly openId = injectDrawerParam();

  /** The first LoadBuilders on this page has settled (rows are current). */
  private readonly loaded = signal(false);

  /** Logo images that failed to load — those avatars fall back to initials. */
  protected readonly logoFailed = signal<ReadonlySet<string>>(new Set());

  protected readonly rowId = (b: Builder): string => b.id;

  protected readonly columns: readonly DataTableColumn<Builder>[] = [
    { key: 'builder', header: 'Builder', value: (b) => b.businessName, cardRole: 'title' },
    { key: 'status', header: 'Status', kind: 'status', statusDomain: 'builder', cardRole: 'chip' },
    { key: 'plan', header: 'Plan', value: (b) => planShortLabel(b.plan), cardRole: 'meta' },
    { key: 'rate', header: 'Rate', align: 'end', value: (b) => rateLabel(b.commissionRatePercent), cardRole: 'meta' },
    { key: 'method', header: 'Payment method', value: (b) => methodShortLabel(b), cardRole: 'meta' },
    { key: 'email', header: 'Email', value: (b) => b.email, cardRole: 'hidden' },
  ];

  constructor() {
    // Deep links and Back/Forward drive the drawer off the URL once the
    // list is loaded; a param naming an unknown builder is dropped.
    effect(() => {
      const id = this.openId();
      // Wait for the rows and for the /me probe (viewers never get the drawer).
      const ready = this.loaded() && this.canManageBuilders();
      untracked(() => this.syncDrawer(id, ready));
    });
  }

  ngOnInit(): void {
    this.store
      .dispatch(new LoadBuilders())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.loaded.set(true),
        error: () => this.loaded.set(true),
      });
  }

  protected retry(): void {
    this.store.dispatch(new LoadBuilders());
  }

  protected startCreate(): void {
    this.openDrawer(null);
  }

  protected openBuilder(builder: Builder): void {
    if (!this.canManageBuilders()) return;
    this.openDrawer(builder.id);
  }

  protected initials(name: string): string {
    return initials(name);
  }

  /** A broken logo URL falls back to the initials avatar, same as no logo. */
  protected onLogoError(builderId: string): void {
    this.logoFailed.update((failed) => new Set(failed).add(builderId));
  }

  private syncDrawer(id: string | null, ready: boolean): void {
    if (id === null || !ready || this.drawers.openDrawer?.urlId === id) return;
    if (!this.builders().some((b) => b.id === id)) {
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { [UI_DRAWER_URL_PARAM]: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
      return;
    }
    this.openDrawer(id);
  }

  private openDrawer(builderId: string | null): void {
    this.drawers.open<AdminBuilderDrawerComponent, boolean, AdminBuilderDrawerData>(
      AdminBuilderDrawerComponent,
      {
        data: { builderId },
        size: 'lg',
        ...(builderId ? { urlId: builderId } : {}),
        injector: this.injector,
      },
    );
  }
}
