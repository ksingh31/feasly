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

  it('uses an obviously fictional address (denylisted against real Calgary addresses)', () => {
    expect(SAMPLE_REPORT_ADDRESS).toContain('Sample');
    for (const real of REAL_ADDRESS_DENYLIST) {
      expect(SAMPLE_REPORT_ADDRESS).not.toBe(real);
    }
    const rendered: string = fixture.nativeElement.textContent;
    expect(rendered).toContain(SAMPLE_REPORT_ADDRESS);
    expect(rendered).toContain('Fictional address');
  });

  it('renders the full unlocked report layout with fictional ranges', () => {
    const text: string = fixture.nativeElement.textContent;
    // Hero Low / Base / High.
    expect(text).toContain('Low');
    expect(text).toContain('Base');
    expect(text).toContain('High');
    expect(text).toContain('$585,000');
    // Breakdown rows.
    expect(text).toContain('Cost breakdown');
    expect(text).toContain('Foundation & concrete');
    // Tier what-if, adjust, narrative placeholder, next steps.
    expect(text).toContain('What if you change the finish tier?');
    expect(text).toContain('Adjust the size');
    expect(text).toContain('AI summary');
    expect(text).toContain('Uncalibrated planning figures');
  });

  it('never gates: no unlock CTA, no lead-capture forms, no email inputs', () => {
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelectorAll('form').length).toBe(0);
    expect(el.querySelectorAll('input[type="email"]').length).toBe(0);
    const gateLinks = Array.from(el.querySelectorAll('a')).filter((a) =>
      (a.getAttribute('href') ?? '').includes('/estimate/gate'),
    );
    expect(gateLinks.length).toBe(0);
    expect(el.textContent).not.toContain('Unlock my full report');
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

  it('is routed at /sample-report with noindex', () => {
    const route = routes.find((r) => r.path === 'sample-report');
    expect(route).toBeDefined();
    expect(route!.component).toBe(SampleReportPageComponent);
    expect(route!.data?.['noindex']).toBe(true);
    expect(route!.canActivate).toContain(robotsGuard);
  });
});
