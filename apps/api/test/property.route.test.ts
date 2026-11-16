/**
 * Property route tests (api-mcp/02).
 *
 * Covers: input validation (400 on missing/overlong params), happy-path
 * delegation to the service, and RFC 7807 error propagation (404 NOT_FOUND,
 * 503 DEPENDENCY_UNAVAILABLE).
 */
import { describe, expect, it } from 'vitest';
import { createPropertyRoute } from '../src/routes/property.route';
import { ErrorCodes, HttpError } from '../src/middleware/errors';
import type {
  AutocompleteResponse,
  PropertyRecord,
} from '@feasly/contracts';
import type { PropertyService } from '../src/services/property.service';
import type { AssessmentService } from '../src/services/assessment.service';

const RECORD: PropertyRecord = {
  addressKey: '1600 90 AV SW',
  address: '1600 90 Av SW, Calgary, AB',
  community: 'BAYVIEW',
  lotSqft: 452960,
  zoning: 'C-C2',
  assessedValue: 60150000,
  assessmentYear: 2026,
  yearBuilt: 1980,
  assessmentClass: 'R',
  isNonResidential: false,
  dataAsOf: '2026-01-15',
  stale: false,
};

const SUGGESTIONS: AutocompleteResponse = {
  suggestions: [
    {
      addressKey: '1600 90 AV SW',
      address: '1600 90 Av SW, Calgary, AB',
      community: 'BAYVIEW',
    },
  ],
};

function serviceWith(overrides: Partial<PropertyService> = {}): PropertyService {
  return {
    autocomplete: async () => SUGGESTIONS,
    getProperty: async () => RECORD,
    ...overrides,
  };
}

function assessmentWith(overrides: Partial<AssessmentService> = {}): AssessmentService {
  return {
    getAssessment: async () => ({
      property: RECORD,
      cityRecordUpdatedOn: '2026-01-15',
      propertyClassLabel: 'Residential',
      history: [{ rollYear: 2026, assessedValue: RECORD.assessedValue }],
      historyAvailable: true,
    }),
    ...overrides,
  };
}

async function catchError(promise: Promise<unknown>): Promise<HttpError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(HttpError);
  return error as HttpError;
}

describe('property route', () => {
  describe('autocomplete', () => {
    it('delegates to the service and returns suggestions', async () => {
      const route = createPropertyRoute({ assessment: assessmentWith(), property: serviceWith() });
      const res = await route.autocomplete('1600 90 Ave');
      expect(res).toEqual(SUGGESTIONS);
    });

    it('rejects a missing query with 400 VALIDATION_FAILED', async () => {
      const route = createPropertyRoute({ assessment: assessmentWith(), property: serviceWith() });
      const error = await catchError(route.autocomplete(undefined));
      expect(error.status).toBe(400);
      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
    });

    it('rejects an empty query with 400 VALIDATION_FAILED', async () => {
      const route = createPropertyRoute({ assessment: assessmentWith(), property: serviceWith() });
      const error = await catchError(route.autocomplete('   '));
      expect(error.status).toBe(400);
      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
    });

    it('rejects an overlong query with 400 VALIDATION_FAILED', async () => {
      const route = createPropertyRoute({ assessment: assessmentWith(), property: serviceWith() });
      const error = await catchError(route.autocomplete('x'.repeat(201)));
      expect(error.status).toBe(400);
      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
    });

    it('propagates service errors unchanged', async () => {
      const route = createPropertyRoute({ assessment: assessmentWith(),
        property: serviceWith({
          autocomplete: async () => {
            throw new HttpError(503, ErrorCodes.DEPENDENCY_UNAVAILABLE, 'down');
          },
        }),
      });
      const error = await catchError(route.autocomplete('1600'));
      expect(error.status).toBe(503);
      expect(error.code).toBe(ErrorCodes.DEPENDENCY_UNAVAILABLE);
    });
  });

  describe('lookup', () => {
    it('delegates to the service and returns the property record', async () => {
      const route = createPropertyRoute({ assessment: assessmentWith(), property: serviceWith() });
      const res = await route.lookup('1600 90 AV SW');
      expect(res).toEqual(RECORD);
    });

    it('rejects a missing addressKey with 400 VALIDATION_FAILED', async () => {
      const route = createPropertyRoute({ assessment: assessmentWith(), property: serviceWith() });
      const error = await catchError(route.lookup(undefined));
      expect(error.status).toBe(400);
      expect(error.code).toBe(ErrorCodes.VALIDATION_FAILED);
    });

    it('propagates NOT_FOUND from the service', async () => {
      const route = createPropertyRoute({ assessment: assessmentWith(),
        property: serviceWith({
          getProperty: async () => {
            throw new HttpError(404, ErrorCodes.NOT_FOUND, 'No City record.');
          },
        }),
      });
      const error = await catchError(route.lookup('999 NOWHERE ST NW'));
      expect(error.status).toBe(404);
      expect(error.code).toBe(ErrorCodes.NOT_FOUND);
    });
  });

  describe('assessment (#695)', () => {
    it('delegates the trimmed key and correlation id to the assessment service', async () => {
      let seen: { key?: string; correlationId?: string } = {};
      const route = createPropertyRoute({
        property: serviceWith(),
        assessment: assessmentWith({
          getAssessment: async (key, options) => {
            seen = { key, correlationId: options?.correlationId };
            return assessmentWith().getAssessment(key);
          },
        }),
      });
      const res = await route.assessment('  1412 PROSPECT AV SW ', 'corr-9');
      expect(res.propertyClassLabel).toBe('Residential');
      expect(seen).toEqual({ key: '1412 PROSPECT AV SW', correlationId: 'corr-9' });
    });

    it('rejects a missing addressKey with 400 VALIDATION_FAILED', async () => {
      const route = createPropertyRoute({ property: serviceWith(), assessment: assessmentWith() });
      const err = await catchError(route.assessment(undefined));
      expect(err.status).toBe(400);
      expect(err.code).toBe(ErrorCodes.VALIDATION_FAILED);
    });

    it('rejects an overlong addressKey with 400', async () => {
      const route = createPropertyRoute({ property: serviceWith(), assessment: assessmentWith() });
      const err = await catchError(route.assessment('x'.repeat(201)));
      expect(err.status).toBe(400);
    });

    it('propagates a service 404 unchanged', async () => {
      const route = createPropertyRoute({
        property: serviceWith(),
        assessment: assessmentWith({
          getAssessment: async () => {
            throw new HttpError(404, ErrorCodes.ADDRESS_NOT_FOUND, 'nope', false);
          },
        }),
      });
      const err = await catchError(route.assessment('9999 NOWHERE ST SW'));
      expect(err.status).toBe(404);
      expect(err.code).toBe(ErrorCodes.ADDRESS_NOT_FOUND);
    });
  });
});
