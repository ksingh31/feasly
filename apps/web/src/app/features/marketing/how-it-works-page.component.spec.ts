import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Meta } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Observable, of, throwError } from 'rxjs';
import type { BuilderPartnerListResponse } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import { PartnersState } from '../../core/partners';
import { WizardState } from '../wizard/wizard.state';
import { HowItWorksPageComponent } from './how-it-works-page.component';

/**
 * SEO-010: /how-it-works renders the 4-step flow, the deterministic-math
 * note, and both project-type CTAs to the wizard entry — and stays
 * indexable (no robots tag).
 */
describe('HowItWorksPageComponent', () => {
  let fixture: ComponentFixture<HowItWorksPageComponent>;
  let httpMock: HttpTestingController;
  /** #918: the partners response the stub API returns (swap per test). */
  let partners$: () => Observable<BuilderPartnerListResponse>;
  const getPartners = vi.fn(() => partners$());
  const LIST: BuilderPartnerListResponse = {
    partners: [
      {
        id: 'p1',
        name: 'Elite Craft Builders',
        logoUrl: null,
        websiteUrl: 'https://elite.example/',
        description: 'Custom infill homes.',
      },
      { id: 'p2', name: 'North Homes', logoUrl: null, websiteUrl: null, description: null },
    ],
  };

  const baseConfig = {
    site: { url: 'https://feasly.com', name: 'Feasly', socialImage: '/assets/og/og-default.png' },
    copy: {
      seo: {
        howItWorksTitle: 'Feasly — How it works',
        howItWorks: 'How it works description.',
      },
      marketing: {
        howItWorks: {
          eyebrow: 'How it works',
          title: 'From address to estimate in about 2 minutes',
          sub: 'Sub copy.',
          steps: [
            { n: '01', title: 'Step one', body: 'Body one.' },
            { n: '02', title: 'Step two', body: 'Body two.' },
            { n: '03', title: 'Step three', body: 'Body three.' },
            { n: '04', title: 'Step four', body: 'Body four.' },
          ],
          mathNoteTitle: 'Real math, not guesses',
          mathNoteBody: 'Deterministic math note.',
          ctaNewBuild: 'Start a new-build estimate →',
          ctaReno: 'Start a renovation estimate →',
        },
      },
    },
  };

  async function mount(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HowItWorksPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideStore([WizardState, PartnersState]),
        { provide: API_SERVICE, useValue: { getPartners } },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush(baseConfig);
    await pending;
    fixture = TestBed.createComponent(HowItWorksPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(async () => {
    getPartners.mockClear();
    partners$ = () => of(LIST);
    await mount();
  });

  describe('#918: builder partners section', () => {
    function section(): HTMLElement {
      fixture.detectChanges();
      return (fixture.nativeElement as HTMLElement).querySelector('section#partners') as HTMLElement;
    }

    it('lists the partners from the shared state, linking websites', () => {
      const el = section();
      expect(el.querySelector('h2')?.textContent).toContain('Our builder partners');
      const items = el.querySelectorAll('li.partner');
      expect(items).toHaveLength(2);
      const link = items[0].querySelector('a') as HTMLAnchorElement;
      expect(link.getAttribute('href')).toBe('https://elite.example/');
      expect(link.getAttribute('rel')).toContain('noopener');
      expect(items[0].textContent).toContain('Custom infill homes.');
      expect(items[1].querySelector('a')).toBeNull();
      expect(items[1].textContent).toContain('North Homes');
      expect(getPartners).toHaveBeenCalledTimes(1);
    });

    it('says the list is unavailable when the request fails', async () => {
      partners$ = () => throwError(() => new Error('down'));
      await mount();
      const el = section();
      expect(el.querySelectorAll('li.partner')).toHaveLength(0);
      expect(el.querySelector('.partner-unavailable')?.textContent).toContain('isn’t available');
    });
  });

  it('renders all four steps with their titles', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    for (const step of ['Step one', 'Step two', 'Step three', 'Step four']) {
      expect(text).toContain(step);
    }
  });

  it('renders the deterministic-math note', () => {
    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Real math, not guesses');
  });

  it('lists what every estimate includes and leaves out (#824)', () => {
    const el = fixture.nativeElement as HTMLElement;
    const titles = [...el.querySelectorAll('app-estimate-scope h2')].map((h) => h.textContent?.trim());
    expect(titles).toEqual(['What this estimate includes', 'Not included']);
    expect(el.querySelectorAll('app-estimate-scope .es-in').length).toBe(DEFAULT_APP_CONFIG.estimateScope.includes.length);
    expect(el.querySelector('app-estimate-scope .es-out')?.textContent).toContain('Demolition');
  });

  it('renders the zoning cross-link card to the zoning guide', () => {
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('Why we ask about your address');
    const link = el.querySelector('a[href="/guides/calgary-zoning-explained"]');
    expect(link?.textContent).toContain('Learn about Calgary zoning');
  });

  it('preselects the project type via NGXS when a CTA is clicked', () => {
    const buttons = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button.cta'),
    );
    expect(buttons).toHaveLength(2);
    expect(buttons[0]?.textContent).toContain('new-build');
    expect(buttons[1]?.textContent).toContain('renovation');
    // Clicking dispatches ChooseProjectType; the wizard entry (/) is the
    // router target and the scope step reads the preselected type.
  });

  it('new-build CTA preselects new-build and enters the wizard at /', () => {
    const router = TestBed.inject(Router);
    const store = TestBed.inject(Store);
    const navigate = vi.spyOn(router, 'navigate');
    const buttons = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button.cta'),
    );
    (buttons[0] as HTMLButtonElement).click();
    expect(store.selectSnapshot(WizardState.projectType)).toBe('new-build');
    expect(navigate).toHaveBeenCalledWith(['/']);
  });

  it('renovation CTA preselects renovation and enters the wizard at /', () => {
    const router = TestBed.inject(Router);
    const store = TestBed.inject(Store);
    const navigate = vi.spyOn(router, 'navigate');
    const buttons = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button.cta'),
    );
    (buttons[1] as HTMLButtonElement).click();
    // The renovation preselect rides in NGXS — the scope step shows
    // Renovation as chosen and its Continue routes to the reno
    // scope-inputs step (→ designed coming-soon page). Routing via `/`
    // keeps wizardPropertyGuard from bouncing fresh visitors.
    expect(store.selectSnapshot(WizardState.projectType)).toBe('renovation');
    expect(navigate).toHaveBeenCalledWith(['/']);
  });

  it('stays indexable: no robots noindex tag', () => {
    expect(TestBed.inject(Meta).getTag('name="robots"')).toBeNull();
  });

  it('sets the page title from the SEO route table', () => {
    expect(document.title).toBe('Feasly — How it works');
  });
});
