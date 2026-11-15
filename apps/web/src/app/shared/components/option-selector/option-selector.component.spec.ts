import { Component } from '@angular/core';
import { RouterTestingModule } from '@angular/router/testing';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { BasementOption, FinishTier, GarageOption } from '@feasly/contracts';
import {
  OptionSelectorComponent,
  type OptionCard,
  type TierOption,
} from './option-selector.component';

const TIER_OPTIONS: TierOption[] = [
  { id: 'standard', name: 'Standard', blurb: 'Quality essentials' },
  { id: 'premium', name: 'Premium', blurb: 'Upgraded finishes' },
  { id: 'luxury', name: 'Luxury', blurb: 'Top of the line' },
];

const GARAGE_OPTIONS: OptionCard<GarageOption>[] = [
  { id: 'none', name: 'No garage', blurb: 'No built-in garage' },
  { id: 'double', name: 'Double', blurb: 'Two-car garage' },
  { id: 'triple', name: 'Triple', blurb: 'Three-car garage' },
];

describe('OptionSelectorComponent', () => {
  async function setup<TId extends string>(
    options: readonly OptionCard<TId>[],
    selected: TId | null,
  ) {
    await TestBed.configureTestingModule({
      imports: [RouterTestingModule, OptionSelectorComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(OptionSelectorComponent<TId>);
    fixture.componentRef.setInput('selected', selected);
    fixture.componentRef.setInput('options', options);
    fixture.componentRef.setInput('label', 'Choose one');
    fixture.detectChanges();
    return { fixture, comp: fixture.componentInstance };
  }

  it('marks the selected option with aria-checked', async () => {
    const { fixture } = await setup(TIER_OPTIONS, 'premium' as FinishTier);
    const el: HTMLElement = fixture.nativeElement;
    const premium = el.querySelector('[data-option="premium"]');
    expect(premium?.getAttribute('aria-checked')).toBe('true');
    expect(el.querySelector('[data-option="standard"]')?.getAttribute('aria-checked')).toBe('false');
  });

  it('defaults to its own boxed section with an h2', async () => {
    const { fixture } = await setup(TIER_OPTIONS, 'premium' as FinishTier);
    const section: HTMLElement = fixture.nativeElement.querySelector('.option-section');
    expect(section.classList.contains('flat')).toBe(false);
    expect(section.querySelector('h2')?.textContent).toBe('Choose one');
  });

  it('flat variant (#508) drops the box and uses an h3 for use inside a parent card', async () => {
    const { fixture } = await setup(TIER_OPTIONS, 'premium' as FinishTier);
    fixture.componentRef.setInput('flat', true);
    fixture.detectChanges();
    const section: HTMLElement = fixture.nativeElement.querySelector('.option-section');
    expect(section.classList.contains('flat')).toBe(true);
    expect(section.querySelector('h2')).toBeNull();
    const h3 = section.querySelector('h3');
    expect(h3?.textContent).toBe('Choose one');
    expect(section.getAttribute('aria-labelledby')).toBe(h3?.id);
  });

  it('emits selectedChange on click', async () => {
    const { fixture, comp } = await setup(TIER_OPTIONS, 'standard' as FinishTier);
    let emitted: string | null = null;
    comp.selectedChange.subscribe((v) => (emitted = v));
    (fixture.nativeElement.querySelector('[data-option="luxury"]') as HTMLElement).click();
    expect(emitted).toBe('luxury');
  });

  it('arrow keys move the selection', async () => {
    const { fixture, comp } = await setup(TIER_OPTIONS, 'standard' as FinishTier);
    let emitted: string | null = null;
    comp.selectedChange.subscribe((v) => (emitted = v));
    const group = fixture.nativeElement.querySelector('[role="radiogroup"]') as HTMLElement;
    group.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(emitted).toBe('premium');
  });

  it('works with non-tier unions (garage options)', async () => {
    const { fixture, comp } = await setup(GARAGE_OPTIONS, 'double' as GarageOption);
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-option="double"]')?.getAttribute('aria-checked')).toBe('true');
    let emitted: GarageOption | null = null;
    comp.selectedChange.subscribe((v) => (emitted = v));
    (el.querySelector('[data-option="none"]') as HTMLElement).click();
    expect(emitted).toBe('none');
  });

  it('works with two-option unions (basement options)', async () => {
    const basementOptions: OptionCard<BasementOption>[] = [
      { id: 'unfinished', name: 'Unfinished', blurb: 'Basic basement' },
      { id: 'finished', name: 'Finished', blurb: 'Livable space' },
    ];
    const { comp } = await setup(basementOptions, 'unfinished' as BasementOption);
    let emitted: BasementOption | null = null;
    comp.selectedChange.subscribe((v) => (emitted = v));
    // ArrowLeft from the first option wraps to the last.
    comp.onKeydown(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(emitted).toBe('finished');
  });
});
