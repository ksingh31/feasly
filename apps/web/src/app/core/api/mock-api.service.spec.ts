import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';
import type { EstimateRequest } from '@feasly/contracts';
import { ConfigService } from '../config/config.service';
import { MockApiService } from './mock-api.service';
import { mockSuggestions } from './mock-data';

/**
 * Contract-conformance for the mock harness (FE0-003): every mock response
 * must satisfy its FE0-001 contract shape, and the pre-gate preview must be
 * incapable of carrying real figures — asserted here at runtime on top of the
 * compile-time type guarantee.
 */
describe('MockApiService', () => {
  let service: MockApiService;
  let httpMock: HttpTestingController;

  const estimateRequest: EstimateRequest = {
    addressKey: 'calgary-1234-14-st-nw',
    sqft: 2400,
    tier: 'premium',
    garage: 'double',
    basement: 'unfinished',
  };

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(MockApiService);
    httpMock = TestBed.inject(HttpTestingController);
    // Tiny latency window so the suite stays fast; the window itself is tested separately.
    const config = TestBed.inject(ConfigService);
    const pending = config.load();
    httpMock
      .expectOne('/assets/config/app-config.json')
      .flush({ timings: { mockLatencyMinMs: 1, mockLatencyMaxMs: 5 } });
    await pending;
  });

  describe('autocomplete', () => {
    it('returns matching suggestions for 3+ chars', async () => {
      const res = await firstValueFrom(service.autocomplete('14 st'));
      expect(res.suggestions.length).toBeGreaterThan(0);
      expect(res.suggestions.length).toBeLessThanOrEqual(6);
      for (const s of res.suggestions) {
        expect(s.addressKey).toBeTruthy();
        expect(s.address).toBeTruthy();
        expect(s.community).toBeTruthy();
      }
    });

    it('returns no suggestions for short queries', async () => {
      const res = await firstValueFrom(service.autocomplete('ab'));
      expect(res.suggestions).toEqual([]);
    });

    it('returns no suggestions when nothing matches', async () => {
      const res = await firstValueFrom(service.autocomplete('zzz nowhere'));
      expect(res.suggestions).toEqual([]);
    });
  });

  describe('getProperty', () => {
    it('returns the fake Calgary property record', async () => {
      const property = await firstValueFrom(service.getProperty('calgary-1234-14-st-nw'));
      expect(property.address).toContain('Calgary');
      expect(property.community).toBe('Capitol Hill');
      expect(property.assessedValue).toBeGreaterThan(0);
    });

    it('errors not_found for an unknown address key', async () => {
      await expect(firstValueFrom(service.getProperty('nope'))).rejects.toMatchObject({
        code: 'not_found',
        retryable: false,
      });
    });

    it('resolves every addressKey the autocomplete can suggest (no dead-end picks)', async () => {
      const suggestions = mockSuggestions();
      expect(suggestions.length).toBeGreaterThan(1);
      for (const suggestion of suggestions) {
        const property = await firstValueFrom(service.getProperty(suggestion.addressKey));
        expect(property.addressKey).toBe(suggestion.addressKey);
        expect(property.address).toBe(suggestion.address);
        expect(property.community).toBe(suggestion.community);
        expect(property.assessedValue).toBeGreaterThan(0);
      }
    });

    it('resolves the previously-failing "222 7 Ave NE" suggestion', async () => {
      const property = await firstValueFrom(service.getProperty('calgary-222-7-ave-ne'));
      expect(property.address).toBe('222 7 Ave NE, Calgary, AB');
      expect(property.community).toBe('Bridgeland');
    });

    it('returns stable records across lookups (no per-load drift)', async () => {
      const first = await firstValueFrom(service.getProperty('calgary-222-7-ave-ne'));
      const second = await firstValueFrom(service.getProperty('calgary-222-7-ave-ne'));
      expect(second).toEqual(first);
    });
  });

  describe('estimates', () => {
    it('pre-gate preview carries zero real figures (blur guarantee)', async () => {
      const preview = await firstValueFrom(service.getPreviewEstimate(estimateRequest));
      // Structural: every figure is the blurred placeholder, rows are empty.
      expect(preview.figures.build).toEqual({ blurred: true });
      expect(preview.figures.total).toEqual({ blurred: true });
      expect(preview.figures.land).toEqual({ blurred: true });
      expect(preview.rows).toEqual([]);
      // Runtime backstop: no 5+ digit number anywhere in the payload (every
      // real figure is >= 100000; ids and dates never reach 5 digits).
      expect(JSON.stringify(preview)).not.toMatch(/\d{5,}/);
      expect(preview.estimateId).toBeTruthy();
      expect(preview.costDataVersion).toBeTruthy();
    });

    it('post-gate estimate carries real ranges with valid rows', async () => {
      const estimate = await firstValueFrom(service.getEstimate(estimateRequest));
      for (const figure of [estimate.figures.build, estimate.figures.total, estimate.figures.land]) {
        expect(Number.isInteger(figure.low)).toBe(true);
        expect(Number.isInteger(figure.high)).toBe(true);
        expect(figure.low).toBeLessThan(figure.high);
      }
      expect(estimate.rows.length).toBeGreaterThan(0);
      for (const row of estimate.rows) {
        expect(row.key).toBeTruthy();
        expect(row.label).toBeTruthy();
        expect(row.range.low).toBeLessThan(row.range.high);
      }
    });
  });

  describe('lead gate + magic link', () => {
    it('submit → dev token → verify round-trips', async () => {
      const preview = await firstValueFrom(service.getPreviewEstimate(estimateRequest));
      const lead = await firstValueFrom(
        service.submitLead({
          email: 'buyer@example.com',
          name: 'Test Buyer',
          timeline: '6-12mo',
          marketingConsent: false,
          estimateId: preview.estimateId,
        }),
      );
      expect(lead.leadId).toBeTruthy();
      expect(lead.magicLinkSent).toBe(true);
      expect(lead.expiresInDays).toBeGreaterThan(0);

      const token = service.devMagicLinkForLead(lead.leadId);
      expect(token).toBeTruthy();
      const verified = await firstValueFrom(service.verifyMagicLink(token!));
      expect(verified.valid).toBe(true);
      if (verified.valid) {
        expect(verified.reportToken).toBe(token);
        expect(verified.estimateId).toBe(preview.estimateId);
        expect(verified.leadId).toBe(lead.leadId);
      }
    });

    it('rejects an unknown token as invalid', async () => {
      const res = await firstValueFrom(service.verifyMagicLink('bogus-token'));
      expect(res.valid).toBe(false);
      if (!res.valid) {
        expect(res.reason).toBe('invalid');
        expect(res.reissueAllowed).toBe(true);
      }
    });

    it('reissue reports sent', async () => {
      const res = await firstValueFrom(service.reissueMagicLink({ email: 'buyer@example.com' }));
      expect(res.sent).toBe(true);
    });
  });

  describe('report', () => {
    async function verifiedToken(): Promise<string> {
      const preview = await firstValueFrom(service.getPreviewEstimate(estimateRequest));
      const lead = await firstValueFrom(
        service.submitLead({
          email: 'buyer@example.com',
          name: 'Test Buyer',
          timeline: '6-12mo',
          marketingConsent: false,
          estimateId: preview.estimateId,
        }),
      );
      const verified = await firstValueFrom(service.verifyMagicLink(service.devMagicLinkForLead(lead.leadId)!));
      if (!verified.valid) throw new Error('mock verify failed');
      return verified.reportToken;
    }

    it('returns a snapshot with real ranges and the disclaimer footer', async () => {
      const report = await firstValueFrom(service.getReport(await verifiedToken()));
      expect(report.buildRange.low).toBeLessThan(report.buildRange.high);
      expect(report.rows.length).toBeGreaterThan(0);
      expect(report.narrative).toContain(
        'Dollar figures are calculated deterministically from our cost model',
      );
      expect(report.version).toBe(1);
    });

    it('errors for an unknown report token', async () => {
      await expect(firstValueFrom(service.getReport('nope'))).rejects.toMatchObject({
        code: 'not_found',
      });
    });

    it('tier revision scales ranges and bumps the version', async () => {
      const token = await verifiedToken();
      const before = await firstValueFrom(service.getReport(token));
      const revised = await firstValueFrom(service.reviseTier(token, { tier: 'luxury' }));
      expect(revised.version).toBe(before.version + 1);
      expect(revised.buildRange.low).toBeGreaterThan(before.buildRange.low);
      expect(revised.inputs.tier).toBe('luxury');
    });

    it('report versions stay monotonic across repeated revisions', async () => {
      const token = await verifiedToken();
      const first = await firstValueFrom(service.reviseTier(token, { tier: 'luxury' }));
      const second = await firstValueFrom(service.reviseTier(token, { tier: 'standard' }));
      expect(second.version).toBe(first.version + 1);
      const reread = await firstValueFrom(service.getReport(token));
      expect(reread.version).toBe(second.version);
    });
  });

  describe('callbacks, sharing, analytics', () => {
    it('requestCallback echoes the window', async () => {
      const res = await firstValueFrom(
        service.requestCallback({
          reportToken: 'mock-x',
          name: 'Test Buyer',
          phone: '4035550100',
          window: 'morning',
        }),
      );
      expect(res).toEqual({ ok: true, window: 'morning' });
    });

    it('shareWithPartner echoes the recipient', async () => {
      const res = await firstValueFrom(
        service.shareWithPartner({ reportToken: 'mock-x', partnerEmail: 'partner@example.com' }),
      );
      expect(res.sent).toBe(true);
      expect(res.sharedTo).toBe('partner@example.com');
    });

    it('trackEvent completes without emitting', async () => {
      await firstValueFrom(service.trackEvent({ event: 'step_view', route: '/', ts: new Date().toISOString() }));
    });
  });
});
