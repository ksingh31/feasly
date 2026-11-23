import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { Store } from '@ngxs/store';
import type { AdminCommunityNarrativeEntry } from '@feasly/contracts';
import {
  type DataTableColumn,
  DataTableComponent,
  ErrorStateComponent,
  KitCountPipe,
  KitDateTimePipe,
  KitRelativePipe,
  KpiGridComponent,
  KpiTileComponent,
  PageHeaderComponent,
  SkeletonComponent,
  UiButtonComponent,
  UiCellDirective,
  UiRowActionsDirective,
} from '../../shared/ui';
import {
  LoadCommunityNarratives,
  RegenerateCommunityNarratives,
} from './community-narratives.actions';
import { CommunityNarrativesState } from './community-narratives.state';

/**
 * Community narratives (#915) — `/admin/ops/community-narratives`.
 *
 * Every community's monthly narrative at a glance: period, status chip
 * (Up to date / Stale / Failed / Never generated), last generated date,
 * attempts and the sanitized last error, from
 * `GET /api/v1/admin/community-narratives`. "Regenerate now" runs for one
 * row or for every community (`POST …/regenerate`) and the returned counts
 * show above the table; communities a run-for-all leaves over (`deferred`)
 * finish on the next daily run.
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-admin-community-narratives',
  standalone: true,
  imports: [
    PageHeaderComponent,
    UiButtonComponent,
    KpiGridComponent,
    KpiTileComponent,
    DataTableComponent,
    UiCellDirective,
    UiRowActionsDirective,
    ErrorStateComponent,
    SkeletonComponent,
    KitCountPipe,
    KitDateTimePipe,
    KitRelativePipe,
  ],
  templateUrl: './admin-community-narratives.component.html',
  styleUrl: './admin-community-narratives.component.scss',
})
export class AdminCommunityNarrativesComponent implements OnInit {
  private readonly store = inject(Store);

  protected readonly communities = this.store.selectSignal(CommunityNarrativesState.communities);
  protected readonly loadStatus = this.store.selectSignal(CommunityNarrativesState.loadStatus);
  protected readonly error = this.store.selectSignal(CommunityNarrativesState.error);
  protected readonly regenerating = this.store.selectSignal(CommunityNarrativesState.regenerating);
  protected readonly lastResult = this.store.selectSignal(CommunityNarrativesState.lastResult);
  protected readonly regenerateError = this.store.selectSignal(
    CommunityNarrativesState.regenerateError,
  );

  /** Reference instant for relative dates; advances on refresh. */
  protected readonly now = signal(new Date());

  protected readonly rows = computed<readonly AdminCommunityNarrativeEntry[]>(
    () => this.communities() ?? [],
  );

  /** Rows per status for the KPI tiles. */
  protected readonly counts = computed(() => {
    const counts = { succeeded: 0, stale: 0, failed: 0, missing: 0 };
    for (const row of this.rows()) counts[row.status] += 1;
    return counts;
  });

  /** Name of the community the last single-row regenerate ran for. */
  protected readonly lastResultName = computed(() => {
    const slug = this.lastResult()?.slug;
    if (!slug) return null;
    return this.rows().find((r) => r.community_slug === slug)?.community_name ?? slug;
  });

  protected readonly busy = computed(() => this.regenerating() !== null);
  protected readonly regeneratingAll = computed(() => this.regenerating()?.scope === 'all');

  protected readonly columns: readonly DataTableColumn<AdminCommunityNarrativeEntry>[] = [
    { key: 'community_name', header: 'Community', cardRole: 'title' },
    {
      key: 'status',
      header: 'Status',
      kind: 'status',
      statusDomain: 'communityNarrative',
      cardRole: 'chip',
    },
    { key: 'period', header: 'Period', value: (r) => r.period ?? '—', cardRole: 'meta' },
    { key: 'generated_at', header: 'Last generated', cardRole: 'meta' },
    { key: 'attempts', header: 'Attempts', kind: 'count', cardRole: 'hidden' },
    { key: 'last_error', header: 'Last error', cardRole: 'meta' },
  ];
  protected readonly rowId = (row: AdminCommunityNarrativeEntry): string => row.community_slug;

  ngOnInit(): void {
    this.refresh();
  }

  protected refresh(): void {
    this.now.set(new Date());
    this.store.dispatch(new LoadCommunityNarratives());
  }

  protected regenerateAll(): void {
    this.store.dispatch(new RegenerateCommunityNarratives());
  }

  protected regenerateOne(row: AdminCommunityNarrativeEntry): void {
    this.store.dispatch(new RegenerateCommunityNarratives(row.community_slug));
  }

  protected isRegenerating(row: AdminCommunityNarrativeEntry): boolean {
    const target = this.regenerating();
    return target?.scope === 'one' && target.slug === row.community_slug;
  }
}
