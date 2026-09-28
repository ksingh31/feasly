import { ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { expect } from 'vitest';
import { AddressAutocompleteComponent } from '../components/address-autocomplete';

/**
 * D-03 shared entry-point harness: drives the <app-address-autocomplete>
 * inside a host entry point (landing hero for new-build + reno, embed
 * shell) and asserts the Calgary-only gate renders — without duplicating
 * the component's own copy tests. Reno has no address input of its own:
 * reno users must pick a property through the landing hero first, so the
 * same gate covers all three entries.
 */
export async function expectSharedCalgaryGate(
  fixture: ComponentFixture<unknown>,
): Promise<void> {
  const autoDe = fixture.debugElement.query(By.directive(AddressAutocompleteComponent));
  expect(autoDe, 'entry point must render the shared address component').toBeTruthy();
  const auto = autoDe.componentInstance as AddressAutocompleteComponent;
  auto.query.setValue('123 King St W, Toronto');
  // Poll for the terminal error state — never a fixed sleep (flakes under
  // parallel-worker load). Pre-search status is 'idle', so waiting on
  // 'error' has no debounce race and can't miss a fast 'searching' phase.
  const deadline = Date.now() + 10000;
  while (auto.status() !== 'error' && Date.now() < deadline) {
    fixture.detectChanges();
    await new Promise((r) => setTimeout(r, 25));
  }
  fixture.detectChanges();
  expect(auto.status()).toBe('error');
  expect(auto.outOfCoverage()).toBe(true);
  const box = fixture.nativeElement.querySelector('.ac-out-of-coverage');
  expect(box?.querySelector('.ac-ooc-heading')?.textContent).toBe(
    'We only support Calgary right now.',
  );
  expect(box?.textContent).toContain("Feasly's cost data covers Calgary addresses only");
}
