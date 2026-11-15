import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, provideRouter, Router } from '@angular/router';
import { Store } from '@ngxs/store';
import { NEVER, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SetReportToken } from '../report/report.actions';
import { ReportState } from '../report/report.state';
import { ConfirmErasePageComponent } from './confirm-erase-page.component';
import { configurePrivacyTestBed, privacyApiMock, type PrivacyApiMock } from './test-helpers/privacy-test-setup';

const REQUEST_ID = '3f9b2c1a-0000-4000-8000-000000000000';
const err = (code: string, message = 'x') => throwError(() => ({ code, message, retryable: false }));
const DONE = { requestId: REQUEST_ID, status: 'completed', confirmedAt: 'now', revokedMagicLinks: 1, deletedLeads: 1 };

/**
 * `/privacy/confirm/:requestId` (#706): emailed links wait for a click;
 * the in-page confirm (router state flag) runs at once; every terminal state.
 */
describe('ConfirmErasePageComponent', () => {
  let fixture: ComponentFixture<ConfirmErasePageComponent>;
  let api: PrivacyApiMock;
  let navigate: ReturnType<typeof vi.spyOn>;

  async function setup(opts: {
    sessionToken?: string;
    fragment?: string;
    fromInPage?: boolean;
  }): Promise<void> {
    window.history.replaceState(opts.fromInPage ? { privacyConfirmed: true } : null, '');
    await configurePrivacyTestBed({
      api,
      files: { saveJson: vi.fn() },
      imports: [ConfirmErasePageComponent],
      providers: [
        provideRouter([]),
        {
          provide: ActivatedRoute,
          useValue: {
            snapshot: {
              paramMap: convertToParamMap({ requestId: REQUEST_ID }),
              fragment: opts.fragment ?? null,
            },
          },
        },
      ],
    });
    if (opts.sessionToken) TestBed.inject(Store).dispatch(new SetReportToken(opts.sessionToken));
    navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(ConfirmErasePageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const state = (): string | null => el().querySelector('[data-state]')?.getAttribute('data-state') ?? null;
  async function clickConfirm(): Promise<void> {
    el().querySelector<HTMLButtonElement>('button.cta')?.click();
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(() => {
    api = privacyApiMock();
  });

  afterEach(() => {
    window.history.replaceState(null, '');
  });

  it('idle: an emailed link waits for an explicit click (link scanners never delete)', async () => {
    api.confirmErasure.mockReturnValue(of(DONE));
    await setup({ fragment: 'token=emailed' });
    expect(state()).toBe('idle');
    expect(api.confirmErasure).not.toHaveBeenCalled();
    await clickConfirm();
    expect(api.confirmErasure).toHaveBeenCalledWith('emailed', REQUEST_ID);
    expect(state()).toBe('done');
  });

  it('strips the #token fragment from the address bar', async () => {
    await setup({ fragment: 'token=emailed' });
    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ fragment: undefined, replaceUrl: true }),
    );
  });

  it('working: shows progress while confirming', async () => {
    api.confirmErasure.mockReturnValue(NEVER);
    await setup({ sessionToken: 'tok', fromInPage: true });
    expect(state()).toBe('working');
  });

  it('done: the in-page confirm runs at once with the session token and clears local report state', async () => {
    api.confirmErasure.mockReturnValue(of(DONE));
    await setup({ sessionToken: 'tok', fromInPage: true });
    expect(api.confirmErasure).toHaveBeenCalledWith('tok', REQUEST_ID);
    expect(state()).toBe('done');
    expect(TestBed.inject(Store).selectSnapshot(ReportState.reportToken)).toBeNull();
  });

  it('no credential: shows the expired state without calling the API', async () => {
    await setup({ fromInPage: true });
    expect(api.confirmErasure).not.toHaveBeenCalled();
    expect(state()).toBe('expired');
  });

  it.each([
    ['FORBIDDEN', 'denied', 'expired'],
    ['CONFLICT', 'This erasure request has already been completed.', 'already-done'],
    ['CONFLICT', 'Erasure is blocked: open invoice', 'blocked'],
    ['NOT_FOUND', 'Unknown erasure request.', 'invalid'],
    ['RATE_LIMITED', 'slow', 'rate-limited'],
    ['http_500', 'boom', 'error'],
  ] as const)('%s (%s) renders %s', async (code, message, expected) => {
    api.confirmErasure.mockReturnValue(err(code, message));
    await setup({ sessionToken: 'tok', fromInPage: true });
    expect(state()).toBe(expected);
  });

  it('retry re-runs the confirm call', async () => {
    api.confirmErasure.mockReturnValueOnce(err('http_500')).mockReturnValueOnce(of(DONE));
    await setup({ sessionToken: 'tok', fromInPage: true });
    await clickConfirm();
    expect(api.confirmErasure).toHaveBeenCalledTimes(2);
    expect(state()).toBe('done');
  });
});
