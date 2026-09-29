/**
 * City-data freshness route tests (trust-strip/01).
 *
 * The route is a thin adapter: exactly one service call, and the wire
 * shape matches the CityDataFreshnessResponse contract. The service
 * never throws, so the route has no error path — null means the Socrata
 * metadata was unreachable (frontend falls back to "Live City data").
 */
import { describe, expect, it } from 'vitest';
import type { CityDataFreshnessResponse } from '@feasly/contracts';
import {
  createCityDataFreshnessRoute,
} from '../src/routes/city-data-freshness.route';
import type { CityDataFreshnessService } from '../src/services/city-data-freshness.service';

function serviceWith(month: string | null): CityDataFreshnessService {
  return {
    getFreshness: async () => ({ refreshedMonth: month }),
  };
}

describe('city-data freshness route', () => {
  it('returns the refresh month from the service', async () => {
    const route = createCityDataFreshnessRoute({
      freshness: serviceWith('September 2026'),
    });
    const res: CityDataFreshnessResponse = await route.handle();
    expect(res).toEqual({ refreshedMonth: 'September 2026' });
  });

  it('passes through null when the Socrata metadata is unreachable', async () => {
    const route = createCityDataFreshnessRoute({ freshness: serviceWith(null) });
    const res: CityDataFreshnessResponse = await route.handle();
    expect(res).toEqual({ refreshedMonth: null });
  });
});
