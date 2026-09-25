import { ComponentFixture, TestBed } from '@angular/core/testing';
import { RouterTestingModule } from '@angular/router/testing';
import { of, throwError, type Observable } from 'rxjs';
import { vi } from 'vitest';
import { FunnelsPageComponent } from './funnels-page.component';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config';
import { SeoService } from '../../core/seo';
import type { FunnelReport } from '../../core/api/funnel.types';

const FUNNELS_COPY = {
  title: 'Funnel dashboard',
  subtitle: 'Numbers only.',
  fromLabel: 'From',
  toLabel: 'To',
  tenantLabel: 'Traffic',
  tenantAll: 'All traffic',
  tenantDirect: 'Feasly direct',
  tenantKey: 'One builder…',
  tenantKeyLabel: 'Builder tenant key',
  tenantKeyPlaceholder: 'e.g. elite-craft',
  apply: 'Apply',
  reset: 'Reset',
  loading: 'Loading funnel…',
  empty: 'No visits in this range yet.',
  loadError: 'Couldn’t load the funnel.',
  invalidRange: 'The start date must be on or before the end date.',
  entryStep: 'Entry step',
  conversionPrefix: 'Converted from previous step:',
  noConversion: '—',
};

const REPORT: FunnelReport = {
  from: null,
  to: null,
  tenant: 'all',
  steps: [
    { step: 'scope', label: 'Scope', count: 100, conversionFromPrevious: null },
    { step: 'details', label: 'Details', count: 80, conversionFromPrevious: 0.8 },
    { step: 'preview', label: 'Preview', count: 60, conversionFromPrevious: 0.75 },
    { step: 'gate', label: 'Gate', count: 40, conversionFromPrevious: 0.6667 },
    { step: 'report', label: 'Report', count: 20, conversionFromPrevious: 0.5 },
  ],
};

const EMPTY_REPORT: FunnelReport = {
  from: null,
  to: null,
  tenant: 'all',
  steps: REPORT.steps.map((s) => ({ ...s, count: 0, conversionFromPrevious: null })),
};

describe('FunnelsPageComponent', () => {
  let fixture: ComponentFixture<FunnelsPageComponent>;
  let api: { getFunnel: ReturnType<typeof vi.fn> };

  async function setup(report$: Observable<FunnelReport>) {
    api = { getFunnel: vi.fn().mockReturnValue(report$) };
    const configStub = {
      get: (section: string) =>
        section === 'copy' ? { admin: { funnels: FUNNELS_COPY } } : {},
    };
    const seoStub = { setForRoute: () => undefined };
    await TestBed.configureTestingModule({
      imports: [FunnelsPageComponent, RouterTestingModule],
      providers: [
        { provide: API_SERVICE, useValue: api },
        { provide: ConfigService, useValue: configStub },
        { provide: SeoService, useValue: seoStub },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(FunnelsPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('renders all five funnel steps with counts', async () => {
    await setup(of(REPORT));
    const el: HTMLElement = fixture.nativeElement;
    const labels = [...el.querySelectorAll('.funnels__step-label')].map((n) => n.textContent?.trim());
    expect(labels).toEqual(['Scope', 'Details', 'Preview', 'Gate', 'Report']);
    const counts = [...el.querySelectorAll('.funnels__step-count')].map((n) => n.textContent?.trim());
    expect(counts).toEqual(['100', '80', '60', '40', '20']);
  });

  it('shows conversion percentages and the entry-step label', async () => {
    await setup(of(REPORT));
    const text: string = fixture.nativeElement.textContent ?? '';
    expect(text).toContain('Entry step');
    expect(text).toContain('80.0%');
    expect(text).toContain('50.0%');
  });

  it('renders the empty state when every step has zero counts', async () => {
    await setup(of(EMPTY_REPORT));
    const text: string = fixture.nativeElement.textContent ?? '';
    expect(text).toContain(FUNNELS_COPY.empty);
    expect(fixture.nativeElement.querySelector('.funnels__steps')).toBeNull();
  });

  it('renders the error banner on fetch failure and keeps no stale crash', async () => {
    await setup(throwError(() => new Error('nope')));
    const text: string = fixture.nativeElement.textContent ?? '';
    expect(text).toContain(FUNNELS_COPY.loadError);
  });

  it('blocks apply when from is after to', async () => {
    await setup(of(REPORT));
    api.getFunnel.mockClear();
    const component = fixture.componentInstance as unknown as {
      from: { set(v: string): void };
      to: { set(v: string): void };
      applyFilters(): void;
    };
    component.from.set('2026-09-20');
    component.to.set('2026-09-10');
    fixture.detectChanges();
    const text: string = fixture.nativeElement.textContent ?? '';
    expect(text).toContain(FUNNELS_COPY.invalidRange);
    component.applyFilters();
    expect(api.getFunnel).not.toHaveBeenCalled();
  });

  it('exposes the tenant-key input only in key mode', async () => {
    await setup(of(REPORT));
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('input[name="tenantKey"]')).toBeNull();
    const component = fixture.componentInstance as unknown as {
      tenantMode: { set(v: 'all' | 'direct' | 'key'): void };
    };
    component.tenantMode.set('key');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('input[name="tenantKey"]')).toBeTruthy();
  });
});
