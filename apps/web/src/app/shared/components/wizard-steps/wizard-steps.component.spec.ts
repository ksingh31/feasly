import { Component } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '../../../core/config';
import { WizardStepsComponent } from './wizard-steps.component';

/**
 * Wizard stepper regression spec (W3, 2026-09-28).
 *
 * The stepper must always render the full three-step flow, with labels
 * from config copy. #507: 1 Address → 2 Your home → 3 Estimate.
 */
@Component({
  standalone: true,
  imports: [WizardStepsComponent],
  template: '<app-wizard-steps [current]="3" />',
})
class HostComponent {}

describe('WizardStepsComponent', () => {
  let fixture: ComponentFixture<HostComponent>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: vi.fn().mockReturnValue({
              wizard: {
                stepAddress: 'Address',
                stepScope: 'Your home',
                stepEstimate: 'Estimate',
              },
            }),
          },
        },
      ],
    });
    fixture = TestBed.createComponent(HostComponent);
    fixture.detectChanges();
  });

  it('renders all three steps in order', () => {
    const labels = Array.from(
      fixture.nativeElement.querySelectorAll('.step-label'),
      (el: Element) => el.textContent?.trim(),
    );
    expect(labels).toEqual(['Address', 'Your home', 'Estimate']);
  });

  it('marks the current step', () => {
    const current = fixture.nativeElement.querySelector('.step-current .step-label');
    expect(current?.textContent?.trim()).toBe('Estimate');
  });
});
