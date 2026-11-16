import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Meta } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Observable, of, throwError } from 'rxjs';
import type { BuilderPartnerListResponse, CityDataFreshnessResponse } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config';
import { DEFAULT_APP_CONFIG } from '../../core/config/app-config.defaults';
import { PartnersState } from '../../core/partners';
import { WizardState } from '../wizard/wizard.state';
import { ESTIMATE_WORKED_EXAMPLE } from '../../core/config/estimate-scope.generated';
import { formatWholeCad } from '../../shared/utils/money';
import { formatIsoDate, HowItWorksPageComponent } from './how-it-works-page.component';
import { DEFAULT_HOW_IT_WORKS_COPY } from './how-it-works-copy.defaults';

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
  /** #827: the live assessment-roll freshness the stub API returns. */
  let freshness$: () => Observable<CityDataFreshnessResponse>;
  const getCityDataFreshness = vi.fn(() => freshness$());
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
        { provide: API_SERVICE, useValue: { getPartners, getCityDataFreshness } },
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
    getCityDataFreshness.mockClear();
    partners$ = () => of(LIST);
    freshness$ = () => of({ refreshedMonth: 'September 2026', rollYear: 2026 });
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

  describe('#827: transparency sections', () => {
    const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
    const copy = DEFAULT_HOW_IT_WORKS_COPY;
    const engineRows = DEFAULT_APP_CONFIG.howWeEstimate.workedExample.groups.flatMap((g) => g.rows);
    const range = (b: { low: number; high: number }): string => `${formatWholeCad(b.low)} – ${formatWholeCad(b.high)}`;

    it('opens with the answer-first passage right under the h1', () => {
      expect(el().querySelectorAll('h1')).toHaveLength(1);
      expect(el().querySelector('h1 + p.answer')?.textContent).toContain('hard costs + soft costs + contingency');
    });

    it('shows the formula as hard + soft + contingency = range, listing every engine line item', () => {
      const terms = [...el().querySelectorAll('.formula-term-title')].map((t) => t.textContent?.trim());
      expect(terms).toEqual(['Hard costs', 'Soft costs', 'Contingency', 'Your build range']);
      const ops = [...el().querySelectorAll('.formula-op')].map((o) => o.textContent?.trim());
      expect(ops).toEqual(['+', '+', '=']);
      const keys = [...el().querySelectorAll('.formula-item')].map((i) => i.getAttribute('data-key'));
      expect(keys).toEqual(engineRows.map((r) => r.key));
      expect(keys).toEqual(DEFAULT_APP_CONFIG.estimateScope.includes.map((i) => i.key));
    });

    it('every engine line item has a "what it covers" note', () => {
      for (const r of engineRows) {
        expect(copy.lineItemNotes[r.key], r.key).toBeTruthy();
      }
      for (const item of el().querySelectorAll('.formula-item')) {
        expect(item.querySelector('.formula-item-note')?.textContent?.trim()).toBeTruthy();
      }
    });

    it('explains why a range: finish level, lot conditions, market movement', () => {
      const text = el().querySelector('[aria-labelledby="why-range-title"]')?.textContent ?? '';
      for (const t of ['Finish level', 'Lot conditions', 'Market movement']) expect(text).toContain(t);
    });

    it('stamps each data source: live assessment month, catalogue date, cost-data version', () => {
      const stamp = (key: string): string =>
        el().querySelector(`[data-source="${key}"] .source-stamp`)?.textContent?.trim() ?? '';
      expect(getCityDataFreshness).toHaveBeenCalledTimes(1);
      expect(stamp('assessment')).toBe('Updated September 2026');
      expect(stamp('land-use')).toBe(`Rules as of ${formatIsoDate(DEFAULT_APP_CONFIG.howWeEstimate.landUseRulesAsOf)}`);
      expect(stamp('cost-data')).toBe(`Version ${ESTIMATE_WORKED_EXAMPLE.costDataVersion}`);
      const assessmentLink = el().querySelector('[data-source="assessment"] a') as HTMLAnchorElement;
      expect(assessmentLink.getAttribute('href')).toBe(DEFAULT_APP_CONFIG.howWeEstimate.sourceUrls.assessment);
      expect(assessmentLink.getAttribute('rel')).toContain('noopener');
      expect(el().querySelector('[data-source="land-use"] a')?.getAttribute('href')).toBe(
        DEFAULT_APP_CONFIG.howWeEstimate.sourceUrls.landUse,
      );
    });

    it('falls back to an undated assessment line when freshness is unavailable', async () => {
      freshness$ = () => throwError(() => new Error('down'));
      await mount();
      fixture.detectChanges();
      expect(el().querySelector('[data-source="assessment"] .source-stamp')?.textContent?.trim()).toBe(
        copy.sources.assessment.stampUnknown,
      );
    });

    it('renders the typical build timeline (shared component)', () => {
      expect(el().querySelector('app-build-timeline .bt-phases')).not.toBeNull();
    });

    it('prices the worked example with the engine-generated figures, in a table', () => {
      const intro = el().querySelector('[aria-labelledby="example-title"] > p')?.textContent ?? '';
      expect(intro).toContain('2,400 sq ft home, Standard finish, on a 6,000 sq ft lot');
      const table = el().querySelector('table.example-table') as HTMLTableElement;
      const text = table.textContent ?? '';
      for (const g of ESTIMATE_WORKED_EXAMPLE.groups) {
        expect(text).toContain(range(g.subtotal));
        if (g.rows.length > 1) for (const r of g.rows) expect(text).toContain(range(r.range));
      }
      expect(table.querySelector('tfoot .total td')?.textContent?.trim()).toBe(range(ESTIMATE_WORKED_EXAMPLE.build));
      expect(el().textContent).toContain(`Priced with cost data ${ESTIMATE_WORKED_EXAMPLE.costDataVersion}.`);
    });

    it('every dollar figure on the page is an engine-generated worked-example figure', () => {
      const allowed = new Set(
        [...engineRows.map((r) => r.range), ...ESTIMATE_WORKED_EXAMPLE.groups.map((g) => g.subtotal), ESTIMATE_WORKED_EXAMPLE.build]
          .flatMap((b) => [formatWholeCad(b.low), formatWholeCad(b.high)]),
      );
      const figures = (el().textContent ?? '').match(/\$[\d,]+/g) ?? [];
      expect(figures.length).toBeGreaterThan(0);
      for (const f of figures) expect(allowed.has(f), f).toBe(true);
    });

    it('says how the data stays current and what happens next', () => {
      expect(el().querySelectorAll('[aria-labelledby="current-title"] li')).toHaveLength(copy.currentItems.length);
      const steps = [...el().querySelectorAll('.next-step h3')].map((h) => h.textContent?.trim());
      expect(steps).toEqual(['Your estimate', 'A builder gets in touch', 'Site visit', 'Your quote']);
      expect(el().querySelector('.next-steps')?.textContent).toContain('3–5 business days');
    });

    it('links to the FAQ and guide; the sample report link waits for its feature flag', () => {
      const hrefs = [...el().querySelectorAll('.hwe-links a')].map((a) => a.getAttribute('href'));
      expect(hrefs).toContain('/faq');
      expect(hrefs).toContain('/guides/cost-to-build-a-house-calgary');
      expect(hrefs).not.toContain('/sample-report');
    });
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
