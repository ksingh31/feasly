import { Component } from '@angular/core';
import { RouterTestingModule } from '@angular/router/testing';
import { TestBed } from '@angular/core/testing';
import { TierSelectorComponent, type TierOption } from './tier-selector.component';

const OPTIONS: TierOption[] = [
  { id: 'standard', name: 'Standard', blurb: 'Quality essentials' },
  { id: 'premium', name: 'Premium', blurb: 'Upgraded finishes' },
  { id: 'luxury', name: 'Luxury', blurb: 'Top of the line' },
];

describe('TierSelectorComponent', () => {
  async function setup(selected: 'standard' | 'premium' | 'luxury' | null = 'standard') {
    await TestBed.configureTestingModule({
      imports: [RouterTestingModule, TierSelectorComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(TierSelectorComponent);
    fixture.componentRef.setInput('selected', selected);
    fixture.componentRef.setInput('options', OPTIONS);
    fixture.componentRef.setInput('label', 'Finish tier');
    fixture.detectChanges();
    return { fixture, comp: fixture.componentInstance };
  }

  it('marks the selected tier with aria-checked', async () => {
    const { fixture } = await setup('premium');
    const el: HTMLElement = fixture.nativeElement;
    const premium = el.querySelector('[data-tier="premium"]');
    expect(premium?.getAttribute('aria-checked')).toBe('true');
    expect(el.querySelector('[data-tier="standard"]')?.getAttribute('aria-checked')).toBe('false');
  });

  it('emits selectedChange on click', async () => {
    const { fixture, comp } = await setup('standard');
    let emitted: string | null = null;
    comp.selectedChange.subscribe((v) => (emitted = v));
    (fixture.nativeElement.querySelector('[data-tier="luxury"]') as HTMLElement).click();
    expect(emitted).toBe('luxury');
  });

  it('arrow keys move the selection', async () => {
    const { fixture, comp } = await setup('standard');
    let emitted: string | null = null;
    comp.selectedChange.subscribe((v) => (emitted = v));
    const group = fixture.nativeElement.querySelector('[role="radiogroup"]') as HTMLElement;
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(emitted).toBe('premium');
  });
});
