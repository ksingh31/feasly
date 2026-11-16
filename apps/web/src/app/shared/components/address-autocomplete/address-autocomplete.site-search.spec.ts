import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import type { AutocompleteResponse, PropertyRecord } from '@feasly/contracts';
import { API_SERVICE } from '../../../core/api';
import { ConfigService } from '../../../core/config';
import { AddressAutocompleteComponent } from './address-autocomplete.component';

/**
 * #783 site search: one box suggests Communities (bundled index, no request)
 * and Addresses (backend autocomplete) in a grouped WAI-ARIA listbox.
 */
const ALTA_ADDRESSES: AutocompleteResponse = {
  suggestions: [
    { addressKey: 'k1', address: '3204 ALTA VISTA RD SW', community: 'ALTADORE' },
    { addressKey: 'k2', address: '3210 ALTA VISTA RD SW', community: 'ALTADORE' },
  ],
};

describe('AddressAutocompleteComponent site search (#783)', () => {
  let autocomplete: ReturnType<typeof vi.fn>;
  let getProperty: ReturnType<typeof vi.fn>;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    autocomplete = vi.fn((_q: string) => of(ALTA_ADDRESSES));
    getProperty = vi.fn((key: string) => of({ addressKey: key } as unknown as PropertyRecord));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AddressAutocompleteComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: API_SERVICE, useValue: { autocomplete, getProperty } },
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    http.expectOne('/assets/config/app-config.json').flush({ timings: { debounceMs: 1 } });
    await pending;
    // No route table here: every navigation is observed, never performed.
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
  });

  afterEach(() => vi.restoreAllMocks());

  function create(opts: { communities?: boolean; navigateAddresses?: boolean } = {}) {
    const fixture = TestBed.createComponent(AddressAutocompleteComponent);
    fixture.componentRef.setInput('communities', opts.communities ?? true);
    fixture.componentRef.setInput('navigateAddresses', opts.navigateAddresses ?? false);
    fixture.detectChanges();
    return fixture;
  }

  /** Polls (with a deadline) until the debounced search has answered. */
  async function type(fixture: ComponentFixture<AddressAutocompleteComponent>, text: string, calls: number) {
    fixture.componentInstance.query.setValue(text);
    await vi.waitFor(
      () => {
        expect(autocomplete).toHaveBeenCalledTimes(calls);
        expect(fixture.componentInstance.status()).not.toBe('searching');
      },
      { timeout: 2000, interval: 5 },
    );
    fixture.detectChanges();
  }

  function el(fixture: ComponentFixture<AddressAutocompleteComponent>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  function key(fixture: ComponentFixture<AddressAutocompleteComponent>, name: string): void {
    el(fixture)
      .querySelector('.ac-input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }));
    fixture.detectChanges();
  }

  it('AC1: "alta" shows Altadore under Communities and matching addresses under Addresses', async () => {
    const fixture = create();
    await type(fixture, 'alta', 1);
    const groups = el(fixture).querySelectorAll('[role="listbox"] > [role="group"]');
    expect(groups.length).toBe(2);
    const [communities, addresses] = Array.from(groups);
    const label = (g: Element) => document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent?.trim();
    expect(label(communities!)).toBe('Communities');
    expect(label(addresses!)).toBe('Addresses');
    const communityNames = Array.from(communities!.querySelectorAll('[role="option"] .ac-option-address')).map(
      (n) => n.textContent?.trim(),
    );
    expect(communityNames[0]).toBe('Altadore');
    expect(addresses!.querySelectorAll('[role="option"]').length).toBe(2);
    expect(addresses!.textContent).toContain('3204 ALTA VISTA RD SW');
  });

  it('labels the box for addresses or communities', () => {
    const fixture = create();
    const input = el(fixture).querySelector('.ac-input') as HTMLInputElement;
    const label = el(fixture).querySelector(`label[for="${input.id}"]`);
    expect(label?.textContent?.trim()).toBe('Search an address or community');
    expect(input.placeholder).toBe('Address or community');
  });

  it('AC3: one request per debounced query, none for the community side', async () => {
    const fixture = create();
    const component = fixture.componentInstance;
    // Rapid keystrokes inside one debounce window collapse to one request.
    component.query.setValue('alt');
    component.query.setValue('alta');
    await type(fixture, 'alta', 1);
    expect(autocomplete).toHaveBeenCalledWith('alta');
    // Picking a community makes no request.
    component.choose(0);
    expect(autocomplete).toHaveBeenCalledTimes(1);
    expect(getProperty).not.toHaveBeenCalled();
  });

  it('AC2: arrows move across both groups, Enter on a community opens its guide', async () => {
    const fixture = create();
    await type(fixture, 'alta', 1);
    const component = fixture.componentInstance;
    const communityCount = component.communityMatches().length;
    expect(communityCount).toBeGreaterThan(0);
    key(fixture, 'ArrowDown');
    const input = el(fixture).querySelector('.ac-input')!;
    const active = document.getElementById(input.getAttribute('aria-activedescendant')!);
    expect(active?.textContent).toContain('Altadore');
    expect(active?.getAttribute('aria-selected')).toBe('true');
    key(fixture, 'Enter');
    expect(navigate).toHaveBeenCalledWith(['/communities', 'altadore']);
    expect(component.open()).toBe(false);
  });

  it('AC2: ArrowDown past the communities reaches the addresses; Enter resolves the address', async () => {
    const fixture = create();
    const picked: PropertyRecord[] = [];
    fixture.componentInstance.selected.subscribe((p) => picked.push(p));
    await type(fixture, 'alta', 1);
    const communityCount = fixture.componentInstance.communityMatches().length;
    for (let i = 0; i <= communityCount; i++) key(fixture, 'ArrowDown');
    const input = el(fixture).querySelector('.ac-input')!;
    expect(document.getElementById(input.getAttribute('aria-activedescendant')!)?.textContent).toContain(
      '3204 ALTA VISTA RD SW',
    );
    key(fixture, 'Enter');
    expect(getProperty).toHaveBeenCalledWith('k1');
    expect(picked).toHaveLength(1);
  });

  it('AC2: Escape closes the list and clears the highlight', async () => {
    const fixture = create();
    await type(fixture, 'alta', 1);
    key(fixture, 'ArrowDown');
    key(fixture, 'Escape');
    expect(el(fixture).querySelector('[role="listbox"]')).toBeNull();
    expect(el(fixture).querySelector('.ac-input')!.getAttribute('aria-activedescendant')).toBeNull();
  });

  it('Escape that closes the list stays inside the box; the next Escape passes through', async () => {
    const fixture = create();
    await type(fixture, 'alta', 1);
    const onDocEscape = vi.fn();
    document.addEventListener('keydown', onDocEscape);
    try {
      key(fixture, 'Escape');
      expect(onDocEscape).not.toHaveBeenCalled();
      key(fixture, 'Escape');
      expect(onDocEscape).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener('keydown', onDocEscape);
    }
  });

  it('nav search: an address pick opens the estimator deep link instead of resolving', async () => {
    const fixture = create({ navigateAddresses: true });
    await type(fixture, 'alta', 1);
    fixture.componentInstance.choose(fixture.componentInstance.communityMatches().length);
    expect(navigate).toHaveBeenCalledWith(['/'], {
      queryParams: { address: '3204 ALTA VISTA RD SW', src: 'site-search' },
    });
    expect(getProperty).not.toHaveBeenCalled();
  });

  it('community matches still show when the address search fails', async () => {
    autocomplete.mockImplementation(() => throwError(() => ({ code: 'UPSTREAM', message: 'x', retryable: true })));
    const fixture = create();
    await type(fixture, 'alta', 1);
    expect(fixture.componentInstance.status()).toBe('error');
    expect(el(fixture).querySelector('[role="listbox"]')?.textContent).toContain('Altadore');
  });

  it('shows no communities (flat list, address label) when the host leaves them off', async () => {
    const fixture = create({ communities: false });
    await type(fixture, 'alta', 1);
    expect(el(fixture).querySelector('[role="group"]')).toBeNull();
    expect(el(fixture).querySelectorAll('[role="option"]').length).toBe(2);
    expect(el(fixture).textContent).not.toContain('Altadore');
    expect(el(fixture).querySelector('label')?.textContent?.trim()).toBe('Your Calgary address');
  });

  it('a street address matches no community', async () => {
    const fixture = create();
    await type(fixture, '1412 prospect', 1);
    expect(fixture.componentInstance.communityMatches()).toEqual([]);
    expect(el(fixture).querySelector('[role="group"]')?.getAttribute('aria-labelledby')).toContain('addresses');
  });
});
