/**
 * Agreement gate helpers (#722): the 409 detector, the return-URL
 * allowlist (no open redirects) and the redirect on AGREEMENT_REQUIRED.
 */
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { Store } from '@ngxs/store';
import { describe, expect, it, vi } from 'vitest';
import {
  BuilderAgreementGate,
  isAgreementRequired,
  safeAgreementReturnUrl,
} from './builder-agreement-gate';
import { MarkBuilderAgreementRequired } from './builder-onboarding.actions';

describe('builder agreement gate (#722)', () => {
  it('detects only the AGREEMENT_REQUIRED code', () => {
    expect(isAgreementRequired({ code: 'AGREEMENT_REQUIRED' })).toBe(true);
    expect(isAgreementRequired({ code: 'http_409' })).toBe(false);
    expect(isAgreementRequired(null)).toBe(false);
    expect(isAgreementRequired('AGREEMENT_REQUIRED')).toBe(false);
  });

  it.each([
    ['/builder/money', '/builder/money'],
    ['/builder?open=lead-1', '/builder?open=lead-1'],
    ['//evil.example/builder', null],
    ['/admin', null],
    ['/builder/agreement', null],
    ['/builder/agreement?returnUrl=/builder', null],
    [null, null],
  ])('return url %s → %s', (raw, expected) => {
    expect(safeAgreementReturnUrl(raw)).toBe(expected);
  });

  it('routes a 409 AGREEMENT_REQUIRED to the agreement, remembering the page', () => {
    TestBed.resetTestingModule();
    const store = { dispatch: vi.fn() };
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: Store, useValue: store }],
    });
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    vi.spyOn(router, 'url', 'get').mockReturnValue('/builder/billing');
    const gate = TestBed.inject(BuilderAgreementGate);

    expect(gate.handle({ code: 'http_500' })).toBe(false);
    expect(navigate).not.toHaveBeenCalled();

    expect(gate.handle({ code: 'AGREEMENT_REQUIRED' })).toBe(true);
    expect(store.dispatch).toHaveBeenCalledWith(expect.any(MarkBuilderAgreementRequired));
    expect(router.serializeUrl(navigate.mock.calls[0]![0] as never)).toBe(
      '/builder/agreement?returnUrl=%2Fbuilder%2Fbilling',
    );
  });
});
