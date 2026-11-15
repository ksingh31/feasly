import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TableFilters } from '../data-table/table-query';
import { type FilterBarSelect, type FilterChange, FilterBarComponent } from './filter-bar.component';

const opts = (...values: string[]) => values.map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }));

const SELECTS: FilterBarSelect[] = [
  { key: 'status', label: 'Status', options: opts('new', 'won'), placeholder: 'Any status' },
  { key: 'builder', label: 'Builder', options: opts('elite'), placeholder: 'Any builder' },
  { key: 'source', label: 'Source', options: opts('embed', 'api'), placeholder: 'Any source' },
  { key: 'owner', label: 'Owner', options: opts('karan'), placeholder: 'Anyone' },
];

@Component({
  standalone: true,
  imports: [FilterBarComponent],
  template: `
    <input class="other-input" />
    <ui-filter-bar
      [search]="search()"
      [filters]="filters()"
      [selects]="selects()"
      [debounceMs]="250"
      (searchChange)="searches.push($event)"
      (filterChange)="changes.push($event)"
      (clearAll)="clears = clears + 1"
    />
  `,
})
class HostComponent {
  readonly search = signal('');
  readonly filters = signal<TableFilters>({});
  readonly selects = signal<readonly FilterBarSelect[]>(SELECTS);
  readonly searches: string[] = [];
  readonly changes: FilterChange[] = [];
  clears = 0;
}

describe('FilterBarComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let host: HostComponent;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(): HTMLElement {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    host = fixture.componentInstance;
    fixture.detectChanges();
    document.body.appendChild(fixture.nativeElement);
    return fixture.nativeElement as HTMLElement;
  }

  function render(): HTMLElement {
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  const searchBox = (el: HTMLElement) => el.querySelector('input[type=search]') as HTMLInputElement;
  const type = (el: HTMLElement, value: string) => {
    const input = searchBox(el);
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };

  it('debounces search by debounceMs and emits the trimmed value once', () => {
    const el = setup();
    type(el, 'ma');
    vi.advanceTimersByTime(100);
    type(el, 'marco ');
    vi.advanceTimersByTime(249);
    expect(host.searches).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(host.searches).toEqual(['marco']);
  });

  it('does not re-emit the search the URL already has', () => {
    const el = setup();
    host.search.set('marco');
    render();
    expect(searchBox(el).value).toBe('marco');
    type(el, 'marco ');
    vi.advanceTimersByTime(250);
    expect(host.searches).toEqual([]);
  });

  it('"/" focuses search, except while typing in another field', () => {
    const el = setup();
    const other = el.querySelector('.other-input') as HTMLInputElement;
    other.focus();
    other.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    expect(document.activeElement).toBe(other);

    other.blur();
    const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    document.body.dispatchEvent(event);
    expect(document.activeElement).toBe(searchBox(el));
    expect(event.defaultPrevented).toBe(true);
  });

  it('shows at most three selects inline; the rest behind "More filters"', () => {
    const el = setup();
    const inlineLabels = () =>
      Array.from(el.querySelectorAll('.ui-fb__bar ui-select label')).map((l) => l.textContent?.trim());
    expect(inlineLabels()).toEqual(['Status', 'Builder', 'Source']);
    const more = Array.from(el.querySelectorAll('.ui-fb__bar button')).find((b) =>
      b.textContent?.includes('More filters'),
    ) as HTMLButtonElement;
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(el.querySelector('.ui-fb__more')).toBeNull();
    more.click();
    render();
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector('.ui-fb__more')?.textContent).toContain('Owner');
  });

  it('a select change emits filterChange', () => {
    const el = setup();
    const select = el.querySelector('.ui-fb__bar select') as HTMLSelectElement;
    select.value = 'won';
    select.dispatchEvent(new Event('change'));
    select.value = '';
    select.dispatchEvent(new Event('change'));
    expect(host.changes).toEqual([{ key: 'status', value: 'won' }]);
  });

  it('chips with × and "Clear all" only while something is active', () => {
    const el = setup();
    expect(el.querySelector('.ui-fb__chips')).toBeNull();

    host.filters.set({ status: 'won', owner: 'karan' });
    render();
    const chips = Array.from(el.querySelectorAll('.ui-fb__chip'));
    expect(chips.map((c) => c.querySelector('span')?.textContent)).toEqual(['Status: Won', 'Owner: Karan']);
    const x = chips[0].querySelector('button') as HTMLButtonElement;
    expect(x.getAttribute('aria-label')).toBe('Remove filter Status: Won');
    x.click();
    expect(host.changes).toEqual([{ key: 'status', value: null }]);

    (el.querySelector('.ui-fb__chips .ui-fb__clear') as HTMLButtonElement).click();
    expect(host.clears).toBe(1);

    host.filters.set({});
    host.search.set('marco');
    render();
    expect(el.querySelector('.ui-fb__chip')).toBeNull();
    expect(el.querySelector('.ui-fb__clear')).not.toBeNull();
  });

  it('mobile Filters (n) opens a bottom sheet; Esc closes it and returns focus', async () => {
    const el = setup();
    host.filters.set({ status: 'won' });
    render();
    const toggle = el.querySelector('.ui-fb__bar .ui-fb__mobile') as HTMLButtonElement;
    expect(toggle.textContent?.replace(/\s+/g, ' ').trim()).toBe('Filters (1)');
    toggle.click();
    render();
    await fixture.whenStable();
    const sheet = el.querySelector('[role=dialog]') as HTMLElement;
    expect(sheet.getAttribute('aria-modal')).toBe('true');
    expect(sheet.querySelectorAll('ui-select')).toHaveLength(4);
    expect(document.activeElement).toBe(sheet.querySelector('h2'));

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    render();
    await fixture.whenStable();
    expect(el.querySelector('[role=dialog]')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });
});
