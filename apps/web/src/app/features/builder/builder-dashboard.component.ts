import {
  Component,
  DestroyRef,
  Injector,
  OnInit,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, type Params, Router, RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import type {
  BuilderLeadListItem,
  BuilderLeadNeedsYouItem,
  BuilderLeadStatus,
} from '@feasly/contracts';
import {
  DataTableComponent,
  type DataTableColumn,
  EmptyStateComponent,
  FilterBarComponent,
  KitDateTimePipe,
  KitRelativePipe,
  PageHeaderComponent,
  SkeletonComponent,
  StatusChipComponent,
  UiCellDirective,
  UiDrawerService,
  type UiDrawerRef,
  UiRowActionsDirective,
  injectTableQuery,
} from '@app/shared/ui';
import { ConfigService } from '../../core/config/config.service';
import { initials } from '../../shared/utils/initials';
import { BUILDER_COPY } from './builder-copy';
import { DueInvoiceBannersComponent } from './due-invoice-banners.component';
import { BuilderState } from './builder.state';
import { LoadBuilderLeads, LoadBuilderNeedsYou } from './builder.actions';
import { LoadBillingCard } from './builder-billing.actions';
import { LoadActionableInvoices } from './builder-invoices.actions';
import { BuilderInvoicesState } from './builder-invoices.state';
import { PruneBannerState } from './due-invoice-banners.actions';
import {
  BuilderLeadDrawerComponent,
  type BuilderLeadDrawerData,
} from './builder-lead-drawer.component';
import {
  DEFAULT_LEAD_SORT,
  LEAD_SORT_KEYS,
  PIPELINE_STATUSES,
  fill,
  heatChipLabel,
  heatLevel,
  mailtoHref,
  pageOf,
  parseStatusFilter,
  projectTypeLabel,
  selectPipelineLeads,
  telHref,
} from './builder-leads-view';

/** "Needs you" group keys, in display order (builder review §Leads home). */
type NeedsYouGroupKey = 'uncontacted' | 'stale' | 'wonWithoutContract';
const NEEDS_YOU_GROUPS: readonly NeedsYouGroupKey[] = ['uncontacted', 'stale', 'wonWithoutContract'];

interface NeedsYouGroupView {
  readonly key: NeedsYouGroupKey;
  readonly title: string;
  readonly ageLabel: string;
  readonly items: readonly BuilderLeadNeedsYouItem[];
}

/** Query param holding the open lead (portal-ui-kit §3: `?open=<id>`). */
const OPEN_PARAM = 'open';
/** Query param for the status segment (shared with injectTableQuery). */
const STATUS_PARAM = 'status';

/**
 * Builder Leads home (#527, builder review "Leads home concept").
 *
 * - **Needs you** (always first): server-grouped cards — new and not yet
 *   contacted, no status change in N+ days, won without a recorded
 *   contract — each with tap-to-call/email and, for won leads, Record
 *   contract (admins; members see who records it).
 * - **Pipeline**: a segmented status filter with counts, a search box and
 *   the kit DataTable (card list on phones). Stale rows are highlighted
 *   and labelled. Status, search, sort and page live in the URL.
 * - A row (or a Needs-you name) opens the lead drawer (#528, `?open=<id>`).
 *
 * Every grouping, count and staleness decision is server-side; the page
 * only filters/sorts the loaded list for display.
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-builder-dashboard',
  standalone: true,
  imports: [
    RouterLink,
    DueInvoiceBannersComponent,
    PageHeaderComponent,
    DataTableComponent,
    UiCellDirective,
    UiRowActionsDirective,
    FilterBarComponent,
    EmptyStateComponent,
    SkeletonComponent,
    StatusChipComponent,
    KitRelativePipe,
    KitDateTimePipe,
  ],
  templateUrl: './builder-dashboard.component.html',
  styleUrls: ['./builder-dashboard.component.scss'],
})
export class BuilderDashboardComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly drawers = inject(UiDrawerService);

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(BUILDER_COPY);
  protected readonly home = this.copy.leadsHome;
  protected readonly debounceMs = inject(ConfigService).get('timings').filterDebounceMs;

  protected readonly leads = this.store.selectSignal(BuilderState.leads);
  protected readonly summary = this.store.selectSignal(BuilderState.summary);
  protected readonly leadsStatus = this.store.selectSignal(BuilderState.leadsStatus);
  protected readonly loadFailed = this.store.selectSignal(BuilderState.loadFailed);
  protected readonly needsYou = this.store.selectSignal(BuilderState.needsYou);
  protected readonly needsYouStatus = this.store.selectSignal(BuilderState.needsYouStatus);
  protected readonly isAdmin = this.store.selectSignal(BuilderState.isBuilderAdmin);

  /** Status segment, search, sort and page — all in the URL (AC3). */
  protected readonly list = injectTableQuery({
    filterKeys: [STATUS_PARAM],
    sortKeys: LEAD_SORT_KEYS,
    defaultSort: DEFAULT_LEAD_SORT,
  });

  private readonly queryParams = toSignal(this.route.queryParams, {
    initialValue: this.route.snapshot.queryParams as Params,
  });

  protected readonly statusFilter = computed(() =>
    parseStatusFilter(this.list.filters()[STATUS_PARAM]),
  );

  protected readonly segments = computed(() => {
    const counts = this.summary();
    return [
      { value: null, label: this.home.allStatusesLabel, count: counts.total },
      ...PIPELINE_STATUSES.map((status) => ({
        value: status,
        label: this.copy.statusLabels[status],
        count: counts[status],
      })),
    ];
  });

  /** Loaded pipeline after the status segment, search and sort. */
  protected readonly filteredLeads = computed(() =>
    selectPipelineLeads(this.leads(), {
      status: this.statusFilter(),
      search: this.list.search(),
      sort: this.list.sort(),
    }),
  );

  protected readonly pageRows = computed(() =>
    pageOf(this.filteredLeads(), this.list.page(), this.home.pageSize),
  );

  protected readonly filtered = computed(
    () => this.statusFilter() !== null || this.list.search() !== '',
  );

  /** Stale lead ids, straight from the server's needs-you feed. */
  private readonly staleIds = computed(
    () => new Set((this.needsYou()?.stale ?? []).map((lead) => lead.id)),
  );

  protected readonly isStale = (lead: BuilderLeadListItem): boolean =>
    this.staleIds().has(lead.id);

  protected readonly rowId = (lead: BuilderLeadListItem): string => lead.id;

  protected readonly columns: readonly DataTableColumn<BuilderLeadListItem>[] = [
    {
      key: 'lead',
      header: this.home.columns.lead,
      sortable: true,
      cardRole: 'title',
      value: (lead) => lead.name,
    },
    {
      key: 'status',
      header: this.home.columns.status,
      kind: 'status',
      statusDomain: 'lead',
      cardRole: 'chip',
    },
    {
      key: 'details',
      header: this.home.columns.details,
      cardRole: 'meta',
      value: (lead) => this.detailsLine(lead),
    },
    {
      key: 'activity',
      header: this.home.columns.activity,
      sortable: true,
      cardRole: 'meta',
      value: (lead) => lead.statusUpdatedAt,
    },
  ];

  protected readonly needsYouGroups = computed<readonly NeedsYouGroupView[]>(() => {
    const feed = this.needsYou();
    if (!feed) return [];
    return NEEDS_YOU_GROUPS.map((key) => ({
      key,
      title: fill(this.home.groups[key], { days: feed.staleAfterDays }),
      ageLabel: this.home.ageLabels[key],
      items: feed[key],
    })).filter((group) => group.items.length > 0);
  });

  protected readonly needsYouCount = computed(() =>
    this.needsYouGroups().reduce((sum, group) => sum + group.items.length, 0),
  );

  protected readonly openId = computed(() => {
    const raw = this.queryParams()[OPEN_PARAM];
    return typeof raw === 'string' && raw ? raw : null;
  });

  /** Lead ids already flagged as inconsistent (warn once per lead, not per render). */
  private readonly flaggedInconsistentLeads = new Set<string>();

  private drawerRef: UiDrawerRef<unknown, BuilderLeadDrawerComponent> | null = null;

  constructor() {
    // Data-inconsistency flag (#474): an invoice exists only once a won
    // lead's contract is recorded. A non-won lead carrying one is a backend
    // data problem — surface it in the console, never lock the UI on it.
    effect(() => {
      for (const lead of this.leads()) {
        if (lead.hasInvoice && lead.status !== 'won' && !this.flaggedInconsistentLeads.has(lead.id)) {
          this.flaggedInconsistentLeads.add(lead.id);
          console.warn('[feasly] builder: non-won lead has invoice', {
            leadId: lead.id,
            status: lead.status,
          });
        }
      }
    });
    // `?open=<id>` drives the lead drawer for deep links and Back/Forward:
    // open it once the lead is loaded and drop a param naming a lead this
    // builder doesn't have. The drawer service closes it when the param
    // goes away.
    effect(() => {
      const id = this.openId();
      const ready = this.leadsStatus() === 'ready';
      untracked(() => this.syncDrawer(id, ready));
    });
  }

  ngOnInit(): void {
    this.store
      .dispatch([new LoadBuilderLeads(), new LoadBuilderNeedsYou()])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
    // Due-invoice banners: EVERY actionable invoice for the banner set
    // (dedicated status-filtered query — never the paginated first page),
    // plus the card summary for the banner's payment-method line. Stale
    // banner dismissals are pruned once the actionable set lands.
    this.store
      .dispatch([new LoadActionableInvoices(), new LoadBillingCard()])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          const actionableIds = this.store
            .selectSnapshot(BuilderInvoicesState.actionableInvoices)
            .map((invoice) => invoice.id);
          this.store.dispatch(new PruneBannerState(actionableIds));
        },
      });
  }

  protected retryLoad(): void {
    this.store
      .dispatch([new LoadBuilderLeads(), new LoadBuilderNeedsYou()])
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected setStatus(status: BuilderLeadStatus | null): void {
    this.list.setFilter(STATUS_PARAM, status);
  }

  /** Opens the lead drawer; the drawer service pushes `?open=<id>` (Back closes it). */
  protected openLead(id: string): void {
    if (!this.leads().some((lead) => lead.id === id)) return;
    this.openDrawer(id);
  }

  private clearOpen(): void {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { [OPEN_PARAM]: null },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }

  private syncDrawer(id: string | null, ready: boolean): void {
    if (id === null || !ready) return;
    if (!this.leads().some((lead) => lead.id === id)) {
      this.clearOpen();
      return;
    }
    this.openDrawer(id);
  }

  private openDrawer(id: string): void {
    const t = this.copy.leadDrawer;
    const ref = this.drawers.open<BuilderLeadDrawerComponent, unknown, BuilderLeadDrawerData>(
      BuilderLeadDrawerComponent,
      {
        data: { leadId: id },
        size: 'lg',
        urlId: id,
        injector: this.injector,
        discardConfirm: {
          title: t.discardTitle,
          body: t.discardBody,
          verb: t.discardVerb,
          cancelLabel: t.discardCancel,
        },
      },
    );
    if (ref === this.drawerRef) return;
    this.drawerRef = ref;
    ref.closed.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(() => {
      if (this.drawerRef === ref) this.drawerRef = null;
    });
  }

  protected heat(score: number): string {
    return heatLevel(score, this.home.heat);
  }

  protected heatLabel(score: number): string {
    return heatChipLabel(score, this.home.heat);
  }

  protected detailsLine(lead: BuilderLeadListItem): string {
    return [
      `${this.home.timelinePrefix} ${lead.timeline}`,
      projectTypeLabel(lead.projectType, this.home.projectTypes),
      lead.addressKey,
    ].join(' · ');
  }

  protected initials(name: string): string {
    return initials(name);
  }

  protected tel(phone: string): string {
    return telHref(phone);
  }

  protected mailto(email: string): string {
    return mailtoHref(email);
  }

  protected callAria(name: string): string {
    return fill(this.home.callAria, { name });
  }

  protected emailAria(name: string): string {
    return fill(this.home.emailAria, { name });
  }

  protected statusLabel(status: BuilderLeadStatus): string {
    return this.copy.statusLabels[status];
  }
}
