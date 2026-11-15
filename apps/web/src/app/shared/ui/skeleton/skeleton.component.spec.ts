import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { SkeletonComponent, type SkeletonVariant } from './skeleton.component';

@Component({
  standalone: true,
  imports: [SkeletonComponent],
  template: `<ui-skeleton [variant]="variant()" [count]="count()" [label]="label()" />`,
})
class HostComponent {
  variant = signal<SkeletonVariant>('text');
  count = signal(3);
  label = signal('Loading');
}

function setup(init?: (h: HostComponent) => void) {
  TestBed.configureTestingModule({ imports: [HostComponent] });
  const fixture = TestBed.createComponent(HostComponent);
  init?.(fixture.componentInstance);
  fixture.detectChanges();
  const root = (): HTMLElement => fixture.nativeElement.querySelector('ui-skeleton');
  return { fixture, root };
}

describe('SkeletonComponent', () => {
  it('is a polite, busy status region with a screen-reader label', () => {
    const { root } = setup((h) => h.label.set('Loading leads'));
    expect(root().getAttribute('role')).toBe('status');
    expect(root().getAttribute('aria-live')).toBe('polite');
    expect(root().getAttribute('aria-busy')).toBe('true');
    expect(root().querySelector('.sr-only')?.textContent).toBe('Loading leads');
    expect(root().querySelector('.ui-skeleton__bars')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders `count` text lines by default', () => {
    const { root } = setup();
    expect(root().querySelectorAll('.ui-skeleton__bar')).toHaveLength(3);
    expect(root().querySelector('.ui-skeleton__bars')?.classList).toContain('ui-skeleton__bars--text');
  });

  it('renders rows for the rows variant (5-row table skeleton)', () => {
    const { root } = setup((h) => {
      h.variant.set('rows');
      h.count.set(5);
    });
    expect(root().querySelectorAll('.ui-skeleton__bar')).toHaveLength(5);
    expect(root().querySelector('.ui-skeleton__bars')?.classList).toContain('ui-skeleton__bars--rows');
  });

  it('renders a single placeholder for the block variant', () => {
    const { root } = setup((h) => {
      h.variant.set('block');
      h.count.set(4);
    });
    expect(root().querySelectorAll('.ui-skeleton__bar')).toHaveLength(1);
  });

  it('clamps a zero or negative count to one bar', () => {
    const { root } = setup((h) => h.count.set(0));
    expect(root().querySelectorAll('.ui-skeleton__bar')).toHaveLength(1);
  });
});
