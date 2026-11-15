import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TechnicalIdsComponent } from './technical-ids.component';

describe('TechnicalIdsComponent (#538)', () => {
  let fixture: ComponentFixture<TechnicalIdsComponent>;
  const writeText = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    fixture = TestBed.createComponent(TechnicalIdsComponent);
    fixture.componentRef.setInput('ids', [
      { label: 'Invoice ID', value: 'inv-uuid' },
      { label: 'Lead ID', value: 'lead-uuid' },
    ]);
    fixture.detectChanges();
  });

  afterEach(() => writeText.mockClear());

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;

  it('is a collapsed disclosure labelled "Technical IDs"', () => {
    const details = el().querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent?.trim()).toBe('Technical IDs');
    expect(Array.from(el().querySelectorAll('dt')).map((d) => d.textContent?.trim())).toEqual([
      'Invoice ID',
      'Lead ID',
    ]);
  });

  it('copies an id with a labelled button and announces it', async () => {
    const buttons = el().querySelectorAll<HTMLButtonElement>('.technical-ids__copy');
    expect(buttons[1].getAttribute('aria-label')).toBe('Copy ID (Lead ID)');
    buttons[1].click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(writeText).toHaveBeenCalledWith('lead-uuid');
    expect(el().querySelector('[aria-live]')?.textContent?.trim()).toBe('ID copied');
  });
});
