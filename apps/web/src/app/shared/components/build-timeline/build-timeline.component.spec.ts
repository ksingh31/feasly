import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from '../../../core/config/app-config.defaults';
import type { AppConfig } from '../../../core/config/app-config';
import { ConfigService } from '../../../core/config/config.service';
import { BuildTimelineComponent } from './build-timeline.component';

/**
 * #823: the typical build timeline renders entirely from config — changing
 * config changes what renders (AC 1).
 */
describe('BuildTimelineComponent', () => {
  function setup(
    buildTimeline: AppConfig['buildTimeline'] = DEFAULT_APP_CONFIG.buildTimeline,
    inputs: { city?: string; showTitle?: boolean } = {},
  ): ComponentFixture<BuildTimelineComponent> {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [BuildTimelineComponent],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (section: keyof AppConfig): unknown =>
              section === 'buildTimeline' ? buildTimeline : DEFAULT_APP_CONFIG[section],
          },
        },
      ],
    });
    const fixture = TestBed.createComponent(BuildTimelineComponent);
    if (inputs.city !== undefined) fixture.componentRef.setInput('city', inputs.city);
    if (inputs.showTitle !== undefined) fixture.componentRef.setInput('showTitle', inputs.showTitle);
    fixture.detectChanges();
    return fixture;
  }

  function phases(fixture: ComponentFixture<BuildTimelineComponent>): string[] {
    return [...(fixture.nativeElement as HTMLElement).querySelectorAll('.bt-phase')].map((li) =>
      (li.textContent ?? '').replace(/\s+/g, ' ').trim(),
    );
  }

  it('renders the default Calgary timeline: six phases, 12–16 month total, pre-sale note', () => {
    const fixture = setup();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h2.bt-title')?.textContent?.trim()).toBe('Typical build timeline');
    expect(el.querySelector('.bt-total')?.textContent?.trim()).toBe('Typical total: 12–16 months');
    expect(phases(fixture)).toEqual([
      'Design and architecture 2–4 months',
      'Development permit 2–4 months',
      'Building permit 1–2 months',
      'Demolition 2–4 weeks',
      'Construction 7–10 months',
      'Final inspections and completion 2–4 weeks',
    ]);
    expect(el.querySelector('.bt-presale')?.textContent?.trim()).toBe(
      'Buying a pre-sale or move-in-ready home follows a different timeline.',
    );
    expect(el.querySelector('ol')?.getAttribute('aria-label')).toBe('Build phases');
  });

  it('changing config changes the timeline', () => {
    const fixture = setup({
      defaultCity: 'calgary',
      cities: {
        calgary: {
          totalMinMonths: 9,
          totalMaxMonths: 11,
          phases: [{ id: 'bp', label: 'Permit review', min: 3, max: 5, unit: 'weeks' }],
        },
      },
    });
    expect(phases(fixture)).toEqual(['Permit review 3–5 weeks']);
    expect((fixture.nativeElement as HTMLElement).querySelector('.bt-total')?.textContent?.trim()).toBe(
      'Typical total: 9–11 months',
    );
  });

  it('picks the requested city (case-insensitive) and renders nothing for an unknown one', () => {
    const config: AppConfig['buildTimeline'] = {
      defaultCity: 'calgary',
      cities: {
        ...DEFAULT_APP_CONFIG.buildTimeline.cities,
        edmonton: {
          totalMinMonths: 10,
          totalMaxMonths: 14,
          phases: [{ id: 'c', label: 'Construction', min: 6, max: 9, unit: 'months' }],
        },
      },
    };
    expect(phases(setup(config, { city: 'Edmonton' }))).toEqual(['Construction 6–9 months']);
    const unknown = setup(config, { city: 'red-deer' });
    expect((unknown.nativeElement as HTMLElement).querySelector('.bt')).toBeNull();
  });

  it('hides its own title when the host heads the section', () => {
    const fixture = setup(DEFAULT_APP_CONFIG.buildTimeline, { showTitle: false });
    expect((fixture.nativeElement as HTMLElement).querySelector('.bt-title')).toBeNull();
    expect(phases(fixture).length).toBe(6);
  });

  it('copy says "typical" and never promises a date', () => {
    const copy = DEFAULT_APP_CONFIG.copy.buildTimeline;
    const all = Object.values(copy).flatMap((v) => (typeof v === 'string' ? [v] : Object.values(v)));
    expect(copy.totalTemplate).toMatch(/typical/i);
    expect(all.join(' ')).not.toMatch(/guarantee|promise|will be (done|complete)/i);
  });
});
