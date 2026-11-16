import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  computed,
  effect,
  inject,
  linkedSignal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import { filter, switchMap } from 'rxjs';
import type { AdminLeadListItem } from '@feasly/contracts';
import { ConfigService } from '@app/core/config/config.service';
import {
  type DataTableColumn,
  DataTableComponent,
  FilterBarComponent,
  PageHeaderComponent,
  UiButtonComponent,
  UiCellDirective,
  UiConfirmService,
  UiDrawerService,
  UiRowActionsDirective,
  UiToastService,
  enumLabel,
  injectDrawerParam,
  injectTableQuery,
} from '@app/shared/ui';
import { AdminLeadDrawerComponent, type AdminLeadDrawerData } from './admin-lead-drawer.component';
import { fill } from './admin-leads-view';
import {
  DecideQuarantined,
  DismissQuarantineError,
  LoadMoreQuarantine,
  LoadQuarantine,
  type QuarantineDecision,
} from './admin-quarantine.actions';
import { AdminQuarantineState } from './admin-quarantine.state';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';
import { injectAdminCopy } from './admin-copy';

/**
 * Admin Quarantine (#540, admin review page map) — `/admin/quarantine`.
 *
 * Honeypot-flagged leads, promoted from a Leads tab to their own section.
 * Same kit DataTable as Leads, with row actions [Approve] [Discard…] and,
 * for `leads:manage` sessions, checkbox selection with a bulk bar
 * (Approve selected… / Discard selected…). Every bulk decision and every
 * discard goes through ConfirmDialog; a single-row approve is reversible
 * from the Leads page, so it applies straight away.
 *
 * Search lives in the URL (`q`); a row opens the lead drawer (`?open=`).
 * All data state lives in AdminQuarantineState.
 */
@Component({
  selector: 'app-admin-quarantine',
  standalone: true,
  imports: [
    PageHeaderComponent,
    FilterBarComponent,
    DataTableComponent,
    UiCellDirective,
    UiRowActionsDirective,
    UiButtonComponent,
  ],
  templateUrl: './admin-quarantine.component.html',
  styleUrls: ['./admin-quarantine.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminQuarantineComponent {
  private readonly store = inject(Store);
  private readonly config = inject(ConfigService);
  private readonly drawers = inject(UiDrawerService);
  private readonly confirms = inject(UiConfirmService);
  private readonly toasts = inject(UiToastService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly copy = injectAdminCopy().quarantine;
  protected readonly debounceMs = this.config.get('timings').filterDebounceMs;

  protected readonly leads = this.store.selectSignal(AdminQuarantineState.leads);
  protected readonly totalCount = this.store.selectSignal(AdminQuarantineState.totalCount);
  protected readonly hasMore = this.store.selectSignal(AdminQuarantineState.hasMore);
  protected readonly listStatus = this.store.selectSignal(AdminQuarantineState.listStatus);
  protected readonly listError = this.store.selectSignal(AdminQuarantineState.listError);
  protected readonly busyIds = this.store.selectSignal(AdminQuarantineState.busyIds);
  protected readonly busyDecision = this.store.selectSignal(AdminQuarantineState.busyDecision);
  protected readonly actionError = this.store.selectSignal(AdminQuarantineState.actionError);

  /** Approve/discard are `leads:manage` writes (display gate; backend re-checks). */
  protected readonly canManage = adminCan(this.store, ADMIN_PERMISSIONS.leadsManage);

  protected readonly list = injectTableQuery();
  protected readonly openId = injectDrawerParam();

  /**
   * Selected row ids. Re-derived whenever the rows change, so leads that
   * left the queue drop out and failed ones stay selected for a retry.
   */
  protected readonly selection = linkedSignal<readonly AdminLeadListItem[], readonly string[]>({
    source: this.leads,
    computation: (rows, previous) => {
      const present = new Set(rows.map((row) => row.id));
      return (previous?.value ?? []).filter((id) => present.has(id));
    },
  });

  protected readonly busy = computed(() => this.busyIds().length > 0);
  protected readonly filtered = computed(() => this.list.search() !== '');
  protected readonly countLabel = computed(() =>
    fill(this.totalCount() === 1 ? this.copy.countOne : this.copy.countMany, { count: this.totalCount() }),
  );

  protected readonly rowId = (lead: AdminLeadListItem): string => lead.id;

  protected readonly columns: readonly DataTableColumn<AdminLeadListItem>[] = [
    { key: 'lead', header: this.copy.columns.lead, cardRole: 'title', value: (l) => l.name },
    { key: 'address', header: this.copy.columns.address, cardRole: 'meta', value: (l) => l.addressKey },
    { key: 'source', header: this.copy.columns.source, cardRole: 'meta', value: (l) => enumLabel(l.source) },
    { key: 'tenant', header: this.copy.columns.tenant, kind: 'id', cardRole: 'hidden', value: (l) => l.tenantKey },
    { key: 'created', header: this.copy.columns.created, kind: 'date', cardRole: 'meta', value: (l) => l.createdAt },
  ];

  constructor() {
    effect(() => {
      const search = this.list.search();
      untracked(() => this.store.dispatch(new LoadQuarantine(search)));
    });

    effect(() => {
      const id = this.openId();
      if (id) untracked(() => this.openDrawer(id));
    });
  }

  protected openLead(lead: AdminLeadListItem): void {
    this.openDrawer(lead.id);
  }

  private openDrawer(id: string): void {
    this.drawers.open<AdminLeadDrawerComponent, unknown, AdminLeadDrawerData>(AdminLeadDrawerComponent, {
      data: { id },
      urlId: id,
      size: 'md',
      injector: this.injector,
    });
  }

  protected isBusy(id: string, decision?: QuarantineDecision): boolean {
    return this.busyIds().includes(id) && (decision === undefined || this.busyDecision() === decision);
  }

  /** Row approve: the lead returns to Leads, where it can be worked or discarded. */
  protected approveOne(lead: AdminLeadListItem): void {
    this.decide([lead.id], 'approve');
  }

  /** Row discard hides the lead from every list — confirm first. */
  protected discardOne(lead: AdminLeadListItem): void {
    this.confirmThen(
      {
        title: fill(this.copy.discardConfirmTitle, { name: lead.name }),
        body: this.copy.discardConfirmBody,
        verb: this.copy.discard,
        tone: 'danger',
      },
      [lead.id],
      'discard',
    );
  }

  protected approveSelected(): void {
    const ids = this.selection();
    if (ids.length === 0) return;
    this.confirmThen(
      {
        title: fill(this.copy.approveConfirmTitleMany, { count: ids.length }),
        body: this.copy.approveConfirmBody,
        verb: this.copy.approve,
        tone: 'default',
      },
      ids,
      'approve',
    );
  }

  protected discardSelected(): void {
    const ids = this.selection();
    if (ids.length === 0) return;
    this.confirmThen(
      {
        title: fill(this.copy.discardConfirmTitleMany, { count: ids.length }),
        body: this.copy.discardConfirmBody,
        verb: this.copy.discard,
        tone: 'danger',
      },
      ids,
      'discard',
    );
  }

  protected clearSelection(): void {
    this.selection.set([]);
  }

  private confirmThen(
    options: { title: string; body: string; verb: string; tone: 'danger' | 'default' },
    ids: readonly string[],
    decision: QuarantineDecision,
  ): void {
    this.confirms
      .confirm({ ...options, verb: options.verb.replace(/…$/, '') })
      .pipe(
        filter(Boolean),
        switchMap(() => this.store.dispatch(new DecideQuarantined(ids, decision))),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.announce());
  }

  private decide(ids: readonly string[], decision: QuarantineDecision): void {
    this.store
      .dispatch(new DecideQuarantined(ids, decision))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.announce());
  }

  /** Toast the leads that were decided; failures stay inline (with the rows still selected). */
  private announce(): void {
    const result = this.store.selectSnapshot(AdminQuarantineState.lastResult);
    const done = result?.succeeded.length ?? 0;
    if (!result || done === 0) return;
    const template =
      result.decision === 'approve'
        ? done === 1
          ? this.copy.approvedOne
          : this.copy.approvedMany
        : done === 1
          ? this.copy.discardedOne
          : this.copy.discardedMany;
    this.toasts.show({ message: fill(template, { count: done }) });
  }

  protected dismissError(): void {
    this.store.dispatch(new DismissQuarantineError());
  }

  protected loadMore(): void {
    this.store.dispatch(new LoadMoreQuarantine());
  }

  protected retry(): void {
    this.store.dispatch(new LoadQuarantine(this.list.search()));
  }
}
