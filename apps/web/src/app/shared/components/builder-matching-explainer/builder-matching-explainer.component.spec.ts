import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
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
});
