import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { ActivatedRoute, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of } from 'rxjs';
import { ConfigService } from '../../core/config';
import { CommunityPageComponent, toDisplayName } from './community-page.component';

/**
 * SEO-04: /communities/:slug renders the H1, stat block, 3 tier ranges,
 * 5-question FAQ, and CTA — with per-page title/meta and the
 * feasly:cost-data-version tag.
 */
describe('CommunityPageComponent', () => {
  let fixture: ComponentFixture<CommunityPageComponent>;

  const communitiesCopy = {
    illustrativeBanner: 'Illustrative ranges — our cost data is being calibrated. Final figures coming soon.',
    titleTemplate: 'Cost to Build a Home in {name}, Calgary | Feasly',
    descriptionTemplate: 'Planning cost ranges for building a home in {name}, Calgary.',
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
  };

  const baseConfig = {
    site: { url: 'https://feasly.com', name: 'Feasly', socialImage: '/assets/og/og-default.png' },
    copy: { seo: {}, communities: communitiesCopy },
  };

  async function setup(slug: string): Promise<void> {
    TestBed.resetTestingModule();
    const navigate = vi.fn();
    TestBed.configureTestingModule({
      imports: [CommunityPageComponent],
      providers: [
        provideRouter([]),
        { provide: ConfigService, useValue: { get: (key: string) => (baseConfig as never)[key] } },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: { get: () => slug } } },
        },
        // SeoService subscribes to router.events in its constructor — the stub
        // must expose an events observable (empty here; no navigation in these tests).
        { provide: Router, useValue: { navigate, events: of() } },
      ],
    });
    // Router is injected via `inject(Router)` — override the token used above.
    fixture = TestBed.createComponent(CommunityPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the H1 with the community display name', async () => {
    await setup('beltline');
    const h1 = fixture.nativeElement.querySelector('h1');
    expect(h1?.textContent).toContain('How much does it cost to build a home in Beltline, Calgary?');
  });

  it('sets the per-page title pattern', async () => {
    await setup('beltline');
    const title = TestBed.inject(Title);
    expect(title.getTitle()).toBe('Cost to Build a Home in Beltline, Calgary | Feasly');
  });

  it('shows the real average assessed value with the fixed-value label', async () => {
    await setup('beltline');
    const html = fixture.nativeElement.innerHTML as string;
    expect(html).toContain('Average City-assessed value (not market value)');
    // Beltline's average from the aggregates fixture data.
    expect(html).toContain('$607,351');
  });

  it('renders all three tier ranges', async () => {
    await setup('beltline');
    const cards = fixture.nativeElement.querySelectorAll('.tier-card');
    expect(cards.length).toBe(3);
    const labels = [...cards].map((c: Element) => c.querySelector('h3')?.textContent);
    expect(labels).toEqual(['Standard', 'Premium', 'Luxury']);
  });

  it('leads each tier card with one hero total-investment number', async () => {
    await setup('beltline');
    const heroes = fixture.nativeElement.querySelectorAll('.tier-card .total-hero-value');
    expect(heroes.length).toBe(3);
    // Beltline Standard: total 1132040 – 1310570.
    expect(heroes[0]?.textContent).toContain('$1,132,040');
    expect(heroes[0]?.textContent).toContain('$1,310,570');
    const eyebrows = fixture.nativeElement.querySelectorAll('.tier-card .total-hero-label');
    expect([...eyebrows].every((e: Element) => e.textContent === 'Total investment')).toBe(true);
  });

  it('does not repeat the assessed land figure inside tier cards', async () => {
    await setup('beltline');
    const cards = fixture.nativeElement.querySelectorAll('.tier-card');
    for (const card of cards) {
      // The old "Land (assessed)" line is gone — land lives in the stat block now.
      expect(card.textContent).not.toContain('Land (assessed)');
      expect(card.querySelector('dl')).toBeNull();
    }
  });

  it('renders a split bar with a text equivalent (never color-only)', async () => {
    await setup('beltline');
    const bars = fixture.nativeElement.querySelectorAll('.tier-card .split-bar');
    expect(bars.length).toBe(3);
    const label = bars[0]?.getAttribute('aria-label') ?? '';
    expect(bars[0]?.getAttribute('role')).toBe('img');
    // Beltline Standard: land 607351, build mid 613954 → land ≈ 50%.
    expect(label).toContain('Cost split: land $607,351 is about 50% of the total');
    expect(label).toContain('build $524,689–$703,219 makes up about 50%');
    // Segment widths sum to 100%.
    const segments = bars[0]?.querySelectorAll('.split-segment');
    const widths = [...segments].map((s: Element) => parseFloat((s as HTMLElement).style.width));
    expect(widths.reduce((a: number, b: number) => a + b, 0)).toBeCloseTo(100, 5);
  });

  it('captions each card with build range and land in small text', async () => {
    await setup('beltline');
    const captions = fixture.nativeElement.querySelectorAll('.tier-card .split-caption');
    expect(captions.length).toBe(3);
    expect(captions[0]?.textContent).toContain('Land');
    expect(captions[0]?.textContent).toContain('~$607,351');
    expect(captions[0]?.textContent).toContain('Build');
    expect(captions[0]?.textContent).toContain('$524,689');
  });

  it('renders exactly 5 FAQ items', async () => {
    await setup('beltline');
    const items = fixture.nativeElement.querySelectorAll('.faq details');
    expect(items.length).toBe(5);
  });

  it('links the CTA to /estimate/address', async () => {
    await setup('beltline');
    const cta = fixture.nativeElement.querySelector('.cta-card a');
    const html = cta?.outerHTML ?? '';
    // RouterLink renders without href in the test bed; assert the binding exists.
    expect(html).toContain('/estimate/address');
    expect(cta?.textContent).toContain('Get your address-specific estimate');
  });

  it('emits the feasly:cost-data-version meta tag', async () => {
    await setup('beltline');
    const meta = TestBed.inject(Meta);
    const tag = meta.getTag('name="feasly:cost-data-version"');
    expect(tag?.content).toBeTruthy();
  });

  it('shows the illustrative banner while uncalibrated', async () => {
    await setup('beltline');
    const banner = fixture.nativeElement.querySelector('.banner');
    // The checked-in ranges are uncalibrated (placeholder cost data).
    expect(banner?.textContent).toContain('Illustrative ranges');
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
