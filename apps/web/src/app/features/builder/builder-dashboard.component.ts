import { Component, DestroyRef, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import type { BuilderLeadListItem, BuilderLeadStatus } from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { BuilderState } from './builder.state';
import { LoadBuilderLeads, UpdateBuilderLeadStatus } from './builder.actions';

/**
 * Builder pipeline dashboard (embed/09): the builder's lead list, in the
 * admin lead-explorer design language (cream/charcoal/brass, totals row,
 * lead cards with avatar initials) with `builder-` class prefixes.
 *
 * Pipeline summary totals are clickable and drive the ephemeral status
 * filter (mirroring admin-leads' filterByStatus toggle). Each lead card
 * carries a status-transition select wired to UpdateBuilderLeadStatus; a
 * won lead shows a hint linking to the report-contract flow.
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
  imports: [RouterLink],
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

  /** Pipeline statuses in the order a builder works them (drives the totals row). */
  protected readonly statuses: readonly BuilderLeadStatus[] = [
    'new',
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

  /** Pipeline totals row: clicking a status filters the list to it; 'all' clears. */
  protected filterByStatus(status: BuilderLeadStatus | 'all'): void {
    const current = this.statusFilter();
    this.statusFilter.set(current === status ? 'all' : status);
  }

  /** Clears the status filter (filter-empty state). */
  protected clearFilter(): void {
    this.statusFilter.set('all');
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

  /** Per-lead status select label, interpolated with the lead name (config-owned). */
  protected statusControlLabel(name: string): string {
    return this.copy.leadsStatusControlLabel.replace('{name}', name);
  }

  /** Filter-select change handler (template-bound). */
  protected onFilterChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.statusFilter.set(value as BuilderLeadStatus | 'all');
  }

  /** Per-lead status-select change handler (template-bound). */
  protected onLeadStatusChange(
    select: HTMLSelectElement,
    leadId: string,
  ): void {
    const value = select.value as BuilderLeadStatus;
    if (this.updatingLeadId() !== null) {
      // Another update is in flight: roll the select back to the
      // authoritative store value instead of queueing a second dispatch.
      this.resyncStatusSelect(select, leadId);
      return;
    }
    this.store
      .dispatch(new UpdateBuilderLeadStatus(leadId, value))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.resyncStatusSelect(select, leadId));
  }

  /**
   * Re-syncs a lead's status select with the authoritative store value.
   *
   * `[value]` on a native select is write-once-per-expression-change: after
   * the user picks a status, if the PATCH fails (or the store value never
   * changes), Angular never rewrites the DOM select while the badge always
   * reflects the store — the dropdown would keep showing the failed pick
   * ("New") next to a "Won" badge. Rewriting `select.value` explicitly
   * after every update attempt keeps the two in sync.
   */
  private resyncStatusSelect(
    select: HTMLSelectElement,
    leadId: string,
  ): void {
    const lead = this.leads().find((l) => l.id === leadId);
    if (lead && select.value !== lead.status) {
      select.value = lead.status;
    }
  }

  /** Avatar initials from the lead name (first letters of first/last word). */
  protected initials(name: string): string {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) {
      return '•';
    }
    const first = parts[0][0] ?? '';
    const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? '') : '';
    return (first + last).toUpperCase();
  }

  protected formatDate(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-CA');
  }
}
