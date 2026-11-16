import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { ConfigService } from '../../../core/config/config.service';
import type { BuildTimelineCity } from '../../../core/config/app-config';

/** One rendered phase row. */
export interface BuildTimelineRow {
  readonly id: string;
  readonly label: string;
  readonly range: string;
}

/** Fills `{min}`/`{max}` in a config template. Display only — no math. */
function fillRange(template: string, min: number, max: number): string {
  return template.split('{min}').join(String(min)).split('{max}').join(String(max));
}

/**
 * BuildTimeline (#823) — the typical design-to-completion timeline for a
 * custom infill build. Every phase, range and line of copy comes from
 * config (`buildTimeline.cities.<city>` + `copy.buildTimeline`), so a new
 * city or real City permit times are a config change. Shared so the report
 * and the address overview render the same section. Copy says "typical",
 * never a promise; renders nothing when the city has no timeline.
 */
@Component({
  selector: 'app-build-timeline',
  standalone: true,
  templateUrl: './build-timeline.component.html',
  styleUrl: './build-timeline.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BuildTimelineComponent {
  private readonly config = inject(ConfigService);

  /** City key in `buildTimeline.cities`; defaults to `buildTimeline.defaultCity`. */
  readonly city = input<string | undefined>(undefined);
  /**
   * Render the h2 title. Hosts that already head the section (the report's
   * disclosure summary) pass `false` and use `copy.buildTimeline.title`.
   */
  readonly showTitle = input(true);

  protected readonly copy = this.config.get('copy').buildTimeline;

  private readonly timeline = computed<BuildTimelineCity | undefined>(() => {
    const settings = this.config.get('buildTimeline');
    const key = (this.city() ?? settings.defaultCity).toLowerCase();
    return settings.cities[key];
  });

  protected readonly total = computed(() => {
    const t = this.timeline();
    return t ? fillRange(this.copy.totalTemplate, t.totalMinMonths, t.totalMaxMonths) : '';
  });

  protected readonly rows = computed<BuildTimelineRow[]>(() => {
    const t = this.timeline();
    if (!t) {
      return [];
    }
    return t.phases.map((phase) => ({
      id: phase.id,
      label: phase.label,
      range: fillRange(this.copy.rangeTemplates[phase.unit], phase.min, phase.max),
    }));
  });
}
