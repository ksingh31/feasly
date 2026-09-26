import { Component, DestroyRef, inject, OnInit } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, ReactiveFormsModule } from '@angular/forms';
import { Store } from '@ngxs/store';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import type {
  AdminLeadFilters,
  AdminLeadSource,
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

const SOURCE_OPTIONS: readonly ('' | AdminLeadSource)[] = ['', 'web', 'embed', 'api', 'mcp'];

const PROJECT_TYPE_OPTIONS: readonly string[] = ['', 'new_build', 'renovation'];

/**
 * Leads explorer (admin/02) — Karan's daily lead view.
 *
 * Table with filters (score, status, source, project type, date range,
 * free-text search, tenant), cursor pagination, a quarantine tab for
 * honeypot-flagged submissions, sandbox toggle, CSV export, and a detail
 * drawer with notes + pipeline status.
 *
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
  protected readonly hasMore = this.store.selectSignal(AdminLeadsState.hasMore);
  protected readonly tab = this.store.selectSignal(AdminLeadsState.tab);
  protected readonly includeSandbox = this.store.selectSignal(AdminLeadsState.includeSandbox);
  protected readonly listStatus = this.store.selectSignal(AdminLeadsState.listStatus);
  protected readonly listError = this.store.selectSignal(AdminLeadsState.listError);
  protected readonly selectedLeadId = this.store.selectSignal(AdminLeadsState.selectedLeadId);
  protected readonly exporting = this.store.selectSignal(AdminLeadsState.exporting);

  protected readonly statusOptions = STATUS_OPTIONS;
  protected readonly sourceOptions = SOURCE_OPTIONS;
  protected readonly projectTypeOptions = PROJECT_TYPE_OPTIONS;

  protected readonly filtersForm = this.fb.nonNullable.group({
    search: [''],
    status: ['' as '' | AdminLeadStatus],
    source: ['' as '' | AdminLeadSource],
    projectType: [''],
    minScore: [''],
    maxScore: [''],
    createdAfter: [''],
    createdBefore: [''],
    tenantId: [''],
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

    // Clear any open drawer when leaving the page so a stale selection
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
    if (raw.source) {
      filters.source = raw.source;
    }
    if (raw.projectType) {
      filters.projectType = raw.projectType;
    }
    const minScore = Number(raw.minScore);
    if (raw.minScore !== '' && Number.isInteger(minScore) && minScore >= 0) {
      filters.minScore = Math.min(minScore, 100);
    }
    const maxScore = Number(raw.maxScore);
    if (raw.maxScore !== '' && Number.isInteger(maxScore) && maxScore >= 0) {
      filters.maxScore = Math.min(maxScore, 100);
    }
    if (raw.createdAfter) {
      filters.createdAfter = new Date(`${raw.createdAfter}T00:00:00`).toISOString();
    }
    if (raw.createdBefore) {
      // End of the selected day, so the whole day is included.
      filters.createdBefore = new Date(`${raw.createdBefore}T23:59:59.999`).toISOString();
    }
    const tenantId = raw.tenantId.trim();
    if (tenantId) {
      filters.tenantId = tenantId;
    }
    return filters;
  }

  protected applyFilters(): void {
    this.store.dispatch(new LoadAdminLeads(this.collectFilters(), this.tab()));
  }

  protected clearFilters(): void {
    this.filtersForm.reset({
      search: '',
      status: '',
      source: '',
      projectType: '',
      minScore: '',
      maxScore: '',
      createdAfter: '',
      createdBefore: '',
      tenantId: '',
    });
    this.applyFilters();
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

  protected formatDate(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('en-CA');
  }

  protected projectTypeLabel(value: string): string {
    return value === 'new_build' ? 'New build' : value === 'renovation' ? 'Renovation' : value;
  }
}
