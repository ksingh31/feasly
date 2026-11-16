import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { DEFAULT_APP_CONFIG } from '../../../core/config/app-config.defaults';
import { ConfigService } from '../../../core/config/config.service';
import { BuilderMatchingExplainerComponent } from './builder-matching-explainer.component';

/**
 * UX audit 2026-09-28: one honest definition of "builders associated with
 * us" / "matched builder", shared by the gate, report next-steps, and FAQ.
 * Native <details> disclosure — no JS behaviour to test beyond rendering
 * the config-owned copy.
 */
describe('BuilderMatchingExplainerComponent', () => {
  let fixture: ComponentFixture<BuilderMatchingExplainerComponent>;

  function setup(): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [BuilderMatchingExplainerComponent],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (section: 'copy'): unknown =>
              section === 'copy'
                ? {
                    builderMatching: {
                      summary: 'What does "builders associated with us" mean?',
                      paragraphs: ['Para one.', 'Para two.'],
                    },
                  }
                : undefined,
          },
        },
      ],
    });
    fixture = TestBed.createComponent(BuilderMatchingExplainerComponent);
    fixture.detectChanges();
  }

  it('renders the summary question and all paragraphs', () => {
    setup();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('summary')?.textContent?.trim()).toBe(
      'What does "builders associated with us" mean?',
    );
    const paras = [...el.querySelectorAll('.bm-body p')].map((p) => p.textContent?.trim());
    expect(paras).toEqual(['Para one.', 'Para two.']);
  });

  it('uses a native details/summary disclosure', () => {
    setup();
    expect(fixture.nativeElement.querySelector('details.bm-explainer')).not.toBeNull();
  });

  // #878 (owner decision 2026-11-15): the shipped explainer discloses the
  // partner model, matching the #847 disclosure on the same screen.
  it('ships partner-model copy: referral commission, no obligation, no neutral-matching claims', () => {
    const text = DEFAULT_APP_CONFIG.copy.builderMatching.paragraphs.join(' ');
    expect(text).toContain('builder partner(s), listed on How it works');
    expect(text).toContain('referral commission only if you sign a contract');
    expect(text).toContain('never changes your estimate');
    expect(text).toContain('never obliged to hire anyone');
    expect(text).not.toMatch(/paid placement|favou?rites|project fit|hand[- ]?pick|rank/i);
  });
});
