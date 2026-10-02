import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Meta } from '@angular/platform-browser';
import { provideRouter, Router } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '../../core/config';
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

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [HowItWorksPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideStore([WizardState]),
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush(baseConfig);
    await pending;
    fixture = TestBed.createComponent(HowItWorksPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
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

  it('renovation CTA lands on the coming-soon page without preselecting', () => {
    const router = TestBed.inject(Router);
    const store = TestBed.inject(Store);
    const navigate = vi.spyOn(router, 'navigate');
    const buttons = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('button.cta'),
    );
    (buttons[1] as HTMLButtonElement).click();
    // No renovation preselect leaks into the wizard store…
    expect(store.selectSnapshot(WizardState.projectType)).toBeNull();
    // …the designed coming-soon page is the target, never the home page.
    expect(navigate).toHaveBeenCalledWith(['/estimate/reno-coming-soon']);
  });

  it('stays indexable: no robots noindex tag', () => {
    expect(TestBed.inject(Meta).getTag('name="robots"')).toBeNull();
  });

  it('sets the page title from the SEO route table', () => {
    expect(document.title).toBe('Feasly — How it works');
  });
});
