import { Component, DebugElement } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { Store } from '@ngxs/store';
import { describe, expect, it, vi } from 'vitest';
import { GoToStep } from '../../../features/wizard/wizard.actions';
import { WizardBackComponent } from './wizard-back.component';

@Component({
  standalone: true,
  imports: [WizardBackComponent],
  template: `<app-wizard-back [label]="label" [link]="link" [step]="step" />`,
})
class HostComponent {
  label = '← Back to details';
  link = '/estimate/details';
  step: 1 | 2 | 3 | null = 3;
}

/**
 * FE-10: the shared wizard back bar renders the label/link and dispatches
 * GoToStep when a step is given (preserving the old per-page goBack()
 * behavior), skipping the dispatch when absent.
 */
describe('WizardBackComponent', () => {
  let fixture: ComponentFixture<HostComponent>;
  let store: { dispatch: ReturnType<typeof vi.fn> };

  function setup(step: 1 | 2 | 3 | null): void {
    store = { dispatch: vi.fn() };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HostComponent],
      providers: [provideRouter([]), { provide: Store, useValue: store }],
    });
    fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.step = step;
    fixture.detectChanges();
  }

  function anchor(): HTMLAnchorElement | null {
    return fixture.nativeElement.querySelector('.wizard-backbar-btn');
  }

  function backComponent(): WizardBackComponent {
    const debug: DebugElement = fixture.debugElement.query(By.directive(WizardBackComponent));
    return debug.componentInstance as WizardBackComponent;
  }

  /** Invokes the anchor's click handler without triggering real navigation. */
  function clickBack(): void {
    (backComponent() as unknown as { onBack(): void }).onBack();
  }

  it('renders the label and link target', () => {
    setup(3);
    const a = anchor();
    expect(a?.textContent?.trim()).toBe('← Back to details');
    expect(a?.getAttribute('href')).toBe('/estimate/details');
  });

  it('dispatches GoToStep(step) on click when step is given', () => {
    setup(2);
    clickBack();
    expect(store.dispatch).toHaveBeenCalledTimes(1);
    const action = store.dispatch.mock.calls[0][0];
    expect(action).toBeInstanceOf(GoToStep);
    expect(action.step).toBe(2);
  });

  it('skips the GoToStep dispatch when no step is given', () => {
    setup(null);
    clickBack();
    expect(store.dispatch).not.toHaveBeenCalled();
  });
});
