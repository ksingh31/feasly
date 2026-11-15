import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { describe, expect, it } from 'vitest';
import { EntityComboboxComponent } from './entity-combobox.component';
import { type EntityOption, filterEntityOptions } from './entity-option';

const OPTIONS: EntityOption[] = [
  { id: 'b-111', label: 'Elite Craft Builders', meta: 'Calgary' },
  { id: 'b-222', label: 'Bowness Homes', meta: 'Calgary' },
  { id: 'b-333', label: 'Crafted Infill Co.', meta: 'Airdrie' },
];

describe('filterEntityOptions', () => {
  it('matches label or meta case-insensitively and id by prefix', () => {
    expect(filterEntityOptions(OPTIONS, 'craft').map((o) => o.id)).toEqual(['b-111', 'b-333']);
    expect(filterEntityOptions(OPTIONS, 'AIRDRIE').map((o) => o.id)).toEqual(['b-333']);
    expect(filterEntityOptions(OPTIONS, 'b-22').map((o) => o.id)).toEqual(['b-222']);
    expect(filterEntityOptions(OPTIONS, '22')).toEqual([]);
    expect(filterEntityOptions(OPTIONS, '  ')).toEqual(OPTIONS);
  });
});

@Component({
  standalone: true,
  imports: [EntityComboboxComponent, ReactiveFormsModule],
  template: `<ui-entity-combobox
    label="Builder"
    hint="Search by name"
    [error]="error()"
    [options]="options()"
    [loading]="loading()"
    [filterLocally]="filterLocally()"
    [formControl]="control"
    (queryChange)="queries.push($event)"
    (selectionChange)="selections.push($event)"
  />`,
})
class HostComponent {
  readonly control = new FormControl<string | null>(null);
  readonly options = signal<readonly EntityOption[]>(OPTIONS);
  readonly error = signal<string | undefined>(undefined);
  readonly loading = signal(false);
  readonly filterLocally = signal(true);
  readonly queries: string[] = [];
  readonly selections: (EntityOption | null)[] = [];
}

describe('EntityComboboxComponent', () => {
  let fixture: ComponentFixture<HostComponent>;

  function setup(): HostComponent {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  function input(): HTMLInputElement {
    return fixture.nativeElement.querySelector('input[role="combobox"]');
  }
  function list(): HTMLElement {
    return fixture.nativeElement.querySelector('[role="listbox"]');
  }
  function options(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('[role="option"]'));
  }
  function key(k: string): KeyboardEvent {
    const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    input().dispatchEvent(event);
    fixture.detectChanges();
    return event;
  }
  function type(text: string): void {
    input().value = text;
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
  }
  function activeLabel(): string | undefined {
    const id = input().getAttribute('aria-activedescendant');
    return id ? fixture.nativeElement.querySelector(`#${id}`)?.querySelector('.combobox__option-label')?.textContent : undefined;
  }

  it('wires the combobox ARIA contract', () => {
    setup();
    const label = fixture.nativeElement.querySelector('label') as HTMLLabelElement;
    expect(label.textContent?.trim()).toBe('Builder');
    expect(label.htmlFor).toBe(input().id);
    expect(input().getAttribute('aria-controls')).toBe(list().id);
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(input().getAttribute('aria-autocomplete')).toBe('list');
    expect(input().getAttribute('aria-describedby')).toContain('-hint');
    expect(list().hidden).toBe(true);
  });

  it('ArrowDown opens the list, ↓/↑ move (wrapping) and Enter selects', () => {
    const host = setup();
    expect(key('ArrowDown').defaultPrevented).toBe(true);
    expect(input().getAttribute('aria-expanded')).toBe('true');
    expect(list().hidden).toBe(false);
    expect(activeLabel()).toBe('Elite Craft Builders');

    key('ArrowDown');
    expect(activeLabel()).toBe('Bowness Homes');
    key('ArrowDown');
    key('ArrowDown');
    expect(activeLabel()).toBe('Elite Craft Builders'); // wrapped
    key('ArrowUp');
    expect(activeLabel()).toBe('Crafted Infill Co.'); // wrapped back

    expect(key('Enter').defaultPrevented).toBe(true);
    expect(host.control.value).toBe('b-333');
    expect(host.selections).toEqual([OPTIONS[2]]);
    expect(input().value).toBe('Crafted Infill Co.');
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(input().hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('typing filters, emits the query and Enter picks the first match', () => {
    const host = setup();
    type('bow');
    expect(host.queries).toEqual(['bow']);
    expect(options().map((o) => o.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Bowness Homes, Calgary']);
    expect(activeLabel()).toBe('Bowness Homes');
    key('Enter');
    expect(host.control.value).toBe('b-222');
  });

  it('Esc closes the list and restores the selected label without changing the value', () => {
    const host = setup();
    host.control.setValue('b-111');
    fixture.detectChanges();
    expect(input().value).toBe('Elite Craft Builders');

    type('zzz');
    expect(options()).toEqual([]);
    expect(list().textContent).toContain('No matches');
    const esc = key('Escape');
    expect(esc.defaultPrevented).toBe(true);
    expect(input().getAttribute('aria-expanded')).toBe('false');
    expect(input().value).toBe('Elite Craft Builders');
    expect(host.control.value).toBe('b-111');
  });

  it('lets Esc bubble when there is nothing to close', () => {
    setup();
    expect(key('Escape').defaultPrevented).toBe(false);
  });

  it('Enter with the list closed does nothing (lets a form submit)', () => {
    const host = setup();
    expect(key('Enter').defaultPrevented).toBe(false);
    expect(host.control.value).toBeNull();
  });

  it('selects with the mouse without losing focus first', () => {
    const host = setup();
    key('ArrowDown');
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    options()[1].dispatchEvent(down);
    fixture.detectChanges();
    expect(down.defaultPrevented).toBe(true);
    expect(host.control.value).toBe('b-222');
  });

  it('clearing the text and leaving the field clears the value', () => {
    const host = setup();
    host.control.setValue('b-222');
    fixture.detectChanges();
    type('');
    input().dispatchEvent(new Event('blur'));
    fixture.detectChanges();
    expect(host.control.value).toBeNull();
    expect(host.selections).toEqual([null]);
    expect(host.control.touched).toBe(true);
  });

  it('keeps the picked label when the host swaps the options (server search)', () => {
    const host = setup();
    type('elite');
    key('Enter');
    host.options.set([]);
    fixture.detectChanges();
    expect(input().value).toBe('Elite Craft Builders');
  });

  it('Enter does not pick a stale, hidden option while a server search is loading', () => {
    const host = setup();
    host.filterLocally.set(false);
    fixture.detectChanges();
    type('bow'); // server mode: the previous (unfiltered) options are still in `options`
    expect(activeLabel()).toBe('Elite Craft Builders');

    host.loading.set(true);
    fixture.detectChanges();
    expect(options()).toEqual([]);
    expect(list().textContent).toContain('Searching');
    expect(input().hasAttribute('aria-activedescendant')).toBe(false);
    expect(key('Enter').defaultPrevented).toBe(false);
    expect(host.control.value).toBeNull();
    expect(host.selections).toEqual([]);

    host.options.set([OPTIONS[1]]);
    host.loading.set(false);
    fixture.detectChanges();
    expect(activeLabel()).toBe('Bowness Homes');
    key('Enter');
    expect(host.control.value).toBe('b-222');
  });

  it('server search: options swapped after typing, Enter picks the first new option', () => {
    const host = setup();
    host.filterLocally.set(false);
    host.options.set([]);
    fixture.detectChanges();
    type('cra');
    expect(input().hasAttribute('aria-activedescendant')).toBe(false);

    host.options.set([OPTIONS[2], OPTIONS[0]]);
    fixture.detectChanges();
    expect(activeLabel()).toBe('Crafted Infill Co.');
    key('Enter');
    expect(host.control.value).toBe('b-333');
  });

  it('never shows a raw id for an unknown value', () => {
    const host = setup();
    host.control.setValue('b-999');
    fixture.detectChanges();
    expect(input().value).toBe('');
  });

  it('respects the disabled state and shows errors', () => {
    const host = setup();
    host.control.disable();
    host.error.set('Pick a builder');
    fixture.detectChanges();
    expect(input().disabled).toBe(true);
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(input().getAttribute('aria-describedby')).toContain('-error');
    expect(fixture.nativeElement.textContent).toContain('Pick a builder');
  });
});
