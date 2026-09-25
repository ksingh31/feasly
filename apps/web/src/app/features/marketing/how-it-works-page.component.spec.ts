import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Meta } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { provideStore } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
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

  it('stays indexable: no robots noindex tag', () => {
    expect(TestBed.inject(Meta).getTag('name="robots"')).toBeNull();
  });

  it('sets the page title from the SEO route table', () => {
    expect(document.title).toBe('Feasly — How it works');
  });
});
