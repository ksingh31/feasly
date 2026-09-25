import { provideHttpClient } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideStore, Store } from '@ngxs/store';
import { beforeEach, describe, expect, it } from 'vitest';
import { AcknowledgeConsent } from './consent.actions';
import { ConsentBannerComponent } from './consent-banner.component';
import { ConsentState } from './consent.state';

/**
 * Story consumer/01: banner renders on first visit (pending), accept/decline
 * record the choice, and the banner disappears once acknowledged. Copy comes
 * from config (no hardcoded strings).
 */
describe('ConsentBannerComponent', () => {
  let fixture: ComponentFixture<ConsentBannerComponent>;
  let store: Store;

  beforeEach(async () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ConsentBannerComponent],
      providers: [provideHttpClient(), provideStore([ConsentState])],
    });
    await TestBed.compileComponents();
    store = TestBed.inject(Store);
    fixture = TestBed.createComponent(ConsentBannerComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  it('renders on first visit with config copy', () => {
    const banner = fixture.debugElement.query(By.css('[data-testid="consent-banner"]'));
    expect(banner).not.toBeNull();
    expect(banner.nativeElement.textContent).toContain('A quick word on analytics.');
    expect(
      fixture.debugElement.query(By.css('[data-testid="consent-accept"]')).nativeElement
        .textContent,
    ).toContain('Accept analytics');
    expect(
      fixture.debugElement.query(By.css('[data-testid="consent-decline"]')).nativeElement
        .textContent,
    ).toContain('Decline');
  });

  it('accept dispatches granted and hides the banner', async () => {
    fixture.debugElement.query(By.css('[data-testid="consent-accept"]')).nativeElement.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(store.selectSnapshot(ConsentState.status)).toBe('granted');
    expect(fixture.debugElement.query(By.css('[data-testid="consent-banner"]'))).toBeNull();
  });

  it('decline dispatches declined and hides the banner', async () => {
    fixture.debugElement.query(By.css('[data-testid="consent-decline"]')).nativeElement.click();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(store.selectSnapshot(ConsentState.status)).toBe('declined');
    expect(fixture.debugElement.query(By.css('[data-testid="consent-banner"]'))).toBeNull();
  });

  it('stays hidden when consent was already acknowledged', async () => {
    store.dispatch(new AcknowledgeConsent(true));
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.debugElement.query(By.css('[data-testid="consent-banner"]'))).toBeNull();
  });
});
