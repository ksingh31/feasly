import { Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Store } from '@ngxs/store';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import type {
  AdminLeadFilters,
  AdminLeadStatus,
} from '@feasly/contracts';
import { ConfigService } from '../../core/config/config.service';
import { SeoService } from '../../core/seo/seo.service';
import { AdminLeadDetailComponent } from './admin-lead-detail.component';
import {
  ClearSelectedAdminLead,
  ExportAdminLeadsCsv,
  LoadAdminLeads,
  LoadMoreAdminLeads,
  SelectAdminLead,
  SetAdminLeadsTab,
  ToggleAdminLeadsSandbox,
  type AdminLeadsTab,
} from './admin-leads.actions';
import { AdminLeadsState } from './admin-leads.state';

const STATUS_OPTIONS: readonly ('' | AdminLeadStatus)[] = [
  '',
  'new',
  'contacted',
  'quoting',
  'won',
  'lost',
];

/** Pipeline statuses in the order Karan works them (drives the totals row). */
const PIPELINE_STATUSES: readonly AdminLeadStatus[] = [
  'new',
  'contacted',
  'quoting',
  'won',
  'lost',
];

/**
 * Assignment filter options. There is no assign-to-builder backend yet, so
 * every lead is unassigned — both options show the full list. The control
 * exists to match the approved mockup's three filters; it becomes a real
 * filter when the backend lands.
 */
const ASSIGNED_OPTIONS: readonly ('' | 'unassigned')[] = ['', 'unassigned'];

/**
 * Leads explorer (admin/02) — Karan's daily lead view. FE-9 redesign:
 * cream/charcoal/brass premium theme, pipeline totals row, exactly three
 * filters (search, status, assigned), lead cards with avatar initials,
 * and a centered lead-detail modal replacing the old side drawer.
 *
 * Tabs (all/quarantine), the sandbox toggle, and CSV export are unchanged.
 * Guarded by `adminGuard`; noindex via the robots guard; excluded from
 * prerendering. All state lives in `AdminLeadsState` — the component only
 * dispatches actions and reads signals.
 */
@Component({
  selector: 'app-admin-leads',
  standalone: true,
  imports: [ReactiveFormsModule, AdminLeadDetailComponent],
  templateUrl: './admin-leads.component.html',
  styleUrls: ['./admin-leads.component.scss'],
})
export class AdminLeadsComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly fb = inject(FormBuilder);
  private readonly destroyRef = inject(DestroyRef);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);

  protected readonly leads = this.store.selectSignal(AdminLeadsState.leads);
  protected readonly totalCount = this.store.selectSignal(AdminLeadsState.totalCount);
  protected readonly statusCounts = this.store.selectSignal(AdminLeadsState.statusCounts);
  protected readonly hasMore = this.store.selectSignal(AdminLeadsState.hasMore);
  protected readonly tab = this.store.selectSignal(AdminLeadsState.tab);
  protected readonly includeSandbox = this.store.selectSignal(AdminLeadsState.includeSandbox);
  protected readonly listStatus = this.store.selectSignal(AdminLeadsState.listStatus);
  protected readonly listError = this.store.selectSignal(AdminLeadsState.listError);
  protected readonly selectedLeadId = this.store.selectSignal(AdminLeadsState.selectedLeadId);
  protected readonly exporting = this.store.selectSignal(AdminLeadsState.exporting);

  protected readonly statusOptions = STATUS_OPTIONS;
  protected readonly pipelineStatuses = PIPELINE_STATUSES;
  protected readonly assignedOptions = ASSIGNED_OPTIONS;

  /** Mobile filter disclosure (filters collapse behind a toggle at 390px). */
  protected readonly filtersOpen = signal(false);

  protected readonly filtersForm = this.fb.nonNullable.group({
    search: [''],
    status: ['' as '' | AdminLeadStatus],
    /** Visual-only until the assign-to-builder backend exists (see ASSIGNED_OPTIONS). */
    assigned: ['' as '' | 'unassigned'],
  });

  constructor() {
    this.seo.setPage({
      title: 'Leads — Feasly Admin',
      description: 'Feasly admin leads explorer.',
      path: '/admin/leads',
    });
  }

  ngOnInit(): void {
    this.store.dispatch(new LoadAdminLeads());

    // Free-text search is debounced (shared timings.debounceMs); every other
    // filter applies on change.
    this.filtersForm.controls.search.valueChanges
      .pipe(
        debounceTime(this.config.get('timings').debounceMs),
        distinctUntilChanged(),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => this.applyFilters());

    // Clear any open modal when leaving the page so a stale selection
    // doesn't linger in memory-only state.
    this.destroyRef.onDestroy(() => {
      this.store.dispatch(new ClearSelectedAdminLead());
    });
  }

  /** Collects the form into backend filters; empty values are omitted. */
  private collectFilters(): AdminLeadFilters {
    const raw = this.filtersForm.getRawValue();
    // The contract marks every filter readonly — build a mutable copy here.
    const filters: { -readonly [K in keyof AdminLeadFilters]: AdminLeadFilters[K] } = {};
    const search = raw.search.trim();
    if (search) {
      filters.search = search;
    }
    if (raw.status) {
      filters.status = raw.status;
    }
    // `assigned` is visual-only: no backend param exists. "Unassigned"
    // matches every lead today, so it intentionally sends nothing.
    return filters;
  }

  protected applyFilters(): void {
    this.store.dispatch(new LoadAdminLeads(this.collectFilters(), this.tab()));
  }

  protected clearFilters(): void {
    this.filtersForm.reset({ search: '', status: '', assigned: '' });
    this.applyFilters();
  }

  /** Pipeline totals row: clicking a status filters the list to it. */
  protected filterByStatus(status: AdminLeadStatus): void {
    const current = this.filtersForm.controls.status.value;
    this.filtersForm.controls.status.setValue(current === status ? '' : status);
    this.applyFilters();
  }

  protected toggleFilters(): void {
    this.filtersOpen.update((open) => !open);
  }

  protected setTab(tab: AdminLeadsTab): void {
    this.store.dispatch(new SetAdminLeadsTab(tab));
  }

  protected toggleSandbox(include: boolean): void {
    this.store.dispatch(new ToggleAdminLeadsSandbox(include));
  }

  protected selectLead(id: string): void {
    this.store.dispatch(new SelectAdminLead(id));
  }

  protected closeDetail(): void {
    this.store.dispatch(new ClearSelectedAdminLead());
  }

  protected loadMore(): void {
    this.store.dispatch(new LoadMoreAdminLeads());
  }

  protected retry(): void {
    this.applyFilters();
  }

  protected exportCsv(): void {
    this.store.dispatch(new ExportAdminLeadsCsv());
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && this.selectedLeadId()) {
      this.store.dispatch(new ClearSelectedAdminLead());
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

  protected projectTypeLabel(value: string): string {
    return value === 'new_build' ? 'New build' : value === 'renovation' ? 'Renovation' : value;
  }

  protected statusLabel(status: AdminLeadStatus): string {
    return status.charAt(0).toUpperCase() + status.slice(1);
  }
}
