/**
 * Shared view-as banner tests (auth/04, DRYed for builder-side view-as,
 * 2026-09-30).
 *
 * The banner is a dumb component now: the host shell supplies the banner
 * model (from its NGXS selector) and handles the exit event. Verifies:
 * - hides when the banner input is null,
 * - renders "Viewing as X" + the real-identity note while active,
 * - renders "no longer available" copy when the target is gone
 *   (displayName null),
 * - clicking Exit emits the exit event (the host dispatches its own
 *   exit action — admin and builder each wire their own).
 * The banner is display-only — enforcement tests live in the API suite.
 */
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ViewAsBannerComponent,
  type ViewAsBannerModel,
} from './view-as-banner.component';

describe('ViewAsBannerComponent (shared)', () => {
  let fixture: ComponentFixture<ViewAsBannerComponent>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ViewAsBannerComponent],
    });
    fixture = TestBed.createComponent(ViewAsBannerComponent);
  });

  function setBanner(banner: ViewAsBannerModel | null): void {
    fixture.componentInstance.banner = banner;
    fixture.detectChanges();
  }

  it('hides the banner when the input is null', () => {
    setBanner(null);
    expect(
      fixture.nativeElement.querySelector('.view-as-banner'),
    ).toBeNull();
  });

  it('shows "Viewing as X" with the real-identity note while active', () => {
    setBanner({ displayName: 'Team Member', realEmail: 'admin@builder.com' });
    const banner = fixture.nativeElement.querySelector('.view-as-banner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('Viewing as');
    expect(banner.textContent).toContain('Team Member');
    expect(banner.textContent).toContain('admin@builder.com');
    expect(
      fixture.nativeElement.querySelector('.view-as-banner__exit'),
    ).not.toBeNull();
  });

  it('shows "no longer available" copy when the target is gone', () => {
    setBanner({ displayName: null, realEmail: 'admin@builder.com' });
    const banner = fixture.nativeElement.querySelector('.view-as-banner');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain('no longer available');
    expect(
      fixture.nativeElement.querySelector('.view-as-banner__exit'),
    ).not.toBeNull();
  });

  it('emits exit when the Exit button is clicked', () => {
    setBanner({ displayName: 'Team Member', realEmail: 'admin@builder.com' });
    let emitted = 0;
    fixture.componentInstance.exit.subscribe(() => {
      emitted += 1;
    });
    const button = fixture.nativeElement.querySelector(
      '.view-as-banner__exit',
    ) as HTMLButtonElement;
    button.click();
    expect(emitted).toBe(1);
  });
});
