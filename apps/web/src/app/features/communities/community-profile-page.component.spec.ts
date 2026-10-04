import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommunityProfilePageComponent,
  resolveProfileCopy,
} from './community-profile-page.component';
import { SetProfilePropertyContext } from './community-profile.actions';
import { CommunityProfileState } from './community-profile.state';
import type { CommunityProfileCopy, CommunityProfileView } from '@feasly/contracts';

/**
 * Property-profile variant: /communities/:slug/ for condo/apartment-dominated
 * communities. Renders real assessment figures only — never build prices.
 */
describe('CommunityProfilePageComponent', () => {
  let fixture: ComponentFixture<CommunityProfilePageComponent>;
  let store: Store;

  const rawCopy: CommunityProfileCopy = {
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
    faqItems: [{ q: 'Q for {name}?', a: 'A {year}.' }],
    nearbyTitle: 'Nearby communities',
    ctaTitle: 'Building a home elsewhere in Calgary?',
    ctaBody: 'CTA body.',
    ctaEstimateLabel: 'Get a free estimate →',
    ctaGuideLabel: 'Calgary build-cost guide',
    finePrint: 'Figures from the {year} roll for {name}.',
    statLabel: 'Average City-assessed value (not market value)',
    statNote: 'Stat note.',
  };

  const view: CommunityProfileView = {
    slug: 'beltline',
    displayName: 'Beltline',
    avgAssessedValue: 607351,
    assessmentYear: '2026',
    dwellingUnits: 11642,
    mix: { singleDetached: 28, semiDuplex: 2, multiFamily: 11612 },
    mostCommonType: 'multiFamily',
    nearby: [{ slug: 'mission', displayName: 'Mission' }],
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      imports: [CommunityProfilePageComponent],
      providers: [provideRouter([]), provideStore([CommunityProfileState])],
    });
    store = TestBed.inject(Store);
    fixture = TestBed.createComponent(CommunityProfilePageComponent);
    fixture.componentRef.setInput('view', view);
    fixture.componentRef.setInput('copy', resolveProfileCopy(rawCopy, view));
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('renders the H1 as "{name}, Calgary" with the profile kicker', () => {
    const h1 = fixture.nativeElement.querySelector('h1');
    expect(h1?.textContent).toBe('Beltline, Calgary');
    expect(fixture.nativeElement.querySelector('.eyebrow')?.textContent).toBe(
      'Community property profile',
    );
  });

  it('never renders build prices', () => {
    const html = fixture.nativeElement.innerHTML as string;
    expect(html).not.toContain('Total investment');
    expect(html).not.toContain('tier-card');
    expect(html).not.toContain('How much does it cost to build');
  });

  it('shows the three stat cards with real figures (no duplicate average)', () => {
    const html = fixture.nativeElement.innerHTML as string;
    expect(html).toContain('11,642');
    expect(html).toContain('2026');
    // The community average appears once (hero), not duplicated in the stats.
    const matches = html.match(/\$607,351/g) ?? [];
    expect(matches.length).toBeLessThanOrEqual(2);
    expect(fixture.nativeElement.querySelector('.stat--wide')).not.toBeNull();
  });

  it('fills every placeholder — no raw {name}/{year} leaks into the DOM', () => {
    const html = fixture.nativeElement.innerHTML as string;
    expect(html).not.toContain('{name}');
    expect(html).not.toContain('{year}');
    expect(html).not.toContain('{avgAssessed}');
    expect(html).not.toContain('{propertyValue}');
    expect(html).toContain('most homes in Beltline are apartments');
  });

  it('replaces repeated placeholders, not just the first (live {name} bug)', () => {
    const resolved = resolveProfileCopy(rawCopy, view);
    // The mock lede contains {name} twice — both must be filled.
    expect(resolved.lede).not.toContain('{name}');
    expect(resolved.lede.match(/Beltline/g)?.length).toBe(2);
    expect(resolved.communityAverageLabel).toBe('Beltline average');
    expect(resolved.honestNote).toContain('2026 assessment roll');
  });

  it('shows the average as the hero figure on direct visits (no property context)', () => {
    const html = fixture.nativeElement.innerHTML as string;
    expect(html).toContain('Beltline average assessed value');
    expect(html).toContain('$607,351');
    // No comparison bars without a property to compare.
    expect(fixture.nativeElement.querySelector('.hero-compare')).toBeNull();
    expect(fixture.nativeElement.querySelector('.property-address')).toBeNull();
  });

  it('renders the property hero with comparison bars when property context exists', async () => {
    store.dispatch(
      new SetProfilePropertyContext({
        address: '1017 11 Ave SW, Calgary, AB',
        assessedValue: 20630000,
      }),
    );
    fixture.detectChanges();
    await fixture.whenStable();
    const html = fixture.nativeElement.innerHTML as string;
    expect(html).toContain('1017 11 Ave SW, Calgary, AB');
    expect(html).toContain('$20,630,000');
    expect(html).toContain("This property's assessed value");
    expect(html).toContain('Beltline average');
    // Proportional bars: property is the larger value → full width.
    const bars = fixture.nativeElement.querySelectorAll('.bars');
    expect(bars.length).toBe(1);
    expect(bars[0].getAttribute('aria-label')).toContain('$20,630,000');
    expect(bars[0].getAttribute('aria-label')).toContain('$607,351');
    expect(bars[0].getAttribute('aria-label')).not.toContain('{propertyValue}');
    expect(html).toContain('Bars drawn proportional to the larger value.');
    expect(html).toContain('Assessed value is for tax purposes');
  });

  it('resolveProfileCopy is the single source for render + JSON-LD copy', () => {
    const resolved = resolveProfileCopy(rawCopy, view);
    expect(resolved.faqItems[0]).toEqual({ q: 'Q for Beltline?', a: 'A 2026.' });
    expect(resolved.finePrint).toBe('Figures from the 2026 roll for Beltline.');
  });
});
