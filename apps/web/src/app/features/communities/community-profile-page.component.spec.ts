import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CommunityProfilePageComponent,
  resolveProfileCopy,
} from './community-profile-page.component';
import type { CommunityProfileCopy, CommunityProfileView } from '@feasly/contracts';

/**
 * Property-profile variant: /communities/:slug/ for condo/apartment-dominated
 * communities. Renders real assessment figures only — never build prices.
 */
describe('CommunityProfilePageComponent', () => {
  let fixture: ComponentFixture<CommunityProfilePageComponent>;

  const rawCopy: CommunityProfileCopy = {
    kicker: 'Community property profile',
    titleTemplate: '{name} Calgary Property Values & Assessed Values | Feasly',
    descriptionTemplate:
      'Property values in {name}, Calgary — average City-assessed value {avgAssessed}.',
    lede: 'Most homes in {name} are apartments, condos, and townhouses.',
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
      providers: [provideRouter([])],
    });
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

  it('shows the four stat cards with real figures', () => {
    const html = fixture.nativeElement.innerHTML as string;
    expect(html).toContain('$607,351');
    expect(html).toContain('11,642');
    expect(html).toContain('2026');
  });

  it('renders the mix bar with segments summing to ~100 and a text equivalent', () => {
    const bar = fixture.nativeElement.querySelector('.mix-bar');
    expect(bar?.getAttribute('role')).toBe('img');
    expect(bar?.getAttribute('aria-label')).toBe('Dwelling mix: 100% multi, 0% semi, 0% single.');
    const segments = [...bar.querySelectorAll('.mix-segment')];
    const widths = segments.map((s: Element) => parseFloat((s as HTMLElement).style.width));
    expect(widths.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(100, 0);
    const html = fixture.nativeElement.innerHTML as string;
    expect(html).toContain('Apartments, condos &amp; townhouses — 100%');
  });

  it('fills every placeholder — no raw {name}/{year} leaks into the DOM', () => {
    const html = fixture.nativeElement.innerHTML as string;
    expect(html).not.toContain('{name}');
    expect(html).not.toContain('{year}');
    expect(html).not.toContain('{avgAssessed}');
    expect(html).toContain('Most homes in Beltline are apartments');
    expect(html).toContain('Q for Beltline?');
  });

  it('resolveProfileCopy is the single source for render + JSON-LD copy', () => {
    const resolved = resolveProfileCopy(rawCopy, view);
    expect(resolved.faqItems[0]).toEqual({ q: 'Q for Beltline?', a: 'A 2026.' });
    expect(resolved.finePrint).toBe('Figures from the 2026 roll for Beltline.');
  });
});
