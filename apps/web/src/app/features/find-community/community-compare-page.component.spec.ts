import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideLocationMocks } from '@angular/common/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { provideStore, Store } from '@ngxs/store';
import { defer, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_SERVICE } from '../../core/api/api.service';
import { mockCommunityCompare } from '../../core/api/mock-data';
import { ConfigService } from '../../core/config';
import { CommunityComparePageComponent } from './community-compare-page.component';
import { SetMatchSelection } from './find-community.actions';
import { CommunityCompareState, FindCommunitySelectionState, FindCommunityState } from './find-community.state';

describe('CommunityComparePageComponent (#780)', () => {
  let harness: RouterTestingHarness;
  let api: { compareCommunities: ReturnType<typeof vi.fn> };

  async function setup(
    url: string,
    options: { must?: string[]; compare?: (slugs: readonly string[]) => unknown } = {},
  ): Promise<void> {
    api = {
      compareCommunities: vi.fn(options.compare ?? ((slugs: readonly string[]) => defer(() => of(mockCommunityCompare(slugs))))),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([
          { path: 'find-a-community/compare', component: CommunityComparePageComponent },
          { path: 'find-a-community', children: [] },
          { path: 'communities/:slug', children: [] },
        ]),
        provideLocationMocks(),
        provideStore([FindCommunitySelectionState, FindCommunityState, CommunityCompareState]),
        { provide: API_SERVICE, useValue: api },
      ],
    });
    const httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush({});
    await pending;
    if (options.must) {
      TestBed.inject(Store).dispatch(
        new SetMatchSelection({
          priorities: options.must.map((key) => ({ key, importance: 'must' as const })),
          filters: [],
        }),
      );
    }
    harness = await RouterTestingHarness.create();
    await harness.navigateByUrl(url, CommunityComparePageComponent);
    await harness.fixture.whenStable();
    harness.detectChanges();
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const el = (): HTMLElement => harness.routeNativeElement as HTMLElement;
  const groupTitles = (): string[] =>
    [...el().querySelectorAll('.cmp-group-row th')].map((th) => th.textContent?.trim() ?? '');

  it('AC1: a shared link with 3 communities renders 3 columns with both links each', async () => {
    await setup('/find-a-community/compare#altadore,killarney-glengarry,bowness');
    expect(api.compareCommunities).toHaveBeenCalledTimes(1);
    expect(api.compareCommunities).toHaveBeenCalledWith(['altadore', 'killarney-glengarry', 'bowness']);
    const cols = [...el().querySelectorAll('thead .cmp-col')];
    expect(cols.map((c) => c.querySelector('.cmp-col-name')?.textContent?.trim())).toEqual([
      'Altadore',
      'Killarney/Glengarry',
      'Bowness',
    ]);
    const links = [...cols[0]!.querySelectorAll('a')];
    expect(links.map((a) => a.textContent?.trim())).toEqual(['See community', 'View lots']);
    expect(links[0]!.getAttribute('href')).toBe('/communities/altadore');
    expect(links[1]!.getAttribute('href')).toBe('/communities/altadore#lots');
    expect(links[1]!.getAttribute('aria-label')).toBe('View lots in Altadore');
    for (const row of el().querySelectorAll('tbody tr:not(.cmp-group-row)')) {
      expect(row.querySelectorAll('td')).toHaveLength(3);
    }
  });

  it('AC1: works for 2 communities; groups in order Schools, Getting around, Lifestyle, Building here', async () => {
    await setup('/find-a-community/compare#altadore,bowness');
    expect(el().querySelectorAll('thead .cmp-col')).toHaveLength(2);
    expect(groupTitles()).toEqual(['Schools', 'Getting around', 'Lifestyle', 'Building here']);
    expect(el().querySelector('[data-group="getting-around"] [data-row="amenity-pathways"]')).not.toBeNull();
    expect(el().querySelector('[data-group="schools"] [data-row="schools-k-6"]')).not.toBeNull();
    expect(el().querySelector('[data-group="lifestyle"] [data-row="tree-cover"]')).not.toBeNull();
    expect(el().querySelector('[data-group="building"] [data-row="typical-new-build"]')).not.toBeNull();
  });

  it('marks the best value with text as well as colour; build ranges are formatted, never marked', async () => {
    await setup('/find-a-community/compare#altadore,bowness');
    const lots = el().querySelector('[data-row="lots-listed"]')!;
    const best = [...lots.querySelectorAll('td')].map((td) => td.classList.contains('is-best'));
    // Bowness has 11 listed lots, Altadore 6.
    expect(best).toEqual([false, true]);
    expect(lots.querySelectorAll('td')[1]!.querySelector('.cmp-best-tag')?.textContent?.trim()).toBe('Best');
    const build = el().querySelector('[data-row="typical-new-build"]')!;
    expect(build.querySelectorAll('.is-best')).toHaveLength(0);
    expect(build.querySelector('td')?.textContent).toMatch(/\$/);
    // An all-equal row marks nothing.
    expect(el().querySelectorAll('[data-row="schools-k-6"] .is-best')).toHaveLength(0);
  });

  it('puts your must-have rows first, tagged, and their group leads', async () => {
    await setup('/find-a-community/compare#altadore,bowness', { must: ['tree-cover', 'libraries'] });
    expect(groupTitles()[0]).toBe('Lifestyle');
    const rows = [...el().querySelectorAll('[data-group="lifestyle"] tr[data-row]')];
    expect(rows.slice(0, 2).map((r) => r.getAttribute('data-row'))).toEqual(['amenity-libraries', 'tree-cover']);
    expect(rows[0]!.querySelector('.cmp-must-tag')?.textContent?.trim()).toBe('Your must-have');
    expect(rows[2]!.querySelector('.cmp-must-tag')).toBeNull();
  });

  it('shows the disclaimer: designations can change, estimates are not quotes', async () => {
    await setup('/find-a-community/compare#altadore,bowness');
    const text = el().querySelector('.cmp-disclaimer')?.textContent ?? '';
    expect(text).toContain('designations can change');
    expect(text).toContain('not quotes');
  });

  it('asks for 2 or 3 communities when the link has fewer, and calls nothing', async () => {
    await setup('/find-a-community/compare#altadore');
    expect(api.compareCommunities).not.toHaveBeenCalled();
    expect(el().querySelector('.cmp-status')?.textContent).toContain('Pick 2 or 3 communities to compare.');
    expect(el().querySelector('table')).toBeNull();
    expect(el().querySelector('.cmp-copy')).toBeNull();
  });

  it('copy link puts the page URL with the columns on the clipboard', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await setup('/find-a-community/compare#altadore,bowness');
    (el().querySelector('.cmp-copy') as HTMLButtonElement).click();
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect(writeText).toHaveBeenCalledWith(expect.stringMatching(/\/find-a-community\/compare#altadore,bowness$/));
    expect(el().querySelector('.cmp-copy-status')?.textContent).toContain('Link copied');
  });

  it('an unknown community says so without a retry; a network failure offers one', async () => {
    await setup('/find-a-community/compare#altadore,nowhere');
    expect(el().querySelector('.cmp-status')?.textContent).toContain('couldn’t find one of these communities');
    expect(el().querySelector('.cmp-retry')).toBeNull();

    await setup('/find-a-community/compare#altadore,bowness', {
      compare: () => throwError(() => ({ code: 'timeout', message: 'x', retryable: true })),
    });
    expect(el().querySelector('.cmp-status')?.textContent).toContain('couldn’t load the comparison');
    expect(el().querySelector('.cmp-retry')).not.toBeNull();
  });
});
