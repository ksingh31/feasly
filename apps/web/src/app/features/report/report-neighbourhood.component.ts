import { ChangeDetectionStrategy, Component, computed, effect, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Store } from '@ngxs/store';
import { ConfigService } from '../../core/config/config.service';
import { mergeLazyCopy } from '../../core/config/lazy-copy';
import { LoadReportNeighbourhood } from './report-neighbourhood.actions';
import {
  DEFAULT_REPORT_NEIGHBOURHOOD_COPY,
  type ReportNeighbourhoodCopy,
} from './report-neighbourhood-copy.defaults';
import { ReportNeighbourhoodState } from './report-neighbourhood.state';

/** One row of the "Living near this lot" grid. */
interface LivingRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** "350 m" under a kilometre, "1.2 km" above (display only). */
export function formatDistanceLabel(m: number): string {
  return m < 1_000 ? `${Math.round(m)} m` : `${(m / 1_000).toFixed(1)} km`;
}

/**
 * Report "Schools for this address" + "Living near this lot" (#785).
 *
 * Free and ungated (shown pre- and post-gate), printed with the report.
 * Reads the stored designations (#775) and community living metrics (#777)
 * through ReportNeighbourhoodState — the API serves both from its own
 * tables, so a visit never triggers an outside call. Each section hides
 * when its data is missing (no empty boxes); with neither on file the
 * whole block, "Find a community" link included, renders nothing.
 */
@Component({
  selector: 'app-report-neighbourhood',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './report-neighbourhood.component.html',
  styleUrl: './report-neighbourhood.component.scss',
})
export class ReportNeighbourhoodComponent {
  private readonly store = inject(Store);
  private readonly config = inject(ConfigService);

  /** The report's address key; null renders nothing. */
  readonly addressKey = input<string | null>(null);

  protected readonly copy: ReportNeighbourhoodCopy = mergeLazyCopy(
    this.config,
    DEFAULT_REPORT_NEIGHBOURHOOD_COPY,
    ['reportNeighbourhood'],
  );

  private readonly schools = this.store.selectSignal(ReportNeighbourhoodState.schools);
  private readonly living = this.store.selectSignal(ReportNeighbourhoodState.living);

  protected readonly designations = computed(() => this.schools()?.designations ?? []);
  protected readonly boards = computed(() => this.schools()?.boards ?? []);

  protected readonly livingIntro = computed((): string | null => {
    const name = this.living()?.name;
    return name ? this.copy.livingIntro.replace('{community}', name) : null;
  });

  /** Categories with a nearest one on file, then tree cover when present. */
  protected readonly livingRows = computed((): LivingRow[] => {
    const living = this.living();
    if (!living) return [];
    const rows: LivingRow[] = living.amenities
      .filter((a) => a.nearest !== null)
      .map((a) => ({
        key: a.category,
        label: a.label,
        value: this.copy.nearestValue
          .replace('{name}', a.nearest!.name)
          .replace('{distance}', formatDistanceLabel(a.nearest!.distanceM)),
      }));
    const tree = living.treeCover;
    if (tree) {
      rows.push({
        key: 'tree-cover',
        label: this.copy.treeCoverLabel,
        value: this.copy.treeCoverValue
          .replace('{level}', this.copy.treeLevels[tree.level])
          .replace('{perHa}', String(Math.round(tree.treesPerHa))),
      });
    }
    return rows;
  });

  /** Either section has data (the "Find a community" link shows only then). */
  protected readonly hasAny = computed(() => this.designations().length > 0 || this.livingRows().length > 0);

  constructor() {
    effect(() => {
      const key = this.addressKey();
      if (key) this.store.dispatch(new LoadReportNeighbourhood(key));
    });
  }

  protected gradeLabel(band: string): string {
    return this.copy.gradeBands[band] ?? band;
  }
}
