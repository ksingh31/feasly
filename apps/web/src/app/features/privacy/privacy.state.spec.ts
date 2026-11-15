import { TestBed } from '@angular/core/testing';
import { Store } from '@ngxs/store';
import { of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ErasureRequestResponse, PrivacyExportResponse } from '@feasly/contracts';
import { SetReportToken } from '../report/report.actions';
import { ReportState } from '../report/report.state';
import { StoreLeadResult } from '../wizard/lead.actions';
import { LeadState } from '../wizard/lead.state';
import {
  CancelErasure,
  ConfirmErasure,
  DownloadMyData,
  RequestErasure,
  ResetPrivacy,
  SendPrivacyLink,
} from './privacy.actions';
import { PrivacyState, toConfirmStatus, toPrivacyFailure } from './privacy.state';
import { configurePrivacyTestBed, privacyApiMock, type PrivacyApiMock } from './test-helpers/privacy-test-setup';

const EXPORT: PrivacyExportResponse = {
  exportedAt: '2026-11-15T00:00:00.000Z',
  email: 'jane@example.com',
  leads: [],
  estimates: [],
  magicLinks: [],
  reportShares: [],
  callbackRequests: [],
  erasureRequests: [],
  retentionNotice: 'draft',
};

const ERASE: ErasureRequestResponse = {
  requestId: '3f9b2c1a-0000-4000-8000-000000000000',
  status: 'requested',
  consequences: ['Your leads are deleted.'],
  createdAt: '2026-11-15T00:00:00.000Z',
};

const err = (code: string, message = 'x') => throwError(() => ({ code, message, retryable: false }));

describe('PrivacyState (#706)', () => {
  let store: Store;
  let api: PrivacyApiMock;
  let files: { saveJson: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = privacyApiMock();
    files = { saveJson: vi.fn() };
    await configurePrivacyTestBed({ api, files });
    store = TestBed.inject(Store);
  });

  it('starts idle on every action', () => {
    expect(store.selectSnapshot(PrivacyState.download)).toBe('idle');
    expect(store.selectSnapshot(PrivacyState.erase)).toBe('idle');
    expect(store.selectSnapshot(PrivacyState.confirm)).toBe('idle');
    expect(store.selectSnapshot(PrivacyState.link)).toBe('idle');
  });

  it('DownloadMyData saves the export as a JSON file and never stores the payload', () => {
    api.exportPrivacyData.mockReturnValue(of(EXPORT));
    store.dispatch(new DownloadMyData('tok'));
    expect(api.exportPrivacyData).toHaveBeenCalledWith('tok');
    expect(files.saveJson).toHaveBeenCalledWith('feasly-my-data.json', EXPORT);
    expect(store.selectSnapshot(PrivacyState.download)).toBe('done');
    expect(JSON.stringify(store.snapshot().privacy)).not.toContain('jane@example.com');
  });

  it.each([
    ['FORBIDDEN', 'expired'],
    ['RATE_LIMITED', 'rate-limited'],
    ['http_500', 'error'],
  ] as const)('DownloadMyData maps %s to %s', (code, status) => {
    api.exportPrivacyData.mockReturnValue(err(code));
    store.dispatch(new DownloadMyData('tok'));
    expect(store.selectSnapshot(PrivacyState.download)).toBe(status);
    expect(files.saveJson).not.toHaveBeenCalled();
  });

  it('RequestErasure moves to pending with the request id and consequences; Cancel clears it', () => {
    api.requestErasure.mockReturnValue(of(ERASE));
    store.dispatch(new RequestErasure('tok'));
    expect(store.selectSnapshot(PrivacyState.erase)).toBe('pending');
    expect(store.selectSnapshot(PrivacyState.eraseRequestId)).toBe(ERASE.requestId);
    expect(store.selectSnapshot(PrivacyState.consequences)).toEqual(ERASE.consequences);
    store.dispatch(new CancelErasure());
    expect(store.selectSnapshot(PrivacyState.erase)).toBe('idle');
    expect(store.selectSnapshot(PrivacyState.eraseRequestId)).toBeNull();
  });

  it('RequestErasure maps a rate limit', () => {
    api.requestErasure.mockReturnValue(err('RATE_LIMITED'));
    store.dispatch(new RequestErasure('tok'));
    expect(store.selectSnapshot(PrivacyState.erase)).toBe('rate-limited');
  });

  it('ConfirmErasure success clears the local report token, lead and wizard state', () => {
    store.dispatch(new SetReportToken('tok'));
    store.dispatch(
      new StoreLeadResult({ leadId: 'l1', email: 'jane@example.com', magicLinkSent: true, expiresInDays: 7 }),
    );
    api.confirmErasure.mockReturnValue(
      of({ requestId: ERASE.requestId, status: 'completed', confirmedAt: 'now', revokedMagicLinks: 1, deletedLeads: 1 }),
    );
    store.dispatch(new ConfirmErasure('tok', ERASE.requestId));
    expect(api.confirmErasure).toHaveBeenCalledWith('tok', ERASE.requestId);
    expect(store.selectSnapshot(PrivacyState.confirm)).toBe('done');
    expect(store.selectSnapshot(ReportState.reportToken)).toBeNull();
    expect(store.selectSnapshot(LeadState.email)).toBeNull();
  });

  it.each([
    ['CONFLICT', 'This erasure request has already been completed.', 'already-done'],
    ['CONFLICT', 'Erasure is blocked: open invoice', 'blocked'],
    ['NOT_FOUND', 'Unknown erasure request.', 'invalid'],
    ['FORBIDDEN', 'denied', 'expired'],
    ['RATE_LIMITED', 'slow down', 'rate-limited'],
    ['timeout', 'timed out', 'error'],
  ] as const)('ConfirmErasure maps %s (%s) to %s and keeps local state', (code, message, status) => {
    store.dispatch(new SetReportToken('tok'));
    api.confirmErasure.mockReturnValue(err(code, message));
    store.dispatch(new ConfirmErasure('tok', ERASE.requestId));
    expect(store.selectSnapshot(PrivacyState.confirm)).toBe(status);
    expect(store.selectSnapshot(ReportState.reportToken)).toBe('tok');
  });

  it('SendPrivacyLink shows "sent" whether or not the backend sent anything (no oracle)', () => {
    api.reissueMagicLink.mockReturnValue(of({ sent: false }));
    store.dispatch(new SendPrivacyLink('unknown@example.com'));
    expect(store.selectSnapshot(PrivacyState.link)).toBe('sent');
    store.dispatch(new ResetPrivacy());
    api.reissueMagicLink.mockReturnValue(of({ sent: true }));
    store.dispatch(new SendPrivacyLink('known@example.com'));
    expect(store.selectSnapshot(PrivacyState.link)).toBe('sent');
    expect(api.reissueMagicLink).toHaveBeenLastCalledWith({ email: 'known@example.com' });
  });

  it('SendPrivacyLink maps rate limits and transport errors', () => {
    api.reissueMagicLink.mockReturnValue(err('http_429'));
    store.dispatch(new SendPrivacyLink('a@example.com'));
    expect(store.selectSnapshot(PrivacyState.link)).toBe('rate-limited');
    api.reissueMagicLink.mockReturnValue(err('http_0'));
    store.dispatch(new SendPrivacyLink('a@example.com'));
    expect(store.selectSnapshot(PrivacyState.link)).toBe('error');
  });

  it('failure mappers tolerate non-ApiError values', () => {
    expect(toPrivacyFailure(undefined)).toBe('error');
    expect(toConfirmStatus(new Error('boom'))).toBe('error');
  });
});
