import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { API_SERVICE } from '../../core/api/api.service';
import { localDateStringDaysAgo } from '../../shared/utils/datetime';
import {
  KitCountPipe,
  KpiGridComponent,
  KpiTileComponent,
  PageHeaderComponent,
  SkeletonComponent,
  UiButtonComponent,
  UiDateFieldComponent,
  type UiSelectOption,
  UiSelectComponent,
  UiTextFieldComponent,
} from '../../shared/ui';
import type {
  FunnelQuery,
  FunnelReport,
  FunnelSourceGroup,
  FunnelTenantFilter,
} from '../../core/api/funnel.types';
import { injectAdminCopy } from './admin-copy';

/**
 * Admin funnel dashboard (admin/07 frontend).
 *
 * `/admin/funnels` — Karan's conversion visibility: per-step counts and
 * step-to-step conversion % from the append-only analytics events table,
 * with date-range, tenant and (#815) utm_source / utm_campaign filters, plus
 * a per-(source, campaign) breakdown table. Numbers only — no PII, no per-user
 * drill-down, by construction of the backend endpoint.
 *
 * Guarded by {@link adminGuard} (admin/01 session auth).
 * Fetches through {@link API_SERVICE} so mock mode works for local dev —
 * the mock returns fixture funnel data. Filter state is component-local
 * signals (read-only dashboard, nothing to persist).
 */
@Component({
  selector: 'app-funnels-page',
  standalone: true,
  imports: [
    FormsModule,
    PageHeaderComponent,
    UiButtonComponent,
    UiDateFieldComponent,
    UiSelectComponent,
    UiTextFieldComponent,
    KpiGridComponent,
    KpiTileComponent,
    SkeletonComponent,
    KitCountPipe,
  ],
  templateUrl: './funnels-page.component.html',
  styleUrl: './funnels-page.component.scss',
})
export class FunnelsPageComponent implements OnInit {
  private readonly api = inject(API_SERVICE);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly copy = injectAdminCopy().funnels;
  private readonly count = new KitCountPipe();

  /** Inclusive start date (YYYY-MM-DD). Empty = unbounded. */
  protected readonly from = signal('');
  /** Inclusive end date (YYYY-MM-DD). Empty = unbounded. */
  protected readonly to = signal('');
  /** Tenant filter mode. */
  protected readonly tenantMode = signal<'all' | 'direct' | 'key'>('all');
  /** Tenant key when tenantMode === 'key'. */
  protected readonly tenantKey = signal('');
  /** #815: exact utm_source filter. Empty = any. */
  protected readonly utmSource = signal('');
  /** #815: exact utm_campaign filter. Empty = any. */
  protected readonly utmCampaign = signal('');
  /**
   * The date preset the current range came from: a trailing day count,
   * 'all' (no dates), or null once the dates were edited by hand.
   */
  protected readonly activePreset = signal<number | 'all' | null>('all');

  protected readonly tenantOptions: readonly UiSelectOption[] = [
    { value: 'all', label: this.copy.tenantAll },
    { value: 'direct', label: this.copy.tenantDirect },
    { value: 'key', label: this.copy.tenantKey },
  ];

  /** Latest fetched report. */
  protected readonly report = signal<FunnelReport | null>(null);
  /** True while a fetch is in flight. */
  protected readonly loading = signal(false);
  /** Fetch failure flag. The banner copy is static. */
  protected readonly loadFailed = signal(false);
  /**
   * Monotonic request generation. A newer load() supersedes any in-flight
   * request (e.g. resetFilters while a fetch is pending); responses from a
   * superseded generation are ignored so stale data can never overwrite the
   * latest report.
   */
  private requestId = 0;

  /** Steps of the latest report (empty array before the first load). */
  protected readonly steps = computed(() => this.report()?.steps ?? []);

  /** #815: per-(source, campaign) funnels of the latest report. */
  protected readonly sourceGroups = computed<readonly FunnelSourceGroup[]>(
    () => this.report()?.bySource ?? [],
  );
  /** True when the backend capped the breakdown. */
  protected readonly sourceGroupsTruncated = computed(() => this.report()?.bySourceTruncated === true);

  /** Max step count — bars scale against this. */
  protected readonly maxCount = computed(() =>
    Math.max(0, ...(this.report()?.steps.map((s) => s.count) ?? [0])),
  );

  /** True when the report has zero counts across every step. */
  protected readonly isEmpty = computed(
    () =>
      this.report() !== null &&
      this.report()!.steps.every((s) => s.count === 0),
  );

  /** Entry → final step conversion (null when the entry step is empty). */
  protected readonly overallConversion = computed<number | null>(() => {
    const steps = this.steps();
    if (steps.length < 2 || steps[0].count <= 0) return null;
    return steps[steps.length - 1].count / steps[0].count;
  });

  /** "{first} → {last}" under the overall-conversion KPI. */
  protected readonly overallConversionSub = computed(() => {
    const steps = this.steps();
    if (steps.length < 2) return undefined;
    return this.copy.overallConversionSub
      .replace('{from}', steps[0].label)
      .replace('{to}', steps[steps.length - 1].label);
  });

  /** Validation error for the date range (from > to). Null when valid. */
  protected readonly rangeError = computed(() => {
    const from = this.from().trim();
    const to = this.to().trim();
    if (from && to && from > to) {
      return this.copy.invalidRange;
    }
    return null;
  });

  ngOnInit(): void {
    // Title comes from the seo-routes table — the admin shell sets it
    // centrally on every navigation (admin/funnels).
    this.load();
  }

  /** Applies the current filter values (form submit). */
  protected applyFilters(): void {
    if (this.rangeError() || this.loading()) {
      return;
    }
    this.load();
  }

  /**
   * Date preset: the trailing `days` days including today, or every date
   * for 'all'. Applies immediately.
   */
  protected applyPreset(preset: number | 'all'): void {
    if (this.loading()) return;
    if (preset === 'all') {
      this.from.set('');
      this.to.set('');
    } else {
      this.from.set(localDateStringDaysAgo(preset - 1));
      this.to.set(localDateStringDaysAgo(0));
    }
    this.activePreset.set(preset);
    this.load();
  }

  protected onFromChange(value: string | null): void {
    this.from.set(value ?? '');
    this.activePreset.set(null);
  }

  protected onToChange(value: string | null): void {
    this.to.set(value ?? '');
    this.activePreset.set(null);
  }

  protected onTenantModeChange(value: string | null): void {
    this.tenantMode.set(value === 'direct' || value === 'key' ? value : 'all');
  }

  /** People lost between step `index - 1` and step `index` (never negative). */
  protected dropOff(index: number): number {
    const steps = this.steps();
    if (index <= 0 || index >= steps.length) return 0;
    return Math.max(0, steps[index - 1].count - steps[index].count);
  }

  protected dropOffLabel(index: number): string {
    return this.copy.dropOff.replace('{count}', this.count.transform(this.dropOff(index)));
  }

  /** Resets all filters to the unbounded defaults. */
  protected resetFilters(): void {
    this.activePreset.set('all');
    this.from.set('');
    this.to.set('');
    this.tenantMode.set('all');
    this.tenantKey.set('');
    this.utmSource.set('');
    this.utmCampaign.set('');
    this.load();
  }

  /** Display value of a breakdown group's source/campaign (null = untagged). */
  protected groupValue(value: string | null): string {
    return value ?? this.copy.sourceNone;
  }

  /** Stable @for track key of a breakdown group. */
  protected groupKey(group: FunnelSourceGroup): string {
    return JSON.stringify([group.utmSource, group.utmCampaign]);
  }

  /** Entry → final conversion of one breakdown group (or "—"). */
  protected groupConversion(group: FunnelSourceGroup): string {
    const first = group.steps[0]?.count ?? 0;
    const last = group.steps[group.steps.length - 1]?.count ?? 0;
    return this.conversionLabel(group.steps.length < 2 || first <= 0 ? null : last / first);
  }

  /** Bar width for a step, as a % of the widest step. */
  protected barWidth(count: number): number {
    const max = this.maxCount();
    return max > 0 ? Math.round((count / max) * 100) : 0;
  }

  /** Human-readable conversion %, or the story-pinned "—" when meaningless. */
  protected conversionLabel(conversion: number | null): string {
    if (conversion === null) {
      return this.copy.noConversion;
    }
    return `${(conversion * 100).toFixed(1)}%`;
  }

  private buildQuery(): FunnelQuery {
    const tenant: FunnelTenantFilter =
      this.tenantMode() === 'key'
        ? (this.tenantKey().trim() || 'all')
        : this.tenantMode();
    return {
      from: this.from().trim() || undefined,
      to: this.to().trim() || undefined,
      tenant,
      utmSource: this.utmSource().trim() || undefined,
      utmCampaign: this.utmCampaign().trim() || undefined,
    };
  }

  private load(): void {
    const query = this.buildQuery();
    const id = ++this.requestId;
    this.loading.set(true);
    this.loadFailed.set(false);
    this.api
      .getFunnel(query)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (report) => {
          // Superseded by a newer load — ignore the stale response.
          if (id !== this.requestId) {
            return;
          }
          this.report.set(report);
          this.loading.set(false);
        },
        error: () => {
          // Keep the last good report visible; the banner explains the
          // failure. Static copy only — no error text or PII in the DOM.
          // Superseded by a newer load — ignore the stale error.
          if (id !== this.requestId) {
            return;
          }
          this.loadFailed.set(true);
          this.loading.set(false);
        },
      });
  }
}
