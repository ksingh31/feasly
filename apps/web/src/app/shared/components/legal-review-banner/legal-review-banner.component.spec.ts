import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { ConfigService } from '../../../core/config/config.service';
import { LegalReviewBannerComponent } from './legal-review-banner.component';

/**
 * legal/01 AC3: the LEGAL_REVIEW_PENDING banner renders if and only if the
 * `legal.reviewPending` flag is true.
 */
describe('LegalReviewBannerComponent', () => {
  let fixture: ComponentFixture<LegalReviewBannerComponent>;

  function setup(reviewPending: boolean): void {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [LegalReviewBannerComponent],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: (section: 'legal' | 'copy'): unknown =>
              section === 'legal'
                ? { reviewPending }
                : {
                    legal: {
                      reviewBannerHeading: 'Draft — pending legal review',
                      reviewBannerBody: 'Draft body.',
                    },
                  },
          },
        },
      ],
    });
    fixture = TestBed.createComponent(LegalReviewBannerComponent);
    fixture.detectChanges();
  }

  it('renders the draft banner while legal review is pending', () => {
    setup(true);
    const banner = fixture.nativeElement.querySelector('.legal-review-banner');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toContain('Draft — pending legal review');
    expect(banner?.getAttribute('role')).toBe('note');
  });

  it('renders nothing once legal review is complete', () => {
    setup(false);
    expect(fixture.nativeElement.querySelector('.legal-review-banner')).toBeNull();
  });
});
