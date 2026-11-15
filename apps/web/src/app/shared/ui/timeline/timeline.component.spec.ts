import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { formatTimelinePayload, sortTimelineEvents, type TimelineEvent, type TimelineOrder } from './timeline';
import { TimelineComponent } from './timeline.component';

const NOW = new Date('2026-11-14T18:00:00Z');

/** Deliberately out of order, with a tie and an unparseable timestamp. */
const EVENTS: TimelineEvent[] = [
  { id: 'b', at: '2026-11-12T10:00:00Z', type: 'invoice_finalized', actor: 'System' },
  { id: 'bad', at: 'not-a-date', title: 'Imported' },
  { id: 'c', at: '2026-11-14T12:00:00Z', title: 'Card charged', tone: 'success', payload: { amount: 19800 } },
  { id: 'a', at: '2026-11-10T09:00:00Z', title: 'Invoice issued', actor: 'Marco Silva' },
  { id: 'b2', at: '2026-11-12T10:00:00Z', title: 'Email sent' },
];

describe('sortTimelineEvents', () => {
  it('sorts out-of-order input newest first by default', () => {
    expect(sortTimelineEvents(EVENTS).map((e) => e.id)).toEqual(['c', 'b', 'b2', 'a', 'bad']);
  });

  it('sorts oldest first on request, still sinking invalid timestamps', () => {
    expect(sortTimelineEvents(EVENTS, 'oldest').map((e) => e.id)).toEqual(['a', 'b', 'b2', 'c', 'bad']);
  });

  it('compares instants, not strings (offsets differ)', () => {
    const events: TimelineEvent[] = [
      { id: 'utc', at: '2026-11-12T10:00:00Z' },
      { id: 'mt', at: '2026-11-12T05:00:00-07:00' }, // 12:00Z — later
    ];
    expect(sortTimelineEvents(events).map((e) => e.id)).toEqual(['mt', 'utc']);
  });

  it('does not mutate the input', () => {
    const copy = [...EVENTS];
    sortTimelineEvents(EVENTS);
    expect(EVENTS).toEqual(copy);
  });
});

describe('formatTimelinePayload', () => {
  it('pretty-prints objects and passes strings through', () => {
    expect(formatTimelinePayload({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(formatTimelinePayload('raw')).toBe('raw');
    expect(formatTimelinePayload(undefined)).toBe('');
    expect(formatTimelinePayload(null)).toBe('');
  });

  it('survives circular payloads', () => {
    const loop: Record<string, unknown> = {};
    loop['self'] = loop;
    expect(formatTimelinePayload(loop)).toBe('[object Object]');
  });
});

@Component({
  standalone: true,
  imports: [TimelineComponent],
  template: `<ui-timeline [events]="events()" [order]="order()" [now]="now" />`,
})
class HostComponent {
  readonly events = signal<readonly TimelineEvent[]>(EVENTS);
  readonly order = signal<TimelineOrder>('newest');
  readonly now = NOW;
}

describe('TimelineComponent', () => {
  let fixture: ComponentFixture<HostComponent>;

  function setup(): HostComponent {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  function titles(): string[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.timeline__title')).map(
      (el) => (el as HTMLElement).textContent?.trim() ?? '',
    );
  }

  it('renders events sorted by timestamp with humanised titles', () => {
    setup();
    expect(titles()).toEqual(['Card charged', 'Invoice finalized', 'Email sent', 'Invoice issued', 'Imported']);
    expect(fixture.nativeElement.textContent).not.toContain('invoice_finalized');
  });

  it('re-sorts when the input or order changes', () => {
    const host = setup();
    host.order.set('oldest');
    fixture.detectChanges();
    expect(titles()[0]).toBe('Invoice issued');
    host.events.set([...EVENTS, { id: 'z', at: '2026-11-14T17:00:00Z', title: 'Latest' }]);
    fixture.detectChanges();
    expect(titles().at(-2)).toBe('Latest');
  });

  it('shows actor, relative time and the absolute time on hover', () => {
    setup();
    const items = fixture.nativeElement.querySelectorAll('.timeline__item');
    const last = items[3] as HTMLElement;
    expect(last.querySelector('.timeline__actor')?.textContent).toBe('Marco Silva');
    const time = last.querySelector('time') as HTMLElement;
    expect(time.getAttribute('datetime')).toBe('2026-11-10T09:00:00Z');
    expect(time.textContent?.trim()).toBe('4 days ago');
    expect(time.getAttribute('title')).toContain('Nov 10, 2026');
  });

  it('expands and collapses the raw payload', () => {
    setup();
    const toggle = fixture.nativeElement.querySelector('.timeline__toggle') as HTMLButtonElement;
    expect(fixture.nativeElement.querySelectorAll('.timeline__toggle').length).toBe(1);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(fixture.nativeElement.querySelector('.timeline__payload')).toBeNull();

    toggle.click();
    fixture.detectChanges();
    const payload = fixture.nativeElement.querySelector('.timeline__payload') as HTMLElement;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.textContent?.trim()).toBe('Hide details');
    expect(payload.textContent).toContain('"amount": 19800');
    expect(toggle.getAttribute('aria-controls')).toBe(payload.id);

    toggle.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.timeline__payload')).toBeNull();
  });

  it('renders an empty state for no events', () => {
    const host = setup();
    host.events.set([]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('ol')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('No activity yet');
  });
});
