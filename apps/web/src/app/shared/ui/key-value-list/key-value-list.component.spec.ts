import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { KeyValueListComponent, type KeyValueItem } from './key-value-list.component';

@Component({
  standalone: true,
  imports: [KeyValueListComponent],
  template: `<ui-key-value-list [items]="items()" />`,
})
class HostComponent {
  items = signal<KeyValueItem[]>([
    { label: 'Builder', value: 'Elite Craft Builders' },
    { label: 'Email', value: 'marco@example.com', href: 'mailto:marco@example.com' },
    { label: 'Phone', value: '(403) 555-0100', href: 'tel:+14035550100' },
    { label: 'Lot size', value: null },
    { label: 'Leads', value: 0 },
  ]);
}

function setup() {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('KeyValueListComponent', () => {
  it('renders a description list with one dt/dd pair per item', () => {
    const { el } = setup();
    const rows = el.querySelectorAll('dl > .ui-kv__row');
    expect(rows).toHaveLength(5);
    expect(rows[0].querySelector('dt')?.textContent).toBe('Builder');
    expect(rows[0].querySelector('dd')?.textContent?.trim()).toBe('Elite Craft Builders');
  });

  it('renders tel:/mailto: links when an href is given', () => {
    const { el } = setup();
    const links = el.querySelectorAll('dd a');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('mailto:marco@example.com');
    expect(links[1].getAttribute('href')).toBe('tel:+14035550100');
  });

  it('shows the empty placeholder for a missing value but keeps 0', () => {
    const { el } = setup();
    const dds = el.querySelectorAll('dd');
    expect(dds[3].querySelector('.ui-kv__empty')?.textContent).toBe('—');
    expect(dds[4].textContent?.trim()).toBe('0');
  });

  it('re-renders when items change', () => {
    const { fixture, el } = setup();
    fixture.componentInstance.items.set([{ label: 'Status', value: 'Active' }]);
    fixture.detectChanges();
    expect(el.querySelectorAll('dt')).toHaveLength(1);
  });
});
