import { ChangeDetectionStrategy, Component, computed, input, signal } from '@angular/core';
import { KitDateTimePipe, KitRelativePipe } from '../format/format.pipes';
import { enumLabel } from '../status/status-dictionary';
import {
  type TimelineEvent,
  type TimelineOrder,
  formatTimelinePayload,
  sortTimelineEvents,
} from './timeline';

let nextTimelineId = 0;

interface TimelineRow {
  readonly event: TimelineEvent;
  readonly title: string;
  readonly payload: string;
}

/**
 * Timeline (portal-ui-kit §3): vertical events with a tone marker,
 * humanised title, actor, relative time (absolute on hover) and an
 * expandable raw payload. Always sorted by timestamp, whatever order the
 * input arrives in.
 */
@Component({
  selector: 'ui-timeline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [KitDateTimePipe, KitRelativePipe],
  templateUrl: './timeline.component.html',
  styleUrl: './timeline.component.scss',
})
export class TimelineComponent {
  readonly events = input.required<readonly TimelineEvent[]>();
  /** Newest first (default) or oldest first. */
  readonly order = input<TimelineOrder>('newest');
  /** Accessible name for the list. */
  readonly label = input('Activity');
  readonly showDetailsLabel = input('Show details');
  readonly hideDetailsLabel = input('Hide details');
  readonly emptyLabel = input('No activity yet');
  /** Reference instant for relative times (tests, SSR); defaults to now. */
  readonly now = input<Date | undefined>(undefined);

  /** Per-instance prefix so two timelines on a page never share element ids. */
  protected readonly uid = `ui-timeline-${nextTimelineId++}`;

  private readonly expanded = signal<ReadonlySet<string>>(new Set());

  protected readonly rows = computed<TimelineRow[]>(() =>
    sortTimelineEvents(this.events(), this.order()).map((event) => ({
      event,
      title: event.title?.trim() || enumLabel(event.type),
      payload: formatTimelinePayload(event.payload),
    })),
  );

  protected isExpanded(id: string): boolean {
    return this.expanded().has(id);
  }

  protected toggle(id: string): void {
    const next = new Set(this.expanded());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this.expanded.set(next);
  }
}
