import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Location } from '@angular/common';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideStore } from '@ngxs/store';
import { of } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommunityMatchRequest } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { mockCommunityMatch } from '../../core/api/mock-data';
import { ConfigService } from '../../core/config';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import { FindACommunityPageComponent } from './find-a-community-page.component';
import { FindCommunitySelectionState, FindCommunityState } from './find-community.state';

const DEBOUNCE = DEFAULT_APP_CONFIG.limits.communityMatchDebounceMs;

describe('FindACommunityPageComponent (#779)', () => {
  let harness: RouterTestingHarness;
  let api: { matchCommunities: ReturnType<typeof vi.fn> };

  async function setup(url = '/find-a-community'): Promise<void> {
    api = {
      matchCommunities: vi.fn((req: CommunityMatchRequest) => of(mockCommunityMatch(req))),
    };
    TestBed.resetTestingModule();
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => s.remove());
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'find-a-community', component: FindACommunityPageComponent }]),
        provideLocationMocks(),
        provideStore([FindCommunitySelectionState, FindCommunityState]),
        { provide: API_SERVICE, useValue: api },
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush({});
    await pending;
    harness = await RouterTestingHarness.create();
    vi.useFakeTimers();
    await harness.navigateByUrl(url, FindACommunityPageComponent);
    harness.detectChanges();
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  const el = (): HTMLElement => harness.routeNativeElement as HTMLElement;
  const chip = (key: string): HTMLButtonElement =>
    el().querySelector(`[data-chip="${key}"]`) as HTMLButtonElement;
  function settle(): void {
    vi.advanceTimersByTime(DEBOUNCE + 1);
    harness.detectChanges();
  }

  it('renders the four chip groups as toggle buttons, unpressed, and asks for a priority', async () => {
    await setup();
    const groups = [...el().querySelectorAll('.find-group-title')].map((h) => h.textContent?.trim());
    expect(groups).toEqual(['Schools', 'Getting around', 'Lifestyle', 'Your build']);
    expect(chip('parks').getAttribute('aria-pressed')).toBe('false');
    expect(chip('wide-lot').textContent).toContain('Wider lots (50 ft+)');
    settle();
    expect(api.matchCommunities).not.toHaveBeenCalled();
    expect(el().querySelector('.find-status')?.textContent).toContain('Pick at least one priority');
    expect(document.querySelector('script[type="application/ld+json"]')?.textContent).toContain(
      'Find a Calgary infill community that fits',
    );
  });

  it('tap once = Nice to have, twice = Must have, three times = off', async () => {
    await setup();
    chip('parks').click();
    harness.detectChanges();
    expect(chip('parks').getAttribute('aria-pressed')).toBe('true');
    expect(chip('parks').textContent).toContain('Nice to have');
    chip('parks').click();
    harness.detectChanges();
    expect(chip('parks').textContent).toContain('Must have');
    chip('parks').click();
    harness.detectChanges();
    expect(chip('parks').getAttribute('aria-pressed')).toBe('false');
  });

  it('AC1: a burst of priority changes re-ranks with exactly one request', async () => {
    await setup();
    chip('parks').click();
    chip('parks').click();
    chip('designated-schools').click();
    chip('lots-listed-now').click();
    harness.detectChanges();
    expect(api.matchCommunities).not.toHaveBeenCalled();
    settle();
    expect(api.matchCommunities).toHaveBeenCalledTimes(1);
    expect(api.matchCommunities).toHaveBeenCalledWith({
      priorities: [
        { key: 'parks', importance: 'must' },
        { key: 'designated-schools', importance: 'nice' },
      ],
      filters: { lotsListedNow: true },
      limit: 30,
    });
    expect(el().querySelectorAll('.find-card').length).toBeGreaterThan(0);

    chip('pools').click();
    harness.detectChanges();
    settle();
    expect(api.matchCommunities).toHaveBeenCalledTimes(2);

    // Taps that net out to the current selection send nothing.
    chip('libraries').click();
    chip('libraries').click();
    chip('libraries').click();
    harness.detectChanges();
    settle();
    expect(api.matchCommunities).toHaveBeenCalledTimes(2);
  });

  it('writes the selection into the link hash', async () => {
    await setup();
    chip('parks').click();
    chip('tree-cover').click();
    chip('tree-cover').click();
    harness.detectChanges();
    expect(TestBed.inject(Location).path(true)).toBe('/find-a-community#p=parks:n,tree-cover:m');
  });

  it('AC2: a shared link restores the priorities and the ranking', async () => {
    await setup('/find-a-community#p=designated-schools:m,parks:n&f=wide-lot');
    expect(chip('designated-schools').textContent).toContain('Must have');
    expect(chip('parks').textContent).toContain('Nice to have');
    expect(chip('wide-lot').getAttribute('aria-pressed')).toBe('true');
    settle();
    expect(api.matchCommunities).toHaveBeenCalledTimes(1);
    const request = api.matchCommunities.mock.calls[0]![0] as CommunityMatchRequest;
    expect(request.priorities).toEqual([
      { key: 'designated-schools', importance: 'must' },
      { key: 'parks', importance: 'nice' },
    ]);
    const expected = mockCommunityMatch(request).results.map((r) => r.name);
    const shown = [...el().querySelectorAll('.find-card-name')].map((h) => h.textContent?.replace(/^\s*\d+\.\s*/, '').trim());
    expect(shown).toEqual(expected);
  });

  it('shows reasons, misses, lots, build range and a community link on each card', async () => {
    await setup('/find-a-community#p=pools:m');
    settle();
    const card = el().querySelector('.find-card') as HTMLElement;
    expect(card.querySelector('.find-match-text')?.textContent).toMatch(/\d+% match/);
    expect(card.querySelectorAll('.find-tag-reason').length).toBeGreaterThan(0);
    expect(card.querySelector('.find-facts')?.textContent).toMatch(/lots listed now/);
    expect(card.querySelector('.find-facts')?.textContent).toMatch(/\$/);
    expect(card.querySelector('a.find-link')?.getAttribute('href')).toMatch(/^\/communities\/[a-z-]+$/);
    // A community that misses the must-have is flagged.
    expect(el().querySelector('.find-badge')?.textContent).toContain('Misses a must-have');
  });

  it('AC3: a 4th compare pick is blocked with a clear message', async () => {
    await setup('/find-a-community#p=parks:n');
    settle();
    const boxes = [...el().querySelectorAll<HTMLInputElement>('.find-compare input')];
    for (const box of boxes.slice(0, 3)) {
      box.click();
      harness.detectChanges();
    }
    expect(el().querySelectorAll('.find-tray-item')).toHaveLength(3);
    expect(el().ownerDocument.querySelector('.find-tray-count')?.textContent).toContain('3 of 3 selected');

    boxes[3]!.click();
    harness.detectChanges();
    expect(boxes[3]!.checked).toBe(false);
    expect(el().querySelectorAll('.find-tray-item')).toHaveLength(3);
    expect(el().querySelector('.find-tray-limit')?.textContent).toContain(
      'You can compare up to 3 communities. Remove one to add another.',
    );

    // Removing one clears the message; the side-by-side table opens.
    (el().querySelector('.find-tray-remove') as HTMLButtonElement).click();
    harness.detectChanges();
    expect(el().querySelector('.find-tray-limit')?.textContent?.trim()).toBe('');
    (el().querySelector('.find-tray-show') as HTMLButtonElement).click();
    harness.detectChanges();
    expect(el().querySelectorAll('.find-compare-table thead th')).toHaveLength(2);
  });
});
