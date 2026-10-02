import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommunitiesIndexPageComponent } from './communities-index-page.component';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';

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

  it('lists exactly 40 communities', () => {
    expect(component['communities']).toHaveLength(40);
  });

  it('renders the exact H1', () => {
    fixture.detectChanges();
    const h1 = fixture.nativeElement.querySelector('h1');
    expect(h1?.textContent?.trim()).toBe('Calgary Community Guides');
  });

  it('renders 40 cards each linking to its community page', () => {
    fixture.detectChanges();
    const cards = fixture.nativeElement.querySelectorAll('a.community-card');
    expect(cards).toHaveLength(40);
    const hrefs = Array.from(cards).map((a) =>
      (a as HTMLAnchorElement).getAttribute('href'),
    );
    // Every card links to /communities/{slug}; slugs are unique.
    expect(new Set(hrefs).size).toBe(40);
    for (const href of hrefs) {
      expect(href).toMatch(/^\/communities\/[a-z0-9-]+$/);
    }
  });

  it('shows the assessed value on each card', () => {
    fixture.detectChanges();
    const assessed = fixture.nativeElement.querySelectorAll('.assessed strong');
    expect(assessed).toHaveLength(40);
    for (const el of Array.from(assessed)) {
      expect((el as HTMLElement).textContent).toMatch(/^\$\d{1,3}(,\d{3})*$/);
    }
  });

  it('shows no "from $X" teaser — build costs are not community-specific (U1)', () => {
    fixture.detectChanges();
    // 28 of 40 communities shared one identical buildLow in the ranges
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
      cards.find((c: Element) => c.querySelector('h2')?.textContent === name)
        ?.querySelector('.card-cta')?.textContent ?? '';
    // Profile communities (condo/apartment-dominated per community-mix.json).
    expect(ctaFor('BELTLINE')).toBe('View community profile →');
    expect(ctaFor('SAGE HILL')).toBe('View community profile →');
    // Build-guide communities keep the cost-guide CTA.
    expect(ctaFor('MAHOGANY')).toBe('View cost guide →');
    expect(ctaFor('PANORAMA HILLS')).toBe('View cost guide →');
  });
});
