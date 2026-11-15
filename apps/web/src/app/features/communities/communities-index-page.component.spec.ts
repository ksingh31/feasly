import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommunitiesIndexPageComponent } from './communities-index-page.component';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import indexData from '../../../content/data/community-index.json';

/** Every community with a generated page (#690: config-driven, not a fixed 40). */
const TOTAL = indexData.communities.length;

describe('CommunitiesIndexPageComponent', () => {
  let fixture: ComponentFixture<CommunitiesIndexPageComponent>;
  let component: CommunitiesIndexPageComponent;

  beforeEach(async () => {
    const seoMock = {
      setForRoute: vi.fn(),
      setJsonLd: vi.fn(),
      getSiteUrl: vi.fn().mockReturnValue('https://feasly.test'),
    };
    const configMock = {
      get: vi.fn().mockReturnValue({
        seo: {},
        marketing: {
          communities: {
            landingTitle: 'Browse community guides',
            landingBody: 'Guides body',
            intro: 'Intro paragraph',
            groups: {
              established: { heading: 'Established and inner-city communities', body: 'Established body' },
              newer: { heading: 'Newer communities', body: 'Newer body' },
            },
          },
        },
      }),
    };
    await TestBed.configureTestingModule({
      imports: [CommunitiesIndexPageComponent, RouterTestingModule],
      providers: [
        { provide: SeoService, useValue: seoMock },
        { provide: ConfigService, useValue: configMock },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(CommunitiesIndexPageComponent);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('lists every generated community (at least the original 40)', () => {
    expect(TOTAL).toBeGreaterThanOrEqual(40);
    expect(component['communities']).toHaveLength(TOTAL);
  });

  it('includes the established infill communities (#690 AC1)', () => {
    const slugs = component['communities'].map((c) => c.slug);
    for (const slug of [
      'altadore',
      'south-calgary',
      'killarney-glengarry',
      'mount-pleasant',
      'capitol-hill',
      'renfrew',
      'parkdale',
      'west-hillhurst',
    ]) {
      expect(slugs).toContain(slug);
    }
  });

  it('shows established/infill communities first, then newer ones (#690)', () => {
    fixture.detectChanges();
    const headings = [...fixture.nativeElement.querySelectorAll('h2.section-heading')].map((h: Element) =>
      h.textContent?.trim(),
    );
    expect(headings).toEqual(['Established and inner-city communities', 'Newer communities']);
    const sections = [...fixture.nativeElement.querySelectorAll('section.community-section')] as Element[];
    const namesIn = (i: number): string[] =>
      [...sections[i]!.querySelectorAll('.community-card h3')].map((h) => h.textContent ?? '');
    expect(namesIn(0)).toContain('ALTADORE');
    expect(namesIn(0)).not.toContain('PANORAMA HILLS');
    expect(namesIn(1)).toContain('PANORAMA HILLS');
    // Each section is labelled by its heading.
    for (const section of sections) {
      const id = section.getAttribute('aria-labelledby');
      expect(section.querySelector(`h2#${id}`)).not.toBeNull();
    }
  });

  it('renders the exact H1', () => {
    fixture.detectChanges();
    const h1 = fixture.nativeElement.querySelector('h1');
    expect(h1?.textContent?.trim()).toBe('Calgary Community Guides');
  });

  it('renders one card per community, each linking to its community page', () => {
    fixture.detectChanges();
    const cards = fixture.nativeElement.querySelectorAll('a.community-card');
    expect(cards).toHaveLength(TOTAL);
    const hrefs = Array.from(cards).map((a) =>
      (a as HTMLAnchorElement).getAttribute('href'),
    );
    // Every card links to /communities/{slug}; slugs are unique.
    expect(new Set(hrefs).size).toBe(TOTAL);
    for (const href of hrefs) {
      expect(href).toMatch(/^\/communities\/[a-z0-9-]+$/);
    }
  });

  it('shows the assessed value on each card', () => {
    fixture.detectChanges();
    const assessed = fixture.nativeElement.querySelectorAll('.assessed strong');
    expect(assessed).toHaveLength(TOTAL);
    for (const el of Array.from(assessed)) {
      expect((el as HTMLElement).textContent).toMatch(/^\$\d{1,3}(,\d{3})*$/);
    }
  });

  it('shows no "from $X" teaser — build costs are not community-specific (U1)', () => {
    fixture.detectChanges();
    // Most communities shared one identical buildLow in the ranges
    // file; repeating it looked like placeholder data. Cards show the
    // community's own average assessed value instead.
    const teasers = fixture.nativeElement.querySelectorAll('.from-price');
    expect(teasers).toHaveLength(0);
  });

  it('sets SEO for the communities route and injects the ItemList JSON-LD', () => {
    const seo = TestBed.inject(SeoService) as unknown as {
      setForRoute: ReturnType<typeof vi.fn>;
      setJsonLd: ReturnType<typeof vi.fn>;
      getSiteUrl: ReturnType<typeof vi.fn>;
    };
    expect(seo.setForRoute).toHaveBeenCalledWith('communities');
    expect(seo.setJsonLd).toHaveBeenCalledTimes(1);
    const schema = seo.setJsonLd.mock.calls[0][0] as Record<string, unknown>;
    expect(schema['@type']).toBe('ItemList');
    const items = schema['itemListElement'] as Record<string, unknown>[];
    // One entry per community guide — crawlers discover every guide.
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]['@type']).toBe('ListItem');
    expect(items[0]['position']).toBe(1);
    expect(String(items[0]['url'])).toMatch(/\/communities\/[a-z-]+\/$/);
  });

  it('shows "View community profile" for profile communities, "View cost guide" otherwise', () => {
    fixture.detectChanges();
    const cards = [...fixture.nativeElement.querySelectorAll('.community-card')];
    const ctaFor = (name: string): string =>
      cards.find((c: Element) => c.querySelector('h3')?.textContent === name)
        ?.querySelector('.card-cta')?.textContent ?? '';
    // Profile communities (condo/apartment-dominated per community-mix.json).
    expect(ctaFor('BELTLINE')).toBe('View community profile →');
    expect(ctaFor('SAGE HILL')).toBe('View community profile →');
    // Build-guide communities keep the cost-guide CTA.
    expect(ctaFor('MAHOGANY')).toBe('View cost guide →');
    expect(ctaFor('PANORAMA HILLS')).toBe('View cost guide →');
  });
  it('lists single-family build-guide communities first, condo profiles last, in each section (S8)', () => {
    fixture.detectChanges();
    const sections = [...fixture.nativeElement.querySelectorAll('section.community-section')] as Element[];
    for (const section of sections) {
      const cards = [...section.querySelectorAll('.community-card')];
      const isProfile = cards.map(
        (c) => c.querySelector('.card-cta')?.textContent === 'View community profile →',
      );
      // Beltline (condo district we can't quote) is never a section's first card.
      expect(cards[0]?.querySelector('h3')?.textContent).not.toBe('BELTLINE');
      expect(isProfile[0]).toBe(false);
      // No build-guide card appears after the first profile card.
      const firstProfile = isProfile.indexOf(true);
      if (firstProfile >= 0) expect(isProfile.slice(firstProfile).every(Boolean)).toBe(true);
    }
  });

  it('orders each card group alphabetically by name', () => {
    fixture.detectChanges();
    const sections = [...fixture.nativeElement.querySelectorAll('section.community-section')] as Element[];
    for (const section of sections) {
      const rows = [...section.querySelectorAll('.community-card')].map((c) => ({
        name: c.querySelector('h3')?.textContent ?? '',
        profile: c.querySelector('.card-cta')?.textContent === 'View community profile →',
      }));
      for (const profile of [false, true]) {
        const names = rows.filter((r) => r.profile === profile).map((r) => r.name);
        expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en-CA')));
      }
    }
  });
});
