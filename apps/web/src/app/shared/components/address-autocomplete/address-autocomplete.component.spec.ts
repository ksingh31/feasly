import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PropertyRecord } from '@feasly/contracts';
import { provideApi } from '../../../core/api';
import { providePropertyData } from '../../../core/api/property-data.service';
import { ConfigService } from '../../../core/config';
import { AddressAutocompleteComponent } from './address-autocomplete.component';

/**
 * FE1-001: autocomplete behavior — 3-char gate, config debounce, keyboard
 * navigation, empty/no-result/error states.
 *
 * Uses real timers: the harness flushes 1ms debounce and 1ms mock latency,
 * so a short sleep settles every async leg.
 */
  /**
   * Waits until the debounced search settles (results in or terminal state),
   * instead of assuming a fixed sleep is enough under CI load.
   */
  async function awaitSearchSettled(
    fixture: ComponentFixture<AddressAutocompleteComponent>,
  ): Promise<void> {
    const component = fixture.componentInstance;
    const deadline = Date.now() + 2000;
    // Let the debounce kick the search off before watching for it to settle.
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (;;) {
      fixture.detectChanges();
      if (component.status() !== 'searching') return;
      if (Date.now() > deadline) throw new Error('autocomplete did not settle');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

describe('AddressAutocompleteComponent', () => {
  let httpMock: HttpTestingController;

  const testConfig = {
    api: { useMockApi: true },
    timings: { debounceMs: 1, mockLatencyMinMs: 1, mockLatencyMaxMs: 1 },
    limits: { autocompleteSuggestionLimit: 6 },
    // Component behavior is specified against the mock harness (FE1-002);
    // the live City client is covered by its own service spec.
    propertyData: { source: 'mock' },
  };

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AddressAutocompleteComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        providePropertyData(),
        provideApi(),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush(testConfig);
    await pending;
  });

  function create(): ComponentFixture<AddressAutocompleteComponent> {
    const fixture = TestBed.createComponent(AddressAutocompleteComponent);
    fixture.detectChanges();
    return fixture;
  }

  async function type(
    fixture: ComponentFixture<AddressAutocompleteComponent>,
    text: string,
  ): Promise<void> {
    fixture.componentInstance.query.setValue(text);
    // Poll for the debounced search to settle instead of a fixed sleep:
    // under parallel-worker load a fixed sleep can lose the race and flake.
    await awaitSearchSettled(fixture);
  }

  function inputEl(fixture: ComponentFixture<AddressAutocompleteComponent>): HTMLInputElement {
    return fixture.nativeElement.querySelector('.ac-input');
  }

  function key(fixture: ComponentFixture<AddressAutocompleteComponent>, keyName: string): void {
    inputEl(fixture).dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true }));
    fixture.detectChanges();
  }

  it('does not search for queries under 3 characters', async () => {
    const fixture = create();
    await type(fixture, 'ab');
    expect(fixture.componentInstance.suggestions()).toEqual([]);
    expect(fixture.componentInstance.searched()).toBe(false);
  });

  it('shows suggestions for 3+ characters (max 6)', async () => {
    const fixture = create();
    await type(fixture, '14 st');
    const options = fixture.nativeElement.querySelectorAll('.ac-option');
    expect(options.length).toBeGreaterThan(0);
    expect(options.length).toBeLessThanOrEqual(6);
    expect(inputEl(fixture).getAttribute('aria-expanded')).toBe('true');
  });

  it('keyboard: ArrowDown + Enter selects the highlighted suggestion', async () => {
    const fixture = create();
    const component = fixture.componentInstance;
    let emitted: PropertyRecord | undefined;
    component.selected.subscribe((p) => (emitted = p));
    await type(fixture, '14 st');
    key(fixture, 'ArrowDown');
    key(fixture, 'Enter');
    await new Promise((resolve) => setTimeout(resolve, 25)); // getProperty latency
    expect(emitted?.addressKey).toBe('calgary-1234-14-st-nw');
  });

  it('Escape dismisses the dropdown', async () => {
    const fixture = create();
    await type(fixture, '14 st');
    expect(fixture.componentInstance.open()).toBe(true);
    key(fixture, 'Escape');
    expect(fixture.componentInstance.open()).toBe(false);
  });

  it('shows the no-results copy when a 3+ char query matches nothing', async () => {
    const fixture = create();
    await type(fixture, 'zzz nowhere');
    const empty = fixture.nativeElement.querySelector('.ac-empty');
    expect(empty?.textContent).toContain("couldn't find that address");
  });

  it('pickTop is false with no suggestions; nudgeIfEmpty shows the hint', async () => {
    const fixture = create();
    const component = fixture.componentInstance;
    expect(component.pickTop()).toBe(false);
    component.nudgeIfEmpty();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.form-error')?.textContent).toContain(
      'Enter your Calgary address',
    );
  });

  it('Enter with no highlight emits submitted (parent decides)', async () => {
    const fixture = create();
    const component = fixture.componentInstance;
    let submitted = false;
    component.submitted.subscribe(() => (submitted = true));
    await type(fixture, '14 st');
    key(fixture, 'Enter');
    expect(submitted).toBe(true);
  });

  it('input uses at least 16px font (no iOS auto-zoom)', async () => {
    const fixture = create();
    const size = getComputedStyle(inputEl(fixture)).fontSize;
    expect(parseFloat(size)).toBeGreaterThanOrEqual(16);
  });

  it('drops a superseded pick response instead of emitting twice', async () => {
    const fixture = create();
    const component = fixture.componentInstance;
    const emitted: PropertyRecord[] = [];
    await type(fixture, '14 st');
    await awaitSearchSettled(fixture);
    component.selected.subscribe((p) => emitted.push(p));
    expect(component.suggestions().length).toBeGreaterThan(0);
    // Two rapid picks of the same address: the first response emits and the
    // second (superseded) response is dropped — the parent navigates once.
    // (The mock only resolves one address key, so both picks use it.)
    component.choose(0);
    component.choose(0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(emitted.length).toBe(1);
    expect(emitted[0].addressKey).toBe('calgary-1234-14-st-nw');
  });

});

describe('AddressAutocompleteComponent with a slow backend', () => {
  // Same harness as above, but the mock backend (40ms) is far slower than
  // the debounce (1ms), so a query change provably lands before an
  // in-flight pick resolves.
  const slowConfig = {
    api: { useMockApi: true },
    timings: { debounceMs: 1, mockLatencyMinMs: 40, mockLatencyMaxMs: 40 },
    limits: { autocompleteSuggestionLimit: 6 },
    propertyData: { source: 'mock' },
  };

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AddressAutocompleteComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        providePropertyData(),
        provideApi(),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    http.expectOne('/assets/config/app-config.json').flush(slowConfig);
    await pending;
  });

  it('drops a pick response when the query changes before it resolves', async () => {
    const fixture = TestBed.createComponent(AddressAutocompleteComponent);
    fixture.detectChanges();
    const component = fixture.componentInstance;
    const emitted: PropertyRecord[] = [];
    component.selected.subscribe((p) => emitted.push(p));
    component.query.setValue('14 st');
    await awaitSearchSettled(fixture);
    expect(component.suggestions().length).toBeGreaterThan(0);
    component.choose(0);
    // A new search abandons the in-flight pick; its late response is dropped.
    component.query.setValue('bridgeland');
    await awaitSearchSettled(fixture);
    // Let the abandoned resolve's latency elapse, then confirm silence.
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(emitted).toEqual([]);
  });
});
