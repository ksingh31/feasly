import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../app.routes';
import { robotsGuard } from '../../core/seo/robots.guard';
import { ConfigService } from '../../core/config';
import {
  SAMPLE_REPORT_ADDRESS,
  SAMPLE_REPORT_DATA,
  SAMPLE_REPORT_NARRATIVE,
  SampleReportPageComponent,
} from './sample-report-page.component';

/** Real Calgary addresses used across fixtures/specs — the sample address must never match one. */
const REAL_ADDRESS_DENYLIST = [
  '1234 14 St NW, Calgary, AB',
  '1410 14 St NW, Calgary, AB',
  '222 7 Ave NE, Calgary, AB',
  '918 16 Ave NW, Calgary, AB',
  '1600 90 Av SW, Calgary, AB',
  '12345 40 St SE, Calgary, AB',
];

/**
 * Story seo/09: the labelled sample report page. Fictional data, unmissable
 * SAMPLE watermark, never gated/emailed/persisted, no conversion events.
 * Layout mirrors the post-consumer/04 report: one hero total + planning range,
 * fixed land figure, exactly three cost buckets, display-only finish tier,
 * always-visible stepper, AI-summary section, next steps, inert share/callback/PDF.
 */
describe('SampleReportPageComponent', () => {
  let fixture: ComponentFixture<SampleReportPageComponent>;
  let httpMock: HttpTestingController;

  async function setup(): Promise<void> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      // Deliberately: NO store, NO API service providers. The sample page must
      // render fully without them — that is the "never persisted / never emailed"
      // guarantee made structural.
      imports: [SampleReportPageComponent],
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock.expectOne('/assets/config/app-config.json').flush({});
    await pending;
    fixture = TestBed.createComponent(SampleReportPageComponent);
    fixture.detectChanges();
  }

  beforeEach(async () => {
    await setup();
  });

  it('marks itself as the fictional sample', () => {
    expect(fixture.componentInstance['sample']).toBe(true);
    expect(SAMPLE_REPORT_DATA.sample).toBe(true);
  });

  it('renders an unmissable SAMPLE watermark', () => {
    const watermark = fixture.nativeElement.querySelector('.sample-watermark');
    expect(watermark).not.toBeNull();
    expect(watermark.getAttribute('aria-hidden')).toBe('true');
    expect(watermark.textContent).toContain('SAMPLE');
  });

  it('frames the uncalibrated-data note for the fictional sample, not a real property', () => {
    const note = fixture.nativeElement.querySelector('.uncalibrated-note');
    expect(note).not.toBeNull();
    expect(note.textContent).toContain('In a real report, your range reflects current cost data');
    expect(note.textContent).not.toContain('your property details');
  });

  it('uses an obviously fictional address (denylisted against real Calgary addresses)', () => {
    expect(SAMPLE_REPORT_ADDRESS).toContain('Sample');
    for (const real of REAL_ADDRESS_DENYLIST) {
      expect(SAMPLE_REPORT_ADDRESS).not.toBe(real);
    }
    const rendered: string = fixture.nativeElement.textContent;
    expect(rendered).toContain(SAMPLE_REPORT_ADDRESS);
    expect(rendered).toContain('Fictional address');
  });

  it('renders one hero total with a planning range — no Low/Base/High labels', () => {
    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('$635,000');
    expect(text).toContain('Likely planning range');
    expect(text).toContain('$561,000');
    expect(text).toContain('$727,000');
    // The consumer/04 redesign removed the Low / Base / High triple.
    const hero = fixture.nativeElement.querySelector('.hero-total');
    expect(hero.textContent).not.toMatch(/\bLow\b/);
    expect(hero.textContent).not.toMatch(/\bBase\b/);
    expect(hero.textContent).not.toMatch(/\bHigh\b/);
  });

  it('shows land as one fixed figure, not a range', () => {
    const landCard = fixture.nativeElement.querySelector('.land-card');
    expect(landCard).not.toBeNull();
    expect(landCard.textContent).toContain('$165,000');
    expect(landCard.textContent).toContain('City of Calgary assessment · not a market price');
    // No range dash in the land figure.
    const figure = landCard.querySelector('.figure-single');
    expect(figure.textContent.trim()).toBe('$165,000');
  });

  it('renders exactly three cost buckets, not trade-level rows', () => {
    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('Where the build budget goes');
    expect(text).toContain('Structure & exterior');
    expect(text).toContain('Interior & home systems');
    expect(text).toContain('Design, permits & contingency');
    // Old trade-level rows are gone.
    expect(text).not.toContain('Foundation & concrete');
    expect(text).not.toContain('Framing & structure');
    expect(text).not.toContain('Mechanical & electrical');
    const segments = fixture.nativeElement.querySelectorAll('.bucket-seg');
    expect(segments.length).toBe(3);
  });

  it('shows the finish tier display-only — no tier toggle', () => {
    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('Selected finish level');
    expect(text).toContain('Standard');
    // The consumer/04 redesign removed the tier switcher from the report.
    expect(fixture.nativeElement.querySelector('.tier-toggle')).toBeNull();
    expect(text).not.toContain('What if you change the finish tier?');
  });

  it('shows an always-visible stepper with no re-run button', () => {
    const stepperCard = fixture.nativeElement.querySelector('.stepper-card');
    expect(stepperCard).not.toBeNull();
    expect(stepperCard.textContent).toContain('Adjust the size');
    // All stepper buttons are disabled (inert on the sample).
    const buttons = stepperCard.querySelectorAll('.step-btn');
    expect(buttons.length).toBe(2);
    buttons.forEach((b: HTMLButtonElement) => expect(b.disabled).toBe(true));
    // No re-run CTA anywhere.
    expect(fixture.nativeElement.textContent).not.toContain('Re-run estimate');
  });

  it('renders the AI-summary section with clearly labelled sample prose', () => {
    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('AI summary');
    expect(text).toContain('Sample text — illustrative only');
    for (const para of SAMPLE_REPORT_NARRATIVE) {
      expect(text).toContain(para.slice(0, 40));
    }
    // The old "coming soon" placeholder is gone.
    expect(text).not.toContain('coming soon');
  });

  it('renders next steps plus inert share/callback/PDF sections', () => {
    const text: string = fixture.nativeElement.textContent;
    expect(text).toContain('Your next three steps');
    expect(text).toContain('Share with a partner');
    expect(text).toContain('Prefer to talk it through?');
    expect(text).toContain('Download PDF');
    // Inert: every CTA on the page is disabled.
    const ctas = fixture.nativeElement.querySelectorAll('.cta');
    expect(ctas.length).toBeGreaterThan(0);
    ctas.forEach((b: HTMLButtonElement) => expect(b.disabled).toBe(true));
  });

  it('keeps fictional figures internally consistent (rows sum to build, total = build + land)', () => {
    const sum = (pick: (r: { low: number; base: number; high: number }) => number) =>
      SAMPLE_REPORT_DATA.rows.reduce((acc, row) => acc + pick(row.range), 0);
    expect(sum((r) => r.base)).toBe(SAMPLE_REPORT_DATA.build.base);
    expect(sum((r) => r.low)).toBe(SAMPLE_REPORT_DATA.build.low);
    expect(sum((r) => r.high)).toBe(SAMPLE_REPORT_DATA.build.high);
    expect(SAMPLE_REPORT_DATA.build.base + SAMPLE_REPORT_DATA.landValue).toBe(
      SAMPLE_REPORT_DATA.total.base,
    );
    expect(SAMPLE_REPORT_DATA.build.low + SAMPLE_REPORT_DATA.landValue).toBe(
      SAMPLE_REPORT_DATA.total.low,
    );
    expect(SAMPLE_REPORT_DATA.build.high + SAMPLE_REPORT_DATA.landValue).toBe(
      SAMPLE_REPORT_DATA.total.high,
    );
  });

  it('never gates: no unlock CTA, no lead-capture forms, no email inputs', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('form').length).toBe(0);
    expect(el.querySelectorAll('input[type="email"]').length).toBe(0);
    const gateLinks = Array.from(el.querySelectorAll('a')).filter((a) =>
      (a.getAttribute('href') ?? '').includes('/estimate/gate'),
    );
    expect(gateLinks.length).toBe(0);
    expect(el.textContent).not.toContain('Unlock my free report');
  });

  it('never persists: touches no browser storage', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem');
    fixture.detectChanges();
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    setItem.mockRestore();
    removeItem.mockRestore();
  });

  it('fires no network calls beyond the config load', () => {
    httpMock.verify();
  });

  it('is routed at /sample-report with noindex', async () => {
    const route = routes.find((r) => r.path === 'sample-report');
    expect(route).toBeDefined();
    // Lazy-loaded (bundle diet): the route uses loadComponent, not component.
    expect(route!.component).toBeUndefined();
    expect(typeof route!.loadComponent).toBe('function');
    const loaded = await route!.loadComponent!();
    expect(loaded).toBe(SampleReportPageComponent);
    expect(route!.data?.['noindex']).toBe(true);
    expect(route!.canActivate).toContain(robotsGuard);
  });
});
