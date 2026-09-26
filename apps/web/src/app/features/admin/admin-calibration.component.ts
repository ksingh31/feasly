import { Component, OnInit, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Store } from '@ngxs/store';
import { Observable } from 'rxjs';
import type { AdminCalibrationResponse } from '@feasly/contracts';
import { SeoService } from '../../core/seo/seo.service';
import {
  CalibrationState,
  CalibrationStatus,
  LoadCalibration,
} from './admin-calibration.state';

/**
 * Admin calibration console (admin/09): `/admin/calibration`.
 *
 * Shows the cost engine's calibration state — current version, error
 * distribution, sample size — and the import history. The "Start v2 import"
 * action opens the v2 flow (cost-engine/01); params are never edited inline
 * (AC2: no write endpoints are wired to this page).
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-admin-calibration',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './admin-calibration.component.html',
  styleUrls: ['./admin-calibration.component.scss'],
})
export class AdminCalibrationComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly seo = inject(SeoService);

  protected readonly calibration$: Observable<AdminCalibrationResponse | null> =
    this.store.select(CalibrationState.calibration);
  protected readonly status$: Observable<CalibrationStatus> = this.store.select(
    CalibrationState.status,
  );
  protected readonly error$: Observable<string | null> = this.store.select(
    CalibrationState.error,
  );

  constructor() {
    this.seo.setPage({
      title: 'Calibration — Feasly Admin',
      description: 'Cost engine calibration console.',
      path: '/admin/calibration',
    });
  }

  ngOnInit(): void {
    this.store.dispatch(new LoadCalibration());
  }

  protected retry(): void {
    this.store.dispatch(new LoadCalibration());
  }

  /**
   * Format integer cents as CAD dollars (no float math in display).
   */
  protected formatCents(cents: number): string {
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: 'CAD',
      maximumFractionDigits: 0,
    }).format(cents / 100);
  }

  /**
   * Format a signed error fraction as a percentage, e.g. +5.2% / -3.1%.
   */
  protected formatError(fraction: number): string {
    const pct = fraction * 100;
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
  }

  protected trackByHouseId(
    _index: number,
    house: { houseId: string },
  ): string {
    return house.houseId;
  }

  protected trackById(_index: number, item: { id: string }): string {
    return item.id;
  }

  /**
   * Bar width as a percentage of the largest bucket (min 2% so tiny
   * counts stay visible).
   */
  protected barWidth(count: number, sampleSize: number): number {
    if (sampleSize <= 0 || count <= 0) return 2;
    return Math.max(2, Math.round((count / sampleSize) * 100));
  }

  /**
   * "Start v2 import" (AC3): opens the v2 import flow from cost-engine/01.
   * The flow itself creates an isolated draft — it never touches the
   * frozen v1, and no params are edited inline on this page (AC2).
   *
   * Placeholder: the import tooling lands with cost-engine/01 (blocked on
   * Karan's cost Sheet). Until then this is disabled in the template when
   * a draft exists; the click is a no-op hook for the future flow.
   */
  protected startV2Import(): void {
    // Hook for the cost-engine/01 import flow. Intentionally a no-op
    // until the tooling exists — the button copy makes the state clear.
  }
}
