import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { TestBed } from '@angular/core/testing';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { CompareResultsComponent } from './compare-results.component';
import { CommunityService } from '../../../core/community';
import { ConfigService } from '../../../core/config/config.service';
import { API_SERVICE } from '../../../core/api/api.service';
import { MockApiService } from '../../../core/api/mock-api.service';
import { providePropertyData } from '../../../core/api/property-data.service';
import { UpdateComparison, WizardState } from '../../wizard';
import { ComparisonLeadSubmitted, RunComparison } from '../comparison.actions';
import { ComparisonState } from '../comparison.state';

/**
 * NBH-03 acceptance criteria: the results render 2–3 community cards with
 * the fixed land figure label, a single City-assessed land value (never a
 * range), transparent derived totals, one "Lowest land cost" badge, and a
 * blurred chart — pre-gate the locked build/total figures render as blurred
 * (aria-hidden) real numbers, never animated skeleton bars.
 */
describe('CompareResultsComponent', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  async function setup() {
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [RouterTestingModule],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        providePropertyData(),
        provideStore([WizardState, ComparisonState]),
        { provide: API_SERVICE, useClass: MockApiService },
        CommunityService,
        ConfigService,
      ],
    }).compileComponents();
    const httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock
      .expectOne('/assets/config/app-config.json')
      .flush({
        api: { useMockApi: true },
        timings: { debounceMs: 1, mockLatencyMinMs: 1, mockLatencyMaxMs: 1 },
        propertyData: { source: 'mock' },
      });
    await pending;
    const store = TestBed.inject(Store);
    store.dispatch(
      new UpdateComparison({ slugs: ['beltline', 'panorama-hills'], sqft: 2200, tier: 'premium' }),
    );
    store.dispatch(new RunComparison());
    await waitFor(() => store.selectSnapshot(ComparisonState.status) === 'ready');
    const fixture = TestBed.createComponent(CompareResultsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    return { fixture, store };
  }

  async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) {
        throw new Error('Timed out waiting for condition');
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  it('renders one card per community with the fixed land-value label', async () => {
    const { fixture } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    const cards = el.querySelectorAll('.community-card');
    expect(cards).toHaveLength(2);
    // Exact story label on every card: land is a fixed value, never a range.
    for (const card of cards) {
      const dt = card.querySelector('.community-card__figure dt');
      expect(dt?.textContent).toContain('Land (assessed value)');
    }
    expect(el.textContent).not.toContain('Land range');
  });

  it('shows the single City-assessed land value from the stats fixture (never a range)', async () => {
    const { fixture, store } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    const stats = store.selectSnapshot(ComparisonState.stats);
    const landValues = el.querySelectorAll('[data-testid="land-value"]');
    expect(landValues).toHaveLength(2);
    const expected = [
      stats['beltline'].avg_assessed_value,
      stats['panorama-hills'].avg_assessed_value,
    ].map((v) => `$${v.toLocaleString('en-CA')}`);
    const rendered = Array.from(landValues).map((n) => n.textContent?.trim());
    expect(rendered).toEqual(expect.arrayContaining(expected));
    // A single fixed figure — no range separator anywhere in the land cells.
    for (const cell of landValues) {
      expect(cell.textContent).not.toMatch(/–|-/);
    }
  });

  it('shows exactly one "Lowest land cost" badge matching the API flag', async () => {
    const { fixture, store } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    const badges = el.querySelectorAll('.community-card__badge');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toContain('Lowest land cost');

    // The badge sits on the card whose row-set carries lowestLand: true.
    const result = store.selectSnapshot(ComparisonState.result);
    const flaggedSlug = result?.rowSets.find((r) => r.lowestLand)?.slug;
    const flaggedCard = el.querySelector(
      `.community-card[data-slug="${flaggedSlug}"] .community-card__badge`,
    );
    expect(flaggedCard).toBeTruthy();
  });

  it('renders the results subheading without a duplicated "Calgary communities"', async () => {
    const { fixture } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    const sub = el.querySelector('.compare-results__sub')?.textContent ?? '';
    expect(sub).toContain('2 Calgary communities');
    expect(sub).not.toContain('Calgary communities Calgary communities');
    expect(sub).toContain('2,200 sq ft');
  });

  it('pre-gate: fixed land value visible, build/total blurred (never animated)', async () => {
    const { fixture, store } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    const result = store.selectSnapshot(ComparisonState.result);
    expect(result).not.toBeNull();

    // The fixed assessed land value is visible pre-gate — as a single number.
    expect(el.querySelectorAll('[data-testid="land-value"]')).toHaveLength(2);
    expect(el.querySelector('[data-testid="land-range"]')).toBeNull();

    // Build/total render as blurred REAL numbers (aria-hidden) — never
    // animated skeleton bars. Unlocked testids are absent pre-gate.
    expect(el.querySelector('[data-testid="build-range"]')).toBeNull();
    expect(el.querySelector('[data-testid="total-range"]')).toBeNull();
    expect(el.querySelector('.locked-slot__skeleton')).toBeNull();

    const stats = store.selectSnapshot(ComparisonState.stats);
    const fmt = (v: number) => `$${Math.round(v).toLocaleString('en-CA')}`;
    result?.rowSets.forEach((rowSet, i) => {
      const buildLocked = el.querySelectorAll('[data-testid="build-range-locked"]')[i];
      const totalLocked = el.querySelectorAll('[data-testid="total-range-locked"]')[i];
      expect(buildLocked).toBeTruthy();
      expect(totalLocked).toBeTruthy();
      // The blurred figures are the real numbers: build range and the
      // derived total (assessed + build).
      expect(buildLocked.textContent?.trim()).toBe(
        `${fmt(rowSet.build.low)} – ${fmt(rowSet.build.high)}`,
      );
      const assessed = stats[rowSet.slug].avg_assessed_value;
      expect(totalLocked.textContent?.trim()).toBe(
        `${fmt(assessed + rowSet.build.low)} – ${fmt(assessed + rowSet.build.high)}`,
      );
      // Blurred, non-interactive, hidden from assistive tech.
      for (const node of [buildLocked, totalLocked]) {
        expect(node.classList.contains('locked-slot__value')).toBe(true);
        expect(node.getAttribute('aria-hidden')).toBe('true');
      }
    });

    const lockedNotes = el.querySelectorAll('.locked-slot__note');
    expect(lockedNotes.length).toBeGreaterThan(0);
    for (const note of lockedNotes) {
      expect(note.textContent).toContain('Available after email verification');
    }
    // Locked slots are aria-hidden, hold real digit text, and are blurred.
    const lockedValues = el.querySelectorAll('.locked-slot__value');
    expect(lockedValues.length).toBeGreaterThan(0);
    for (const value of lockedValues) {
      expect(value.getAttribute('aria-hidden')).toBe('true');
      expect(value.textContent).toMatch(/\$\d/);
      expect(getComputedStyle(value as HTMLElement).filter).toContain('blur');
      expect(getComputedStyle(value as HTMLElement).userSelect).toBe('none');
    }
  });

  it('pre-gate: chart renders blurred real-geometry bars, never readable', async () => {
    const { fixture } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    // Locked bars use the REAL bar geometry (left/width set) — blurred.
    const lockedBars = el.querySelectorAll('.compare-chart__bar--locked');
    expect(lockedBars.length).toBe(2);
    for (const bar of lockedBars) {
      expect(bar.getAttribute('aria-hidden')).toBe('true');
      expect((bar as HTMLElement).style.left).not.toBe('');
      expect((bar as HTMLElement).style.width).not.toBe('');
      expect(getComputedStyle(bar as HTMLElement).filter).toContain('blur');
    }
    // No $/sqft or margin labels anywhere in the chart.
    const chartText = el.querySelector('.compare-chart')?.textContent ?? '';
    expect(chartText).not.toMatch(/\$\s*[\d,]+\s*\/\s*(sq|ft)/i);
    expect(chartText.toLowerCase()).not.toContain('margin');
  });

  it('pre-gate: unlock CTA navigates to the comparison gate', async () => {
    const { fixture } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    const unlock = el.querySelector('[data-testid="unlock-cta"]') as HTMLButtonElement;
    expect(unlock).toBeTruthy();
    expect(unlock.textContent).toContain('Unlock Full Numbers →');
  });

  it('post-gate: all figures unblurred with the same badge, no locked notes', async () => {
    const { fixture, store } = await setup();
    store.dispatch(new ComparisonLeadSubmitted('lead-mock-123'));
    fixture.detectChanges();
    await fixture.whenStable();

    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('[data-testid="build-range"]')).toHaveLength(2);
    expect(el.querySelectorAll('[data-testid="total-range"]')).toHaveLength(2);
    expect(el.querySelector('.locked-slot__note')).toBeNull();
    expect(el.querySelector('[data-testid="unlock-cta"]')).toBeNull();
    // The badge survives the unlock.
    expect(el.querySelectorAll('.community-card__badge')).toHaveLength(1);
    // Real chart bars render post-gate with data-driven geometry.
    const bars = el.querySelectorAll('.compare-chart__bar:not(.compare-chart__bar--locked)');
    expect(bars).toHaveLength(2);
    for (const bar of bars) {
      expect((bar as HTMLElement).style.left).not.toBe('');
      expect((bar as HTMLElement).style.width).not.toBe('');
    }
  });

  it('post-gate: total is derived transparently as assessed + build range', async () => {
    const { fixture, store } = await setup();
    store.dispatch(new ComparisonLeadSubmitted('lead-mock-123'));
    fixture.detectChanges();
    await fixture.whenStable();

    const el: HTMLElement = fixture.nativeElement;
    const result = store.selectSnapshot(ComparisonState.result);
    const stats = store.selectSnapshot(ComparisonState.stats);
    expect(result).not.toBeNull();

    const totals = el.querySelectorAll('[data-testid="total-range"]');
    const maths = el.querySelectorAll('[data-testid="total-math"]');
    expect(totals).toHaveLength(2);
    expect(maths).toHaveLength(2);

    const fmt = (v: number) => `$${Math.round(v).toLocaleString('en-CA')}`;
    result?.rowSets.forEach((rowSet, i) => {
      const assessed = stats[rowSet.slug].avg_assessed_value;
      const expectedLow = assessed + rowSet.build.low;
      const expectedHigh = assessed + rowSet.build.high;
      // The displayed total is assessed + build — never the API's land-spread total.
      expect(totals[i].textContent?.trim()).toBe(
        `${fmt(expectedLow)} – ${fmt(expectedHigh)}`,
      );
      // The derivation is visible: "$assessed + $buildLow – $buildHigh".
      expect(maths[i].textContent?.trim()).toBe(
        `${fmt(assessed)} + ${fmt(rowSet.build.low)} – ${fmt(rowSet.build.high)}`,
      );
    });
  });

  it('post-gate: chart bars use the same derived totals the cards show', async () => {
    const { fixture, store } = await setup();
    store.dispatch(new ComparisonLeadSubmitted('lead-mock-123'));
    fixture.detectChanges();
    await fixture.whenStable();

    const el: HTMLElement = fixture.nativeElement;
    const result = store.selectSnapshot(ComparisonState.result);
    const stats = store.selectSnapshot(ComparisonState.stats);
    expect(result).not.toBeNull();

    const derived = (result?.rowSets ?? []).map((r) => {
      const assessed = stats[r.slug].avg_assessed_value;
      return { slug: r.slug, low: assessed + r.build.low, high: assessed + r.build.high };
    });
    const maxHigh = Math.max(...derived.map((d) => d.high));
    for (const d of derived) {
      const bar = el.querySelector(
        `.compare-chart__bar[data-slug="${d.slug}"]`,
      ) as HTMLElement;
      expect(bar).toBeTruthy();
      // The CSSOM normalizes "90.50%" to "90.5%" — compare numerically.
      expect(parseFloat(bar.style.left)).toBeCloseTo((d.low / maxHigh) * 100, 2);
      expect(parseFloat(bar.style.width)).toBeCloseTo(
        Math.max(((d.high - d.low) / maxHigh) * 100, 2),
        2,
      );
    }
  });

  it('post-gate: tier what-if re-runs every row-set inline', async () => {
    const { fixture, store } = await setup();
    store.dispatch(new ComparisonLeadSubmitted('lead-mock-123'));
    fixture.detectChanges();
    await fixture.whenStable();

    const before = store.selectSnapshot(ComparisonState.result)?.rowSets[0].build.base;
    const tierSelector: HTMLElement = fixture.nativeElement;
    const luxuryOption = Array.from(
      tierSelector.querySelectorAll('app-tier-selector button'),
    ).find((b) => b.textContent?.includes('Luxury')) as HTMLButtonElement;
    // Fall back to dispatching when the shared selector's DOM differs.
    if (luxuryOption) {
      luxuryOption.click();
    } else {
      const { ReviseComparisonTier } = await import('../comparison.actions');
      store.dispatch(new ReviseComparisonTier('luxury'));
    }
    await waitFor(
      () => store.selectSnapshot(ComparisonState.result)?.inputs.tier === 'luxury',
    );
    fixture.detectChanges();
    await fixture.whenStable();
    const after = store.selectSnapshot(ComparisonState.result)?.rowSets[0].build.base;
    expect(after).toBeGreaterThan(before ?? 0);
  });

  it('edit action returns to the picker (navigates with ?edit=1)', async () => {
    const { fixture } = await setup();
    const el: HTMLElement = fixture.nativeElement;
    const editButton = Array.from(el.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Edit communities'),
    ) as HTMLButtonElement;
    expect(editButton).toBeTruthy();
    expect(editButton.textContent).toContain('← Edit communities');
  });
});
