import { Component, DestroyRef, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Store } from '@ngxs/store';
import type { BuilderLeadListItem, BuilderLeadStatus } from '@feasly/contracts';
import { BUILDER_COPY } from './builder-copy';
import { BuilderLeadCommentsComponent } from './builder-lead-comments.component';
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
  imports: [RouterLink, BuilderLeadCommentsComponent],
  templateUrl: './builder-dashboard.component.html',
  styleUrls: ['./builder-dashboard.component.scss'],
})
export class BuilderDashboardComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly destroyRef = inject(DestroyRef);

  /** Builder portal copy (config-owned). */
  protected readonly copy = inject(BUILDER_COPY);

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

  /** Lead ids whose notes thread is expanded (ephemeral UI state, not persisted). */
  protected readonly expandedNotes = signal<ReadonlySet<string>>(new Set());

  protected notesExpanded(leadId: string): boolean {
    return this.expandedNotes().has(leadId);
  }

  protected toggleNotes(leadId: string): void {
    this.expandedNotes.update((open) => {
      const next = new Set(open);
      if (next.has(leadId)) {
        next.delete(leadId);
      } else {
        next.add(leadId);
      }
      return next;
    });
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

  /**
   * Pending (unapplied) status selections, keyed by lead id. Selecting a
   * status never saves — it only stages the choice here; the Apply button
   * performs the actual PATCH. This is Karan's explicit order (2026-09-29):
   * no auto-save on selection anywhere in the app.
   */
  protected readonly pendingStatus = signal<Record<string, BuilderLeadStatus>>(
    {},
  );

  /** The value the select renders: the pending pick, or the store value. */
  protected pendingStatusFor(lead: BuilderLeadListItem): BuilderLeadStatus {
    return this.pendingStatus()[lead.id] ?? lead.status;
  }

  /**
   * The Apply button is enabled only when the staged selection differs
   * from the stored status and no save is in flight.
   */
  protected canApplyLeadStatus(lead: BuilderLeadListItem): boolean {
    return (
      this.pendingStatusFor(lead) !== lead.status &&
      this.updatingLeadId() === null
    );
  }

  /** Stages a status choice without saving (template-bound). */
  protected onLeadStatusSelect(leadId: string, value: string): void {
    const status = value as BuilderLeadStatus;
    this.pendingStatus.update((pending) => ({ ...pending, [leadId]: status }));
  }

  /**
   * Saves the staged status for one lead (Apply button, template-bound).
   * Clears the staged choice on completion — on success the store value
   * matches the pick, on failure the select reverts to the stored status,
   * so badge and dropdown can never disagree.
   */
  protected applyLeadStatus(leadId: string): void {
    const pending = this.pendingStatus()[leadId];
    const lead = this.leads().find((l) => l.id === leadId);
    // Recorded leads are locked: never dispatch a status change for them
    // (the backend rejects it too — this is the UI-side guard).
    if (!lead || lead.hasInvoice || pending === undefined || pending === lead.status) {
      this.clearPendingStatus(leadId);
      return;
    }
    this.store
      .dispatch(new UpdateBuilderLeadStatus(leadId, pending))
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.clearPendingStatus(leadId));
  }

  private clearPendingStatus(leadId: string): void {
    this.pendingStatus.update((pending) => {
      if (!(leadId in pending)) {
        return pending;
      }
      const next = { ...pending };
      delete next[leadId];
      return next;
    });
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
