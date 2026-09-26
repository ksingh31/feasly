import { Component, DestroyRef, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type {
  AdminEstimateDetail,
  ApiError,
  CostRow,
  FinishTier,
} from '@feasly/contracts';
import {
  aggregateCostBuckets,
  type CostBucket,
} from '../../shared/cost-buckets';
import { SeoService } from '../../core/seo/seo.service';
import { AdminEstimatesApiService } from './admin-estimates-api.service';

/** Lookup lifecycle for the admin estimate view. */
type LookupStatus = 'idle' | 'loading' | 'ready' | 'not-found' | 'error';

/** Human-readable input rows for the ops view. */
interface InputRow {
  readonly label: string;
  readonly value: string;
}

const TIER_LABELS: Record<FinishTier, string> = {
  standard: 'Standard',
  premium: 'Premium',
  luxury: 'Luxury',
};

const RENO_TYPE_LABELS: Record<string, string> = {
  extensive: 'Extensive remodel',
  addition: 'Addition',
  basement: 'Basement',
  combined: 'Combined',
};

/**
 * Admin estimate lookup (admin/03).
 *
 * `/admin/estimates` — paste-an-ID search entry. `/admin/estimates/:id` —
 * read-only snapshot view: exactly what the homeowner saw (inputs, ranges,
 * cost-data version, snapshot history) plus an ops strip (version string,
 * created-at, linked lead link, snapshot timeline).
 *
 * Rendering mirrors the consumer report through the shared
 * {@link aggregateCostBuckets} helper (DRY — same bucket math, no invented
 * figures). Strictly read-only: the template has no editable controls and
 * the service exposes no mutation method (AC3). `outputs` deep-equals the
 * consumer `ReportSnapshot` figures by contract (AC1 — pinned server-side).
 */
@Component({
  selector: 'app-admin-estimate-lookup',
  standalone: true,
  imports: [FormsModule, RouterLink],
  templateUrl: './admin-estimate-lookup.component.html',
  styleUrl: './admin-estimate-lookup.component.scss',
})
export class AdminEstimateLookupComponent {
  private readonly api = inject(AdminEstimatesApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly seo = inject(SeoService);
  private readonly destroyRef = inject(DestroyRef);

  /** Estimate ID being looked up (from the `:id` route param). */
  protected readonly lookupId = signal<string | null>(null);  /** Paste-an-ID search box value. */
  protected readonly searchId = signal('');
  /** Latest fetched detail. Null before the first load. */
  protected readonly detail = signal<AdminEstimateDetail | null>(null);
  /** Lookup lifecycle. */
  protected readonly status = signal<LookupStatus>('idle');

  /**
   * Monotonic lookup token. Navigating between IDs reuses this component
   * instance, so an earlier lookup can still be in flight when a newer one
   * starts (or when the user navigates back to the search entry). Every
   * new lookup/clear bumps the token; handlers from a superseded token
   * are discarded so a stale response can never overwrite newer state.
   */
  private requestSeq = 0;

  /** True when the route carries an `:id` (detail view, not the search entry). */
  protected readonly isDetailView = computed(() => this.lookupId() !== null);

  /** Cost breakdown buckets — same aggregation the consumer report uses. */
  protected readonly buckets = computed<readonly CostBucket[]>(() => {
    const rows: readonly CostRow[] = this.detail()?.rows ?? [];
    return aggregateCostBuckets(rows);
  });

  protected readonly bucketsAriaLabel = computed(() =>
    this.buckets()
      .map((b) => `${b.label}: ${this.formatCad(b.range.base)}`)
      .join(', '),
  );

  /** True for renovation estimates (reno-flavoured inputs wording). */
  protected readonly isReno = computed(
    () => this.detail()?.projectType === 'renovation',
  );

  /** Human-readable input rows, mirroring the consumer report's details. */
  protected readonly inputRows = computed<readonly InputRow[]>(() => {
    const detail = this.detail();
    if (!detail) return [];
    const inputs = detail.inputs as unknown as Record<string, unknown>;
    const rows: InputRow[] = [];
    if (detail.projectType === 'renovation') {
      const renoType = String(inputs['renoType'] ?? '');
      rows.push({
        label: 'Renovation type',
        value: RENO_TYPE_LABELS[renoType] ?? renoType,
      });
      const sqft = inputs['renoSqft'];
      rows.push({
        label: 'Affected area',
        value: typeof sqft === 'number' ? this.formatSqft(sqft) : '—',
      });
      if (typeof inputs['underpinning'] === 'boolean') {
        rows.push({
          label: 'Underpinning',
          value: inputs['underpinning'] ? 'Yes' : 'No',
        });
      }
    } else {
      const sqft = inputs['sqft'];
      rows.push({
        label: 'Living area',
        value: typeof sqft === 'number' ? this.formatSqft(sqft) : '—',
      });
      const garage = inputs['garage'];
      if (typeof garage === 'string' && garage) {
        rows.push({ label: 'Garage', value: this.titleCase(garage) });
      }
      const basement = inputs['basement'];
      if (typeof basement === 'string' && basement) {
        rows.push({ label: 'Basement', value: this.titleCase(basement) });
      }
    }
    const tier = inputs['tier'];
    if (typeof tier === 'string' && tier in TIER_LABELS) {
      rows.push({
        label: 'Finish tier',
        value: TIER_LABELS[tier as FinishTier],
      });
    }
    return rows;
  });

  protected readonly showNotFound = computed(
    () => this.status() === 'not-found',
  );
  protected readonly showError = computed(() => this.status() === 'error');
  protected readonly showLoading = computed(
    () => this.status() === 'loading' && this.detail() === null,
  );

  constructor() {
    this.seo.setPage({
      title: 'Estimate lookup — Feasly Admin',
      description: 'Read-only admin estimate lookup.',
      path: '/admin/estimates',
    });
    // Subscribe to paramMap (not the constructor-time snapshot): both
    // /admin/estimates and /admin/estimates/:id render this component, so
    // navigating between IDs reuses the instance and the constructor never
    // re-runs. The subscription reloads the estimate on every param change.
    this.route.paramMap
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((params) => {
        const raw = params.get('id');
        if (raw && raw.trim().length > 0) {
          const id = raw.trim();
          this.lookupId.set(id);
          this.searchId.set(id);
          this.load(id);
        } else {
          // Back at the search entry: clear any previously loaded detail and
          // invalidate any in-flight lookup so its response cannot
          // re-populate the view after the clear.
          this.requestSeq++;
          this.lookupId.set(null);
          this.detail.set(null);
          this.status.set('idle');
        }
      });
  }

  /** Search-box submit: route to the detail view for the pasted ID. */
  protected search(): void {
    const id = this.searchId().trim();
    if (id.length === 0) return;
    void this.router.navigate(['/admin/estimates', id]);
  }

  /** Fetch one estimate's read-only detail (AC2: 404 → not-found state). */
  private load(id: string): void {
    const token = ++this.requestSeq;
    this.status.set('loading');
    this.detail.set(null);
    this.api
      .getEstimate(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (detail) => {
          if (token !== this.requestSeq) return; // superseded lookup
          this.detail.set(detail);
          this.status.set('ready');
        },
        error: (error: unknown) => {
          if (token !== this.requestSeq) return; // superseded lookup
          const code =
            typeof error === 'object' && error !== null && 'code' in error
              ? (error as ApiError).code
              : null;
          this.status.set(code === 'ESTIMATE_NOT_FOUND' ? 'not-found' : 'error');
        },
      });
  }

  /** Retry the current lookup after a transient failure. */
  protected retry(): void {
    const id = this.lookupId();
    if (id) this.load(id);
  }

  protected formatCad(value: number): string {
    return `$${Math.round(value).toLocaleString('en-CA')}`;
  }

  protected formatSqft(value: number): string {
    return `${value.toLocaleString('en-CA')} sq ft`;
  }

  protected formatDate(iso: string): string {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleString('en-CA', {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        });
  }

  private titleCase(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
}
