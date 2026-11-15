import { Component, OnInit, computed, inject } from '@angular/core';
import { Store } from '@ngxs/store';
import type {
  AdminCalibrationResponse,
  CalibrationHouseReport,
  CalibrationImportHistoryItem,
} from '@feasly/contracts';
import {
  type DataTableColumn,
  DataTableComponent,
  ErrorStateComponent,
  KeyValueListComponent,
  type KeyValueItem,
  KitCountPipe,
  KitDateTimePipe,
  PageHeaderComponent,
  SkeletonComponent,
  StatusChipComponent,
  UiButtonComponent,
  UiCellDirective,
} from '../../shared/ui';
import { CalibrationState, LoadCalibration } from './admin-calibration.state';

/** One histogram row, pre-scaled for the template. */
interface HistogramRow {
  readonly bucket: string;
  readonly count: number;
  /** Bar width as % of the tallest bucket; 0 for empty buckets. */
  readonly width: number;
}

/**
 * Admin calibration console (admin/09, kit migration #547):
 * `/admin/calibration`.
 *
 * Shows the cost engine's calibration state — current version, error
 * distribution, sample size — and the import history. The import action
 * stays disabled until the import tooling lands; params are never edited
 * inline (AC2: no write endpoints are wired to this page).
 *
 * Kit: PageHeader, KeyValueList + StatusChip for the version facts,
 * DataTable for per-house results and imports (dates via kitDateTime),
 * a histogram with an axis and a zero-state. Copy about versions is
 * derived from the payload, never hard-coded (review B10).
 *
 * noindex,nofollow via the robots guard; excluded from prerendering.
 */
@Component({
  selector: 'app-admin-calibration',
  standalone: true,
  imports: [
    PageHeaderComponent,
    KeyValueListComponent,
    StatusChipComponent,
    DataTableComponent,
    UiCellDirective,
    UiButtonComponent,
    ErrorStateComponent,
    SkeletonComponent,
    KitDateTimePipe,
    KitCountPipe,
  ],
  templateUrl: './admin-calibration.component.html',
  styleUrls: ['./admin-calibration.component.scss'],
})
export class AdminCalibrationComponent implements OnInit {
  private readonly store = inject(Store);
  private readonly count = new KitCountPipe();

  protected readonly calibration = this.store.selectSignal(CalibrationState.calibration);
  protected readonly status = this.store.selectSignal(CalibrationState.status);
  protected readonly error = this.store.selectSignal(CalibrationState.error);

  protected readonly houseColumns: readonly DataTableColumn<CalibrationHouseReport>[] = [
    { key: 'houseId', header: 'House', kind: 'id', cardRole: 'title' },
    { key: 'actualTotalCents', header: 'Actual', kind: 'money' },
    { key: 'engineTotalCents', header: 'Engine', kind: 'money' },
    {
      key: 'errorFraction',
      header: 'Error',
      align: 'end',
      value: (row) => this.formatError(row.errorFraction),
    },
  ];
  protected readonly houseRowId = (row: CalibrationHouseReport): string => row.houseId;

  protected readonly importColumns: readonly DataTableColumn<CalibrationImportHistoryItem>[] = [
    { key: 'version', header: 'Version', kind: 'id', cardRole: 'title' },
    { key: 'status', header: 'Status', kind: 'status', statusDomain: 'calibrationImport' },
    { key: 'importedAt', header: 'Imported' },
    { key: 'houseCount', header: 'Houses', kind: 'count' },
    { key: 'importedBy', header: 'By' },
  ];
  protected readonly importRowId = (row: CalibrationImportHistoryItem): string => row.id;

  /** Version facts beside the calibrated/frozen chips. */
  protected readonly versionItems = computed<readonly KeyValueItem[]>(() => {
    const cal = this.calibration();
    if (!cal) return [];
    return [
      { label: 'Source', value: cal.current.source },
      { label: 'Hard-cost categories', value: this.count.transform(cal.current.hardCostCategories) },
      { label: 'Soft-cost categories', value: this.count.transform(cal.current.softCostCategories) },
      { label: 'Finish tiers', value: cal.current.tiers.join(', ') },
    ];
  });

  /**
   * The small-sample warning, suppressed at n=0 — with no houses the
   * report's empty state says it better (review B11).
   */
  protected readonly sampleWarning = computed(() => {
    const report = this.calibration()?.report;
    return report && report.sampleSize > 0 ? report.smallSampleWarning : null;
  });

  /** Histogram rows scaled to the tallest bucket; zero buckets get no bar. */
  protected readonly histogram = computed<readonly HistogramRow[]>(() => {
    const dist = this.calibration()?.report.errorDistribution;
    if (!dist) return [];
    const max = Math.max(0, ...dist.counts);
    return dist.buckets.map((bucket, i) => {
      const count = dist.counts[i] ?? 0;
      return { bucket, count, width: max > 0 ? Math.round((count / max) * 100) : 0 };
    });
  });

  protected readonly histogramLabel = computed(() =>
    this.histogram()
      .map((row) => `${row.bucket}: ${row.count}`)
      .join(', '),
  );

  /** The draft import's version, when one is in progress. */
  protected readonly draftVersion = computed(
    () => this.calibration()?.importHistory.find((i) => i.status === 'draft')?.version ?? null,
  );

  /** "Next calibration" copy, derived from the payload (review B10). */
  protected readonly nextCalibrationCopy = computed(() => {
    const cal: AdminCalibrationResponse | null = this.calibration();
    if (!cal) return '';
    const live = cal.current.version;
    if (cal.hasDraftV2) {
      const draft = this.draftVersion();
      const draftName = draft ? `The ${draft} draft import` : 'A draft import';
      return `${draftName} is in progress. ${live} stays live and untouched until the draft is reviewed and frozen.`;
    }
    return `When new cost data arrives, start the next import. ${live} stays live until the new version is reviewed and frozen.`;
  });

  ngOnInit(): void {
    this.store.dispatch(new LoadCalibration());
  }

  protected retry(): void {
    this.store.dispatch(new LoadCalibration());
  }

  /** Signed per-house error, e.g. +5.2% / -3.1%. */
  protected formatError(fraction: number): string {
    const pct = fraction * 100;
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
  }

  /** Mean absolute error has no sign (review B23): 0.047 → "4.7%". */
  protected formatAbsError(fraction: number): string {
    return `${Math.abs(fraction * 100).toFixed(1)}%`;
  }
}
