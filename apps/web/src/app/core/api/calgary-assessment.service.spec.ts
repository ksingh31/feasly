import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import type { TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import { ConfigService } from '../config/config.service';
import { CalgaryAssessmentService } from './calgary-assessment.service';

/**
 * FE1-002: the live City of Calgary client. The HTTP layer is mocked, but
 * every fixture row uses the real dataset's schema shape (dataset 4bsw-nn7w,
 * "Current Year Property Assessments (Parcel)": roll_year, address,
 * assessed_value, comm_name, year_of_construction, land_use_designation,
 * land_size_sf, mod_date) — no live network in CI.
 */
describe('CalgaryAssessmentService', () => {
  let service: CalgaryAssessmentService;
  let httpMock: HttpTestingController;

  /** Fixture rows in the live schema shape (values plausible, not real). */
  const THIS_YEAR = new Date().getFullYear();
  const ROW_918 = {
    roll_year: String(THIS_YEAR),
    address: '918 16 AVE NW',
    assessed_value: '823000',
    comm_name: 'Mount Pleasant',
    year_of_construction: '1974',
    land_use_designation: 'R-C1',
    land_size_sf: '6100',
    mod_date: '2026-07-01T00:00:00.000',
  };
  const ROW_222 = {
    roll_year: THIS_YEAR,
    address: '222 7 AVE NE',
    assessed_value: 915000,
    comm_name: 'Bridgeland',
    year_of_construction: 1983,
    land_use_designation: 'R-C2',
    land_size_sf: 5600,
    mod_date: '2026-07-01T00:00:00.000',
  };

  const RESOURCE = 'https://data.calgary.ca/resource/4bsw-nn7w.json';

  async function wire(configOverrides: Record<string, unknown> = {}) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(CalgaryAssessmentService);
    httpMock = TestBed.inject(HttpTestingController);
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock
      .expectOne('/assets/config/app-config.json')
      .flush({ propertyData: { source: 'live' }, ...configOverrides });
    await pending;
  }

  beforeEach(async () => {
    await wire();
  });

  function expectSearch(query: string): TestRequest {
    return httpMock.expectOne(
      (req) =>
        req.method === 'GET' &&
        req.url === RESOURCE &&
        (req.params.get('$where') ?? '').includes(query),
    );
  }

  describe('autocomplete', () => {
    it('queries Socrata with a prefix search on the normalized query', async () => {
      const pending = firstValueFrom(service.autocomplete('16 ave'));
      const req = expectSearch('16 AV');
      expect(req.request.params.get('$select')).toBe('address,comm_name');
      expect(req.request.params.get('$where')).toBe(
        "starts_with(upper(address),'16 AV')",
      );
      expect(req.request.params.get('$order')).toBe('address');
      expect(req.request.params.get('$limit')).toBe('50');
      req.flush([]);
      const res = await pending;
      expect(res.suggestions).toEqual([]);
    });

    describe('street-type normalization', () => {
      async function whereFor(input: string): Promise<string | null> {
        const pending = firstValueFrom(service.autocomplete(input));
        const req = httpMock.expectOne((r) => r.url === RESOURCE);
        const where = req.request.params.get('$where');
        req.flush([]);
        await pending;
        return where;
      }

      it('rewrites AVE to the dataset abbreviation AV', async () => {
        await expect(whereFor('1600 90 ave sw')).resolves.toBe(
          "starts_with(upper(address),'1600 90 AV SW')",
        );
      });

      it('rewrites full spellings like STREET to ST', async () => {
        await expect(whereFor('101 9 street nw')).resolves.toBe(
          "starts_with(upper(address),'101 9 ST NW')",
        );
      });

      it('rewrites the type token even without a trailing quadrant', async () => {
        await expect(whereFor('16 avenue')).resolves.toBe(
          "starts_with(upper(address),'16 AV')",
        );
      });

      it('leaves already-abbreviated queries untouched', async () => {
        await expect(whereFor('1600 90 av sw')).resolves.toBe(
          "starts_with(upper(address),'1600 90 AV SW')",
        );
      });

      it('never rewrites a street name that contains a type word', async () => {
        // PARK is the street name here; only AVE (the type token) is rewritten.
        await expect(whereFor('park ave sw')).resolves.toBe(
          "starts_with(upper(address),'PARK AV SW')",
        );
      });

      it('leaves unknown tokens alone', async () => {
        await expect(whereFor('kensington')).resolves.toBe(
          "starts_with(upper(address),'KENSINGTON')",
        );
      });
    });

    it('maps rows to suggestions with formatted addresses, deduped', async () => {
      const pending = firstValueFrom(service.autocomplete('16 ave'));
      // Same address twice (two parcels) collapses to one suggestion.
      expectSearch('16 AV').flush([ROW_918, { ...ROW_918, assessed_value: '900000' }, ROW_222]);
      const res = await pending;
      expect(res.suggestions).toEqual([
        {
          addressKey: '918 16 AVE NW',
          address: '918 16 Ave NW, Calgary, AB',
          community: 'Mount Pleasant',
        },
        {
          addressKey: '222 7 AVE NE',
          address: '222 7 Ave NE, Calgary, AB',
          community: 'Bridgeland',
        },
      ]);
    });

    it('caps suggestions at the configured limit', async () => {
      await wire({ limits: { autocompleteSuggestionLimit: 1 } });
      const pending = firstValueFrom(service.autocomplete('16 ave'));
      expectSearch('16 AV').flush([ROW_918, ROW_222]);
      const res = await pending;
      expect(res.suggestions).toHaveLength(1);
    });

    it('short queries resolve empty without any HTTP request', async () => {
      const res = await firstValueFrom(service.autocomplete('ab'));
      expect(res.suggestions).toEqual([]);
      httpMock.verify();
    });

    it('zero rows resolve to an empty suggestion list', async () => {
      const pending = firstValueFrom(service.autocomplete('zzz nowhere'));
      expectSearch('ZZZ NOWHERE').flush([]);
      expect((await pending).suggestions).toEqual([]);
    });

    it('escapes single quotes in the SoQL predicate', async () => {
      const pending = firstValueFrom(service.autocomplete("o'brien"));
      const req = expectSearch("O''BRIEN");
      expect(req.request.params.get('$where')).toContain("O''BRIEN");
      req.flush([]);
      await pending;
    });

    it('maps transport failures to a retryable city_data_unavailable error', async () => {
      const pending = firstValueFrom(service.autocomplete('16 ave'));
      expectSearch('16 AV').flush('boom', { status: 500, statusText: 'Server Error' });
      await expect(pending).rejects.toMatchObject({
        code: 'city_data_unavailable',
        retryable: true,
      });
    });

    it('times out per api.timeoutMs with a retryable error', async () => {
      await wire({ api: { timeoutMs: 30 } });
      const pending = firstValueFrom(service.autocomplete('16 ave'));
      // Never flushed: the timeout must fire first.
      await expect(pending).rejects.toMatchObject({
        code: 'city_data_unavailable',
        retryable: true,
      });
    });

    it('caches repeated queries within the TTL', async () => {
      const first = firstValueFrom(service.autocomplete('16 ave'));
      expectSearch('16 AV').flush([ROW_918]);
      expect((await first).suggestions).toHaveLength(1);
      // Second identical query: served from cache, no new HTTP.
      const second = await firstValueFrom(service.autocomplete('16 ave'));
      expect(second.suggestions).toHaveLength(1);
      httpMock.verify();
    });
  });

  describe('getProperty', () => {
    function expectDetail(key: string): TestRequest {
      return httpMock.expectOne(
        (req) =>
          req.method === 'GET' &&
          req.url === RESOURCE &&
          req.params.get('$where') === `address='${key}'`,
      );
    }

    it('maps a live row onto the PropertyRecord contract', async () => {
      const pending = firstValueFrom(service.getProperty('918 16 AVE NW'));
      expectDetail('918 16 AVE NW').flush([ROW_918]);
      expect(await pending).toEqual({
        addressKey: '918 16 AVE NW',
        address: '918 16 Ave NW, Calgary, AB',
        community: 'Mount Pleasant',
        lotSqft: 6100,
        zoning: 'R-C1',
        assessedValue: 823000,
        assessmentYear: THIS_YEAR,
        yearBuilt: 1974,
        dataAsOf: '2026-07-01',
        stale: false,
      });
    });

    it('accepts numeric (non-string) column values', async () => {
      const pending = firstValueFrom(service.getProperty('222 7 AVE NE'));
      expectDetail('222 7 AVE NE').flush([ROW_222]);
      const property = await pending;
      expect(property.assessedValue).toBe(915000);
      expect(property.lotSqft).toBe(5600);
      expect(property.yearBuilt).toBe(1983);
    });

    it('picks the highest assessed value when parcels share an address', async () => {
      const pending = firstValueFrom(service.getProperty('918 16 AVE NW'));
      expectDetail('918 16 AVE NW').flush([
        { ...ROW_918, assessed_value: '500000' },
        { ...ROW_918, assessed_value: '823000' },
      ]);
      expect((await pending).assessedValue).toBe(823000);
    });

    it('marks older assessment years stale', async () => {
      const pending = firstValueFrom(service.getProperty('918 16 AVE NW'));
      expectDetail('918 16 AVE NW').flush([{ ...ROW_918, roll_year: '2020' }]);
      const property = await pending;
      expect(property.assessmentYear).toBe(2020);
      expect(property.stale).toBe(true);
    });

    it('errors not_found (non-retryable) for an unknown address', async () => {
      const pending = firstValueFrom(service.getProperty('1 NOWHERE ST NW'));
      expectDetail('1 NOWHERE ST NW').flush([]);
      await expect(pending).rejects.toMatchObject({
        code: 'not_found',
        retryable: false,
      });
    });

    it('treats a row with no usable assessed value as not found', async () => {
      const pending = firstValueFrom(service.getProperty('918 16 AVE NW'));
      expectDetail('918 16 AVE NW').flush([
        { ...ROW_918, assessed_value: 'not-a-number' },
      ]);
      // Non-retryable: the City has the address but no usable value, so
      // retrying the same lookup cannot help.
      await expect(pending).rejects.toMatchObject({
        code: 'not_found',
        retryable: false,
      });
    });

    it('caches records by address key', async () => {
      const first = firstValueFrom(service.getProperty('918 16 AVE NW'));
      expectDetail('918 16 AVE NW').flush([ROW_918]);
      await first;
      const second = await firstValueFrom(service.getProperty('918 16 AVE NW'));
      expect(second.assessedValue).toBe(823000);
      httpMock.verify();
    });
  });
});
