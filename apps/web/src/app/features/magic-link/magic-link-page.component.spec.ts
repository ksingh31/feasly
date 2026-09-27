import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { provideRouter } from '@angular/router';
import { provideStore, Store } from '@ngxs/store';
import { throwError } from 'rxjs';
import { of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MagicLinkVerifyResponse } from '@feasly/contracts';
import { API_SERVICE } from '../../core/api/api.service';
import { ConfigService } from '../../core/config';
import { MagicLinkPageComponent } from './magic-link-page.component';
import { SetReportToken } from '../report/report.actions';

/**
 * Magic-link redemption (consumer/02): `/r/:token` verifies the token,
 * hands the report token to the report NGXS state, and lands on the unlocked
 * report. Expired/invalid/empty tokens show an error card with a resend form
 * (POST /api/v1/magic-link/reissue). Transport failures show a retry screen.
 * The page is noindexed.
 */
describe('MagicLinkPageComponent', () => {
  let fixture: ComponentFixture<MagicLinkPageComponent>;
  let httpMock: HttpTestingController;
  let api: {
    verifyMagicLink: ReturnType<typeof vi.fn>;
    reissueMagicLink: ReturnType<typeof vi.fn>;
  };
  let dispatchSpy: ReturnType<typeof vi.spyOn>;
  let navigateSpy: ReturnType<typeof vi.spyOn>;

  function text(): string {
    return (fixture.nativeElement as HTMLElement).textContent ?? '';
  }

  async function setup(token: string | null, response: MagicLinkVerifyResponse | { error: unknown }): Promise<void> {
    TestBed.resetTestingModule();
    api = {
      verifyMagicLink: vi.fn(),
      reissueMagicLink: vi.fn(),
    };
    if ('error' in response) {
      api.verifyMagicLink.mockReturnValue(throwError(() => response.error));
    } else {
      api.verifyMagicLink.mockReturnValue(of(response));
    }
    api.reissueMagicLink.mockReturnValue(of({ sent: true }));
    TestBed.configureTestingModule({
      imports: [MagicLinkPageComponent],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        provideStore([]),
        { provide: API_SERVICE, useValue: api },
        {
          provide: ActivatedRoute,
          useValue: { snapshot: { paramMap: convertToParamMap(token ? { token } : {}) } },
        },
      ],
    });
    httpMock = TestBed.inject(HttpTestingController);
    const pending = TestBed.inject(ConfigService).load();
    httpMock.expectOne('/assets/config/app-config.json').flush({});
    await pending;
    dispatchSpy = vi.spyOn(TestBed.inject(Store), 'dispatch');
    navigateSpy = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(MagicLinkPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('valid token dispatches SetReportToken and navigates to the report', async () => {
    await setup('tok-abc', { valid: true, reportToken: 'rep-123', estimateId: 'est-1', leadId: 'lead-1' });
    expect(api.verifyMagicLink).toHaveBeenCalledWith('tok-abc');
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    const action = dispatchSpy.mock.calls[0][0];
    expect(action).toBeInstanceOf(SetReportToken);
    expect(action.reportToken).toBe('rep-123');
    expect(navigateSpy).toHaveBeenCalledWith(['/estimate/report']);
  });

  it('expired token shows the expired card with a resend form', async () => {
    await setup('tok-old', { valid: false, reason: 'expired', reissueAllowed: true });
    expect(text()).toContain('expired');
    expect(fixture.nativeElement.querySelector('form')).toBeTruthy();
    expect(dispatchSpy).not.toHaveBeenCalled();
    expect(navigateSpy).not.toHaveBeenCalled();
  });

  it('invalid token shows the invalid card with a resend form', async () => {
    await setup('tok-bogus', { valid: false, reason: 'invalid', reissueAllowed: true });
    expect(text()).toContain('valid');
    expect(fixture.nativeElement.querySelector('form')).toBeTruthy();
    expect(dispatchSpy).not.toHaveBeenCalled();
  });

  it('empty token shows the invalid card without calling the API', async () => {
    await setup(null, { valid: false, reason: 'invalid', reissueAllowed: true });
    expect(api.verifyMagicLink).not.toHaveBeenCalled();
    expect(text()).toContain('valid');
  });

  it('transport failure shows the error card and retry re-verifies', async () => {
    await setup('tok-abc', { error: { code: 'NETWORK_ERROR' } });
    expect(text()).toContain('Something went wrong');
    expect(api.verifyMagicLink).toHaveBeenCalledTimes(1);
    api.verifyMagicLink.mockReturnValue(
      of({ valid: true, reportToken: 'rep-123', estimateId: 'est-1', leadId: 'lead-1' }),
    );
    (fixture.nativeElement.querySelector('button.cta') as HTMLButtonElement).click();
    await fixture.whenStable();
    expect(api.verifyMagicLink).toHaveBeenCalledTimes(2);
    expect(navigateSpy).toHaveBeenCalledWith(['/estimate/report']);
  });

  it('resend posts the email and shows the sent confirmation', async () => {
    await setup('tok-old', { valid: false, reason: 'expired', reissueAllowed: true });
    const input = fixture.nativeElement.querySelector('input[type="email"]') as HTMLInputElement;
    input.value = 'qa@example.com';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit'),
    );
    await fixture.whenStable();
    expect(api.reissueMagicLink).toHaveBeenCalledWith({ email: 'qa@example.com' });
    expect(text()).toContain('on its way');
  });

  it('resend with an invalid email does not call the API', async () => {
    await setup('tok-old', { valid: false, reason: 'expired', reissueAllowed: true });
    const input = fixture.nativeElement.querySelector('input[type="email"]') as HTMLInputElement;
    input.value = 'not-an-email';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('form') as HTMLFormElement).dispatchEvent(
      new Event('submit'),
    );
    await fixture.whenStable();
    expect(api.reissueMagicLink).not.toHaveBeenCalled();
    expect(text()).toContain('valid email');
  });
});
