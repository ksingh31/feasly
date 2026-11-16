import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { NEVER, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SetReportToken } from '../report/report.actions';
import { MyDataPageComponent } from './my-data-page.component';
import { configurePrivacyTestBed, privacyApiMock, type PrivacyApiMock } from './test-helpers/privacy-test-setup';

const REQUEST_ID = '3f9b2c1a-0000-4000-8000-000000000000';
const err = (code: string) => throwError(() => ({ code, message: 'x', retryable: false }));

/**
 * `/privacy/my-data` (#706): every state — idle (with / without token),
 * working, done, pending erasure, expired, rate-limited, error, link sent.
 */
describe('MyDataPageComponent', () => {
  let fixture: ComponentFixture<MyDataPageComponent>;
  let api: PrivacyApiMock;
  let files: { saveJson: ReturnType<typeof vi.fn> };

  async function setup(token: string | null, config?: Record<string, unknown>): Promise<void> {
    await configurePrivacyTestBed({
      api,
      files,
      config,
      imports: [MyDataPageComponent],
      providers: [provideRouter([])],
    });
    if (token) TestBed.inject(Store).dispatch(new SetReportToken(token));
    fixture = TestBed.createComponent(MyDataPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const text = (): string => el().textContent ?? '';
  const q = (sel: string): HTMLElement | null => el().querySelector(sel);
  async function click(sel: string): Promise<void> {
    (q(sel) as HTMLElement).click();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(() => {
    api = privacyApiMock();
    files = { saveJson: vi.fn() };
  });

  it('idle with a token: download + delete actions, no email form', async () => {
    await setup('tok');
    expect(q('[data-action="download"]')).not.toBeNull();
    expect(q('[data-action="delete"]')).not.toBeNull();
    expect(q('input[type="email"]')).toBeNull();
    expect(text()).not.toContain('tok');
  });

  it('working: the download button disables and shows progress', async () => {
    api.exportPrivacyData.mockReturnValue(NEVER);
    await setup('tok');
    await click('[data-action="download"]');
    const btn = q('[data-action="download"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('Preparing your file');
  });

  it('done: downloads the file and confirms on screen', async () => {
    api.exportPrivacyData.mockReturnValue(of({ email: 'jane@example.com' }));
    await setup('tok');
    await click('[data-action="download"]');
    expect(api.exportPrivacyData).toHaveBeenCalledWith('tok');
    expect(files.saveJson).toHaveBeenCalled();
    expect(q('[data-state="download-done"]')).not.toBeNull();
    expect(text()).not.toContain('jane@example.com');
  });

  it('pending erasure (in-page flag on): shows the consequences and routes to the confirm page', async () => {
    api.requestErasure.mockReturnValue(
      of({ requestId: REQUEST_ID, status: 'requested', consequences: ['Leads are deleted.'], createdAt: 'now' }),
    );
    await setup('tok', { features: { privacyEraseConfirmInPage: true } });
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    await click('[data-action="delete"]');
    expect(q('[data-state="pending"]')).not.toBeNull();
    expect(text()).toContain('Leads are deleted.');
    await click('.cta.danger');
    expect(navigate).toHaveBeenCalledWith(['/privacy/confirm', REQUEST_ID], {
      state: { privacyConfirmed: true },
    });
  });

  it('with the emailed-confirm flow (flag off) the pending state says "check your email" and offers no in-page delete', async () => {
    api.requestErasure.mockReturnValue(
      of({
        requestId: REQUEST_ID,
        status: 'requested',
        consequences: ['Leads are deleted.'],
        createdAt: 'now',
        confirmationEmailSent: true,
      }),
    );
    await setup('tok', { features: { privacyEraseConfirmInPage: false } });
    await click('[data-action="delete"]');
    expect(text()).toContain('We’ve emailed you a link');
    expect(q('.cta.danger')).toBeNull();
    expect(q('[data-action="resend-email"]')).toBeNull();
  });

  it('flag off + email not sent (#806): never claims an email went out and offers a resend', async () => {
    const pending = {
      requestId: REQUEST_ID,
      status: 'requested',
      consequences: ['Leads are deleted.'],
      createdAt: 'now',
      confirmationEmailSent: false,
    };
    api.requestErasure.mockReturnValue(of(pending));
    await setup('tok', { features: { privacyEraseConfirmInPage: false } });
    await click('[data-action="delete"]');
    expect(q('[data-state="email-not-sent"]')).not.toBeNull();
    expect(text()).not.toContain('We’ve emailed you a link');
    expect(q('.cta.danger')).toBeNull();

    api.requestErasure.mockReturnValue(of({ ...pending, confirmationEmailSent: true }));
    await click('[data-action="resend-email"]');
    expect(api.requestErasure).toHaveBeenCalledTimes(2);
    expect(q('[data-state="pending"]')).not.toBeNull();
    expect(q('[data-state="email-sent"]')).not.toBeNull();
    expect(q('[data-action="resend-email"]')).toBeNull();
  });

  it('flag off + resend in flight: the resend button disables', async () => {
    api.requestErasure.mockReturnValue(
      of({ requestId: REQUEST_ID, status: 'requested', consequences: [], createdAt: 'now', confirmationEmailSent: false }),
    );
    await setup('tok', { features: { privacyEraseConfirmInPage: false } });
    await click('[data-action="delete"]');
    api.requestErasure.mockReturnValue(NEVER);
    await click('[data-action="resend-email"]');
    const btn = q('[data-action="resend-email"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.textContent).toContain('Sending');
  });

  it('cancel keeps the data and returns to idle', async () => {
    api.requestErasure.mockReturnValue(
      of({ requestId: REQUEST_ID, status: 'requested', consequences: [], createdAt: 'now' }),
    );
    await setup('tok');
    await click('[data-action="delete"]');
    await click('[data-state="pending"] .text-button');
    expect(q('[data-action="delete"]')).not.toBeNull();
  });

  it('expired: a revoked token falls back to the email form', async () => {
    api.exportPrivacyData.mockReturnValue(err('FORBIDDEN'));
    await setup('tok');
    await click('[data-action="download"]');
    expect(q('[data-state="expired"]')).not.toBeNull();
    expect(q('input[type="email"]')).not.toBeNull();
  });

  it('rate-limited: shows the wait message', async () => {
    api.requestErasure.mockReturnValue(err('RATE_LIMITED'));
    await setup('tok');
    await click('[data-action="delete"]');
    expect(q('[data-state="rate-limited"]')).not.toBeNull();
  });

  it('error: shows retry, which resets to idle', async () => {
    api.exportPrivacyData.mockReturnValue(err('http_500'));
    await setup('tok');
    await click('[data-action="download"]');
    expect(q('[data-state="error"]')).not.toBeNull();
    await click('[data-state="error"] .text-button');
    expect(q('[data-state="error"]')).toBeNull();
  });

  it('idle without a token: shows the email form', async () => {
    await setup(null);
    expect(q('[data-state="no-token"]')).not.toBeNull();
    expect(q('[data-action="download"]')).toBeNull();
  });

  it('rejects an invalid email without calling the API', async () => {
    await setup(null);
    await click('button[type="submit"]');
    expect(q('#privacy-email-error')).not.toBeNull();
    expect(api.reissueMagicLink).not.toHaveBeenCalled();
  });

  it('unknown and known emails produce the same on-screen response', async () => {
    const screens: string[] = [];
    for (const sent of [false, true]) {
      api = privacyApiMock();
      api.reissueMagicLink.mockReturnValue(of({ sent }));
      await setup(null);
      const input = q('input[type="email"]') as HTMLInputElement;
      input.value = sent ? 'known@example.com' : 'unknown@example.com';
      input.dispatchEvent(new Event('input'));
      await click('button[type="submit"]');
      expect(q('[data-state="link-sent"]')).not.toBeNull();
      screens.push((q('main') as HTMLElement).innerHTML);
    }
    expect(screens[0]).toBe(screens[1]);
  });

  it('link rate-limited and link error show inline messages', async () => {
    api.reissueMagicLink.mockReturnValue(err('RATE_LIMITED'));
    await setup(null);
    const input = q('input[type="email"]') as HTMLInputElement;
    input.value = 'a@example.com';
    input.dispatchEvent(new Event('input'));
    await click('button[type="submit"]');
    expect(q('[data-state="link-rate-limited"]')).not.toBeNull();
    api.reissueMagicLink.mockReturnValue(err('http_0'));
    await click('button[type="submit"]');
    expect(q('[data-state="link-error"]')).not.toBeNull();
  });
});
