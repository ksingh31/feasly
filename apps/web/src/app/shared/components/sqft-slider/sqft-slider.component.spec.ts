import { Component } from '@angular/core';
import { RouterTestingModule } from '@angular/router/testing';
import { TestBed } from '@angular/core/testing';
import { SqftSliderComponent } from './sqft-slider.component';

describe('SqftSliderComponent', () => {
  async function setup(inputs: Partial<{
    value: number; min: number; max: number; step: number; label: string; hint: string; unit: string;
  }> = {}) {
    await TestBed.configureTestingModule({
      imports: [RouterTestingModule, SqftSliderComponent],
    }).compileComponents();
    const fixture = TestBed.createComponent(SqftSliderComponent);
    const comp = fixture.componentInstance;
    fixture.componentRef.setInput('value', inputs.value ?? 2000);
    fixture.componentRef.setInput('min', inputs.min ?? 800);
    fixture.componentRef.setInput('max', inputs.max ?? 6000);
    fixture.componentRef.setInput('step', inputs.step ?? 50);
    fixture.componentRef.setInput('label', inputs.label ?? 'Living area');
    fixture.componentRef.setInput('unit', inputs.unit ?? 'sq ft');
    if (inputs.hint) fixture.componentRef.setInput('hint', inputs.hint);
    fixture.detectChanges();
    return { fixture, comp };
  }

  it('renders the label and formatted value', async () => {
    const { fixture } = await setup({ value: 2500 });
    const el: HTMLElement = fixture.nativeElement;
    expect(el.textContent).toContain('Living area');
    expect(el.textContent).toContain('2,500 sq ft');
  });

  it('clamps out-of-range input to [min, max]', async () => {
    const { fixture, comp } = await setup({ value: 2000, min: 800, max: 6000 });
    let emitted = 0;
    comp.valueChange.subscribe((v: number) => (emitted = v));
    const input = fixture.nativeElement.querySelector('input[type="range"]') as HTMLInputElement;
    input.value = '99999';
    input.dispatchEvent(new Event('input'));
    expect(emitted).toBe(6000);
  });

  it('rounds fractional values to whole numbers', async () => {
    const { fixture, comp } = await setup();
    let emitted = 0;
    comp.valueChange.subscribe((v: number) => (emitted = v));
    const input = fixture.nativeElement.querySelector('input[type="range"]') as HTMLInputElement;
    // valueAsNumber reflects the stepped value; emulate via direct handler call
    comp.onInput({ target: { valueAsNumber: 2000.6 } } as unknown as Event);
    expect(emitted).toBe(2001);
    expect(Number.isInteger(emitted)).toBe(true);
  });
});
