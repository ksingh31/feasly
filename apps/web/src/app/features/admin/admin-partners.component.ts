import { Component, DestroyRef, inject, Injector, OnInit, computed } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import type { Observable } from 'rxjs';
import type { AdminBuilderPartner } from '@feasly/contracts';
import {
  type DataTableColumn,
  type UiRowAction,
  DataTableComponent,
  ErrorStateComponent,
  PageHeaderComponent,
  SkeletonComponent,
  UiButtonComponent,
  UiCellDirective,
  UiDrawerService,
  UiRowActionsComponent,
  UiRowActionsDirective,
  UiToastService,
} from '@app/shared/ui';
import {
  ClearAdminPartnerSaveError,
  LoadAdminPartners,
  MoveAdminPartner,
  SetAdminPartnerActive,
} from './admin-partners.actions';
import { AdminPartnersState } from './admin-partners.state';
import { injectAdminCopy } from './admin-copy';
import { fill } from './admin-leads-view';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';
import {
  AdminPartnerDrawerComponent,
  type AdminPartnerDrawerData,
  type AdminPartnerDrawerResult,
} from './admin-partner-drawer.component';

/** Row-menu action ids. */
type PartnerRowAction = 'edit' | 'activate' | 'deactivate';

/** Fallback toast text when a write fails without a backend message. */
const WRITE_FAILED = 'Could not save the change. Try again.';

/**
 * Builder partners (#919) — `/admin/partners`.
 *
 * The builder companies Feasly discloses as receiving leads from its own
 * site (#888). One kit DataTable in display order: add and edit in a
 * drawer (name, logo URL, website, short description), activate or
 * deactivate from the row menu, and move rows up or down to reorder.
 * Every change goes through the #896 admin API and confirms with a toast;
 * deactivating offers Undo.
 *
 * Writes need `builders:manage` (display-only gate; the backend re-checks).
 * All state lives in AdminPartnersState. noindex via the robots guard.
 */
@Component({
  selector: 'app-admin-partners',
  standalone: true,
  imports: [
    PageHeaderComponent,
    UiButtonComponent,
    DataTableComponent,
    UiCellDirective,
    UiRowActionsDirective,
    UiRowActionsComponent,
    ErrorStateComponent,
    SkeletonComponent,
  ],
  templateUrl: './admin-partners.component.html',
  styleUrl: './admin-partners.component.scss',
})
export class AdminPartnersComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly drawers = inject(UiDrawerService);
  private readonly toasts = inject(UiToastService);
  private readonly copy = injectAdminCopy().partners;

  protected readonly partners = this.store.selectSignal(AdminPartnersState.partners);
  protected readonly loadStatus = this.store.selectSignal(AdminPartnersState.loadStatus);
  protected readonly loadError = this.store.selectSignal(AdminPartnersState.loadError);
  protected readonly busyId = this.store.selectSignal(AdminPartnersState.busyId);
  protected readonly canManage = adminCan(this.store, ADMIN_PERMISSIONS.buildersManage);

  protected readonly loaded = computed(() => this.loadStatus() === 'ready' || this.partners().length > 0);
  protected readonly activeCount = computed(() => this.partners().filter((p) => p.active).length);

  protected readonly columns: readonly DataTableColumn<AdminBuilderPartner>[] = [
    { key: 'position', header: 'Order', value: (p) => this.position(p), cardRole: 'hidden' },
    { key: 'name', header: 'Partner', cardRole: 'title' },
    {
      key: 'active',
      header: 'Status',
      kind: 'status',
      statusDomain: 'builder',
      value: (p) => (p.active ? 'active' : 'inactive'),
      cardRole: 'chip',
    },
    { key: 'websiteUrl', header: 'Website', cardRole: 'meta' },
    { key: 'description', header: 'Description', value: (p) => p.description ?? '—', cardRole: 'meta' },
  ];
  protected readonly rowId = (p: AdminBuilderPartner): string => p.id;

  /** The ⋮ menu items for each row, keyed by partner id. */
  protected readonly rowActions = computed(() => {
    const busy = this.busyId() !== null;
    const map = new Map<string, UiRowAction[]>();
    for (const p of this.partners()) {
      map.set(p.id, [
        { id: 'edit', label: 'Edit' },
        p.active
          ? { id: 'deactivate', label: 'Deactivate', tone: 'danger', disabled: busy }
          : { id: 'activate', label: 'Activate', disabled: busy },
      ]);
    }
    return map;
  });

  ngOnInit(): void {
    this.refresh();
  }

  protected refresh(): void {
    this.store.dispatch(new LoadAdminPartners());
  }

  /** 1-based place in the display order. */
  protected position(partner: AdminBuilderPartner): number {
    return this.partners().findIndex((p) => p.id === partner.id) + 1;
  }

  protected isFirst(partner: AdminBuilderPartner): boolean {
    return this.partners()[0]?.id === partner.id;
  }

  protected isLast(partner: AdminBuilderPartner): boolean {
    return this.partners().at(-1)?.id === partner.id;
  }

  // ------------------------------------------------------------ drawer

  protected openAdd(): void {
    this.openDrawer(null);
  }

  protected openEdit(partner: AdminBuilderPartner): void {
    if (this.canManage()) this.openDrawer(partner.id);
  }

  private openDrawer(partnerId: string | null): void {
    this.store.dispatch(new ClearAdminPartnerSaveError());
    const ref = this.drawers.open<
      AdminPartnerDrawerComponent,
      AdminPartnerDrawerResult,
      AdminPartnerDrawerData
    >(AdminPartnerDrawerComponent, {
      data: { partnerId },
      size: 'md',
      injector: this.injector,
    });
    ref.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((saved) => {
      if (!saved) return;
      this.toasts.show({
        message: partnerId === null ? `${saved.name} added.` : `${saved.name} saved.`,
      });
    });
  }

  // ---------------------------------------------------------- row menu

  protected onRowAction(partner: AdminBuilderPartner, action: string): void {
    switch (action as PartnerRowAction) {
      case 'edit':
        this.openEdit(partner);
        break;
      case 'activate':
        this.setActive(partner, true);
        break;
      case 'deactivate':
        this.setActive(partner, false);
        break;
    }
  }

  private setActive(partner: AdminBuilderPartner, active: boolean, undoable = true): void {
    this.run(this.store.dispatch(new SetAdminPartnerActive(partner.id, active)), () => {
      this.toasts.show({
        message: fill(active ? this.copy.shownToast : this.copy.hiddenToast, { name: partner.name }),
        undo: undoable ? () => this.setActive(partner, !active, false) : undefined,
      });
    });
  }

  protected move(partner: AdminBuilderPartner, direction: -1 | 1): void {
    this.run(this.store.dispatch(new MoveAdminPartner(partner.id, direction)), () => {
      this.toasts.show({
        message: fill(direction < 0 ? this.copy.movedUpToast : this.copy.movedDownToast, {
          name: partner.name,
        }),
      });
    });
  }

  /** Dispatch a row write; toast success via `done`, or the failure. */
  private run(result: Observable<void>, done: () => void): void {
    result.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: done,
      error: (err: { message?: string } | null) =>
        this.toasts.show({ message: err?.message ?? WRITE_FAILED, tone: 'danger' }),
    });
  }
}
