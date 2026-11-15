import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { StatusChipComponent } from './status-chip.component';
import type { StatusDomain } from './status-dictionary';

@Component({
  standalone: true,
  imports: [StatusChipComponent],
  template: `<ui-status-chip
    [domain]="domain()"
    [status]="status()"
    [dot]="dot()"
    [label]="label()"
  />`,
})
class HostComponent {
  readonly domain = signal<StatusDomain>('invoice');
  readonly status = signal<string | null>('in_review');
  readonly dot = signal(false);
  readonly label = signal<string | undefined>(undefined);
}

describe('StatusChipComponent', () => {
  let fixture: ComponentFixture<HostComponent>;

  function setup(): HostComponent {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  function chip(): HTMLElement {
    return fixture.nativeElement.querySelector('.status-chip');
  }

  it('renders the dictionary label and tone class', () => {
    setup();
    expect(chip().textContent?.trim()).toBe('In review');
    expect(chip().classList).toContain('status-chip--warning');
  });

  it('updates when the status input changes', () => {
    const host = setup();
    host.status.set('paid');
    fixture.detectChanges();
    expect(chip().textContent?.trim()).toBe('Paid');
    expect(chip().classList).toContain('status-chip--success');
    expect(chip().classList).not.toContain('status-chip--warning');
  });

  it('renders a decorative dot only when asked', () => {
    const host = setup();
    expect(fixture.nativeElement.querySelector('.status-chip__dot')).toBeNull();
    host.dot.set(true);
    fixture.detectChanges();
    const dot = fixture.nativeElement.querySelector('.status-chip__dot');
    expect(dot).not.toBeNull();
    expect(dot.getAttribute('aria-hidden')).toBe('true');
    expect(chip().textContent?.trim()).toBe('In review');
  });

  it('accepts a label override while keeping the status tone', () => {
    const host = setup();
    host.label.set('Auto-charges in 3 days');
    fixture.detectChanges();
    expect(chip().textContent?.trim()).toBe('Auto-charges in 3 days');
    expect(chip().classList).toContain('status-chip--warning');
  });

  it('never renders a raw enum for an unknown status', () => {
    const host = setup();
    host.domain.set('builder');
    host.status.set('on_hold');
    fixture.detectChanges();
    expect(chip().textContent?.trim()).toBe('On hold');
    expect(chip().classList).toContain('status-chip--neutral');
  });
});
