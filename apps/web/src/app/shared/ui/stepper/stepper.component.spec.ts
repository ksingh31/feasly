import { Component, signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import {
  INVOICE_STEPS,
  type StepperModel,
  invoiceStepperModel,
  leadStepperModel,
  stepStates,
} from './stepper';
import { StepperComponent } from './stepper.component';

describe('stepStates', () => {
  it('marks earlier steps complete, the current one current, later upcoming', () => {
    expect(stepStates(INVOICE_STEPS, 'charged')).toEqual(['complete', 'complete', 'current', 'upcoming']);
    expect(stepStates(INVOICE_STEPS, null)).toEqual(['upcoming', 'upcoming', 'upcoming', 'upcoming']);
    expect(stepStates(INVOICE_STEPS, 'nope')).toEqual(['upcoming', 'upcoming', 'upcoming', 'upcoming']);
  });
});

describe('leadStepperModel', () => {
  it('maps admin quoting and builder quoted to the same step', () => {
    expect(leadStepperModel('quoting').current).toBe('quoted');
    expect(leadStepperModel('quoted').current).toBe('quoted');
  });

  it('resolves the outcome step to Won or Lost with the dictionary tone', () => {
    expect(leadStepperModel('won')).toMatchObject({ current: 'outcome', currentLabel: 'Won', tone: 'success' });
    expect(leadStepperModel('lost')).toMatchObject({ current: 'outcome', currentLabel: 'Lost', tone: 'neutral' });
  });

  it('unknown status → nothing started', () => {
    expect(leadStepperModel(undefined)).toMatchObject({ current: null, tone: 'neutral' });
  });
});

describe('invoiceStepperModel', () => {
  it.each([
    ['draft', null, 'neutral', undefined],
    ['in_review', 'review', 'warning', undefined],
    ['disputed', 'review', 'paused', 'Disputed'],
    ['finalized', 'charged', 'info', undefined],
    ['failed', 'charged', 'danger', 'Charge failed'],
    ['paid', 'paid', 'success', undefined],
    ['void', 'issued', 'neutral', 'Void'],
  ])('%s → step %s, tone %s', (status, current, tone, currentLabel) => {
    const model = invoiceStepperModel(status);
    expect(model.current).toBe(current);
    expect(model.tone).toBe(tone);
    expect(model.currentLabel).toBe(currentLabel);
  });
});

@Component({
  standalone: true,
  imports: [StepperComponent],
  template: `<ui-stepper [model]="model()" label="Invoice progress" />`,
})
class HostComponent {
  readonly model = signal<StepperModel>(invoiceStepperModel('failed'));
}

describe('StepperComponent', () => {
  let fixture: ComponentFixture<HostComponent>;

  function setup(): HostComponent {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [HostComponent] });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  function steps(): HTMLElement[] {
    return Array.from(fixture.nativeElement.querySelectorAll('.stepper__step'));
  }

  it('renders an ordered list with aria-current on the current step', () => {
    setup();
    const list = fixture.nativeElement.querySelector('ol') as HTMLElement;
    expect(list.getAttribute('aria-label')).toBe('Invoice progress');
    expect(list.classList).toContain('stepper--danger');
    expect(steps().map((s) => s.querySelector('.stepper__label')?.textContent)).toEqual([
      'Issued',
      'Review window',
      'Charge failed',
      'Paid',
    ]);
    expect(steps().map((s) => s.getAttribute('aria-current'))).toEqual([null, null, 'step', null]);
  });

  it('speaks each step state for screen readers', () => {
    setup();
    expect(steps().map((s) => s.querySelector('.sr-only')?.textContent)).toEqual([
      '(Completed)',
      '(Completed)',
      '(Current)',
      '(Upcoming)',
    ]);
  });

  it('updates when the model changes', () => {
    const host = setup();
    host.model.set(leadStepperModel('contacted'));
    fixture.detectChanges();
    expect(steps().map((s) => s.className.split(' ')[1])).toEqual([
      'stepper__step--complete',
      'stepper__step--current',
      'stepper__step--upcoming',
      'stepper__step--upcoming',
    ]);
    expect(steps()[3].querySelector('.stepper__label')?.textContent).toBe('Won/Lost');
  });
});
