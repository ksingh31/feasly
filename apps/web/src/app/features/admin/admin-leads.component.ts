import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import { filter } from 'rxjs';
import type { AdminLeadListItem, AdminLeadStatus } from '@feasly/contracts';
import { ConfigService } from '@app/core/config/config.service';
import {
  type DataTableColumn,
  DataTableComponent,
  type FilterBarSelect,
  FilterBarComponent,
  KitCountPipe,
  PageHeaderComponent,
  UiButtonComponent,
  UiCellDirective,
  UiConfirmService,
  UiDrawerService,
  UiRowActionsDirective,
  enumLabel,
  injectDrawerParam,
  injectTableQuery,
  statusPresentation,
} from '@app/shared/ui';
import { AdminLeadDrawerComponent, type AdminLeadDrawerData } from './admin-lead-drawer.component';
import {
  ApproveQuarantinedLead,
  DiscardQuarantinedLead,
  DismissExportError,
  DismissQuarantineActionError,
  ExportAdminLeadsCsv,
  LoadAdminLeads,
  LoadMoreAdminLeads,
  SetAdminLeadsTab,
  ToggleAdminLeadsSandbox,
  type AdminLeadsTab,
} from './admin-leads.actions';
import { AdminLeadsState } from './admin-leads.state';
import { LoadBuilders } from './admin-builders.actions';
import { AdminBuildersState } from './admin-builders.state';
import { ADMIN_PERMISSIONS, adminCan } from './admin-permissions';
import {
  ADMIN_LEADS_VIEWS,
  ASSIGNED_PARAM,
  type AdminLeadsView,
  LEADS_FILTER_KEYS,
  PIPELINE_STATUSES,
  STATUS_PARAM,
  UNASSIGNED,
  VIEW_PARAM,
  fill,
  leadsFilters,
  parseStatus,
  parseView,
} from './admin-leads-view';

/** Saved-view id → copy key. */
const VIEW_COPY_KEY: Readonly<Record<AdminLeadsView, 'all' | 'new' | 'unassigned' | 'quotingStale'>> = {
  all: 'all',
  new: 'new',
  unassigned: 'unassigned',
  'quoting-stale': 'quotingStale',
};

/**
 * Admin Leads (#539, admin review S5/S6) — the team's daily lead view.
 *
 * - Saved views (All · New · Unassigned · Quoting > N days), pipeline
 *   totals as filter tiles, FilterBar (search, status, builder) — all in
 *   the URL (`view`, `status`, `assigned`, `q`), so views are shareable.
 * - Kit DataTable (48px rows; card list below 768px) with labelled columns.
 *   The list API is cursor-paged, so "Load more" appends below the table.
 * - A row opens the lead drawer (`?open=<id>`; deep links and Back work).
 * - Tabs (all / quarantine), sandbox toggle and CSV export carry over.
 *
 * All state lives in AdminLeadsState; this component maps URL → actions.
 */
@Component({
  selector: 'app-admin-leads',
  standalone: true,
  imports: [
    PageHeaderComponent,
    FilterBarComponent,
    DataTableComponent,
    UiCellDirective,
    UiRowActionsDirective,
    UiButtonComponent,
    KitCountPipe,
  ],
  templateUrl: './admin-leads.component.html',
  styleUrls: ['./admin-leads.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AdminLeadsComponent {
  private readonly store = inject(Store);
  private readonly config = inject(ConfigService);
  private readonly drawers = inject(UiDrawerService);
  private readonly confirms = inject(UiConfirmService);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly copy = this.config.get('copy').admin.leads;
  protected readonly debounceMs = this.config.get('timings').filterDebounceMs;
  private readonly staleDays = this.config.get('admin').leads.quotingStaleDays;

  protected readonly leads = this.store.selectSignal(AdminLeadsState.leads);
  protected readonly totalCount = this.store.selectSignal(AdminLeadsState.totalCount);
  protected readonly statusCounts = this.store.selectSignal(AdminLeadsState.statusCounts);
  protected readonly hasMore = this.store.selectSignal(AdminLeadsState.hasMore);
  protected readonly tab = this.store.selectSignal(AdminLeadsState.tab);
  protected readonly includeSandbox = this.store.selectSignal(AdminLeadsState.includeSandbox);
  protected readonly listStatus = this.store.selectSignal(AdminLeadsState.listStatus);
  protected readonly listError = this.store.selectSignal(AdminLeadsState.listError);
  protected readonly exporting = this.store.selectSignal(AdminLeadsState.exporting);
  protected readonly exportError = this.store.selectSignal(AdminLeadsState.exportError);
  protected readonly quarantineActionId = this.store.selectSignal(AdminLeadsState.quarantineActionId);
  protected readonly quarantineActionKind = this.store.selectSignal(AdminLeadsState.quarantineActionKind);
  protected readonly quarantineActionError = this.store.selectSignal(AdminLeadsState.quarantineActionError);
  private readonly builders = this.store.selectSignal(AdminBuildersState.builders);

  /** Quarantine approve/discard are `leads:manage` writes. */
  protected readonly canManageLeads = adminCan(this.store, ADMIN_PERMISSIONS.leadsManage);

  /** Search, saved view and filters — all in the URL. */
  protected readonly list = injectTableQuery({ filterKeys: LEADS_FILTER_KEYS });
  /** `?open=<id>` — the lead whose drawer is open. */
  protected readonly openId = injectDrawerParam();

  protected readonly view = computed(() => parseView(this.list.filters()[VIEW_PARAM]));
  protected readonly statusFilter = computed(() => parseStatus(this.list.filters()[STATUS_PARAM]));

  protected readonly views = computed(() =>
    ADMIN_LEADS_VIEWS.map((id) => ({
      id,
      label: fill(this.copy.views[VIEW_COPY_KEY[id]], { days: this.staleDays }),
    })),
  );
  protected readonly viewHint = computed(() =>
    fill(this.copy.viewHints[VIEW_COPY_KEY[this.view()]], { days: this.staleDays }),
  );

  protected readonly pipelineStatuses = PIPELINE_STATUSES;

  protected readonly selects = computed<readonly FilterBarSelect[]>(() => [
    {
      key: STATUS_PARAM,
      label: this.copy.statusFilter,
      placeholder: this.copy.anyStatus,
      options: PIPELINE_STATUSES.map((s) => ({ value: s, label: this.statusLabel(s) })),
    },
    {
      key: ASSIGNED_PARAM,
      label: this.copy.assignedFilter,
      placeholder: this.copy.anyAssignment,
      options: [
        { value: UNASSIGNED, label: this.copy.unassigned },
        ...this.builders().map((b) => ({ value: b.id, label: b.displayName })),
      ],
    },
  ]);

  /** Anything narrowing the list (drives the empty-state variant). */
  protected readonly filtered = computed(
    () => this.list.search() !== '' || Object.keys(this.list.filters()).length > 0,
  );

  protected readonly countLabel = computed(() =>
    fill(this.totalCount() === 1 ? this.copy.countOne : this.copy.countMany, { count: this.totalCount() }),
  );

  protected readonly rowId = (lead: AdminLeadListItem): string => lead.id;

  protected readonly columns: readonly DataTableColumn<AdminLeadListItem>[] = [
    { key: 'lead', header: this.copy.columns.lead, cardRole: 'title', value: (l) => l.name },
    { key: 'address', header: this.copy.columns.address, cardRole: 'meta', value: (l) => l.addressKey },
    {
      key: 'status',
      header: this.copy.columns.status,
      kind: 'status',
      statusDomain: 'lead',
      cardRole: 'chip',
    },
    { key: 'tenant', header: this.copy.columns.tenant, kind: 'id', cardRole: 'hidden', value: (l) => l.tenantKey },
    { key: 'source', header: this.copy.columns.source, cardRole: 'meta', value: (l) => enumLabel(l.source) },
    { key: 'score', header: this.copy.columns.score, kind: 'count', cardRole: 'hidden', value: (l) => l.leadScore },
    { key: 'timeline', header: this.copy.columns.timeline, cardRole: 'hidden', value: (l) => l.timeline },
    { key: 'consent', header: this.copy.columns.consent, cardRole: 'hidden', value: (l) => l.contactConsent },
    { key: 'created', header: this.copy.columns.created, kind: 'date', cardRole: 'meta', value: (l) => l.createdAt },
  ];

  /**
   * Stable key for "what the list should show" — the drawer's `?open=`
   * param also changes the URL, and must not trigger a reload.
   */
  private readonly listKey = computed(() =>
    JSON.stringify({ q: this.list.search(), f: this.list.filters() }),
  );

  constructor() {
    this.store.dispatch(new LoadBuilders());

    effect(() => {
      this.listKey();
      untracked(() => this.load());
    });

    // Deep links and Back/Forward drive the drawer off the URL.
    effect(() => {
      const id = this.openId();
      if (id) untracked(() => this.openDrawer(id));
    });
  }

  private load(): void {
    const filters = leadsFilters(this.list.search(), this.list.filters(), new Date(), this.staleDays);
    this.store.dispatch(new LoadAdminLeads(filters, this.tab()));
  }

  protected selectView(view: AdminLeadsView): void {
    this.list.setFilter(VIEW_PARAM, view === 'all' ? null : view);
  }

  /** Totals tile: filter to that status (click again to clear). */
  protected filterByStatus(status: AdminLeadStatus): void {
    this.list.setFilter(STATUS_PARAM, this.statusFilter() === status ? null : status);
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

  protected setTab(tab: AdminLeadsTab): void {
    this.store.dispatch(new SetAdminLeadsTab(tab));
  }

  protected toggleSandbox(include: boolean): void {
    this.store.dispatch(new ToggleAdminLeadsSandbox(include));
  }

  protected loadMore(): void {
    this.store.dispatch(new LoadMoreAdminLeads());
  }

  protected retry(): void {
    this.load();
  }

  protected exportCsv(): void {
    this.store.dispatch(new ExportAdminLeadsCsv());
  }

  protected dismissExportError(): void {
    this.store.dispatch(new DismissExportError());
  }

  protected approveLead(lead: AdminLeadListItem): void {
    this.store.dispatch(new ApproveQuarantinedLead(lead.id));
  }

  /** Discard hides the lead from every list — confirm first. */
  protected discardLead(lead: AdminLeadListItem): void {
    this.confirms
      .confirm({
        title: fill(this.copy.discardConfirmTitle, { name: lead.name }),
        body: this.copy.discardConfirmBody,
        verb: this.copy.discard,
        tone: 'danger',
      })
      .pipe(filter(Boolean), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.store.dispatch(new DiscardQuarantinedLead(lead.id)));
  }

  protected dismissQuarantineError(): void {
    this.store.dispatch(new DismissQuarantineActionError());
  }

  protected quarantineBusy(id: string): boolean {
    return this.quarantineActionId() === id;
  }

  protected statusLabel(status: AdminLeadStatus): string {
    return statusPresentation('lead', status).label;
  }
}
