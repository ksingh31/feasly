import { Component, DestroyRef, computed, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import type { BuilderLeadListItem, BuilderLeadStatus } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { BuilderState } from './builder.state';
import { LoadBuilderLeads, UpdateBuilderLeadStatus } from './builder.actions';

/**
 * Builder pipeline dashboard (embed/09): the builder's lead list.
 *
 * Shows the tenant-scoped leads (name, email, phone, timeline, lead score,
 * status, dates) with per-lead status actions (contacted / quoted / won /
 * lost) and a pipeline summary (counts per status, incl. won/lost).
 * Cross-tenant probing is enforced server-side (403); a 403 here renders
 * the honest "not yours" copy instead of failing silently.
 *
 * The backend writes the authoritative timestamps; confirmed transitions
 * apply locally so the list and summary stay in sync without a reload.
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-builder-dashboard',
  standalone: true,
  templateUrl: './builder-dashboard.component.html',
  styleUrls: ['./builder-dashboard.component.scss'],
})
export class BuilderDashboardComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(ConfigService).get('copy').builder;

  protected readonly leads = this.store.selectSignal(BuilderState.leads);
  protected readonly summary = this.store.selectSignal(BuilderState.summary);
  protected readonly leadsStatus = this.store.selectSignal(BuilderState.leadsStatus);
  protected readonly loadFailed = this.store.selectSignal(BuilderState.loadFailed);
  protected readonly updatingLeadId = this.store.selectSignal(BuilderState.updatingLeadId);
  protected readonly updateError = this.store.selectSignal(BuilderState.updateError);

  /** Statuses a builder can set (matches the backend enum). */
  protected readonly statuses: readonly BuilderLeadStatus[] = [
    'contacted',
    'quoted',
    'won',
    'lost',
  ];

  /** Ephemeral view filter (signal, not persisted — resets on reload). */
  protected readonly statusFilter = signal<BuilderLeadStatus | 'all'>('all');

  /** Leads after applying the status filter. */
  protected readonly filteredLeads = computed<readonly BuilderLeadListItem[]>(() => {
    const filter = this.statusFilter();
    const leads = this.leads();
    return filter === 'all' ? leads : leads.filter((lead) => lead.status === filter);
  });

  ngOnInit(): void {
    this.store
      .dispatch(new LoadBuilderLeads())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected retryLoad(): void {
    this.store
      .dispatch(new LoadBuilderLeads())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  protected setStatus(leadId: string, status: BuilderLeadStatus): void {
    if (this.updatingLeadId() !== null) return;
    this.store
      .dispatch(new UpdateBuilderLeadStatus(leadId, status))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** True while this lead's status update is in flight. */
  protected isUpdating(leadId: string): boolean {
    return this.updatingLeadId() === leadId;
  }

  /** True when the list is loaded but the filter matches nothing. */
  protected get filterEmpty(): boolean {
    return (
      this.leadsStatus() === 'ready' &&
      this.leads().length > 0 &&
      this.filteredLeads().length === 0
    );
  }

  /** Human label for a pipeline status (config-owned). */
  protected statusLabel(status: BuilderLeadStatus): string {
    return this.copy.statusLabels[status];
  }

  /** Filter-select change handler (template-bound). */
  protected onFilterChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.statusFilter.set(value as BuilderLeadStatus | 'all');
  }
}
