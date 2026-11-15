import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { of, throwError, type Observable } from 'rxjs';
import type { CityDataFreshnessResponse } from '@feasly/contracts';
import { API_SERVICE } from '../api/api.service';
import { ConfigService } from '../config/config.service';
import { DataFreshnessService } from './data-freshness.service';

/** #513: one shared freshness request per session, mock-aware, never throws. */
describe('DataFreshnessService', () => {
  function setup(
    source: 'mock' | 'live',
    response: Observable<CityDataFreshnessResponse>,
  ): { service: DataFreshnessService; call: ReturnType<typeof vi.fn> } {
    TestBed.resetTestingModule();
    const call = vi.fn().mockReturnValue(response);
    TestBed.configureTestingModule({
      providers: [
        { provide: API_SERVICE, useValue: { getCityDataFreshness: call } },
        { provide: ConfigService, useValue: { get: () => ({ source }) } },
      ],
    });
    return { service: TestBed.inject(DataFreshnessService), call };
  }

  it('loads once and exposes month + roll year', () => {
    const { service, call } = setup('live', of({ refreshedMonth: 'November 2026', rollYear: 2026 }));
    service.load();
    service.load();
    expect(call).toHaveBeenCalledTimes(1);
    expect(service.freshness()).toEqual({ refreshedMonth: 'November 2026', rollYear: 2026 });
  });

  it('treats a missing rollYear (older API) as unknown', () => {
    const { service } = setup('live', of({ refreshedMonth: 'November 2026' }));
    service.load();
    expect(service.freshness()).toEqual({ refreshedMonth: 'November 2026', rollYear: null });
  });

  it('resolves a failed request to unknown', () => {
    const { service } = setup('live', throwError(() => new Error('down')));
    service.load();
    expect(service.freshness()).toEqual({ refreshedMonth: null, rollYear: null });
  });

  it('retries on the next load after a failure (a blip is not cached)', () => {
    const { service, call } = setup('live', throwError(() => new Error('down')));
    service.load();
    call.mockReturnValue(of({ refreshedMonth: 'November 2026', rollYear: 2026 }));
    service.load();
    expect(call).toHaveBeenCalledTimes(2);
    expect(service.freshness()).toEqual({ refreshedMonth: 'November 2026', rollYear: 2026 });
  });

  it('never calls the endpoint on the mock property path', () => {
    const { service, call } = setup('mock', of({ refreshedMonth: 'November 2026', rollYear: 2026 }));
    service.load();
    expect(call).not.toHaveBeenCalled();
    expect(service.freshness()).toEqual({ refreshedMonth: null, rollYear: null });
  });
});
