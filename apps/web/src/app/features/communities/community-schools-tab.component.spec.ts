import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import type { SchoolsListResponse } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import {
  mockCommunitySchoolDesignations,
  mockCommunitySchools,
} from '../../core/api/mock-community-guide';
import { ConfigService } from '../../core/config';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import { SchoolComparisonState } from '../../core/schools';
import { LoadCommunitySchools, OpenCommunityGuide } from './community-guide.actions';
import { CommunityGuideState } from './community-guide.state';
import { CommunitySchoolsTabComponent } from './community-schools-tab.component';

/** #781 Schools tab: type filter (AC1), type badges (AC2), Fraser flag (AC3). */
describe('CommunitySchoolsTabComponent', () => {
  let fixture: ComponentFixture<CommunitySchoolsTabComponent>;

  function setup(opts: {
    fraser?: boolean;
    schools?: SchoolsListResponse;
    failDesignations?: boolean;
    comparisonMax?: number;
  } = {}): { api: Record<string, ReturnType<typeof vi.fn>> } {
    TestBed.resetTestingModule();
    const api = {
      getCommunitySchoolDesignations: vi.fn((slug: string) =>
        opts.failDesignations ? throwError(() => new Error('down')) : of(mockCommunitySchoolDesignations(slug)),
      ),
      listCommunitySchools: vi.fn((code: string) => of(opts.schools ?? mockCommunitySchools(code))),
    };
    const config = {
      ...DEFAULT_APP_CONFIG,
      features: { ...DEFAULT_APP_CONFIG.features, schoolFraserScore: opts.fraser ?? false },
      limits: { ...DEFAULT_APP_CONFIG.limits, schoolComparisonMax: opts.comparisonMax ?? 4 },
    };
    TestBed.configureTestingModule({
      imports: [CommunitySchoolsTabComponent],
      providers: [
        provideStore([CommunityGuideState, SchoolComparisonState]),
        { provide: API_SERVICE, useValue: api },
        {
          provide: ConfigService,
          useValue: { get: (key: string) => (config as never)[key], getServedCopy: () => null },
        },
      ],
    });
    const store = TestBed.inject(Store);
    store.dispatch(new OpenCommunityGuide('mahogany'));
    store.dispatch(new LoadCommunitySchools());
    fixture = TestBed.createComponent(CommunitySchoolsTabComponent);
    fixture.componentRef.setInput('displayName', 'Mahogany');
    fixture.detectChanges();
    return { api };
  }

  const el = (): HTMLElement => fixture.nativeElement;
  const cards = (): HTMLElement[] => Array.from(el().querySelectorAll<HTMLElement>('.school-card'));
  const clickFilter = (key: string): void => {
    el().querySelector<HTMLButtonElement>(`[data-filter="${key}"]`)!.click();
    fixture.detectChanges();
  };

  it('shows the typically designated notice, designations and both board lookup links', () => {
    setup();
    const text = el().textContent ?? '';
    expect(text).toContain('typically designated for homes in Mahogany');
    expect(text).toContain('confirm with the board');
    expect(text).toContain('Sample Elementary School');
    const lookups = Array.from(el().querySelectorAll<HTMLAnchorElement>('a.lookup')).map((a) => a.href);
    expect(lookups).toEqual([
      'https://cbe.ab.ca/schools/find-a-school',
      'https://www.cssd.ab.ca/schools',
    ]);
  });

  it('offers the All / Public (CBE) / Catholic (CCSD) / Charter / Private filters', () => {
    setup();
    const labels = Array.from(el().querySelectorAll('.filters .chip')).map((b) => b.textContent?.trim());
    expect(labels).toEqual(['All', 'Public (CBE)', 'Catholic (CCSD)', 'Charter', 'Private']);
  });

  it('AC1: each type filter shows only that type', () => {
    setup();
    expect(cards().length).toBe(4);
    for (const type of ['public_cbe', 'catholic_ccsd', 'charter', 'private']) {
      clickFilter(type);
      const shown = cards();
      expect(shown.length).toBeGreaterThan(0);
      expect(shown.every((c) => c.dataset['schoolType'] === type)).toBe(true);
      expect(
        el().querySelector(`[data-filter="${type}"]`)!.getAttribute('aria-pressed'),
      ).toBe('true');
    }
    clickFilter('all');
    expect(cards().length).toBe(4);
  });

  it('AC1: a filter with no matching schools says so', () => {
    const base = mockCommunitySchools('MOK');
    setup({ schools: { ...base, schools: base.schools.filter((s) => s.type !== 'charter') } });
    clickFilter('charter');
    expect(cards().length).toBe(0);
    expect(el().textContent).toContain('No schools of this type in Mahogany.');
  });

  it('AC2: private and charter schools always show their type badge', () => {
    setup();
    const badgeFor = (type: string): string | undefined =>
      cards()
        .find((c) => c.dataset['schoolType'] === type)
        ?.querySelector('.badge')
        ?.textContent?.trim();
    expect(badgeFor('private')).toBe('Private');
    expect(badgeFor('charter')).toBe('Charter');
    clickFilter('private');
    expect(badgeFor('private')).toBe('Private');
  });

  it('groups cards by level in config order', () => {
    setup();
    const levels = Array.from(el().querySelectorAll('.level h3')).map((h) => h.textContent?.trim());
    expect(levels).toEqual(['Elementary', 'Junior high', 'High school']);
  });

  it('AC3: hides the Fraser row entirely when the flag is off', () => {
    setup({ fraser: false });
    expect(el().querySelectorAll('[data-testid="fraser"]').length).toBe(0);
    expect(el().textContent).not.toContain('Fraser');
  });

  it('AC3: shows the score with a source link, and "n/a" when missing, when the flag is on', () => {
    setup({ fraser: true });
    const rows = Array.from(el().querySelectorAll<HTMLElement>('[data-testid="fraser"]'));
    expect(rows.length).toBe(4);
    expect(rows[0].textContent).toContain('7.1 / 10 (2025)');
    expect(rows[0].querySelector('a')?.getAttribute('href')).toBe('https://www.compareschoolrankings.org');
    expect(rows.slice(1).every((r) => r.textContent?.includes('n/a'))).toBe(true);
  });

  it('shows programs, provincial results, enrolment and the Google reviews link-out', () => {
    setup();
    const first = cards()[0];
    expect(first.textContent).toContain('French immersion');
    expect(first.textContent).toContain('Grade 6 PAT (2024-25): 78% acceptable · 21% excellence');
    expect(first.textContent).toContain('412 of 500 spaces (82%), 2025-26');
    const reviews = first.querySelector<HTMLAnchorElement>('a.reviews');
    expect(reviews?.textContent).toContain('Google reviews');
    expect(reviews?.target).toBe('_blank');
    // A school with nothing published shows n/a, never a guess.
    const charter = cards().find((c) => c.dataset['schoolType'] === 'charter')!;
    expect(charter.textContent).toContain('n/a');
  });

  it('adds and removes a school from the comparison, and blocks adding past the max', () => {
    setup({ comparisonMax: 1 });
    const store = TestBed.inject(Store);
    const buttons = (): HTMLButtonElement[] =>
      cards().map((c) => c.querySelector<HTMLButtonElement>('button.compare')!);
    buttons()[0].click();
    fixture.detectChanges();
    expect(store.selectSnapshot(SchoolComparisonState.schoolIds)).toEqual(['mock-cbe-1']);
    expect(buttons()[0].getAttribute('aria-pressed')).toBe('true');
    expect(buttons()[0].textContent).toContain('Added to comparison');
    expect(buttons()[1].disabled).toBe(true);
    expect(el().textContent).toContain('Your comparison is full');
    buttons()[0].click();
    fixture.detectChanges();
    expect(store.selectSnapshot(SchoolComparisonState.schoolIds)).toEqual([]);
    expect(buttons()[1].disabled).toBe(false);
  });

  it('shows an error with a retry that refetches', () => {
    const { api } = setup({ failDesignations: true });
    expect(el().querySelector('[role="alert"]')?.textContent).toContain("couldn't load schools");
    el().querySelector<HTMLButtonElement>('button.retry')!.click();
    expect(api['getCommunitySchoolDesignations']).toHaveBeenCalledTimes(2);
  });
});
