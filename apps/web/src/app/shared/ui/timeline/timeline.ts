/**
 * Timeline ordering (portal-ui-kit §3: "Always sorted by timestamp").
 * Pure — no Angular.
 */
import type { StatusTone } from '../status/status-dictionary';

export interface TimelineEvent {
  /** Stable id (track key). */
  readonly id: string;
  /** ISO instant the event happened. */
  readonly at: string;
  /** Humanised title. Falls back to the sentence-cased `type`. */
  readonly title?: string;
  /** Wire event type, e.g. `invoice_finalized`. Never rendered raw. */
  readonly type?: string;
  /** Who did it ("Marco Silva", "System"). */
  readonly actor?: string;
  /** Tone of the marker dot; neutral when omitted. */
  readonly tone?: StatusTone;
  /** Raw payload, shown in a collapsed "Details" section. */
  readonly payload?: unknown;
}

export type TimelineOrder = 'newest' | 'oldest';

/**
 * Returns a new array sorted by `at`, regardless of input order.
 * Ties keep their input order (stable); unparseable timestamps sink to the
 * end in either direction so they never masquerade as the latest event.
 */
export function sortTimelineEvents(
  events: readonly TimelineEvent[],
  order: TimelineOrder = 'newest',
): TimelineEvent[] {
  const direction = order === 'newest' ? -1 : 1;
  return events
    .map((event, index) => ({ event, index, time: Date.parse(event.at) }))
    .sort((a, b) => {
      const aBad = Number.isNaN(a.time);
      const bBad = Number.isNaN(b.time);
      if (aBad || bBad) {
        return aBad === bBad ? a.index - b.index : aBad ? 1 : -1;
      }
      return a.time === b.time ? a.index - b.index : (a.time - b.time) * direction;
    })
    .map(({ event }) => event);
}

/** Pretty-printed payload for the details section ('' when there is none). */
export function formatTimelinePayload(payload: unknown): string {
  if (payload === undefined || payload === null) {
    return '';
  }
  if (typeof payload === 'string') {
    return payload;
  }
  try {
    return JSON.stringify(payload, null, 2) ?? '';
  } catch {
    return String(payload);
  }
}
