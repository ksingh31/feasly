import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from '../../../core/config/app-config.defaults';
import type { AppConfig } from '../../../core/config/app-config';
import { ConfigService } from '../../../core/config/config.service';
import { ESTIMATE_LINE_ITEMS } from '../../../core/config/estimate-scope.generated';
import { EstimateScopeComponent, type EstimateScopePart } from './estimate-scope.component';

/**
 * #824: the includes list is the engine's line items (generated file — the
 * cost-engine agreement test pins that file to `createEstimate()` rows);
 * the not-included list is config, minus anything the engine now prices.
 */
describe('EstimateScopeComponent', () => {
  function setup(
    estimateScope: AppConfig['estimateScope'] = DEFAULT_APP_CONFIG.estimateScope,
    inputs: { part?: EstimateScopePart; headingLevel?: 2 | 3; showTitles?: boolean } = {},
  ): ComponentFixture<EstimateScopeComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [EstimateScopeComponent],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (section: keyof AppConfig): unknown =>
              section === 'estimateScope' ? estimateScope : DEFAULT_APP_CONFIG[section],
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(EstimateScopeComponent);
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    return fixture;
  }

  function texts(fixture: ComponentFixture<EstimateScopeComponent>, selector: string): string[] {
    return [...(fixture.nativeElement as HTMLElement).querySelectorAll(selector)].map((el) =>
      (el.textContent ?? '').trim(),
    );
  }

  it('the default includes list is exactly the engine line items, in engine order', () => {
    expect(DEFAULT_APP_CONFIG.estimateScope.includes).toBe(ESTIMATE_LINE_ITEMS.items);
    const fixture = setup();
    expect(texts(fixture, '.es-in')).toEqual(ESTIMATE_LINE_ITEMS.items.map((i) => i.label));
    expect(texts(fixture, '.es-in')).toEqual([
      'Envelope (roof, siding, windows)',
      'Interior finishes',
      'Foundation',
      'Framing & structure',
      'Mechanical, electrical & plumbing',
      'Site preparation & excavation',
      'Design & engineering',
      'Permits & fees',
      'Contingency',
    ]);
  });

  it('renders the not-included list from config, with titles', () => {
    const fixture = setup();
    expect(texts(fixture, 'h3.es-title')).toEqual(['What this estimate includes', 'Not included']);
    expect(texts(fixture, '.es-out')).toEqual([
      'Demolition of an existing home',
      'Utility connections (water, sewer, gas, power)',
      'Landscaping & driveway',
      'New-home warranty',
      'GST',
      'Buying the land (the total adds the City-assessed lot value)',
    ]);
  });

  it('an item the engine starts pricing moves from "Not included" to "includes" (#825)', () => {
    const fixture = setup({
      includes: [...DEFAULT_APP_CONFIG.estimateScope.includes, { key: 'hard.demolition', label: 'Demolition' }],
      notIncluded: DEFAULT_APP_CONFIG.estimateScope.notIncluded,
    });
    expect(texts(fixture, '.es-in')).toContain('Demolition');
    expect(texts(fixture, '.es-out')).not.toContain('Demolition of an existing home');
    expect(texts(fixture, '.es-out')).toContain('GST');
  });

  it('renders one part only, at the requested heading level, or without titles', () => {
    let fixture = setup(undefined, { part: 'includes', headingLevel: 2 });
    expect(texts(fixture, 'h2.es-title')).toEqual(['What this estimate includes']);
    expect(texts(fixture, '.es-out')).toEqual([]);

    fixture = setup(undefined, { part: 'excluded', showTitles: false });
    expect(texts(fixture, '.es-title')).toEqual([]);
    expect(texts(fixture, '.es-in')).toEqual([]);
    expect(texts(fixture, '.es-out').length).toBe(6);
  });

  it('copy makes no accuracy claims', () => {
    const fixture = setup();
    const text = ((fixture.nativeElement as HTMLElement).textContent ?? '').toLowerCase();
    for (const banned of ['accurate', 'accuracy', 'guarantee', 'exact', 'precise', 'appraisal', 'market value']) {
      expect(text).not.toContain(banned);
    }
  });
});
