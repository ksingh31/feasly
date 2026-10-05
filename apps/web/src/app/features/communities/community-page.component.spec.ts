import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { ActivatedRoute, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { ConfigService } from '../../core/config';
import { CommunityPageComponent } from './community-page.component';
import { CommunityProfilePageComponent, resolveProfileCopy } from './community-profile-page.component';
import { CommunityProfileState } from './community-profile.state';
import { SetProfilePropertyContext } from './community-profile.actions';
import type { RawCommunityProfileCopy } from '@feasly/contracts';
import { toDisplayName } from './community-names';

const mockProfileCopy: RawCommunityProfileCopy = {
  kicker: 'Community property profile',
  titleTemplate: '{name} Calgary Property Values & Assessed Values | Feasly',
  descriptionTemplate:
    'Property values in {name}, Calgary — average City-assessed value {avgAssessed}.',
  lede: "most homes in {name} are apartments, condos, and townhouses. Here's the test lede for {name}.",
  ledeLead: "We don't quote this property type yet",
  propertyValueLabel: "This property's assessed value",
  communityAverageLabel: '{name} average',
  comparePropertyTag: 'This property',
  compareBarCaption: 'Bars drawn proportional to the larger value.',
  compareBarLabelTemplate:
    'Bar comparison: this property assessed at {propertyValue} versus the {name} average of {avgAssessed}',
  honestNote:
    'City of Calgary {year} assessment roll. Assessed value is for tax purposes — not market value.',
  averageHeroLabel: '{name} average assessed value',
  homesAssessedLabel: 'Homes assessed',
  homesAssessedSub: '{year} assessment roll',
  mostCommonTypeLabel: 'Most common home type',
  assessmentYearLabel: 'Assessment year',
  mixTitle: 'What people live in here',
  mixBody: 'Dwelling mix for {name}.',
  mixBarLabelTemplate: 'Dwelling mix: {multiPct}% multi, {semiPct}% semi, {singlePct}% single.',
  typeLabels: {
    singleDetached: 'Single-detached',
    semiDuplex: 'Semi-detached / duplex',
    multiFamily: 'Apartments, condos & townhouses',
  },
  noBuildTitle: "Why you won't see build prices on this page",
  noBuildBody: 'No build prices for {name}.',
  noBuildGuideLink: 'See the Calgary build-cost guide →',
  explainerTitle: 'How Calgary assessments work',
  explainerItems: [{ title: 'T1.', body: 'B1.' }],
  faqTitle: 'Common questions',
  faqItems: [
    { q: 'PQ1 for {name}?', a: 'PA1 {year}.' },
    { q: 'PQ2?', a: 'PA2.' },
    { q: 'PQ3?', a: 'PA3.' },
  ],
  nearbyTitle: 'Nearby communities',
  ctaTitle: 'Building a home elsewhere in Calgary?',
  ctaBody: 'CTA body.',
  ctaEstimateLabel: 'Get a free estimate →',
  ctaGuideLabel: 'Calgary build-cost guide',
  finePrint: 'Figures from the {year} roll for {name}.',
};

/**
 * SEO-04: /communities/:slug renders the H1, stat block, 3 tier ranges,
 * 5-question FAQ, and CTA — with per-page title/meta and the
 * feasly:cost-data-version tag.
 */
describe('CommunityPageComponent', () => {
  let fixture: ComponentFixture<CommunityPageComponent>;

  const communitiesCopy = {
    illustrativeBanner:
      'Illustrative ranges — our cost data is being calibrated. Final figures coming soon.',
    titleTemplate: 'Feasly — Cost to build a home in {name}, Calgary',
    descriptionTemplate:
      'Planning cost ranges for building a home in {name}, Calgary — average City-assessed value {avgAssessed}.',
    statLabel: 'Average City-assessed value (not market value)',
    statNote: 'Stat note.',
    basisNote: 'Basis note.',
    tierSectionTitle: 'What it costs to build in {name}',
    tierSectionSub: 'Sub.',
    totalLabel: 'Total investment',
    landSplitLabel: 'Land',
    buildSplitLabel: 'Build',
    splitBarLabelTemplate:
      'Cost split: land {land} is about {landPct}% of the total; build {build} makes up about {buildPct}%.',
    faqTitle: 'Common questions',
    faqItems: [
      { q: 'Q1?', a: 'A1.' },
      { q: 'Q2?', a: 'A2.' },
      { q: 'Q3?', a: 'A3.' },
      { q: 'Q4?', a: 'A4.' },
      { q: 'Q5?', a: 'A5.' },
    ],
    ctaTitle: 'Building in {name}?',
    ctaBody: 'CTA body.',
    ctaLabel: 'Get your address-specific estimate →',
    // Coverage-redirect card (guide variant, QA 2026-10-04).
    coverageLede:
      "We can't build-cost this address yet — here's the City-assessed value, compared with the {name} average.",
    propertyValueLabel: "This property's assessed value",
    communityAverageLabel: '{name} average',
    comparePropertyTag: 'This property',
    compareBarCaption: 'Bars drawn proportional to the larger value.',
    compareBarLabelTemplate:
      'Bar comparison: this property assessed at {propertyValue} versus the {name} average of {avgAssessed}',
    coverageHonestNote:
      'City of Calgary {year} assessment roll. Assessed value is for tax purposes — not market value.',
  };

  const baseConfig = {
    site: { url: 'https://feasly.com', name: 'Feasly', socialImage: '/assets/og/og-default.png' },
    copy: { seo: {}, communities: communitiesCopy },
  };

  /**
   * Mock per-slug page data (mirrors the shape generated by
   * `scripts/build-community-pages.ts`). The resolver normally supplies this
   * via `ActivatedRoute.data`; tests inject it directly.
   */
  function mockPageData(slug: string): unknown {
    const isProfile = slug === 'beltline';
    const displayName = slug === 'beltline' ? 'Beltline' : 'Mahogany';
    return {
      slug,
      type: isProfile ? 'profile' : 'build-guide',
      assessmentYear: '2026',
      aggregate: {
        slug,
        name: slug.toUpperCase(),
        count: isProfile ? 11642 : 8689,
        avgAssessedValue: isProfile ? 607351 : 719666,
        avgLotSqft: isProfile ? 0 : 43382,
      },
      range: isProfile
        ? null
        : {
            slug,
            tiers: {
              standard: {
                buildLow: 400000,
                buildHigh: 500000,
                landValue: 300000,
                totalLow: 700000,
                totalHigh: 800000,
              },
              premium: {
                buildLow: 500000,
                buildHigh: 650000,
                landValue: 300000,
                totalLow: 800000,
                totalHigh: 950000,
              },
              luxury: {
                buildLow: 650000,
                buildHigh: 850000,
                landValue: 300000,
                totalLow: 950000,
                totalHigh: 1150000,
              },
            },
            costDataVersion: 'test',
            calibrated: false,
            buildSqft: 2400,
          },
      nearby: [
        { slug: 'copperfield', name: 'COPPERFIELD' },
        { slug: 'mckenzie-towne', name: 'MCKENZIE TOWNE' },
        { slug: 'auburn-bay', name: 'AUBURN BAY' },
      ],
      ...(isProfile
        ? {
            mix: {
              dwellingUnits: 11642,
              mix: { singleDetached: 28, semiDuplex: 2, multiFamily: 11612 },
              mostCommonType: 'multiFamily',
            },
          }
        : {}),
    };
  }

  async function setup(
    slug: string,
    opts?: { propertyContext?: { address: string; assessedValue: number } },
  ): Promise<void> {
    TestBed.resetTestingModule();
    const navigate = vi.fn();
    const pageData = mockPageData(slug) as { type: string };
    // Mirror the resolver: profile slugs get the preloaded component + copy.
    const resolved =
      pageData.type === 'profile'
        ? {
            pageData,
            profileComponent: CommunityProfilePageComponent,
            resolveProfileCopy,
            profileCopyRaw: mockProfileCopy,
          }
        : { pageData };
    TestBed.configureTestingModule({
      imports: [CommunityPageComponent],
      providers: [
        provideRouter([]),
        provideStore([CommunityProfileState]),
        { provide: ConfigService, useValue: { get: (key: string) => (baseConfig as never)[key] } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { data: { pageData: resolved } } },
        },
        // SeoService subscribes to router.events in its constructor — the stub
        // must expose an events observable (empty here; no navigation in these tests).
        { provide: Router, useValue: { navigate, events: of() } },
      ],
    });
    // Mirror the coverage gate: seed the transient context BEFORE the
    // component's ngOnInit captures (and consumes) it.
    if (opts?.propertyContext) {
      TestBed.inject(Store).dispatch(new SetProfilePropertyContext(opts.propertyContext));
    }
    // Router is injected via `inject(Router)` — override the token used above.
    fixture = TestBed.createComponent(CommunityPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    // The profile variant lazy-loads its component via dynamic import — poll
    // for whichever variant resolves (profileView for profiles, community
    // for build guides) instead of sleeping a fixed timeout.
    await vi.waitFor(() => {
      const cmp = fixture.componentInstance;
      expect(cmp.profileView ?? cmp.community).toBeTruthy();
    });
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the H1 with the community display name', async () => {
    await setup('mahogany');
    const h1 = fixture.nativeElement.querySelector('h1');
    expect(h1?.textContent).toContain(
      'How much does it cost to build a home in Mahogany, Calgary?',
    );
  });

  it('sets the per-page title pattern', async () => {
    await setup('mahogany');
    const title = TestBed.inject(Title);
    expect(title.getTitle()).toBe('Feasly — Cost to build a home in Mahogany, Calgary');
  });

  it('sets a unique meta description carrying the real assessed value', async () => {
    await setup('mahogany');
    const meta = TestBed.inject(Meta);
    const description = meta.getTag('name="description"')?.content ?? '';
    // Mahogany's average from the aggregates fixture data — the description
    // must carry the real figure so all 40 community pages are unique.
    expect(description).toContain('Mahogany');
    expect(description).toContain('$719,666');
  });

  it('shows the real average assessed value with the fixed-value label', async () => {
    await setup('mahogany');
    const html = fixture.nativeElement.innerHTML as string;
    expect(html).toContain('Average City-assessed value (not market value)');
    // Mahogany's average from the aggregates fixture data.
    expect(html).toContain('$719,666');
  });

  it('renders all three tier ranges', async () => {
    await setup('mahogany');
    const cards = fixture.nativeElement.querySelectorAll('.tier-card');
    expect(cards.length).toBe(3);
    const labels = [...cards].map((c: Element) => c.querySelector('h3')?.textContent);
    expect(labels).toEqual(['Standard', 'Premium', 'Luxury']);
  });

  it('leads each tier card with one hero total-investment number', async () => {
    await setup('mahogany');
    const heroes = fixture.nativeElement.querySelectorAll('.tier-card .total-hero-value');
    expect(heroes.length).toBe(3);
    // Mock Standard tier: total 700000 – 800000.
    expect(heroes[0]?.textContent).toContain('$700,000');
    expect(heroes[0]?.textContent).toContain('$800,000');
    const eyebrows = fixture.nativeElement.querySelectorAll('.tier-card .total-hero-label');
    expect([...eyebrows].every((e: Element) => e.textContent === 'Total investment')).toBe(true);
  });

  it('does not repeat the assessed land figure inside tier cards', async () => {
    await setup('mahogany');
    const cards = fixture.nativeElement.querySelectorAll('.tier-card');
    for (const card of cards) {
      // The old "Land (assessed)" line is gone — land lives in the stat block now.
      expect(card.textContent).not.toContain('Land (assessed)');
      expect(card.querySelector('dl')).toBeNull();
    }
  });

  it('renders a split bar with a text equivalent (never color-only)', async () => {
    await setup('mahogany');
    const bars = fixture.nativeElement.querySelectorAll('.tier-card .split-bar');
    expect(bars.length).toBe(3);
    const label = bars[0]?.getAttribute('aria-label') ?? '';
    expect(bars[0]?.getAttribute('role')).toBe('img');
    // Mock Standard tier: land 300000, build 400000–500000 (mid 450000) → land = 40%.
    expect(label).toContain('Cost split: land $300,000 is about 40% of the total');
    expect(label).toContain('build $400,000–$500,000 makes up about 60%');
    // Segment widths sum to 100%.
    const segments = bars[0]?.querySelectorAll('.split-segment');
    const widths = [...segments].map((s: Element) => parseFloat((s as HTMLElement).style.width));
    expect(widths.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(100, 5);
  });

  it('captions each card with build range and land in small text', async () => {
    await setup('mahogany');
    const captions = fixture.nativeElement.querySelectorAll('.tier-card .split-caption');
    expect(captions.length).toBe(3);
    expect(captions[0]?.textContent).toContain('Land');
    expect(captions[0]?.textContent).toContain('~$300,000');
    expect(captions[0]?.textContent).toContain('Build');
    expect(captions[0]?.textContent).toContain('$400,000');
  });

  it('renders exactly 5 FAQ items', async () => {
    await setup('mahogany');
    const items = fixture.nativeElement.querySelectorAll('.faq details');
    expect(items.length).toBe(5);
  });

  it('links the CTA to the homepage address step', async () => {
    await setup('mahogany');
    const cta = fixture.nativeElement.querySelector('.cta-card a');
    const html = (cta?.outerHTML ?? '').toLowerCase();
    // RouterLink renders without href in the test bed; assert the binding exists.
    // The wizard's address step lives on the landing page (/) — there is no
    // /estimate/address route (P0 fix: the old link 404'd).
    expect(html).toContain('routerlink="/"');
    expect(html).not.toContain('/estimate/address');
    expect(cta?.textContent).toContain('Get your address-specific estimate');
  });

  it('emits the feasly:cost-data-version meta tag', async () => {
    await setup('mahogany');
    const meta = TestBed.inject(Meta);
    const tag = meta.getTag('name="feasly:cost-data-version"');
    expect(tag?.content).toBeTruthy();
  });

  it('shows the illustrative banner while uncalibrated', async () => {
    await setup('mahogany');
    const banner = fixture.nativeElement.querySelector('.banner');
    // The checked-in ranges are uncalibrated (placeholder cost data).
    expect(banner?.textContent).toContain('Illustrative ranges');
  });

  describe('guide-variant coverage redirect (QA 2026-10-04)', () => {
    const gateContext = {
      address: '13310 14 ST NW, Calgary, AB',
      assessedValue: 76500,
    };

    it('shows no coverage card on a direct guide visit', async () => {
      await setup('mahogany');
      expect(fixture.nativeElement.querySelector('.coverage-card')).toBeNull();
    });

    it('renders the coverage card explaining the redirect', async () => {
      await setup('mahogany', { propertyContext: gateContext });
      const card = fixture.nativeElement.querySelector('.coverage-card');
      expect(card).toBeTruthy();
      // The user gets an explanation, not a generic guide.
      expect(card.textContent).toContain("We can't build-cost this address yet");
      expect(card.textContent).toContain('compared with the Mahogany average');
    });

    it('shows the rejected property versus the community average', async () => {
      await setup('mahogany', { propertyContext: gateContext });
      const card = fixture.nativeElement.querySelector('.coverage-card');
      // The rejected property's address and assessed value…
      expect(card.textContent).toContain('13310 14 ST NW, Calgary, AB');
      expect(card.textContent).toContain("This property's assessed value");
      expect(card.textContent).toContain('$76,500');
      // …against the community average (Mahogany mock: $719,666).
      expect(card.textContent).toContain('Mahogany average');
      expect(card.textContent).toContain('$719,666');
      // Honest note carries the roll year.
      expect(card.textContent).toContain('City of Calgary 2026 assessment roll');
      expect(card.textContent).toContain('not market value');
    });

    it('draws proportional comparison bars with a text equivalent', async () => {
      await setup('mahogany', { propertyContext: gateContext });
      const card = fixture.nativeElement.querySelector('.coverage-card');
      const bars = card.querySelector('.bars');
      // Never color-only: role=img + full aria-label.
      expect(bars?.getAttribute('role')).toBe('img');
      const label = bars?.getAttribute('aria-label') ?? '';
      expect(label).toContain('$76,500');
      expect(label).toContain('Mahogany average of $719,666');
      const barEls = card.querySelectorAll('.bar');
      expect(barEls.length).toBe(2);
      // Property 76500 vs average 719666 → property ≈ 10.6%, average 100%.
      expect(parseFloat((barEls[0] as HTMLElement).style.width)).toBeCloseTo(
        (76500 / 719666) * 100,
        1,
      );
      expect(parseFloat((barEls[1] as HTMLElement).style.width)).toBeCloseTo(100, 1);
    });

    it('consumes the property context once — no stale card on a later visit', async () => {
      await setup('mahogany', { propertyContext: gateContext });
      expect(fixture.nativeElement.querySelector('.coverage-card')).toBeTruthy();
      // The transient context is cleared on capture: a later same-session
      // direct visit renders the generic guide again.
      const store = TestBed.inject(Store);
      expect(store.selectSnapshot(CommunityProfileState.propertyContext)).toBeNull();
    });
  });

  describe('property-profile variant', () => {
    it('renders the profile layout for a condo-dominated community', async () => {
      await setup('beltline');
      const h1 = fixture.nativeElement.querySelector('h1');
      expect(h1?.textContent).toBe('Beltline, Calgary');
      const html = fixture.nativeElement.innerHTML as string;
      expect(html).toContain('Community property profile');
      // Simplified profile: shows assessed values, not dwelling-mix prose.
      expect(html).toContain('$607,351');
      // Live-bug regression: the lede template holds {name} twice — both
      // must be interpolated, never rendered literally.
      expect(html).not.toContain('{name}');
      expect(html).toContain("We don't quote this property type yet");
    });

    it('sets the honest profile title (no build-cost claim)', async () => {
      await setup('beltline');
      const title = TestBed.inject(Title);
      expect(title.getTitle()).toBe('Beltline Calgary Property Values & Assessed Values | Feasly');
      expect(title.getTitle()).not.toContain('Cost to build');
    });

    it('sets a profile meta description carrying the real assessed value', async () => {
      await setup('beltline');
      const meta = TestBed.inject(Meta);
      const description = meta.getTag('name="description"')?.content ?? '';
      expect(description).toContain('Beltline');
      expect(description).toContain('$607,351');
    });

    it('renders assessed values without dwelling-mix bar or build prices', async () => {
      await setup('beltline');
      const html = fixture.nativeElement.innerHTML as string;
      // Simplified profile: no dwelling-mix bar, no build-price tiers.
      expect(fixture.nativeElement.querySelector('.mix-bar')).toBeNull();
      expect(fixture.nativeElement.querySelectorAll('.tier-card').length).toBe(0);
      expect(html).not.toContain('Total investment');
      // Shows the community average assessed value.
      expect(html).toContain('$607,351');
    });

    it('shows the real assessed value and dwelling stats', async () => {
      await setup('beltline');
      const html = fixture.nativeElement.innerHTML as string;
      expect(html).toContain('$607,351');
      expect(html).toContain('Homes assessed');
      expect(html).toContain('Most common home type');
      expect(html).toContain('Apartments, condos &amp; townhouses');
    });

    it('does not render FAQs (simplified profile)', async () => {
      await setup('beltline');
      const items = fixture.nativeElement.querySelectorAll('.faq details');
      expect(items.length).toBe(0);
      const html = fixture.nativeElement.innerHTML as string;
      expect(html).not.toContain('{name}');
      expect(html).not.toContain('{year}');
    });
  });

  afterEach(() => {
    // SEO-06: the component injects JSON-LD scripts into document.head;
    // remove them so later specs see a clean DOM (test isolation).
    document.head
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((el) => el.remove());
  });
});

describe('toDisplayName', () => {
  it('title-cases SCREAMING_CASE city names', () => {
    expect(toDisplayName('BELTLINE')).toBe('Beltline');
    expect(toDisplayName('PANORAMA HILLS')).toBe('Panorama Hills');
  });

  it('handles Mc/Mac prefixes', () => {
    expect(toDisplayName('MCKENZIE TOWNE')).toBe('McKenzie Towne');
  });

  it('preserves slashes', () => {
    expect(toDisplayName('DOUGLASDALE/GLEN')).toBe('Douglasdale/Glen');
    expect(toDisplayName('BRIDGELAND/RIVERSIDE')).toBe('Bridgeland/Riverside');
  });
  afterEach(() => {
    // Remove JSON-LD scripts to prevent test pollution (SEO-06).
    document.head
      .querySelectorAll('script[type="application/ld+json"]')
      .forEach((el) => el.remove());
  });
});
