import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { SeoService } from '../../core/seo/seo.service';
import { ConfigService } from '../../core/config/config.service';
import { API_SERVICE } from '../../core/api/api.service';
import { SiteFooterComponent, SiteNavComponent } from '../../shared/components';
import type {
  FunnelQuery,
  FunnelReport,
  FunnelTenantFilter,
} from '../../core/api/funnel.types';

/**
 * Admin funnel dashboard (admin/07 frontend).
 *
 * `/admin/funnels` — Karan's conversion visibility: per-step counts and
 * step-to-step conversion % from the append-only analytics events table,
 * with date-range and tenant filters. Numbers only — no PII, no per-user
 * drill-down, by construction of the backend endpoint.
 *
 * Guarded by {@link adminGuard} (interim X-Admin-Key until admin/01).
 * Fetches through {@link API_SERVICE} so mock mode works for local dev —
 * the mock returns fixture funnel data. Filter state is component-local
 * signals (read-only dashboard, nothing to persist).
 */
@Component({
  selector: 'app-funnels-page',
  standalone: true,
  imports: [FormsModule, SiteFooterComponent, SiteNavComponent],
  templateUrl: './funnels-page.component.html',
  styleUrl: './funnels-page.component.scss',
})
export class FunnelsPageComponent implements OnInit {
  private readonly api = inject(API_SERVICE);
  private readonly seo = inject(SeoService);
  private readonly config = inject(ConfigService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly copy = this.config.get('copy').admin.funnels;

  /** Inclusive start date (YYYY-MM-DD). Empty = unbounded. */
  protected readonly from = signal('');
  /** Inclusive end date (YYYY-MM-DD). Empty = unbounded. */
  protected readonly to = signal('');
  /** Tenant filter mode. */
  protected readonly tenantMode = signal<'all' | 'direct' | 'key'>('all');
  /** Tenant key when tenantMode === 'key'. */
  protected readonly tenantKey = signal('');

  /** Latest fetched report. */
  protected readonly report = signal<FunnelReport | null>(null);
  /** True while a fetch is in flight. */
  protected readonly loading = signal(false);
  /** Fetch failure flag. The banner copy is static. */
  protected readonly loadFailed = signal(false);

  /** Steps of the latest report (empty array before the first load). */
  protected readonly steps = computed(() => this.report()?.steps ?? []);

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
    this.seo.setForRoute('admin/funnels');
    this.load();
  }

  /** Applies the current filter values (form submit). */
  protected applyFilters(): void {
    if (this.rangeError() || this.loading()) {
      return;
    }
    this.load();
  }

  /** Resets all filters to the unbounded defaults. */
  protected resetFilters(): void {
    this.from.set('');
    this.to.set('');
    this.tenantMode.set('all');
    this.tenantKey.set('');
    this.load();
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
    };
  }

  private load(): void {
    const query = this.buildQuery();
    this.loading.set(true);
    this.loadFailed.set(false);
    this.api
      .getFunnel(query)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (report) => {
          this.report.set(report);
          this.loading.set(false);
        },
        error: () => {
          // Keep the last good report visible; the banner explains the
          // failure. Static copy only — no error text or PII in the DOM.
          this.loadFailed.set(true);
          this.loading.set(false);
        },
      });
  }
}
