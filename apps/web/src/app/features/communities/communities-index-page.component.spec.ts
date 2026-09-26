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
    expect(h1?.textContent?.trim()).toBe('Calgary Community Build-Cost Guides');
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

  it('degrades gracefully when ranges are unavailable (no teaser)', () => {
    // The dynamic import rejects in the test env (no ranges file) — the
    // component must still render all cards without throwing.
    const first = component['communities'][0];
    expect(component.fromPrice(first)).toBeNull();
  });

  it('sets SEO for the communities route and clears JSON-LD', () => {
    const seo = TestBed.inject(SeoService) as unknown as {
      setForRoute: ReturnType<typeof vi.fn>;
      setJsonLd: ReturnType<typeof vi.fn>;
    };
    expect(seo.setForRoute).toHaveBeenCalledWith('communities');
    expect(seo.setJsonLd).toHaveBeenCalledWith(null);
  });
});
